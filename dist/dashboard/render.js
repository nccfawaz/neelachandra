import { jsx as _jsx } from "hono/jsx/jsx-runtime";
import { currentUser, currentSession } from '../types.js';
import { AppShell } from './layouts/AppShell.js';
import { Alert } from './components/index.js';
export function page(c, opts, body) {
    const session = currentSession(c);
    return c.html(_jsx(AppShell, { title: opts.title, user: currentUser(c), perms: c.get('perms'), csrfToken: session.csrfToken, path: opts.path, subtitle: opts.subtitle, actions: opts.actions, charts: opts.charts, clients: opts.clients, children: body }));
}
/**
 * Reads ?ok= and ?error= off the URL.
 *
 * Results travel in the query string rather than a session flash because a
 * flash needs a session write on every redirect, and the redirect target is
 * always a GET the user can safely reload.
 */
export function banner(c) {
    const url = new URL(c.req.url);
    const ok = url.searchParams.get('ok');
    const error = url.searchParams.get('error');
    if (error)
        return _jsx(Alert, { tone: "error", children: error });
    if (ok)
        return _jsx(Alert, { tone: "ok", children: ok });
    return null;
}
/** Redirect carrying a success message. 303 so a reload does not repost. */
export function okRedirect(c, path, message) {
    const sep = path.includes('?') ? '&' : '?';
    return c.redirect(`${path}${sep}ok=${encodeURIComponent(message)}`, 303);
}
export function errRedirect(c, path, message) {
    const sep = path.includes('?') ? '&' : '?';
    return c.redirect(`${path}${sep}error=${encodeURIComponent(message)}`, 303);
}
/** Reads a page number from ?page=, clamped so a hand-typed value cannot break the query. */
export function pageParam(c, pageSize) {
    const raw = Number(new URL(c.req.url).searchParams.get('page') ?? '1');
    const p = Number.isInteger(raw) && raw > 0 ? raw : 1;
    return { page: p, offset: (p - 1) * pageSize, pageSize };
}
export function queryParam(c, name) {
    const v = new URL(c.req.url).searchParams.get(name);
    return v && v.trim() !== '' ? v.trim() : undefined;
}
