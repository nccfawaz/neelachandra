import { Hono } from 'hono'
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { AppShell } from '../../dashboard/layouts/AppShell.js'
import { Alert, CsrfInput, DataTable, FormField, Panel } from '../../dashboard/components/index.js'
import { isProd } from '../../env.js'
import { writeAudit } from '../../lib/audit.js'
import { bufferToIp } from '../../lib/crypto.js'
import { issueToken, verifyToken } from '../../lib/csrf.js'
import { formatDateTime } from '../../lib/dates.js'
import { isAppError } from '../../lib/errors.js'
import { MIN_PASSWORD_LENGTH } from '../../lib/password.js'
import { COOKIE_NAME, cookieOptions, destroySession, listUserSessions } from '../../lib/session.js'
import { countUnusedRecoveryCodes, qrDataUrl } from '../../lib/totp.js'
import { readBody } from '../../middleware/csrf.js'
import { currentSession, currentUser, type AppEnv } from '../../types.js'
import {
  ForgotPasswordPage,
  LoginPage,
  RecoveryCodesPage,
  ResetInvalidPage,
  ResetPasswordPage,
  TotpEnrolPage,
  TotpVerifyPage,
} from './pages.js'
import {
  changePasswordSchema,
  fieldErrors,
  forgotSchema,
  loginSchema,
  safeNext,
  setPasswordSchema,
  totpSchema,
} from './schemas.js'
import * as service from './service.js'

/**
 * Auth routes (spec 6.1 route table).
 *
 * There is no registration route here, and none anywhere else in src/
 * (spec 4.5). Accounts come from an invite issued by a users.manage holder,
 * or from scripts/seed-users.mjs --owner for the very first account.
 */

const auth = new Hono<AppEnv>()

/**
 * The CSRF token on the login and reset forms cannot come from a session,
 * because there is no session yet. It comes from a short-lived cookie that
 * the POST compares against its own hidden field: double submit, which is
 * the right tool for a pre-session form and is safe here because the cookie
 * is HttpOnly and SameSite=Lax.
 */
const PRE_SESSION_COOKIE = 'ncc_csrf'

function issuePreSessionToken(c: Context<AppEnv>): string {
  const token = issueToken()
  setCookie(c, PRE_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'Lax',
    path: '/',
    maxAge: 3600,
  })
  return token
}

function verifyPreSessionToken(c: Context<AppEnv>, body: Record<string, unknown>): void {
  verifyToken(getCookie(c, PRE_SESSION_COOKIE), body['nc_csrf'])
}

function setSessionCookie(c: Context<AppEnv>, cookieValue: string): void {
  setCookie(c, COOKIE_NAME, cookieValue, cookieOptions(isProd))
  deleteCookie(c, PRE_SESSION_COOKIE, { path: '/' })
}

/* Login ------------------------------------------------------------------ */

auth.get('/login', (c) => {
  if (c.get('user')) return c.redirect('/app', 302)
  const token = issuePreSessionToken(c)
  const next = c.req.query('next')
  const cleanNext = next ? safeNext(next) : '/app'
  return c.html(
    <LoginPage
      csrfToken={token}
      next={cleanNext === '/app' ? undefined : cleanNext}
      notice={c.req.query('signedout') === '1' ? 'You have been signed out.' : undefined}
    />
  )
})

auth.post('/login', async (c) => {
  const body = await readBody(c)
  verifyPreSessionToken(c, body)

  const parsed = loginSchema.safeParse(body)
  if (!parsed.success) {
    return c.html(
      <LoginPage
        csrfToken={issuePreSessionToken(c)}
        email={typeof body['email'] === 'string' ? body['email'] : undefined}
        error="Enter your work email and password."
      />,
      400
    )
  }

  const outcome = await service.login({
    email: parsed.data.email,
    password: parsed.data.password,
    ip: c.get('clientIp'),
    userAgent: c.req.header('user-agent') ?? null,
  })

  if (outcome.kind !== 'ok') {
    // 401 rather than 200 so a scanner sees a failure and the browser does
    // not cache the response as a successful page.
    return c.html(
      <LoginPage
        csrfToken={issuePreSessionToken(c)}
        email={parsed.data.email}
        next={parsed.data.next ? safeNext(parsed.data.next) : undefined}
        error={outcome.message}
      />,
      outcome.kind === 'locked' ? 429 : 401
    )
  }

  setSessionCookie(c, outcome.cookieValue)

  // The session is half authenticated at this point. requireAuth sends the
  // user to /2fa/verify or /app/account/password as needed, so this redirect
  // does not have to know the order of those gates.
  const next = safeNext(parsed.data.next)
  return c.redirect(next, 302)
})

/* Logout ----------------------------------------------------------------- */

auth.post('/logout', async (c) => {
  const session = c.get('session')
  const user = c.get('user')
  if (session) {
    const db = c.get('db')
    await db.transaction().execute(async (trx) => {
      await writeAudit(trx, {
        userId: user?.id ?? null,
        action: 'auth.logout',
        entityType: 'users',
        entityId: user?.id ?? null,
        ip: c.get('clientIp'),
      })
      await destroySession(trx, session.id)
    })
  }
  deleteCookie(c, COOKIE_NAME, cookieOptions(isProd))
  return c.redirect('/login?signedout=1', 302)
})

/* Two factor ------------------------------------------------------------- */

auth.get('/2fa/verify', (c) => {
  const user = c.get('user')
  const session = c.get('session')
  // Only reachable with a half-authenticated session (spec 6.1).
  if (!user || !session) return c.redirect('/login', 302)
  if (!user.totpConfirmed) return c.redirect('/2fa/enrol', 302)
  if (session.totpVerified) return c.redirect('/app', 302)
  return c.html(<TotpVerifyPage csrfToken={session.csrfToken} />)
})

auth.post('/2fa/verify', async (c) => {
  const user = c.get('user')
  const session = c.get('session')
  if (!user || !session) return c.redirect('/login', 302)

  const body = await readBody(c)
  const parsed = totpSchema.safeParse(body)
  if (!parsed.success) {
    return c.html(
      <TotpVerifyPage csrfToken={session.csrfToken} error={fieldErrors(parsed.error)['code']} />,
      400
    )
  }

  try {
    const { cookieValue } = await service.verifyTotp({
      userId: user.id,
      sessionId: session.id,
      code: parsed.data.code,
      ip: c.get('clientIp'),
      userAgent: c.req.header('user-agent') ?? null,
    })
    setSessionCookie(c, cookieValue)
    return c.redirect('/app', 302)
  } catch (err) {
    if (!isAppError(err)) throw err
    return c.html(<TotpVerifyPage csrfToken={session.csrfToken} error={err.message} />, 422)
  }
})

auth.get('/2fa/enrol', async (c) => {
  const user = c.get('user')
  const session = c.get('session')
  if (!user || !session) return c.redirect('/login', 302)
  if (user.totpConfirmed) return c.redirect('/2fa/verify', 302)

  const offer = await service.beginEnrolment(user.id)
  return c.html(
    <TotpEnrolPage
      csrfToken={session.csrfToken}
      qrDataUrl={await qrDataUrl(offer.otpauth)}
      secret={offer.secret}
    />
  )
})

auth.post('/2fa/enrol', async (c) => {
  const user = c.get('user')
  const session = c.get('session')
  if (!user || !session) return c.redirect('/login', 302)

  const body = await readBody(c)
  const parsed = totpSchema.safeParse(body)

  const rerender = async (message: string, status: 400 | 422) => {
    const offer = await service.beginEnrolment(user.id)
    return c.html(
      <TotpEnrolPage
        csrfToken={session.csrfToken}
        qrDataUrl={await qrDataUrl(offer.otpauth)}
        secret={offer.secret}
        error={message}
      />,
      status
    )
  }

  if (!parsed.success) return rerender('Enter the 6 digit code from your app.', 400)

  try {
    const result = await service.confirmEnrolment({
      userId: user.id,
      sessionId: session.id,
      code: parsed.data.code,
      ip: c.get('clientIp'),
      userAgent: c.req.header('user-agent') ?? null,
    })
    setSessionCookie(c, result.cookieValue)
    // Shown once and never again: the codes exist only as argon2 hashes from
    // here on, so there is no route that can redisplay them (spec 4.5).
    return c.html(<RecoveryCodesPage codes={result.recoveryCodes} />)
  } catch (err) {
    if (!isAppError(err)) throw err
    return rerender(err.message, 422)
  }
})

/* Forgot and reset ------------------------------------------------------- */

auth.get('/forgot-password', (c) => {
  return c.html(<ForgotPasswordPage csrfToken={issuePreSessionToken(c)} />)
})

auth.post('/forgot-password', async (c) => {
  const body = await readBody(c)
  verifyPreSessionToken(c, body)

  const parsed = forgotSchema.safeParse(body)
  if (!parsed.success) {
    return c.html(
      <ForgotPasswordPage
        csrfToken={issuePreSessionToken(c)}
        email={typeof body['email'] === 'string' ? body['email'] : undefined}
      />,
      400
    )
  }

  await service.requestReset({ email: parsed.data.email, ip: c.get('clientIp') })
  // The same page regardless of whether the address exists (spec 6.1).
  return c.html(<ForgotPasswordPage csrfToken="" sent />)
})

auth.get('/reset-password/:token', async (c) => {
  const token = c.req.param('token')
  const row = await service.lookupToken(token)
  if (!row) return c.html(<ResetInvalidPage />, 410)
  return c.html(
    <ResetPasswordPage csrfToken={issuePreSessionToken(c)} token={token} purpose={row.purpose} />
  )
})

auth.post('/reset-password/:token', async (c) => {
  const token = c.req.param('token')
  const body = await readBody(c)
  verifyPreSessionToken(c, body)

  const row = await service.lookupToken(token)
  if (!row) return c.html(<ResetInvalidPage />, 410)

  const parsed = setPasswordSchema.safeParse(body)
  if (!parsed.success) {
    return c.html(
      <ResetPasswordPage
        csrfToken={issuePreSessionToken(c)}
        token={token}
        purpose={row.purpose}
        fieldError={fieldErrors(parsed.error)}
      />,
      400
    )
  }

  try {
    await service.completeReset({
      token,
      password: parsed.data.password,
      ip: c.get('clientIp'),
    })
  } catch (err) {
    if (!isAppError(err)) throw err
    return c.html(
      <ResetPasswordPage
        csrfToken={issuePreSessionToken(c)}
        token={token}
        purpose={row.purpose}
        error={err.message}
      />,
      422
    )
  }

  // Every session was deleted, including any this browser held, so the user
  // signs in fresh. That is the point of the delete (spec 6.1).
  deleteCookie(c, COOKIE_NAME, cookieOptions(isProd))
  return c.redirect('/login', 302)
})

/* In-app account screens ------------------------------------------------- */

export const account = new Hono<AppEnv>()

function ChangePasswordForm(props: {
  csrfToken: string
  needsCurrent: boolean
  error?: string
  fieldError?: Record<string, string>
  saved?: boolean
}) {
  return (
    <Panel title="Change password">
      {props.saved ? <Alert tone="ok">Your password has been changed.</Alert> : null}
      {props.error ? <Alert tone="error">{props.error}</Alert> : null}
      <form method="post" action="/app/account/password" class="ncc-stack" style="margin-top:.8rem">
        <CsrfInput token={props.csrfToken} />
        {props.needsCurrent ? (
          <FormField
            label="Current password"
            name="current"
            type="password"
            required
            autocomplete="current-password"
            error={props.fieldError?.['current']}
          />
        ) : (
          <p class="ncc-hint">
            This account has no password yet, so the current password is not required.
          </p>
        )}
        <FormField
          label="New password"
          name="password"
          type="password"
          required
          autocomplete="new-password"
          hint={`At least ${MIN_PASSWORD_LENGTH} characters. Checked against the most common passwords.`}
          error={props.fieldError?.['password']}
        />
        <FormField
          label="Repeat new password"
          name="confirm"
          type="password"
          required
          autocomplete="new-password"
          error={props.fieldError?.['confirm']}
        />
        <div>
          <button class="ncc-btn ncc-btn-primary" type="submit">
            Save new password
          </button>
        </div>
      </form>
    </Panel>
  )
}

account.get('/password', async (c) => {
  const user = currentUser(c)
  const session = currentSession(c)
  const db = c.get('db')
  const row = await db
    .selectFrom('users')
    .select('password_hash')
    .where('id', '=', user.id)
    .executeTakeFirst()

  return c.html(
    <AppShell
      title="Password"
      user={user}
      perms={c.get('perms')}
      csrfToken={session.csrfToken}
      path="/app/account/password"
      subtitle={
        user.mustChangePassword
          ? 'Set a password before using the rest of the platform.'
          : undefined
      }
    >
      <ChangePasswordForm
        csrfToken={session.csrfToken}
        needsCurrent={row?.password_hash !== null && row?.password_hash !== undefined}
        saved={c.req.query('saved') === '1'}
      />
    </AppShell>
  )
})

account.post('/password', async (c) => {
  const user = currentUser(c)
  const session = currentSession(c)
  const body = await readBody(c)
  const parsed = changePasswordSchema.safeParse(body)

  const shell = (inner: ReturnType<typeof ChangePasswordForm>, status: 400 | 422) =>
    c.html(
      <AppShell
        title="Password"
        user={user}
        perms={c.get('perms')}
        csrfToken={session.csrfToken}
        path="/app/account/password"
      >
        {inner}
      </AppShell>,
      status
    )

  const db = c.get('db')
  const row = await db
    .selectFrom('users')
    .select('password_hash')
    .where('id', '=', user.id)
    .executeTakeFirst()
  const needsCurrent = row?.password_hash !== null && row?.password_hash !== undefined

  if (!parsed.success) {
    return shell(
      <ChangePasswordForm
        csrfToken={session.csrfToken}
        needsCurrent={needsCurrent}
        fieldError={fieldErrors(parsed.error)}
      />,
      400
    )
  }

  try {
    const { cookieValue } = await service.changeOwnPassword({
      userId: user.id,
      sessionId: session.id,
      current: parsed.data.current,
      password: parsed.data.password,
      ip: c.get('clientIp'),
      userAgent: c.req.header('user-agent') ?? null,
    })
    setCookie(c, COOKIE_NAME, cookieValue, cookieOptions(isProd))
    return c.redirect('/app/account/password?saved=1', 302)
  } catch (err) {
    if (!isAppError(err)) throw err
    return shell(
      <ChangePasswordForm
        csrfToken={session.csrfToken}
        needsCurrent={needsCurrent}
        error={err.message}
      />,
      422
    )
  }
})

account.get('/sessions', async (c) => {
  const user = currentUser(c)
  const session = currentSession(c)
  const db = c.get('db')
  const rows = await listUserSessions(db, user.id)
  const recoveryLeft = user.totpConfirmed ? await countUnusedRecoveryCodes(db, user.id) : null

  return c.html(
    <AppShell
      title="Your account"
      user={user}
      perms={c.get('perms')}
      csrfToken={session.csrfToken}
      path="/app/account/sessions"
      subtitle={user.email}
    >
      <div class="ncc-stack">
        <Panel title="Active sessions">
          <p class="ncc-hint">
            Sessions last 12 hours from sign in and do not extend with use. Revoking one signs that
            device out immediately.
          </p>
          <DataTable
            rows={rows}
            empty="No other active sessions."
            columns={[
              {
                header: 'Signed in',
                cell: (r) => <span>{formatDateTime(String(r.created_at))}</span>,
              },
              {
                header: 'Last seen',
                cell: (r) => <span>{formatDateTime(String(r.last_seen_at))}</span>,
              },
              { header: 'IP', cell: (r) => <span>{bufferToIp(r.ip) ?? '-'}</span> },
              {
                header: 'Device',
                cell: (r) => <span class="ncc-hint">{r.user_agent ?? 'unknown'}</span>,
              },
              {
                header: '',
                cell: (r) =>
                  r.id === session.id ? (
                    <span class="ncc-badge ncc-badge-ok">this device</span>
                  ) : (
                    <form method="post" action="/app/account/sessions/revoke">
                      <CsrfInput token={session.csrfToken} />
                      <input type="hidden" name="session_id" value={r.id} />
                      <button class="ncc-btn ncc-btn-danger" type="submit">
                        Revoke
                      </button>
                    </form>
                  ),
              },
            ]}
          />
        </Panel>

        <Panel title="Security">
          <ul class="ncc-hint" style="padding-left:1.1rem;line-height:1.8">
            <li>
              Two factor authentication:{' '}
              {user.totpConfirmed ? 'enabled' : 'not set up on this account'}
            </li>
            {recoveryLeft !== null ? (
              <li>Unused recovery codes: {recoveryLeft} of 10</li>
            ) : null}
            <li>
              <a href="/app/account/password">Change your password</a>
            </li>
          </ul>
        </Panel>
      </div>
    </AppShell>
  )
})

account.post('/sessions/revoke', async (c) => {
  const user = currentUser(c)
  const session = currentSession(c)
  const body = await readBody(c)
  const target = typeof body['session_id'] === 'string' ? body['session_id'] : ''

  const db = c.get('db')
  await db.transaction().execute(async (trx) => {
    // Scoped to the caller's own rows, so a session id from another account
    // cannot be revoked by guessing it.
    const deleted = await trx
      .deleteFrom('user_sessions')
      .where('id', '=', target)
      .where('user_id', '=', user.id)
      .executeTakeFirst()
    if (Number(deleted.numDeletedRows ?? 0) > 0) {
      await writeAudit(trx, {
        userId: user.id,
        action: 'auth.session_revoked',
        entityType: 'user_sessions',
        entityId: null,
        after: { session_id: target },
        ip: c.get('clientIp'),
      })
    }
  })

  if (target === session.id) {
    deleteCookie(c, COOKIE_NAME, cookieOptions(isProd))
    return c.redirect('/login?signedout=1', 302)
  }
  return c.redirect('/app/account/sessions', 302)
})

export default auth
