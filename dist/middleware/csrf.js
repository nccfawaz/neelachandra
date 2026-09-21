import { getCookie } from 'hono/cookie';
import { CSRF_FIELD, requiresCsrf, verifyToken } from '../lib/csrf.js';
import { ForbiddenError } from '../lib/errors.js';
/**
 * Content types whose body is NOT parsed here.
 *
 * PRECONDITION, DECISIONS.md 15.1: this skips the *body parse* only. The guard
 * below still runs and still calls verifyToken, so a multipart POST must carry
 * the token in the x-csrf-token header or it is refused -- which means a plain
 * <form enctype="multipart/form-data"> does not work as written, and no upload
 * handler may land until that is deliberately covered (htmx already sends the
 * header via hx-headers on <body>). Never resolve it by making this list skip
 * verification, and never mount an upload route outside csrfProtect.
 */
const SKIP_CONTENT_TYPES = ['multipart/form-data'];
/**
 * Pre-session double-submit (spec 2.5, same rationale as auth/routes.tsx's
 * PRE_SESSION_COOKIE): a visitor posting /login or /forgot-password has no
 * session row yet, so the synchroniser token has no server half to compare
 * against. Those forms instead carry the token issued with the page — the
 * double-submit pattern, safe here because the pre-session cookie is
 * HttpOnly and SameSite=Lax, and the login form cannot be a CSRF target in
 * any useful sense (a forged login only logs the VICTIM into the attacker's
 * account). The cookie value IS the expected token; the form echoes it.
 *
 * Exported so the auth module's issuePreSessionToken/verifyPreSessionToken
 * and this guard agree on the cookie name from one constant.
 */
export const PRE_SESSION_COOKIE = 'ncc_csrf';
/** Paths guarded by double-submit instead of the session token. */
const PRE_SESSION_PATHS = new Set(['/login', '/forgot-password']);
/** Pre-session POST paths with parameters: the reset form posts to
 * /reset-password/<token>, so it is matched by pattern — exactly one token
 * segment — not by prefix, which would let sub-paths through. */
function isPreSessionPath(path) {
    return PRE_SESSION_PATHS.has(path) || /^\/reset-password\/[^/]+$/.test(path);
}
export function csrfProtect() {
    return async (c, next) => {
        if (!requiresCsrf(c.req.method))
            return next();
        const session = c.get('session');
        const contentType = c.req.header('content-type') ?? '';
        // A file upload is streamed, so it cannot be buffered here without
        // holding 15 MB in memory before the guard runs. Those routes carry the
        // token in the x-csrf-token header instead, checked below without a body
        // parse.
        const isMultipart = SKIP_CONTENT_TYPES.some((t) => contentType.includes(t));
        let body = null;
        if (!isMultipart && contentType.includes('form-urlencoded')) {
            body = (await c.req.parseBody({ all: true }));
            c.set('parsedBody', body);
        }
        else if (!isMultipart && contentType.includes('application/json')) {
            try {
                body = (await c.req.json());
            }
            catch {
                body = null;
            }
            c.set('parsedBody', body);
        }
        // A non-string here means the field was sent twice, which no template in
        // the app does. Falling through to the header (and then failing
        // verification) is the fail-closed direction, and a Forbidden on submit is
        // a findable bug in a way a silently accepted duplicate is not.
        const suppliedFromBody = body?.[CSRF_FIELD];
        const supplied = typeof suppliedFromBody === 'string' && suppliedFromBody.length > 0
            ? suppliedFromBody
            : c.req.header('x-csrf-token');
        // Pre-session forms: no session exists, so the session-token branch
        // below can never pass. Double-submit instead: cookie value equals the
        // token the page embedded, compared timing-safely.
        const path = new URL(c.req.url).pathname;
        if (!session && isPreSessionPath(path)) {
            const expected = getCookie(c, PRE_SESSION_COOKIE);
            if (!expected) {
                throw new ForbiddenError('This form is missing its security token. Reload the page and try again.');
            }
            verifyToken(expected, supplied);
            return next();
        }
        if (!session)
            throw new ForbiddenError('Your session has ended. Sign in again.');
        verifyToken(session.csrfToken, supplied);
        return next();
    };
}
/**
 * Reads the body the guard already consumed, or parses it if the guard did
 * not run for this route. Handlers call this instead of c.req.parseBody().
 *
 * The fallback repeats `{ all: true }` so a handler reached without the guard
 * sees the same shape as one reached through it — otherwise a form would work
 * or drop its lines depending on which middleware ran.
 */
export async function readBody(c) {
    const cached = c.get('parsedBody');
    if (cached)
        return cached;
    return (await c.req.parseBody({ all: true }));
}
