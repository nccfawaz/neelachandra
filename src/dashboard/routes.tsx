import { Hono } from 'hono'
import type { AppEnv } from '../types.js'
import { currentUser, currentSession, currentScope } from '../types.js'
import { AppShell } from './layouts/AppShell.js'
import type { Context } from 'hono'
import type { Child } from 'hono/jsx'
import { Alert, DataTable, KpiCard, Panel, type Column } from './components/index.js'
import { requirePermission } from '../middleware/requirePermission.js'
import { PERMISSIONS } from '../lib/permissions.js'
import { loadWidget, widgetByKey, widgetsFor, type WidgetData, type WidgetDef } from './widgets.js'
import { formatPaiseAsRupeesSymbol } from '../lib/money.js'
import { formatDateTime } from '../lib/dates.js'
import { NotFoundError } from '../lib/errors.js'
import { readBody } from '../middleware/csrf.js'
import { banner, okRedirect, errRedirect } from './render.js'
import * as q from '../modules/hr/queries.js'
import * as svc from '../modules/hr/service.js'
import { UnprocessableError, ConflictError } from '../lib/errors.js'

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

const dashboard = new Hono<AppEnv>()

function WidgetBody(props: { data: WidgetData }) {
  const data = props.data
  if (data.kind === 'count') {
    return (
      <>
        <div class="ncc-kpi__value">{data.count}</div>
        {data.hint ? <div class="ncc-kpi__hint">{data.hint}</div> : null}
      </>
    )
  }
  if (data.kind === 'money') {
    return (
      <>
        <div class="ncc-kpi__value">{formatPaiseAsRupeesSymbol(data.paise)}</div>
        {data.hint ? <div class="ncc-kpi__hint">{data.hint}</div> : null}
      </>
    )
  }
  if (data.rows.length === 0) {
    return <p class="ncc-muted">{data.empty}</p>
  }
  return (
    <ul class="ncc-list">
      {data.rows.map((row) => (
        <li class={row.tone ? `ncc-list__item is-${row.tone}` : 'ncc-list__item'}>
          {row.href ? <a href={row.href}>{row.label}</a> : <span>{row.label}</span>}
          <span class="ncc-list__value">{row.value}</span>
        </li>
      ))}
    </ul>
  )
}

function Widget(props: { def: WidgetDef; data: WidgetData }) {
  // A widget spans the full grid width only when its def says so (wide:true),
  // not merely because it renders rows. This is what keeps the panel grid on a
  // fixed two-column rhythm instead of every rows-widget claiming a whole row
  // (DECISIONS 40, item B).
  const wide = props.def.wide === true
  return (
    <section class={wide ? 'ncc-card ncc-card--wide' : 'ncc-card'}>
      <p class="ncc-kpi__label">{props.def.title}</p>
      <WidgetBody data={props.data} />
    </section>
  )
}

dashboard.get('/app', requirePermission(PERMISSIONS.DASHBOARD_VIEW_OWN_KPI), async (c) => {
  const user = currentUser(c)
  const session = currentSession(c)
  const perms = c.get('perms')
  const db = c.get('db')

  const defs = widgetsFor(perms)
  const ctx = {
    db,
    userId: user.id,
    employeeId: user.employeeId,
    perms,
    scope: currentScope(c),
  }

  // Settled, not all: one widget whose query fails must not blank the whole
  // dashboard. A failed widget says so in place and the rest still render.
  const results = await Promise.allSettled(defs.map((def) => loadWidget(def.key, ctx)))

  const rendered = defs.map((def, i) => {
    const result = results[i]
    if (result && result.status === 'fulfilled') return { def, data: result.value }
    console.error(`[dashboard] widget ${def.key} failed`, result?.status === 'rejected' ? result.reason : null)
    return {
      def,
      data: { kind: 'rows' as const, rows: [], empty: 'This panel could not be loaded.' },
    }
  })

  const kpis = rendered.filter((r) => r.data.kind !== 'rows')
  const allPanels = rendered.filter((r) => r.data.kind === 'rows')
  // Actions come before counts (DECISIONS 40, item B): the one queue a person
  // acts on today — "Waiting on you" (pending_approvals) — leads, beside the
  // check-in/out control. Every count is 0 and will be for weeks, so the tiles
  // sit below the things that need a hand.
  const actionPanels = allPanels.filter((r) => r.def.key === 'pending_approvals')
  const panels = allPanels.filter((r) => r.def.key !== 'pending_approvals')

  const unread = await db
    .selectFrom('notifications')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('user_id', '=', user.id)
    .where('read_at', 'is', null)
    .executeTakeFirst()
  const unreadCount = Number(unread?.n ?? 0)
  const checkinPanelHtml = await checkinPanel(c)

  return c.html(
    <AppShell
      title="Dashboard"
      user={user}
      perms={perms}
      csrfToken={session.csrfToken}
      path="/app"
      clients={checkinPanelHtml ? ['checkin-geo'] : undefined}
      subtitle={greeting(user.fullName)}
    >
      {/* Check-in/out results 303 back here with ?ok=/?error= (DECISIONS
          36.x). This is the only screen every staff role sees, so an
          unrendered error here is a silent failure -- render the flash like
          every other module route does. */}
      {banner(c)}

      {unreadCount > 0 ? (
        <Alert tone="warn">
          You have {unreadCount} unread {unreadCount === 1 ? 'notification' : 'notifications'}.{' '}
          <a href="/app/notifications">Open them</a>.
        </Alert>
      ) : null}

      {defs.length === 0 ? (
        <Alert tone="warn">
          Your account has no dashboard permissions yet. An administrator needs to assign you a role.
        </Alert>
      ) : null}

      {/* Actions first (DECISIONS 40, item B): the check-in/out control and the
          approval queue are the two things a person came here to act on. The
          KPI counts, all zero for now, sit below them. */}
      {checkinPanelHtml}

      {actionPanels.length > 0 ? (
        <div class="ncc-grid ncc-grid--2">
          {actionPanels.map((r) => (
            <Widget def={r.def} data={r.data} />
          ))}
        </div>
      ) : null}

      {kpis.length > 0 ? (
        <div class="ncc-grid ncc-grid--kpi">
          {kpis.map((r) => (
            <Widget def={r.def} data={r.data} />
          ))}
        </div>
      ) : null}

      {panels.length > 0 ? (
        <div class="ncc-grid ncc-grid--2">
          {panels.map((r) => (
            <Widget def={r.def} data={r.data} />
          ))}
        </div>
      ) : null}
    </AppShell>
  )
})

function greeting(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? name
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }).format(new Date())
  )
  const part = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
  return `${part}, ${first}.`
}

/** The per-widget fragment endpoint, for a widget that needs lazy loading. */
dashboard.get('/api/dashboard/widget/:key', requirePermission(PERMISSIONS.DASHBOARD_VIEW_OWN_KPI), async (c) => {
  const def = widgetByKey(c.req.param('key'))
  const perms = c.get('perms')
  // An unknown key and a key the caller may not see are the same answer, so
  // the endpoint cannot be used to enumerate which widgets exist.
  if (!def || !def.perms.some((p) => perms.has(p))) throw new NotFoundError('No such widget.')

  const user = currentUser(c)
  const data = await loadWidget(def.key, {
    db: c.get('db'),
    userId: user.id,
    employeeId: user.employeeId,
    perms,
    scope: currentScope(c),
  })
  return c.html(<Widget def={def} data={data} />)
})

/* Notifications ----------------------------------------------------------- */

interface NotificationRow {
  id: number
  kind: string
  title: string
  body: string | null
  link_path: string | null
  severity: 'info' | 'warn' | 'critical'
  read_at: string | null
  created_at: string
}

dashboard.get('/app/notifications', requirePermission(PERMISSIONS.DASHBOARD_VIEW_OWN_KPI), async (c) => {
  const user = currentUser(c)
  const session = currentSession(c)

  const rows = await c
    .get('db')
    .selectFrom('notifications')
    .select(['id', 'kind', 'title', 'body', 'link_path', 'severity', 'read_at', 'created_at'])
    .where('user_id', '=', user.id)
    .orderBy('created_at', 'desc')
    .limit(100)
    .execute()

  const columns: Column<NotificationRow>[] = [
    {
      header: 'When',
      cell: (row) => <span class="ncc-muted">{formatDateTime(row.created_at)}</span>,
    },
    {
      header: 'Notification',
      cell: (row) => (
        <>
          <strong>{row.link_path ? <a href={row.link_path}>{row.title}</a> : row.title}</strong>
          {row.body ? <div class="ncc-muted">{row.body}</div> : null}
        </>
      ),
    },
    {
      header: 'Status',
      cell: (row) => (row.read_at ? <span class="ncc-muted">Read</span> : <strong>Unread</strong>),
    },
  ]

  return c.html(
    <AppShell
      title="Notifications"
      user={user}
      perms={c.get('perms')}
      csrfToken={session.csrfToken}
      path="/app/notifications"
      actions={
        <form method="post" action="/app/notifications/read-all">
          <input type="hidden" name="nc_csrf" value={session.csrfToken} />
          <button class="ncc-btn" type="submit">
            Mark all read
          </button>
        </form>
      }
    >
      <Panel title="Recent">
        <DataTable
          columns={columns}
          rows={rows as unknown as NotificationRow[]}
          empty="Nothing here yet. Notifications appear when something needs your attention."
        />
      </Panel>
    </AppShell>
  )
})

dashboard.post('/app/notifications/read-all', requirePermission(PERMISSIONS.DASHBOARD_VIEW_OWN_KPI), async (c) => {
  const user = currentUser(c)
  await c
    .get('db')
    .updateTable('notifications')
    .set({ read_at: new Date().toISOString().slice(0, 19).replace('T', ' ') })
    .where('user_id', '=', user.id)
    .where('read_at', 'is', null)
    .execute()
  return c.redirect('/app/notifications', 303)
})

dashboard.post('/api/notifications/:id/read', requirePermission(PERMISSIONS.DASHBOARD_VIEW_OWN_KPI), async (c) => {
  const user = currentUser(c)
  await readBody(c)
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) throw new NotFoundError('No such notification.')

  // Scoped to the caller's own rows, so an id from someone else's list is a
  // no-op rather than a cross-user write.
  await c
    .get('db')
    .updateTable('notifications')
    .set({ read_at: new Date().toISOString().slice(0, 19).replace('T', ' ') })
    .where('id', '=', id)
    .where('user_id', '=', user.id)
    .execute()
  return c.body(null, 204)
})

export default dashboard

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
async function checkinPanel(c: Context<AppEnv>) {
  const user = currentUser(c)
  const db = c.get('db')
  if (user.employeeId === null) return null
  const csrfToken = currentSession(c).csrfToken

  const [day, sites] = await Promise.all([q.selfDay(db, user.id), q.checkinSiteOptions(db)])
  const checkedIn = day?.checkin_at != null
  const checkedOut = day?.checkout_at != null

  /* The plain-language confirmation of the LAST press (DECISIONS 31.13).
   * A stored coordinate means "Location recorded" with the time of that
   * press; a timestamp with NULLs means the device gave nothing, so the
   * line says so and the attendance stands. The handlers set ?loc= from
   * what they stored; without it the line stays off (a first visit, a
   * no-JS post, an error redirect). */
  const loc = new URL(c.req.url).searchParams.get('loc')
  let locConfirmHtml: Child | null = null
  if (checkedIn && loc === 'stored' && day?.checkin_lat != null && day?.checkin_lng != null) {
    locConfirmHtml = (
      <p class="ncc-checkin-confirm" role="status">
        Location recorded at {formatDateTime(day.checkin_at)}
      </p>
    )
  } else if (loc === 'unavailable') {
    locConfirmHtml = (
      <p class="ncc-checkin-confirm" role="status">
        {checkedOut ? 'Checked out' : 'Checked in'} — location unavailable. Your attendance stands;
        the row is marked so HR can follow up if the site matters.
      </p>
    )
  }

  return (
    <section class="ncc-card ncc-card--wide">
      <p class="ncc-kpi__label">Site attendance — {formatDateTime(new Date().toISOString())}</p>

      {sites.length === 0 ? (
        <p class="ncc-muted">
          No check-in sites are configured yet: an office location of type "office" or an active project with
          coordinates (projects.geo_lat / geo_lng) puts a site in this list.
        </p>
      ) : (
        <form method="post" action="/app/attendance/checkin" class="ncc-inline-form">
          <input type="hidden" name="nc_csrf" value={csrfToken} />
          <input type="hidden" name="lat" value="" />
          <input type="hidden" name="lng" value="" />
          {/* Exactly one action shows at a time (DECISIONS 31.11): the button
              is the whole screen, and two equal buttons invite the wrong
              press. The check-in time, once it exists, is the status line. */}
          {checkedIn ? (
            <p class="ncc-checkin-time">
              Checked in at {day?.checkin_at}
              {checkedOut ? <> · checked out at {day?.checkout_at}</> : null}
            </p>
          ) : (
            <label class="ncc-field">
              Site
              {/* No option is preselected: the first entry is an empty
                  placeholder, so a worker chooses Office or Site DELIBERATELY
                  rather than silently accepting whatever happened to sort
                  first. It is intentionally NOT `disabled` (the HTML reset
                  algorithm would then skip it and preselect the first real
                  option, defeating the point) and intentionally NOT `required`
                  (a forgotten choice must reach the server and come back as a
                  VISIBLE error banner on /app, which also covers the no-JS
                  post -- the empty siteKey is rejected by checkPostOf and
                  errRedirect renders it). */}
              <select name="siteKey">
                <option value="" selected>
                  Choose a site…
                </option>
                {sites.map((s) => (
                  <option value={s.key}>{s.label}</option>
                ))}
              </select>
            </label>
          )}
          {/* Which thing actually happened at the last press (31.13): the
              reading either landed or it did not. `?loc=` is set by the
              check-in/check-out handlers from the outcome they stored, so
              the worker knows without asking anyone. A plain ?ok= flash
              (e.g. from a no-JS post without the param) is unaffected. */}
          {checkedOut ? null : checkedIn ? (
            <button type="submit" class="ncc-checkin-btn" formaction="/app/attendance/checkout">
              Check out
            </button>
          ) : (
            <button type="submit" class="ncc-checkin-btn">
              Check in
            </button>
          )}
          {locConfirmHtml}
        </form>
      )}

      <p class="ncc-checkin-note">
        Location is recorded when you press the button — at check-in and check-out only.
        Your position is not tracked at any other time.
      </p>
    </section>
  )
}

interface CheckPost {
  siteKey: string | null
  reading: { lat: number; lng: number } | null
}

async function checkPostOf(c: Context<AppEnv>): Promise<CheckPost> {
  const body = await readBody(c)
  // Only the CHECK-IN form carries the site dropdown. The check-out form
  // posts no siteKey at all -- the site was chosen at check-in and is read
  // back from the attendance row by the service (DECISIONS 31.12). A siteKey
  // on a check-out post is accepted and ignored, so a stale cached form
  // cannot break the post.
  const rawSiteKey = typeof body['siteKey'] === 'string' ? body['siteKey'] : ''
  // The generic 'site' default (DECISIONS 36.1) plus the addressed forms
  // office:N / project:N. 'site' is what the dropdown submits on a plain
  // check-in press, so it MUST be accepted here or the common path 303s to
  // /app?error= (DECISIONS 36.x). resolveCheckinSite/selfCheckIn already
  // understand all three.
  const siteKey = rawSiteKey === 'site' || /^(office|project):\d+$/.test(rawSiteKey) ? rawSiteKey : null
  // A missing, blank, or failed position ("0", "0,0", garbage) is a reading
  // of "unavailable", not a refusal and not a coordinate: the client script
  // fills these from navigator.geolocation when the worker grants it, and a
  // denied prompt or a dead GPS submits empty strings. The service stores
  // NULL and the row's flag records the gap (DECISIONS 31); the check-in
  // itself always stands.
  const rawLat = typeof body['lat'] === 'string' ? body['lat'].trim() : ''
  const rawLng = typeof body['lng'] === 'string' ? body['lng'].trim() : ''
  const lat = Number(rawLat)
  const lng = Number(rawLng)
  const reading =
    rawLat === '' || rawLng === '' || Number.isNaN(lat) || Number.isNaN(lng)
      ? null
      : { lat, lng }
  return { siteKey, reading }
}

const employeeIdOf = async (c: Context<AppEnv>): Promise<number> => {
  const employeeId = currentUser(c).employeeId
  if (employeeId === null) {
    throw new UnprocessableError(
      'Your login is not linked to an employee record. Ask HR to link them before checking in.'
    )
  }
  return employeeId
}

const checkinMessage = (r: ReturnType<typeof svc.selfCheckIn> extends Promise<infer T> ? T : never): string =>
  r.outcome === 'unavailable'
    ? 'Checked in. No position was available from your device, so the reading is marked unavailable — your attendance stands.'
    : r.outcome === 'far'
      ? 'Checked in. The reading was far from the site, so it has been flagged for HR review — your attendance stands.'
      : 'Checked in.'
// 'recorded' (36.1) is a good reading against the generic Site: nothing was
// flagged, so the plain success line is the honest one — the ?loc=stored
// param already tells the panel to show "Location recorded".

/* Which of the two things the worker needs to know happened (31.13): the
 * reading was stored, or it was not. Travels as ?loc= so the panel itself
 * can render the confirmation beside the button, where the eye already is. */
const locParamOf = (r: { outcome: string }): string => (r.outcome === 'unavailable' ? 'unavailable' : 'stored')

const checkoutMessage = (r: Awaited<ReturnType<typeof svc.selfCheckOut>>): string =>
  r.outcome === 'unavailable'
    ? 'Checked out. No position was available from your device, so the reading is marked unavailable — your attendance stands.'
    : r.outcome === 'far'
      ? 'Checked out. The reading was far from the site, so it has been flagged for HR review — your attendance stands.'
      : 'Checked out.'

dashboard.post('/app/attendance/checkin', requirePermission(PERMISSIONS.DASHBOARD_VIEW_OWN_KPI), async (c) => {
  const post = await checkPostOf(c)
  try {
    if (post.siteKey === null) {
      throw new UnprocessableError('Choose the site you are checking in at.')
    }
    const result = await svc.selfCheckIn(c.get('db'), actorOf(c), {
      employeeId: await employeeIdOf(c),
      siteKey: post.siteKey,
      reading: post.reading,
    })
    return okRedirect(c, `/app?loc=${locParamOf(result)}`, checkinMessage(result))
  } catch (err) {
    if (err instanceof UnprocessableError || err instanceof ConflictError) {
      return errRedirect(c, '/app', err.message)
    }
    throw err
  }
})

dashboard.post('/app/attendance/checkout', requirePermission(PERMISSIONS.DASHBOARD_VIEW_OWN_KPI), async (c) => {
  const post = await checkPostOf(c)
  try {
    const result = await svc.selfCheckOut(c.get('db'), actorOf(c), {
      employeeId: await employeeIdOf(c),
      reading: post.reading,
    })
    return okRedirect(c, `/app?loc=${locParamOf(result)}`, checkoutMessage(result))
  } catch (err) {
    if (err instanceof UnprocessableError || err instanceof ConflictError) {
      return errRedirect(c, '/app', err.message)
    }
    throw err
  }
})

function actorOf(c: Context<AppEnv>): svc.Actor {
  return { userId: currentUser(c).id, ip: c.get('clientIp') }
}
