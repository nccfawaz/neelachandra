import type { Context } from 'hono'
import type { Child } from 'hono/jsx'
import type { AppEnv } from '../types.js'
import { currentUser, currentSession } from '../types.js'
import { AppShell } from './layouts/AppShell.js'
import type { ClientComponent } from './layouts/AppShell.js'
import { Alert } from './components/index.js'

/**
 * The shell wrapper every module route uses.
 *
 * Six modules rendering AppShell by hand means six chances to forget the
 * csrfToken or pass the wrong path, and a wrong path silently breaks the
 * sidebar highlight. So the wiring is done once here and a route only
 * supplies its title, path and body.
 */

export interface PageOptions {
  title: string
  path: string
  subtitle?: string
  actions?: Child
  charts?: boolean
  clients?: ClientComponent[]
}

export function page(c: Context<AppEnv>, opts: PageOptions, body: Child) {
  const session = currentSession(c)
  return c.html(
    <AppShell
      title={opts.title}
      user={currentUser(c)}
      perms={c.get('perms')}
      csrfToken={session.csrfToken}
      path={opts.path}
      subtitle={opts.subtitle}
      actions={opts.actions}
      charts={opts.charts}
      clients={opts.clients}
    >
      {body}
    </AppShell>
  )
}

/**
 * Reads ?ok= and ?error= off the URL.
 *
 * Results travel in the query string rather than a session flash because a
 * flash needs a session write on every redirect, and the redirect target is
 * always a GET the user can safely reload.
 */
export function banner(c: Context<AppEnv>) {
  const url = new URL(c.req.url)
  const ok = url.searchParams.get('ok')
  const error = url.searchParams.get('error')
  if (error) return <Alert tone="error">{error}</Alert>
  if (ok) return <Alert tone="ok">{ok}</Alert>
  return null
}

/** Redirect carrying a success message. 303 so a reload does not repost. */
export function okRedirect(c: Context<AppEnv>, path: string, message: string) {
  const sep = path.includes('?') ? '&' : '?'
  return c.redirect(`${path}${sep}ok=${encodeURIComponent(message)}`, 303)
}

export function errRedirect(c: Context<AppEnv>, path: string, message: string) {
  const sep = path.includes('?') ? '&' : '?'
  return c.redirect(`${path}${sep}error=${encodeURIComponent(message)}`, 303)
}

/** Reads a page number from ?page=, clamped so a hand-typed value cannot break the query. */
export function pageParam(c: Context<AppEnv>, pageSize: number) {
  const raw = Number(new URL(c.req.url).searchParams.get('page') ?? '1')
  const p = Number.isInteger(raw) && raw > 0 ? raw : 1
  return { page: p, offset: (p - 1) * pageSize, pageSize }
}

export function queryParam(c: Context<AppEnv>, name: string): string | undefined {
  const v = new URL(c.req.url).searchParams.get(name)
  return v && v.trim() !== '' ? v.trim() : undefined
}
