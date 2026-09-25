import { jsx as _jsx, jsxs as _jsxs } from "hono/jsx/jsx-runtime";
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { AppShell } from '../../dashboard/layouts/AppShell.js';
import { Alert, CsrfInput, DataTable, FormField, Panel } from '../../dashboard/components/index.js';
import { isProd } from '../../env.js';
import { writeAudit } from '../../lib/audit.js';
import { bufferToIp } from '../../lib/crypto.js';
import { issueToken, verifyToken } from '../../lib/csrf.js';
import { formatDateTime } from '../../lib/dates.js';
import { isAppError } from '../../lib/errors.js';
import { MIN_PASSWORD_LENGTH } from '../../lib/password.js';
import { COOKIE_NAME, cookieOptions, destroySession, listUserSessions } from '../../lib/session.js';
import { countUnusedRecoveryCodes, qrDataUrl } from '../../lib/totp.js';
import { readBody } from '../../middleware/csrf.js';
import { currentSession, currentUser } from '../../types.js';
import { ForgotPasswordPage, LoginPage, RecoveryCodesPage, ResetInvalidPage, ResetPasswordPage, TotpEnrolPage, TotpVerifyPage, } from './pages.js';
import { changePasswordSchema, fieldErrors, forgotSchema, loginSchema, safeNext, setPasswordSchema, totpSchema, } from './schemas.js';
import * as service from './service.js';
/**
 * Auth routes (spec 6.1 route table).
 *
 * There is no registration route here, and none anywhere else in src/
 * (spec 4.5). Accounts come from an invite issued by a users.manage holder,
 * or from scripts/seed-users.mjs --owner for the very first account.
 */
const auth = new Hono();
/**
 * The CSRF token on the login and reset forms cannot come from a session,
 * because there is no session yet. It comes from a short-lived cookie that
 * the POST compares against its own hidden field: double submit, which is
 * the right tool for a pre-session form and is safe here because the cookie
 * is HttpOnly and SameSite=Lax.
 */
const PRE_SESSION_COOKIE = 'ncc_csrf';
function issuePreSessionToken(c) {
    const token = issueToken();
    setCookie(c, PRE_SESSION_COOKIE, token, {
        httpOnly: true,
        secure: isProd,
        sameSite: 'Lax',
        path: '/',
        maxAge: 3600,
    });
    return token;
}
function verifyPreSessionToken(c, body) {
    verifyToken(getCookie(c, PRE_SESSION_COOKIE), body['nc_csrf']);
}
function setSessionCookie(c, cookieValue, ttlSeconds) {
    setCookie(c, COOKIE_NAME, cookieValue, cookieOptions(isProd, ttlSeconds));
    deleteCookie(c, PRE_SESSION_COOKIE, { path: '/' });
}
/* Login ------------------------------------------------------------------ */
auth.get('/login', (c) => {
    if (c.get('user'))
        return c.redirect('/app', 302);
    const token = issuePreSessionToken(c);
    const next = c.req.query('next');
    const cleanNext = next ? safeNext(next) : '/app';
    return c.html(_jsx(LoginPage, { csrfToken: token, next: cleanNext === '/app' ? undefined : cleanNext, notice: c.req.query('signedout') === '1' ? 'You have been signed out.' : undefined }));
});
auth.post('/login', async (c) => {
    const body = await readBody(c);
    verifyPreSessionToken(c, body);
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
        return c.html(_jsx(LoginPage, { csrfToken: issuePreSessionToken(c), email: typeof body['email'] === 'string' ? body['email'] : undefined, error: "Enter your work email and password." }), 400);
    }
    const outcome = await service.login({
        email: parsed.data.email,
        password: parsed.data.password,
        ip: c.get('clientIp'),
        userAgent: c.req.header('user-agent') ?? null,
    });
    if (outcome.kind !== 'ok') {
        // 401 rather than 200 so a scanner sees a failure and the browser does
        // not cache the response as a successful page.
        return c.html(_jsx(LoginPage, { csrfToken: issuePreSessionToken(c), email: parsed.data.email, next: parsed.data.next ? safeNext(parsed.data.next) : undefined, error: outcome.message }), outcome.kind === 'locked' ? 429 : 401);
    }
    setSessionCookie(c, outcome.cookieValue, outcome.ttlSeconds);
    // The session is half authenticated at this point. requireAuth sends the
    // user to /2fa/verify or /app/account/password as needed, so this redirect
    // does not have to know the order of those gates.
    const next = safeNext(parsed.data.next);
    return c.redirect(next, 302);
});
/* Logout ----------------------------------------------------------------- */
auth.post('/logout', async (c) => {
    const session = c.get('session');
    const user = c.get('user');
    if (session) {
        const db = c.get('db');
        await db.transaction().execute(async (trx) => {
            await writeAudit(trx, {
                userId: user?.id ?? null,
                action: 'auth.logout',
                entityType: 'users',
                entityId: user?.id ?? null,
                ip: c.get('clientIp'),
            });
            await destroySession(trx, session.id);
        });
    }
    deleteCookie(c, COOKIE_NAME, cookieOptions(isProd));
    return c.redirect('/login?signedout=1', 302);
});
/* Two factor ------------------------------------------------------------- */
auth.get('/2fa/verify', (c) => {
    const user = c.get('user');
    const session = c.get('session');
    // Only reachable with a half-authenticated session (spec 6.1).
    if (!user || !session)
        return c.redirect('/login', 302);
    if (!user.totpConfirmed)
        return c.redirect('/2fa/enrol', 302);
    if (session.totpVerified)
        return c.redirect('/app', 302);
    return c.html(_jsx(TotpVerifyPage, { csrfToken: session.csrfToken }));
});
auth.post('/2fa/verify', async (c) => {
    const user = c.get('user');
    const session = c.get('session');
    if (!user || !session)
        return c.redirect('/login', 302);
    const body = await readBody(c);
    const parsed = totpSchema.safeParse(body);
    if (!parsed.success) {
        return c.html(_jsx(TotpVerifyPage, { csrfToken: session.csrfToken, error: fieldErrors(parsed.error)['code'] }), 400);
    }
    try {
        const { cookieValue, ttlSeconds } = await service.verifyTotp({
            userId: user.id,
            sessionId: session.id,
            code: parsed.data.code,
            ip: c.get('clientIp'),
            userAgent: c.req.header('user-agent') ?? null,
        });
        setSessionCookie(c, cookieValue, ttlSeconds);
        return c.redirect('/app', 302);
    }
    catch (err) {
        if (!isAppError(err))
            throw err;
        return c.html(_jsx(TotpVerifyPage, { csrfToken: session.csrfToken, error: err.message }), 422);
    }
});
auth.get('/2fa/enrol', async (c) => {
    const user = c.get('user');
    const session = c.get('session');
    if (!user || !session)
        return c.redirect('/login', 302);
    if (user.totpConfirmed)
        return c.redirect('/2fa/verify', 302);
    const offer = await service.beginEnrolment(user.id);
    return c.html(_jsx(TotpEnrolPage, { csrfToken: session.csrfToken, qrDataUrl: await qrDataUrl(offer.otpauth), secret: offer.secret }));
});
auth.post('/2fa/enrol', async (c) => {
    const user = c.get('user');
    const session = c.get('session');
    if (!user || !session)
        return c.redirect('/login', 302);
    const body = await readBody(c);
    const parsed = totpSchema.safeParse(body);
    const rerender = async (message, status) => {
        const offer = await service.beginEnrolment(user.id);
        return c.html(_jsx(TotpEnrolPage, { csrfToken: session.csrfToken, qrDataUrl: await qrDataUrl(offer.otpauth), secret: offer.secret, error: message }), status);
    };
    if (!parsed.success)
        return rerender('Enter the 6 digit code from your app.', 400);
    try {
        const result = await service.confirmEnrolment({
            userId: user.id,
            sessionId: session.id,
            code: parsed.data.code,
            ip: c.get('clientIp'),
            userAgent: c.req.header('user-agent') ?? null,
        });
        setSessionCookie(c, result.cookieValue, result.ttlSeconds);
        // Shown once and never again: the codes exist only as argon2 hashes from
        // here on, so there is no route that can redisplay them (spec 4.5).
        return c.html(_jsx(RecoveryCodesPage, { codes: result.recoveryCodes }));
    }
    catch (err) {
        if (!isAppError(err))
            throw err;
        return rerender(err.message, 422);
    }
});
/* Forgot and reset ------------------------------------------------------- */
auth.get('/forgot-password', (c) => {
    return c.html(_jsx(ForgotPasswordPage, { csrfToken: issuePreSessionToken(c) }));
});
auth.post('/forgot-password', async (c) => {
    const body = await readBody(c);
    verifyPreSessionToken(c, body);
    const parsed = forgotSchema.safeParse(body);
    if (!parsed.success) {
        return c.html(_jsx(ForgotPasswordPage, { csrfToken: issuePreSessionToken(c), email: typeof body['email'] === 'string' ? body['email'] : undefined }), 400);
    }
    await service.requestReset({ email: parsed.data.email, ip: c.get('clientIp') });
    // The same page regardless of whether the address exists (spec 6.1).
    return c.html(_jsx(ForgotPasswordPage, { csrfToken: "", sent: true }));
});
auth.get('/reset-password/:token', async (c) => {
    const token = c.req.param('token');
    const row = await service.lookupToken(token);
    if (!row)
        return c.html(_jsx(ResetInvalidPage, {}), 410);
    return c.html(_jsx(ResetPasswordPage, { csrfToken: issuePreSessionToken(c), token: token, purpose: row.purpose }));
});
auth.post('/reset-password/:token', async (c) => {
    const token = c.req.param('token');
    const body = await readBody(c);
    verifyPreSessionToken(c, body);
    const row = await service.lookupToken(token);
    if (!row)
        return c.html(_jsx(ResetInvalidPage, {}), 410);
    const parsed = setPasswordSchema.safeParse(body);
    if (!parsed.success) {
        return c.html(_jsx(ResetPasswordPage, { csrfToken: issuePreSessionToken(c), token: token, purpose: row.purpose, fieldError: fieldErrors(parsed.error) }), 400);
    }
    try {
        await service.completeReset({
            token,
            password: parsed.data.password,
            ip: c.get('clientIp'),
        });
    }
    catch (err) {
        if (!isAppError(err))
            throw err;
        return c.html(_jsx(ResetPasswordPage, { csrfToken: issuePreSessionToken(c), token: token, purpose: row.purpose, error: err.message }), 422);
    }
    // Every session was deleted, including any this browser held, so the user
    // signs in fresh. That is the point of the delete (spec 6.1).
    deleteCookie(c, COOKIE_NAME, cookieOptions(isProd));
    return c.redirect('/login', 302);
});
/* In-app account screens ------------------------------------------------- */
export const account = new Hono();
function ChangePasswordForm(props) {
    return (_jsxs(Panel, { title: "Change password", children: [props.saved ? _jsx(Alert, { tone: "ok", children: "Your password has been changed." }) : null, props.error ? _jsx(Alert, { tone: "error", children: props.error }) : null, _jsxs("form", { method: "post", action: "/app/account/password", class: "ncc-stack", style: "margin-top:.8rem", children: [_jsx(CsrfInput, { token: props.csrfToken }), props.needsCurrent ? (_jsx(FormField, { label: "Current password", name: "current", type: "password", required: true, autocomplete: "current-password", error: props.fieldError?.['current'] })) : (_jsx("p", { class: "ncc-hint", children: "This account has no password yet, so the current password is not required." })), _jsx(FormField, { label: "New password", name: "password", type: "password", required: true, autocomplete: "new-password", hint: `At least ${MIN_PASSWORD_LENGTH} characters. Checked against the most common passwords.`, error: props.fieldError?.['password'] }), _jsx(FormField, { label: "Repeat new password", name: "confirm", type: "password", required: true, autocomplete: "new-password", error: props.fieldError?.['confirm'] }), _jsx("div", { children: _jsx("button", { class: "ncc-btn ncc-btn-primary", type: "submit", children: "Save new password" }) })] })] }));
}
account.get('/password', async (c) => {
    const user = currentUser(c);
    const session = currentSession(c);
    const db = c.get('db');
    const row = await db
        .selectFrom('users')
        .select('password_hash')
        .where('id', '=', user.id)
        .executeTakeFirst();
    return c.html(_jsx(AppShell, { title: "Password", user: user, perms: c.get('perms'), csrfToken: session.csrfToken, path: "/app/account/password", subtitle: user.mustChangePassword
            ? 'Set a password before using the rest of the platform.'
            : undefined, children: _jsx(ChangePasswordForm, { csrfToken: session.csrfToken, needsCurrent: row?.password_hash !== null && row?.password_hash !== undefined, saved: c.req.query('saved') === '1' }) }));
});
account.post('/password', async (c) => {
    const user = currentUser(c);
    const session = currentSession(c);
    const body = await readBody(c);
    const parsed = changePasswordSchema.safeParse(body);
    const shell = (inner, status) => c.html(_jsx(AppShell, { title: "Password", user: user, perms: c.get('perms'), csrfToken: session.csrfToken, path: "/app/account/password", children: inner }), status);
    const db = c.get('db');
    const row = await db
        .selectFrom('users')
        .select('password_hash')
        .where('id', '=', user.id)
        .executeTakeFirst();
    const needsCurrent = row?.password_hash !== null && row?.password_hash !== undefined;
    if (!parsed.success) {
        return shell(_jsx(ChangePasswordForm, { csrfToken: session.csrfToken, needsCurrent: needsCurrent, fieldError: fieldErrors(parsed.error) }), 400);
    }
    try {
        const { cookieValue, ttlSeconds } = await service.changeOwnPassword({
            userId: user.id,
            sessionId: session.id,
            current: parsed.data.current,
            password: parsed.data.password,
            ip: c.get('clientIp'),
            userAgent: c.req.header('user-agent') ?? null,
        });
        setCookie(c, COOKIE_NAME, cookieValue, cookieOptions(isProd, ttlSeconds));
        return c.redirect('/app/account/password?saved=1', 302);
    }
    catch (err) {
        if (!isAppError(err))
            throw err;
        return shell(_jsx(ChangePasswordForm, { csrfToken: session.csrfToken, needsCurrent: needsCurrent, error: err.message }), 422);
    }
});
account.get('/sessions', async (c) => {
    const user = currentUser(c);
    const session = currentSession(c);
    const db = c.get('db');
    const rows = await listUserSessions(db, user.id);
    const recoveryLeft = user.totpConfirmed ? await countUnusedRecoveryCodes(db, user.id) : null;
    return c.html(_jsx(AppShell, { title: "Your account", user: user, perms: c.get('perms'), csrfToken: session.csrfToken, path: "/app/account/sessions", subtitle: user.email, children: _jsxs("div", { class: "ncc-stack", children: [_jsxs(Panel, { title: "Active sessions", children: [_jsx("p", { class: "ncc-hint", children: "Sessions last 12 hours from sign in and do not extend with use. Revoking one signs that device out immediately." }), _jsx(DataTable, { rows: rows, empty: "No other active sessions.", columns: [
                                {
                                    header: 'Signed in',
                                    cell: (r) => _jsx("span", { children: formatDateTime(String(r.created_at)) }),
                                },
                                {
                                    header: 'Last seen',
                                    cell: (r) => _jsx("span", { children: formatDateTime(String(r.last_seen_at)) }),
                                },
                                { header: 'IP', cell: (r) => _jsx("span", { children: bufferToIp(r.ip) ?? '-' }) },
                                {
                                    header: 'Device',
                                    cell: (r) => _jsx("span", { class: "ncc-hint", children: r.user_agent ?? 'unknown' }),
                                },
                                {
                                    header: '',
                                    cell: (r) => r.id === session.id ? (_jsx("span", { class: "ncc-badge ncc-badge-ok", children: "this device" })) : (_jsxs("form", { method: "post", action: "/app/account/sessions/revoke", children: [_jsx(CsrfInput, { token: session.csrfToken }), _jsx("input", { type: "hidden", name: "session_id", value: r.id }), _jsx("button", { class: "ncc-btn ncc-btn-danger", type: "submit", children: "Revoke" })] })),
                                },
                            ] })] }), _jsx(Panel, { title: "Security", children: _jsxs("ul", { class: "ncc-hint", style: "padding-left:1.1rem;line-height:1.8", children: [_jsxs("li", { children: ["Two factor authentication:", ' ', user.totpConfirmed ? 'enabled' : 'not set up on this account'] }), recoveryLeft !== null ? (_jsxs("li", { children: ["Unused recovery codes: ", recoveryLeft, " of 10"] })) : null, _jsx("li", { children: _jsx("a", { href: "/app/account/password", children: "Change your password" }) })] }) })] }) }));
});
account.post('/sessions/revoke', async (c) => {
    const user = currentUser(c);
    const session = currentSession(c);
    const body = await readBody(c);
    const target = typeof body['session_id'] === 'string' ? body['session_id'] : '';
    const db = c.get('db');
    await db.transaction().execute(async (trx) => {
        // Scoped to the caller's own rows, so a session id from another account
        // cannot be revoked by guessing it.
        const deleted = await trx
            .deleteFrom('user_sessions')
            .where('id', '=', target)
            .where('user_id', '=', user.id)
            .executeTakeFirst();
        if (Number(deleted.numDeletedRows ?? 0) > 0) {
            await writeAudit(trx, {
                userId: user.id,
                action: 'auth.session_revoked',
                entityType: 'user_sessions',
                entityId: null,
                after: { session_id: target },
                ip: c.get('clientIp'),
            });
        }
    });
    if (target === session.id) {
        deleteCookie(c, COOKIE_NAME, cookieOptions(isProd));
        return c.redirect('/login?signedout=1', 302);
    }
    return c.redirect('/app/account/sessions', 302);
});
export default auth;
