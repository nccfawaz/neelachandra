// Generate the staff sign-in page at /login.
//
// WHY GENERATED, AND WHY IT IS A STATIC PAGE FOR NOW
// The chrome is lifted verbatim from a captured golden page, exactly as the
// error pages are, so the sign-in screen looks like the rest of the site
// without anyone inventing a design. See build-error-pages.mjs for the reasoning.
//
// This is the FRONT END ONLY. Nothing authenticates yet, and it must not
// pretend to: the site is currently static hosting where PHP does not execute
// and there is no Node process, so there is no server to check a password
// against. The form therefore has no live action, states plainly that access is
// not yet enabled, and carries the exact field names, autocomplete hints and
// CSRF placeholder that section 2.5 of NCC_BUILD_SPEC.md specifies, so the
// Node phase wires it up rather than rebuilding it.
//
// The alternative, shipping a form that posts nowhere and silently fails, would
// look functional to staff and generate support calls. Being explicit is the
// honest option.
//
// Usage: node scripts/build-login-page.mjs

import fs from 'node:fs'
import path from 'node:path'

const DONOR = 'legacy/golden/terms.html'
const html = fs.readFileSync(DONOR, 'utf8')

function extract (re, label) {
  const m = html.match(re)
  if (!m) throw new Error(`Could not extract ${label} from ${DONOR}. Refusing to invent it.`)
  return m[0]
}

const socialBar = extract(/<div class="top-social-bar">[\s\S]*?<\/div>/i, 'top social bar')
const header = extract(/<header[\s\S]*?<\/header>/i, 'header')
const footer = extract(/<footer[\s\S]*?<\/footer>/i, 'footer')
const gaBlock = extract(/<!-- Google tag \(gtag\.js\) -->[\s\S]*?<\/script>\s*<script>[\s\S]*?<\/script>/i, 'GA4 block')
const styleBlocks = [...html.matchAll(/<style[\s\S]*?<\/style>/gi)].map(m => m[0]).join('\n')
const fontLinks = [...html.matchAll(/<link[^>]*fonts\.googleapis[^>]*>/gi)].map(m => m[0]).join('\n    ')

// Scoped to .ncc-login so it cannot shift the cascade on any existing page.
// Colours and the type stack are taken from the site's own inline styles.
const LOGIN_CSS = `  <style>
    .ncc-login{max-width:1100px;margin:0 auto;padding:96px 24px 120px;font-family:"DM Sans",sans-serif}
    .ncc-login__grid{display:grid;grid-template-columns:1fr 1fr;gap:56px;align-items:start}
    .ncc-login__intro h1{font-size:clamp(28px,3.2vw,44px);line-height:1.15;margin:0 0 18px;color:#111}
    .ncc-login__intro p{font-size:clamp(15px,1.1vw,17px);line-height:1.7;color:#444;margin:0 0 14px}
    .ncc-login__note{border-left:3px solid #e8650a;padding:14px 18px;background:#fdf6f0;margin-top:26px}
    .ncc-login__note strong{color:#111}
    .ncc-login__card{border:1px solid #e6e6e6;border-radius:14px;padding:32px;background:#fff;box-shadow:0 2px 18px rgba(0,0,0,.05)}
    .ncc-login__card h2{font-size:20px;margin:0 0 22px;color:#111}
    .ncc-login__field{margin-bottom:18px}
    .ncc-login__field label{display:block;font-size:14px;color:#333;margin-bottom:7px}
    .ncc-login__field input{width:100%;box-sizing:border-box;padding:12px 14px;font-size:15px;font-family:inherit;border:1px solid #d6d6d6;border-radius:8px;background:#fff}
    .ncc-login__field input:focus{outline:none;border-color:#e8650a;box-shadow:0 0 0 3px rgba(232,101,10,.14)}
    .ncc-login__row{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:22px 0 8px;font-size:14px}
    .ncc-login__row a{color:#e8650a;text-decoration:none}
    .ncc-login__row a:hover{text-decoration:underline}
    .ncc-login__submit{width:100%;padding:14px 18px;font-size:16px;font-family:inherit;font-weight:600;color:#fff;background:#e8650a;border:0;border-radius:9px;cursor:pointer}
    .ncc-login__submit:hover{background:#cf5808}
    .ncc-login__submit[disabled]{background:#c9c9c9;cursor:not-allowed}
    .ncc-login__status{margin-top:16px;font-size:14px;line-height:1.6;color:#8a4b00;background:#fff6ec;border:1px solid #f3d6b8;border-radius:8px;padding:12px 14px}
    .ncc-login__meta{margin-top:22px;font-size:13px;color:#666;line-height:1.6}
    @media (max-width:900px){.ncc-login__grid{grid-template-columns:1fr;gap:36px}.ncc-login{padding:64px 18px 88px}}
  </style>`

const page = `${socialBar}<head>
    ${gaBlock}
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Staff Login | Neelachandra Construction and Interiors</title>
    <meta name="description" content="Sign-in for Neelachandra Construction and Interiors staff. Internal use only.">
    <!-- Internal page: never indexed, and no link equity passed. -->
    <meta name="robots" content="noindex, nofollow">
    <link rel="canonical" href="https://neelachandra.com/login">
    <link rel="icon" href="/favicon.ico" sizes="any">
    <link rel="shortcut icon" href="/favicon.ico">
    <link rel="apple-touch-icon" href="/favicon.ico">
    <link rel="manifest" href="/site.webmanifest">
    ${fontLinks}
${styleBlocks}
${LOGIN_CSS}
  </head>
  <body>
${header}
    <main class="ncc-login" id="login-main">
      <div class="ncc-login__grid">
        <section class="ncc-login__intro" aria-labelledby="login-heading">
          <h1 id="login-heading">Staff sign-in</h1>
          <p>This is the entry point to the Neelachandra internal workspace: project tracking,
             inventory, purchase and expense approvals, site reports, recruitment and the
             sales pipeline.</p>
          <p>Accounts are created by the owner or an administrator. There is no public
             registration, and there is no client portal on this address.</p>
          <div class="ncc-login__note">
            <p><strong>Access is not enabled yet.</strong> The workspace is being built. This
               page is the sign-in screen it will use; the accounts and the server that checks
               them are part of the next phase. Nothing you type here is sent anywhere.</p>
          </div>
        </section>

        <section class="ncc-login__card" aria-labelledby="login-form-heading">
          <h2 id="login-form-heading">Sign in to your account</h2>
          <!-- Field names, autocomplete hints and the CSRF placeholder match
               section 2.5 of NCC_BUILD_SPEC.md so the Node phase can wire this
               form up without redesigning it. The action is intentionally empty
               and the controls are disabled while there is no server. -->
          <form id="login-form" method="post" action="" autocomplete="on" novalidate>
            <input type="hidden" name="_csrf" value="">
            <input type="hidden" name="next" value="/app">
            <div class="ncc-login__field">
              <label for="login-email">Work email</label>
              <input type="email" id="login-email" name="email" autocomplete="username"
                     inputmode="email" placeholder="you@neelachandra.com" disabled>
            </div>
            <div class="ncc-login__field">
              <label for="login-password">Password</label>
              <input type="password" id="login-password" name="password"
                     autocomplete="current-password" placeholder="Your password" disabled>
            </div>
            <div class="ncc-login__row">
              <label for="login-remember" style="display:flex;align-items:center;gap:8px;margin:0">
                <input type="checkbox" id="login-remember" name="remember" value="1"
                       style="width:auto" disabled> Keep me signed in
              </label>
              <a href="/contact-us" rel="nofollow">Forgot password?</a>
            </div>
            <button type="submit" class="ncc-login__submit" id="login-submit" disabled>
              Sign in
            </button>
            <p class="ncc-login__status" id="login-status" role="status">
              Sign-in opens once the internal workspace goes live. To get an account, or if you
              need something from the office in the meantime,
              <a href="/contact-us">contact us</a>.
            </p>
          </form>
          <p class="ncc-login__meta">
            Authorised users only. Activity in the workspace is logged.
          </p>
        </section>
      </div>
    </main>
${footer}
  </body>
</html>
`

const file = path.resolve('login.html')
fs.writeFileSync(file, page)
console.log(`  login.html  ${fs.statSync(file).size} bytes`)
console.log(`\nLogin page written, chrome lifted verbatim from ${DONOR}.`)
console.log('Form is intentionally inert: no server exists yet to authenticate against.')
