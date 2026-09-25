import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "hono/jsx/jsx-runtime";
import { Hono } from 'hono';
import { currentUser, currentSession, currentScope } from '../types.js';
import { AppShell } from './layouts/AppShell.js';
import { Alert, DataTable, KpiCard, Panel } from './components/index.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { PERMISSIONS } from '../lib/permissions.js';
import { loadWidget, widgetByKey, widgetsFor } from './widgets.js';
import { formatPaiseAsRupeesSymbol } from '../lib/money.js';
import { formatDateTime } from '../lib/dates.js';
import { NotFoundError } from '../lib/errors.js';
import { readBody } from '../middleware/csrf.js';
import { okRedirect, errRedirect } from './render.js';
import * as q from '../modules/hr/queries.js';
import * as svc from '../modules/hr/service.js';
import { UnprocessableError, ConflictError } from '../lib/errors.js';
/**
 * The landing dashboard and the notification list (spec 6.2).
 *
 * Widgets render server side on first paint rather than as htmx holes that
 * fill in afterwards. The spec's reason for independent loading was that one
 * slow query must not block the page; these are all indexed lookups against
 * a ten-user dataset, and a page that visibly assembles itself in six steps
 * is worse than one that arrives complete. The per-widget endpoint exists
 * anyway, so a widget that turns out slow can be moved to lazy loading by
 * changing one attribute rather than restructuring the page.
 */
const dashboard = new Hono();
function WidgetBody(props) {
    const data = props.data;
    if (data.kind === 'count') {
        return (_jsxs(_Fragment, { children: [_jsx("div", { class: "ncc-kpi__value", children: data.count }), data.hint ? _jsx("div", { class: "ncc-kpi__hint", children: data.hint }) : null] }));
    }
    if (data.kind === 'money') {
        return (_jsxs(_Fragment, { children: [_jsx("div", { class: "ncc-kpi__value", children: formatPaiseAsRupeesSymbol(data.paise) }), data.hint ? _jsx("div", { class: "ncc-kpi__hint", children: data.hint }) : null] }));
    }
    if (data.rows.length === 0) {
        return _jsx("p", { class: "ncc-muted", children: data.empty });
    }
    return (_jsx("ul", { class: "ncc-list", children: data.rows.map((row) => (_jsxs("li", { class: row.tone ? `ncc-list__item is-${row.tone}` : 'ncc-list__item', children: [row.href ? _jsx("a", { href: row.href, children: row.label }) : _jsx("span", { children: row.label }), _jsx("span", { class: "ncc-list__value", children: row.value })] }))) }));
}
function Widget(props) {
    const isKpi = props.data.kind !== 'rows';
    return (_jsxs("section", { class: isKpi ? 'ncc-card' : 'ncc-card ncc-card--wide', children: [_jsx("p", { class: "ncc-kpi__label", children: props.def.title }), _jsx(WidgetBody, { data: props.data })] }));
}
dashboard.get('/app', requirePermission(PERMISSIONS.DASHBOARD_VIEW_OWN_KPI), async (c) => {
    const user = currentUser(c);
    const session = currentSession(c);
    const perms = c.get('perms');
    const db = c.get('db');
    const defs = widgetsFor(perms);
    const ctx = {
        db,
        userId: user.id,
        employeeId: user.employeeId,
        perms,
        scope: currentScope(c),
    };
    // Settled, not all: one widget whose query fails must not blank the whole
    // dashboard. A failed widget says so in place and the rest still render.
    const results = await Promise.allSettled(defs.map((def) => loadWidget(def.key, ctx)));
    const rendered = defs.map((def, i) => {
        const result = results[i];
        if (result && result.status === 'fulfilled')
            return { def, data: result.value };
        console.error(`[dashboard] widget ${def.key} failed`, result?.status === 'rejected' ? result.reason : null);
        return {
            def,
            data: { kind: 'rows', rows: [], empty: 'This panel could not be loaded.' },
        };
    });
    const kpis = rendered.filter((r) => r.data.kind !== 'rows');
    const panels = rendered.filter((r) => r.data.kind === 'rows');
    const unread = await db
        .selectFrom('notifications')
        .select((eb) => eb.fn.countAll().as('n'))
        .where('user_id', '=', user.id)
        .where('read_at', 'is', null)
        .executeTakeFirst();
    const unreadCount = Number(unread?.n ?? 0);
    const checkinPanelHtml = await checkinPanel(c);
    return c.html(_jsxs(AppShell, { title: "Dashboard", user: user, perms: perms, csrfToken: session.csrfToken, path: "/app", clients: checkinPanelHtml ? ['checkin-geo'] : undefined, subtitle: greeting(user.fullName), children: [unreadCount > 0 ? (_jsxs(Alert, { tone: "warn", children: ["You have ", unreadCount, " unread ", unreadCount === 1 ? 'notification' : 'notifications', ".", ' ', _jsx("a", { href: "/app/notifications", children: "Open them" }), "."] })) : null, defs.length === 0 ? (_jsx(Alert, { tone: "warn", children: "Your account has no dashboard permissions yet. An administrator needs to assign you a role." })) : null, kpis.length > 0 ? (_jsx("div", { class: "ncc-grid ncc-grid--kpi", children: kpis.map((r) => (_jsx(Widget, { def: r.def, data: r.data }))) })) : null, panels.length > 0 ? (_jsx("div", { class: "ncc-grid ncc-grid--2", children: panels.map((r) => (_jsx(Widget, { def: r.def, data: r.data }))) })) : null, checkinPanelHtml] }));
});
function greeting(name) {
    const first = name.trim().split(/\s+/)[0] ?? name;
    const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }).format(new Date()));
    const part = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    return `${part}, ${first}.`;
}
/** The per-widget fragment endpoint, for a widget that needs lazy loading. */
dashboard.get('/api/dashboard/widget/:key', requirePermission(PERMISSIONS.DASHBOARD_VIEW_OWN_KPI), async (c) => {
    const def = widgetByKey(c.req.param('key'));
    const perms = c.get('perms');
    // An unknown key and a key the caller may not see are the same answer, so
    // the endpoint cannot be used to enumerate which widgets exist.
    if (!def || !def.perms.some((p) => perms.has(p)))
        throw new NotFoundError('No such widget.');
    const user = currentUser(c);
    const data = await loadWidget(def.key, {
        db: c.get('db'),
        userId: user.id,
        employeeId: user.employeeId,
        perms,
        scope: currentScope(c),
    });
    return c.html(_jsx(Widget, { def: def, data: data }));
});
dashboard.get('/app/notifications', requirePermission(PERMISSIONS.DASHBOARD_VIEW_OWN_KPI), async (c) => {
    const user = currentUser(c);
    const session = currentSession(c);
    const rows = await c
        .get('db')
        .selectFrom('notifications')
        .select(['id', 'kind', 'title', 'body', 'link_path', 'severity', 'read_at', 'created_at'])
        .where('user_id', '=', user.id)
        .orderBy('created_at', 'desc')
        .limit(100)
        .execute();
    const columns = [
        {
            header: 'When',
            cell: (row) => _jsx("span", { class: "ncc-muted", children: formatDateTime(row.created_at) }),
        },
        {
            header: 'Notification',
            cell: (row) => (_jsxs(_Fragment, { children: [_jsx("strong", { children: row.link_path ? _jsx("a", { href: row.link_path, children: row.title }) : row.title }), row.body ? _jsx("div", { class: "ncc-muted", children: row.body }) : null] })),
        },
        {
            header: 'Status',
            cell: (row) => (row.read_at ? _jsx("span", { class: "ncc-muted", children: "Read" }) : _jsx("strong", { children: "Unread" })),
        },
    ];
    return c.html(_jsx(AppShell, { title: "Notifications", user: user, perms: c.get('perms'), csrfToken: session.csrfToken, path: "/app/notifications", actions: _jsxs("form", { method: "post", action: "/app/notifications/read-all", children: [_jsx("input", { type: "hidden", name: "nc_csrf", value: session.csrfToken }), _jsx("button", { class: "ncc-btn", type: "submit", children: "Mark all read" })] }), children: _jsx(Panel, { title: "Recent", children: _jsx(DataTable, { columns: columns, rows: rows, empty: "Nothing here yet. Notifications appear when something needs your attention." }) }) }));
});
dashboard.post('/app/notifications/read-all', requirePermission(PERMISSIONS.DASHBOARD_VIEW_OWN_KPI), async (c) => {
    const user = currentUser(c);
    await c
        .get('db')
        .updateTable('notifications')
        .set({ read_at: new Date().toISOString().slice(0, 19).replace('T', ' ') })
        .where('user_id', '=', user.id)
        .where('read_at', 'is', null)
        .execute();
    return c.redirect('/app/notifications', 303);
});
dashboard.post('/api/notifications/:id/read', requirePermission(PERMISSIONS.DASHBOARD_VIEW_OWN_KPI), async (c) => {
    const user = currentUser(c);
    await readBody(c);
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0)
        throw new NotFoundError('No such notification.');
    // Scoped to the caller's own rows, so an id from someone else's list is a
    // no-op rather than a cross-user write.
    await c
        .get('db')
        .updateTable('notifications')
        .set({ read_at: new Date().toISOString().slice(0, 19).replace('T', ' ') })
        .where('id', '=', id)
        .where('user_id', '=', user.id)
        .execute();
    return c.body(null, 204);
});
export default dashboard;
/* Site check-in / check-out (DECISIONS 31) -------------------------------- */
/**
 * The own-day panel on the landing dashboard.
 *
 * Both buttons live here, on the first screen after login, rendered server
 * side with no client component: a check-in is a form post and a form post
 * works without JavaScript, which is the same rule the attendance grid holds
 * itself to.
 *
 * The on-page statement is part of the decision, not decoration: the panel
 * says, in prose, that location is captured at check-in and check-out only and
 * never tracked in between. A worker's consent to one measurement is informed
 * consent; silence about continuous tracking is not.
 *
 * The panel renders for any user whose login is linked to an employee record.
 * The muster-excluded owner sees the panel too, but his posts are refused by
 * name in the service -- the exclusion is a write gate, not a missing button.
 */
async function checkinPanel(c) {
    const user = currentUser(c);
    const db = c.get('db');
    if (user.employeeId === null)
        return null;
    const csrfToken = currentSession(c).csrfToken;
    const [day, sites] = await Promise.all([q.selfDay(db, user.id), q.checkinSiteOptions(db)]);
    const checkedIn = day?.checkin_at != null;
    const checkedOut = day?.checkout_at != null;
    /* The plain-language confirmation of the LAST press (DECISIONS 31.13).
     * A stored coordinate means "Location recorded" with the time of that
     * press; a timestamp with NULLs means the device gave nothing, so the
     * line says so and the attendance stands. The handlers set ?loc= from
     * what they stored; without it the line stays off (a first visit, a
     * no-JS post, an error redirect). */
    const loc = new URL(c.req.url).searchParams.get('loc');
    let locConfirmHtml = null;
    if (checkedIn && loc === 'stored' && day?.checkin_lat != null && day?.checkin_lng != null) {
        locConfirmHtml = (_jsxs("p", { class: "ncc-checkin-confirm", role: "status", children: ["Location recorded at ", formatDateTime(day.checkin_at)] }));
    }
    else if (loc === 'unavailable') {
        locConfirmHtml = (_jsxs("p", { class: "ncc-checkin-confirm", role: "status", children: [checkedOut ? 'Checked out' : 'Checked in', " \u2014 location unavailable. Your attendance stands; the row is marked so HR can follow up if the site matters."] }));
    }
    return (_jsxs("section", { class: "ncc-card ncc-card--wide", children: [_jsxs("p", { class: "ncc-kpi__label", children: ["Site attendance \u2014 ", formatDateTime(new Date().toISOString())] }), sites.length === 0 ? (_jsx("p", { class: "ncc-muted", children: "No check-in sites are configured yet: an office location of type \"office\" or an active project with coordinates (projects.geo_lat / geo_lng) puts a site in this list." })) : (_jsxs("form", { method: "post", action: "/app/attendance/checkin", class: "ncc-inline-form", children: [_jsx("input", { type: "hidden", name: "nc_csrf", value: csrfToken }), _jsx("input", { type: "hidden", name: "lat", value: "" }), _jsx("input", { type: "hidden", name: "lng", value: "" }), checkedIn ? (_jsxs("p", { class: "ncc-checkin-time", children: ["Checked in at ", day?.checkin_at, checkedOut ? _jsxs(_Fragment, { children: [" \u00B7 checked out at ", day?.checkout_at] }) : null] })) : (_jsxs("label", { class: "ncc-field", children: ["Site", _jsx("select", { name: "siteKey", children: sites.map((s) => (_jsx("option", { value: s.key, children: s.label }))) })] })), checkedOut ? null : checkedIn ? (_jsx("button", { type: "submit", class: "ncc-checkin-btn", formaction: "/app/attendance/checkout", children: "Check out" })) : (_jsx("button", { type: "submit", class: "ncc-checkin-btn", children: "Check in" })), locConfirmHtml] })), _jsx("p", { class: "ncc-checkin-note", children: "Location is recorded when you press the button \u2014 at check-in and check-out only. Your position is not tracked at any other time." })] }));
}
async function checkPostOf(c) {
    const body = await readBody(c);
    // Only the CHECK-IN form carries the site dropdown. The check-out form
    // posts no siteKey at all -- the site was chosen at check-in and is read
    // back from the attendance row by the service (DECISIONS 31.12). A siteKey
    // on a check-out post is accepted and ignored, so a stale cached form
    // cannot break the post.
    const rawSiteKey = typeof body['siteKey'] === 'string' ? body['siteKey'] : '';
    const siteKey = /^(office|project):\d+$/.test(rawSiteKey) ? rawSiteKey : null;
    // A missing, blank, or failed position ("0", "0,0", garbage) is a reading
    // of "unavailable", not a refusal and not a coordinate: the client script
    // fills these from navigator.geolocation when the worker grants it, and a
    // denied prompt or a dead GPS submits empty strings. The service stores
    // NULL and the row's flag records the gap (DECISIONS 31); the check-in
    // itself always stands.
    const rawLat = typeof body['lat'] === 'string' ? body['lat'].trim() : '';
    const rawLng = typeof body['lng'] === 'string' ? body['lng'].trim() : '';
    const lat = Number(rawLat);
    const lng = Number(rawLng);
    const reading = rawLat === '' || rawLng === '' || Number.isNaN(lat) || Number.isNaN(lng)
        ? null
        : { lat, lng };
    return { siteKey, reading };
}
const employeeIdOf = async (c) => {
    const employeeId = currentUser(c).employeeId;
    if (employeeId === null) {
        throw new UnprocessableError('Your login is not linked to an employee record. Ask HR to link them before checking in.');
    }
    return employeeId;
};
const checkinMessage = (r) => r.outcome === 'unavailable'
    ? 'Checked in. No position was available from your device, so the reading is marked unavailable — your attendance stands.'
    : r.outcome === 'far'
        ? 'Checked in. The reading was far from the site, so it has been flagged for HR review — your attendance stands.'
        : 'Checked in.';
/* Which of the two things the worker needs to know happened (31.13): the
 * reading was stored, or it was not. Travels as ?loc= so the panel itself
 * can render the confirmation beside the button, where the eye already is. */
const locParamOf = (r) => (r.outcome === 'unavailable' ? 'unavailable' : 'stored');
const checkoutMessage = (r) => r.outcome === 'unavailable'
    ? 'Checked out. No position was available from your device, so the reading is marked unavailable — your attendance stands.'
    : r.outcome === 'far'
        ? 'Checked out. The reading was far from the site, so it has been flagged for HR review — your attendance stands.'
        : 'Checked out.';
dashboard.post('/app/attendance/checkin', requirePermission(PERMISSIONS.DASHBOARD_VIEW_OWN_KPI), async (c) => {
    const post = await checkPostOf(c);
    try {
        if (post.siteKey === null) {
            throw new UnprocessableError('Choose the site you are checking in at.');
        }
        const result = await svc.selfCheckIn(c.get('db'), actorOf(c), {
            employeeId: await employeeIdOf(c),
            siteKey: post.siteKey,
            reading: post.reading,
        });
        return okRedirect(c, `/app?loc=${locParamOf(result)}`, checkinMessage(result));
    }
    catch (err) {
        if (err instanceof UnprocessableError || err instanceof ConflictError) {
            return errRedirect(c, '/app', err.message);
        }
        throw err;
    }
});
dashboard.post('/app/attendance/checkout', requirePermission(PERMISSIONS.DASHBOARD_VIEW_OWN_KPI), async (c) => {
    const post = await checkPostOf(c);
    try {
        const result = await svc.selfCheckOut(c.get('db'), actorOf(c), {
            employeeId: await employeeIdOf(c),
            reading: post.reading,
        });
        return okRedirect(c, `/app?loc=${locParamOf(result)}`, checkoutMessage(result));
    }
    catch (err) {
        if (err instanceof UnprocessableError || err instanceof ConflictError) {
            return errRedirect(c, '/app', err.message);
        }
        throw err;
    }
});
function actorOf(c) {
    return { userId: currentUser(c).id, ip: c.get('clientIp') };
}
