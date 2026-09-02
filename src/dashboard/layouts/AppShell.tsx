import type { Child } from 'hono/jsx'
import { visibleNav, activeHref } from '../nav.js'
import type { CurrentUser } from '../../types.js'

/**
 * The /app chrome (spec 3: "sidebar filtered by permissions").
 *
 * Rendered server side on every request. There is no client router and no
 * hydration: htmx swaps fragments into this shell, so the shell itself is
 * plain HTML and the browser needs no JavaScript to display a page. That is
 * deliberate for a site supervisor on a phone with two bars of signal.
 */

export interface AppShellProps {
  title: string
  user: CurrentUser
  perms: Set<string>
  csrfToken: string
  path: string
  /** Second line under the page title. */
  subtitle?: string
  /** Right side of the page head, usually the primary action. */
  actions?: Child
  /** Loads Chart.js. Only the pages that draw a chart pass true (spec 2.3). */
  charts?: boolean
  children?: Child
}

export function AppShell(props: AppShellProps) {
  const groups = visibleNav(props.perms)
  const active = activeHref(props.path, groups)

  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{props.title} | Neelachandra staff</title>
        {/* The staff area must never be indexed. It is behind a login, but a
            stray link in an email signature is enough to get a URL crawled. */}
        <meta name="robots" content="noindex, nofollow" />
        <link rel="icon" href="/favicon.ico" sizes="any" />
        <link
          href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
        <link rel="stylesheet" href="/assets/css/dashboard.css" />
        <script src="/assets/vendor/htmx.min.js" defer></script>
        <script src="/assets/vendor/alpine.min.js" defer></script>
        {props.charts ? <script src="/assets/vendor/chart.umd.min.js" defer></script> : null}
      </head>
      {/* Every htmx request carries the CSRF token as a header, so an hx-post
          with no form fields is still protected (lib/csrf extractToken). */}
      <body hx-headers={JSON.stringify({ 'x-csrf-token': props.csrfToken })}>
        <div class="ncc-shell">
          <nav class="ncc-sidebar" aria-label="Main">
            <a class="ncc-sidebar__brand" href="/app">
              <span class="ncc-sidebar__mark" aria-hidden="true">
                N
              </span>
              <span>Neelachandra</span>
            </a>
            {groups.map((group) => (
              <div>
                <div class="ncc-sidebar__group">{group.label}</div>
                {group.items.map((item) => (
                  <a
                    class="ncc-navlink"
                    href={item.href}
                    aria-current={item.href === active ? 'page' : undefined}
                  >
                    {item.label}
                  </a>
                ))}
              </div>
            ))}
          </nav>

          <div class="ncc-main">
            <header class="ncc-topbar">
              <h1 class="ncc-topbar__title">{props.title}</h1>
              <div class="ncc-topbar__right">
                <a href="/app/account/sessions">{props.user.fullName}</a>
                <form method="post" action="/logout">
                  <input type="hidden" name="nc_csrf" value={props.csrfToken} />
                  <button class="ncc-btn" type="submit">
                    Sign out
                  </button>
                </form>
              </div>
            </header>

            <main class="ncc-content" id="main-content">
              {props.subtitle || props.actions ? (
                <div class="ncc-page-head">
                  <div>{props.subtitle ? <p>{props.subtitle}</p> : null}</div>
                  {props.actions ? <div class="ncc-row">{props.actions}</div> : null}
                </div>
              ) : null}
              {props.children}
            </main>
          </div>
        </div>
      </body>
    </html>
  )
}

/**
 * The auth screens (login, 2FA, reset) do not get the shell, because there is
 * no permission set to build a sidebar from yet. They share the tokens and
 * the .ncc-auth card instead.
 */
export function AuthLayout(props: { title: string; children?: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{props.title} | Neelachandra staff</title>
        <meta name="robots" content="noindex, nofollow" />
        <link rel="icon" href="/favicon.ico" sizes="any" />
        <link
          href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
        <link rel="stylesheet" href="/assets/css/dashboard.css" />
      </head>
      <body>
        <div class="ncc-auth">
          <div class="ncc-auth__card">{props.children}</div>
        </div>
      </body>
    </html>
  )
}
