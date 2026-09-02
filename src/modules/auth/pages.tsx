import { AuthLayout } from '../../dashboard/layouts/AppShell.js'
import { Alert, CsrfInput, FormField } from '../../dashboard/components/index.js'
import { MIN_PASSWORD_LENGTH } from '../../lib/password.js'

/**
 * The auth screens. They share the .ncc-auth card rather than the app shell,
 * because there is no permission set to build a sidebar from until the user
 * is through all of these.
 */

export function LoginPage(props: {
  csrfToken: string
  next?: string
  email?: string
  error?: string
  notice?: string
}) {
  return (
    <AuthLayout title="Sign in">
      <h1>Staff sign in</h1>
      <p class="ncc-muted">Neelachandra Construction and Interiors</p>

      {props.error ? <Alert tone="error">{props.error}</Alert> : null}
      {props.notice ? <Alert tone="ok">{props.notice}</Alert> : null}

      <form method="post" action="/login" class="ncc-stack" style="margin-top:1rem">
        <CsrfInput token={props.csrfToken} />
        {props.next ? <input type="hidden" name="next" value={props.next} /> : null}
        <FormField
          label="Work email"
          name="email"
          type="email"
          value={props.email}
          required
          autocomplete="username"
        />
        <FormField
          label="Password"
          name="password"
          type="password"
          required
          autocomplete="current-password"
        />
        <button class="ncc-btn ncc-btn-primary" type="submit" style="width:100%">
          Sign in
        </button>
      </form>

      <div class="ncc-auth__foot">
        <a href="/forgot-password">Forgot password</a>
        <a href="/">Back to the website</a>
      </div>
      {/* There is no sign-up link because there is no public registration
          route anywhere in the application (spec 4.5). */}
      <p class="ncc-hint" style="margin-top:.9rem">
        Accounts are created by an administrator. There is no self sign up.
      </p>
    </AuthLayout>
  )
}

export function TotpVerifyPage(props: { csrfToken: string; error?: string }) {
  return (
    <AuthLayout title="Two factor">
      <h1>Enter your code</h1>
      <p class="ncc-muted">Open your authenticator app and enter the current 6 digit code.</p>
      {props.error ? <Alert tone="error">{props.error}</Alert> : null}
      <form method="post" action="/2fa/verify" class="ncc-stack" style="margin-top:1rem">
        <CsrfInput token={props.csrfToken} />
        <FormField
          label="Code"
          name="code"
          required
          autocomplete="one-time-code"
          placeholder="123456"
          hint="A recovery code also works here."
        />
        <button class="ncc-btn ncc-btn-primary" type="submit" style="width:100%">
          Continue
        </button>
      </form>
      <div class="ncc-auth__foot">
        <form method="post" action="/logout">
          <CsrfInput token={props.csrfToken} />
          <button class="ncc-btn" type="submit">
            Sign out
          </button>
        </form>
      </div>
    </AuthLayout>
  )
}

export function TotpEnrolPage(props: {
  csrfToken: string
  qrDataUrl: string
  secret: string
  error?: string
}) {
  return (
    <AuthLayout title="Set up two factor">
      <h1>Set up two factor authentication</h1>
      <p class="ncc-muted">
        Your role requires this. It has to be done before you can use the rest of the platform.
      </p>
      {props.error ? <Alert tone="error">{props.error}</Alert> : null}

      <ol class="ncc-hint" style="padding-left:1.2rem;line-height:1.7">
        <li>Install Google Authenticator, Authy or any TOTP app.</li>
        <li>Scan this code, or type the key below it.</li>
        <li>Enter the 6 digit code the app shows.</li>
      </ol>

      <div style="text-align:center;margin:.8rem 0">
        <img
          src={props.qrDataUrl}
          alt="Two factor setup QR code"
          width="200"
          height="200"
          style="border:1px solid var(--ncc-border);border-radius:var(--ncc-radius)"
        />
        <p class="ncc-hint" style="margin-top:.4rem">
          Setup key: <code>{props.secret}</code>
        </p>
      </div>

      <form method="post" action="/2fa/enrol" class="ncc-stack">
        <CsrfInput token={props.csrfToken} />
        <FormField label="Code from the app" name="code" required placeholder="123456" />
        <button class="ncc-btn ncc-btn-primary" type="submit" style="width:100%">
          Confirm and finish
        </button>
      </form>
    </AuthLayout>
  )
}

/**
 * Shown once, immediately after enrolment. There is no route that redisplays
 * these, because they are stored only as argon2 hashes and the server cannot
 * read them back (spec 4.5).
 */
export function RecoveryCodesPage(props: { codes: string[] }) {
  return (
    <AuthLayout title="Recovery codes">
      <h1>Save your recovery codes</h1>
      <Alert tone="warn">
        These are shown once and cannot be shown again. Each one works a single time. Print them or
        put them in a password manager now.
      </Alert>
      <ul
        style="list-style:none;padding:0;margin:1rem 0;display:grid;grid-template-columns:1fr 1fr;gap:.4rem"
      >
        {props.codes.map((c) => (
          <li>
            <code>{c}</code>
          </li>
        ))}
      </ul>
      <a class="ncc-btn ncc-btn-primary" href="/app" style="display:block;text-align:center">
        I have saved them, continue
      </a>
    </AuthLayout>
  )
}

export function ForgotPasswordPage(props: { csrfToken: string; sent?: boolean; email?: string }) {
  if (props.sent) {
    return (
      <AuthLayout title="Check your email">
        <h1>Check your email</h1>
        {/* Deliberately identical whether or not the address exists
            (spec 6.1), so the form cannot be used to test addresses. */}
        <p>
          If an account exists for that address, a reset link is on its way. The link works once and
          expires in 2 hours.
        </p>
        <div class="ncc-auth__foot">
          <a href="/login">Back to sign in</a>
        </div>
      </AuthLayout>
    )
  }
  return (
    <AuthLayout title="Forgot password">
      <h1>Forgot your password</h1>
      <p class="ncc-muted">Enter your work email and we will send a reset link.</p>
      <form method="post" action="/forgot-password" class="ncc-stack" style="margin-top:1rem">
        <CsrfInput token={props.csrfToken} />
        <FormField
          label="Work email"
          name="email"
          type="email"
          value={props.email}
          required
          autocomplete="username"
        />
        <button class="ncc-btn ncc-btn-primary" type="submit" style="width:100%">
          Send reset link
        </button>
      </form>
      <div class="ncc-auth__foot">
        <a href="/login">Back to sign in</a>
      </div>
    </AuthLayout>
  )
}

export function ResetPasswordPage(props: {
  csrfToken: string
  token: string
  purpose: 'invite' | 'reset'
  error?: string
  fieldError?: Record<string, string>
}) {
  const isInvite = props.purpose === 'invite'
  return (
    <AuthLayout title={isInvite ? 'Set your password' : 'Choose a new password'}>
      <h1>{isInvite ? 'Set your password' : 'Choose a new password'}</h1>
      <p class="ncc-muted">
        {isInvite
          ? 'Welcome. Choose the password you will use to sign in. Nobody else has seen or set one for this account.'
          : 'Choose a new password. Every existing session will be signed out.'}
      </p>
      {props.error ? <Alert tone="error">{props.error}</Alert> : null}
      <form
        method="post"
        action={`/reset-password/${props.token}`}
        class="ncc-stack"
        style="margin-top:1rem"
      >
        <CsrfInput token={props.csrfToken} />
        <FormField
          label="New password"
          name="password"
          type="password"
          required
          autocomplete="new-password"
          hint={`At least ${MIN_PASSWORD_LENGTH} characters. Checked against the most common passwords. No other rules.`}
          error={props.fieldError?.password}
        />
        <FormField
          label="Repeat new password"
          name="confirm"
          type="password"
          required
          autocomplete="new-password"
          error={props.fieldError?.confirm}
        />
        <button class="ncc-btn ncc-btn-primary" type="submit" style="width:100%">
          Save password
        </button>
      </form>
    </AuthLayout>
  )
}

export function ResetInvalidPage() {
  return (
    <AuthLayout title="Link not valid">
      <h1>That link is no longer valid</h1>
      <p>
        Reset and invite links work once and then expire. Request a new one, or ask an administrator
        to reissue your invite.
      </p>
      <div class="ncc-auth__foot">
        <a href="/forgot-password">Request a new link</a>
        <a href="/login">Back to sign in</a>
      </div>
    </AuthLayout>
  )
}
