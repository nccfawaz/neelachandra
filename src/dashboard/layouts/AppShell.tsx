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

/**
 * A page-scoped client component, by name.
 *
 * A UNION AND NOT A STRING, so a route cannot put an arbitrary path into a
 * script tag. Every member is a file this repository wrote at
 * `public/assets/js/<name>.js`; adding a component means adding a member here,
 * which is also the list of them.
 */
export type ClientComponent = 'attendance-grid' | 'checkin-geo'

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
  /**
   * Client components this page needs, loaded from /assets/js. Nothing is
   * bundled: these are hand-written files served as they are, like the vendor
   * scripts beside them.
   */
  clients?: ClientComponent[]
  /**
   * Top-bar global search (29.55). Renders the field only; the /app/search
   * handler is not built yet, so submitting is a no-op that re-renders the
   * dashboard rather than a 404.
   */
  searchPlaceholder?: string
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
        {/* Installable to a phone home screen (DECISIONS 34.2): the manifest
            makes Chrome offer "Add to home screen" with standalone display
            and the brand theme; the service worker registration (below, at
            the end of body) is what turns that offer into a full install.
            The public site keeps its own site.webmanifest, untouched. */}
        <link rel="manifest" href="/assets/app-manifest.webmanifest" />
        <meta name="theme-color" content="#f48120" />
        <link rel="apple-touch-icon" href="/assets/icons/icon-180.png" />
        <script src="/assets/vendor/htmx.min.js" defer></script>
        {/* BEFORE Alpine and also deferred, which is load bearing. This build
            of Alpine does not wait for DOMContentLoaded: its module tail calls
            `queueMicrotask(() => Alpine.start())`, and a microtask drains
            between two deferred script tasks -- so Alpine has walked the DOM
            before the NEXT deferred tag runs. A component script listed after
            `alpine.min.js` registers its `alpine:init` listener after the event
            has fired and the component silently never exists; every
            x-expression on the page warns `... is not defined`. Component
            scripts come first, then, so their listener is in place before
            Alpine's own script task runs and dispatches it. Proven in a real
            browser by tests/e2e/attendance-hint.test.ts, which fails in state 3
            under the old order. */}
        {(props.clients ?? []).map((name) => (
          <script src={`/assets/js/${name}.js`} defer></script>
        ))}
        <script src="/assets/vendor/alpine.min.js" defer></script>
        {props.charts ? <script src="/assets/vendor/chart.umd.min.js" defer></script> : null}
      </head>
      {/* Every htmx request carries the CSRF token as a header, so an hx-post
          with no form fields is still protected (lib/csrf extractToken). */}
      <body hx-headers={JSON.stringify({ 'x-csrf-token': props.csrfToken })}>
        <div class="ncc-shell">
          {/* 37.2 off-canvas nav, no JavaScript: a visually-hidden but
              focusable checkbox holds the open/closed state, the menu button
              in the topbar is its <label>, and the backdrop is a second label
              that closes it. The CSS slides .ncc-sidebar in on :checked. The
              checkbox is the first child so its ~ selectors reach both the
              sidebar and the backdrop. */}
          <input type="checkbox" id="ncc-nav-toggle" class="ncc-nav-toggle" aria-label="Menu" />
          <nav class="ncc-sidebar" aria-label="Main">
            <a class="ncc-sidebar__brand" href="/app">
              {/* Full lockup (29.57, corrected): the un-cropped logo.svg —
                  arch, wordmark and rule together — at its natural aspect,
                  sized to the sidebar width. The asset stays byte-untouched:
                  no <view>, no fragment. The separate NEELACHANDRA text is
                  gone; the asset already contains it. STAFF PLATFORM survives
                  as a small label beneath, since the asset's own tagline is
                  illegible at this size (DECISIONS 29.59). */}
              <img
                class="ncc-sidebar__lockup"
                src="/assets/images/header/logo.svg"
                alt="Neelachandra"
              />
              <span class="ncc-sidebar__wordmark-sub">STAFF PLATFORM</span>
            </a>
            {groups.map((group) => (
              <div>
                <div class="ncc-sidebar__group">{group.label}</div>
                {group.items.map((item) =>
                  item.disabled === true ? (
                    <span
                      class="ncc-navlink ncc-navlink--disabled"
                      aria-disabled="true"
                      title="Not built yet"
                    >
                      {item.label}
                    </span>
                  ) : (
                    <a
                      class="ncc-navlink"
                      href={item.href}
                      aria-current={item.href === active ? 'page' : undefined}
                    >
                      {item.label}
                    </a>
                  )
                )}
              </div>
            ))}
          </nav>

          {/* Closes the drawer when the darkened area beside it is tapped.
              display:none until the checkbox is checked (compact only). */}
          <label for="ncc-nav-toggle" class="ncc-nav-backdrop" aria-hidden="true"></label>

          <div class="ncc-main">
            <header class="ncc-topbar">
              {/* The drawer's open control. A <label>, not a <button>, so it
                  toggles the checkbox with no script; display:none above the
                  breakpoint where the sidebar is always visible. */}
              <label for="ncc-nav-toggle" class="ncc-nav-btn" aria-label="Menu">
                ☰
              </label>
              <h1 class="ncc-topbar__title">{props.title}</h1>
              <form class="ncc-topbar__search" action="/app" method="get" role="search">
                <input
                  type="search"
                  name="q"
                  placeholder={props.searchPlaceholder ?? 'Search projects, vendors, invoices…'}
                  aria-label="Search"
                />
              </form>
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
        {/* Service worker for installability only (DECISIONS 34.2): it caches
            NOTHING -- app pages must never be served stale. Registration sits
            at the end of body so it never delays first paint. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "if ('serviceWorker' in navigator) { window.addEventListener('load', function () { navigator.serviceWorker.register('/app-sw.js', { scope: '/' }) }) }",
          }}
        />
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
