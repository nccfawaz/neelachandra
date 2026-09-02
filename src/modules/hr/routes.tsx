import { Hono } from 'hono'
import type { AppEnv } from '../../types.js'
import { page, banner } from '../../dashboard/render.js'
import { Alert, KpiCard, Panel } from '../../dashboard/components/index.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { PERMISSIONS } from '../../lib/permissions.js'

/**
 * Hr module routes.
 *
 * The schema, the permission keys and the navigation for this module are
 * complete and live. The transactional screens are the next build phase, so
 * every route below is mounted, guarded by the same permission its sidebar
 * item names, and reports the real row count from its primary table. That
 * preserves the invariant the navigation depends on: a link the user can see
 * is a link that neither 404s nor 403s.
 */

const hr = new Hono<AppEnv>()

hr.get('/app/hr/employees', requirePermission(PERMISSIONS.HR_EMPLOYEE_VIEW), async (c) => {
  const db = c.get('db')
  const row = await db
    .selectFrom('employees')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirst()
  const total = Number(row?.n ?? 0)
  return page(
    c,
    { title: 'Employees', path: '/app/hr/employees' },
    <>
      {banner(c)}
      <div class="ncc-kpi-row">
        <KpiCard label="Records held" value={String(total)} hint="Live count from employees" />
      </div>
      <Panel title="Employees">
        <Alert tone="warn">
          The data model behind this screen is migrated. The entry and approval
          forms are the next build phase.
        </Alert>
      </Panel>
    </>
  )
})

hr.get('/app/hr/attendance', requirePermission(PERMISSIONS.HR_ATTENDANCE_RECORD), async (c) => {
  const db = c.get('db')
  const row = await db
    .selectFrom('attendance')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirst()
  const total = Number(row?.n ?? 0)
  return page(
    c,
    { title: 'Attendance', path: '/app/hr/attendance' },
    <>
      {banner(c)}
      <div class="ncc-kpi-row">
        <KpiCard label="Records held" value={String(total)} hint="Live count from attendance" />
      </div>
      <Panel title="Attendance">
        <Alert tone="warn">
          The data model behind this screen is migrated. The entry and approval
          forms are the next build phase.
        </Alert>
      </Panel>
    </>
  )
})

hr.get('/app/hr/leave', requirePermission(PERMISSIONS.HR_EMPLOYEE_VIEW), async (c) => {
  const db = c.get('db')
  const row = await db
    .selectFrom('leave_requests')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirst()
  const total = Number(row?.n ?? 0)
  return page(
    c,
    { title: 'Leave', path: '/app/hr/leave' },
    <>
      {banner(c)}
      <div class="ncc-kpi-row">
        <KpiCard label="Records held" value={String(total)} hint="Live count from leave_requests" />
      </div>
      <Panel title="Leave">
        <Alert tone="warn">
          The data model behind this screen is migrated. The entry and approval
          forms are the next build phase.
        </Alert>
      </Panel>
    </>
  )
})

hr.get('/app/hr/contractors', requirePermission(PERMISSIONS.HR_LABOUR_CONTRACTOR_MANAGE), async (c) => {
  const db = c.get('db')
  const row = await db
    .selectFrom('labour_contractors')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirst()
  const total = Number(row?.n ?? 0)
  return page(
    c,
    { title: 'Labour contractors', path: '/app/hr/contractors' },
    <>
      {banner(c)}
      <div class="ncc-kpi-row">
        <KpiCard label="Records held" value={String(total)} hint="Live count from labour_contractors" />
      </div>
      <Panel title="Labour contractors">
        <Alert tone="warn">
          The data model behind this screen is migrated. The entry and approval
          forms are the next build phase.
        </Alert>
      </Panel>
    </>
  )
})

hr.get('/app/hr/recruiting', requirePermission(PERMISSIONS.HR_RECRUIT_MANAGE), async (c) => {
  const db = c.get('db')
  const row = await db
    .selectFrom('applicants')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirst()
  const total = Number(row?.n ?? 0)
  return page(
    c,
    { title: 'Recruiting', path: '/app/hr/recruiting' },
    <>
      {banner(c)}
      <div class="ncc-kpi-row">
        <KpiCard label="Records held" value={String(total)} hint="Live count from applicants" />
      </div>
      <Panel title="Recruiting">
        <Alert tone="warn">
          The data model behind this screen is migrated. The entry and approval
          forms are the next build phase.
        </Alert>
      </Panel>
    </>
  )
})

export default hr
