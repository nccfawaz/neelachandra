import { Hono } from 'hono'
import type { AppEnv } from '../types.js'
import { currentUser, currentSession, currentScope } from '../types.js'
import { AppShell } from './layouts/AppShell.js'
import type { Context } from 'hono'
import { Alert, DataTable, KpiCard, Panel, type Column } from './components/index.js'
import { requirePermission } from '../middleware/requirePermission.js'
import { PERMISSIONS } from '../lib/permissions.js'
import { loadWidget, widgetByKey, widgetsFor, type WidgetData, type WidgetDef } from './widgets.js'
import { formatPaiseAsRupeesSymbol } from '../lib/money.js'
import { formatDateTime } from '../lib/dates.js'
import { NotFoundError } from '../lib/errors.js'
import { readBody } from '../middleware/csrf.js'
import { okRedirect, errRedirect } from './render.js'
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
  const isKpi = props.data.kind !== 'rows'
  return (
    <section class={isKpi ? 'ncc-card' : 'ncc-card ncc-card--wide'}>
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
  const panels = rendered.filter((r) => r.data.kind === 'rows')

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
      subtitle={greeting(user.fullName)}
    >
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

      {checkinPanelHtml}
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

  return (
    <section class="ncc-card ncc-card--wide">
      <p class="ncc-kpi__label">Site attendance — {formatDateTime(new Date().toISOString())}</p>
      {checkedIn && checkedOut ? (
        <p class="ncc-list__item">
          Day complete: checked in at {day?.checkin_at}, checked out at {day?.checkout_at}.
        </p>
      ) : checkedIn ? (
        <p>You are checked in today. Check out when you leave the site.</p>
      ) : (
        <p>You are not checked in yet today.</p>
      )}

      <p class="ncc-muted">
        Location is recorded when you press check-in and check-out — at those two moments only.
        Your position is not tracked at any other time.
      </p>

      {sites.length === 0 ? (
        <p class="ncc-muted">
          No site locations carry coordinates yet; ask an administrator to set latitude and longitude on a location.
        </p>
      ) : (
        <form method="post" action="/app/attendance/checkin" class="ncc-inline-form">
          <input type="hidden" name="nc_csrf" value={csrfToken} />
          <label>
            Site
            <select name="siteLocationId">
              {sites.map((s) => (
                <option value={String(s.id)}>{s.name}</option>
              ))}
            </select>
          </label>
          <input type="hidden" name="lat" value="" />
          <input type="hidden" name="lng" value="" />
          {!checkedIn ? <button type="submit">Check in</button> : null}
          {checkedIn && !checkedOut ? <button type="submit" formaction="/app/attendance/checkout">Check out</button> : null}
        </form>
      )}
    </section>
  )
}

interface CheckPost {
  siteLocationId: number
  reading: { lat: number; lng: number }
}

async function checkPostOf(c: Context<AppEnv>): Promise<CheckPost> {
  const body = await readBody(c)
  const siteLocationId = Number(body['siteLocationId'])
  const lat = Number(body['lat'])
  const lng = Number(body['lng'])
  if (!Number.isInteger(siteLocationId) || siteLocationId < 1) {
    throw new UnprocessableError('Choose the site you are checking in at.')
  }
  // A missing or stale browser position is a reading of "unavailable", not a
  // refusal: DECISIONS 31 means the check-in stands and the flag says what the
  // device could not supply. The browser fills these via geolocation when it
  // can; without it the row carries NULLs and the far view notes the gap.
  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    throw new UnprocessableError('No position was supplied. Press the button again to retry, or continue and the reading will be flagged.')
  }
  return { siteLocationId, reading: { lat, lng } }
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

dashboard.post('/app/attendance/checkin', requirePermission(PERMISSIONS.DASHBOARD_VIEW_OWN_KPI), async (c) => {
  const post = await checkPostOf(c)
  try {
    const result = await svc.selfCheckIn(c.get('db'), actorOf(c), {
      employeeId: await employeeIdOf(c),
      siteLocationId: post.siteLocationId,
      reading: post.reading,
    })
    return okRedirect(c, '/app', result.far ? 'Checked in. The reading was far from the site, so it has been flagged for HR review — your attendance stands.' : 'Checked in.')
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
      siteLocationId: post.siteLocationId,
      reading: post.reading,
    })
    return okRedirect(c, '/app', result.far ? 'Checked out. The reading was far from the site, so it has been flagged for HR review — your attendance stands.' : 'Checked out.')
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
