import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../types.js'
import { currentUser, currentSession } from '../../types.js'
import { AppShell } from '../../dashboard/layouts/AppShell.js'
import {
  Alert,
  DataTable,
  DefinitionList,
  FormField,
  Pager,
  Panel,
  StatusBadge,
  Tabs,
  type Column,
} from '../../dashboard/components/index.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { PERMISSIONS, PERMISSION_MODULES } from '../../lib/permissions.js'
import { readBody } from '../../middleware/csrf.js'
import { NotFoundError } from '../../lib/errors.js'
import { parseJsonColumn } from '../../lib/json.js'
import { formatDate, formatDateTime } from '../../lib/dates.js'
import { formatPaise } from '../../lib/money.js'
import { allSettings } from '../../lib/settings.js'
import * as q from './queries.js'
import * as svc from './service.js'
import {
  auditFilterSchema,
  createUserSchema,
  enquiryStatusSchema,
  firstError,
  overrideSchema,
  rolePermissionsSchema,
  rolesSchema,
  statusSchema,
} from './schemas.js'

/**
 * Admin routes (spec 6.2).
 *
 * Two permissions run this module and they are not the same thing:
 * users.manage is account administration, roles.manage is privilege
 * administration. Splitting them means an office administrator can invite a
 * site engineer without being able to grant themselves finance access.
 */

type Ctx = Context<AppEnv>

const admin = new Hono<AppEnv>()

const ADMIN_TABS = [
  { label: 'Users', href: '/app/admin/users' },
  { label: 'Roles', href: '/app/admin/roles' },
  { label: 'Approval limits', href: '/app/admin/approval-limits' },
  { label: 'Reference data', href: '/app/admin/reference' },
  { label: 'Settings', href: '/app/admin/settings' },
  { label: 'Audit log', href: '/app/admin/audit' },
  { label: 'Enquiries', href: '/app/admin/enquiries' },
]

function actorOf(c: Ctx): svc.Actor {
  return { userId: currentUser(c).id, ip: c.get('clientIp') }
}

/** Reads ?ok= and ?error= so a redirect can carry a result without a session flash. */
function banner(c: Ctx) {
  const url = new URL(c.req.url)
  const ok = url.searchParams.get('ok')
  const error = url.searchParams.get('error')
  if (error) return <Alert tone="error">{error}</Alert>
  if (ok) return <Alert tone="ok">{ok}</Alert>
  return null
}

/* Users ------------------------------------------------------------------- */

admin.get('/app/admin/users', requirePermission(PERMISSIONS.USERS_MANAGE), async (c) => {
  const db = c.get('db')
  const [users, roles] = await Promise.all([q.listUsers(db), q.allRoles(db)])

  const columns: Column<q.UserListRow>[] = [
    {
      header: 'Name',
      cell: (row) => (
        <>
          <a href={`/app/admin/users/${row.id}`}>
            <strong>{row.full_name}</strong>
          </a>
          <div class="ncc-muted">{row.email}</div>
        </>
      ),
    },
    { header: 'Roles', cell: (row) => row.roles ?? <span class="ncc-muted">None</span> },
    {
      header: 'Status',
      cell: (row) => (
        <>
          <StatusBadge status={row.status} />
          {row.locked_until && row.locked_until > new Date().toISOString().slice(0, 19).replace('T', ' ') ? (
            <div class="ncc-muted">Locked until {formatDateTime(row.locked_until)}</div>
          ) : null}
        </>
      ),
    },
    {
      header: 'Two factor',
      cell: (row) => (row.totp_confirmed_at ? 'Enrolled' : <span class="ncc-muted">Not enrolled</span>),
    },
    {
      header: 'Last sign in',
      cell: (row) => (row.last_login_at ? formatDateTime(row.last_login_at) : <span class="ncc-muted">Never</span>),
    },
  ]

  const user = currentUser(c)
  const session = currentSession(c)

  return c.html(
    <AppShell
      title="Users"
      user={user}
      perms={c.get('perms')}
      csrfToken={session.csrfToken}
      path="/app/admin/users"
      subtitle="Staff accounts. There is no self sign up; every account starts here as an invitation."
    >
      <Tabs tabs={ADMIN_TABS} active="/app/admin/users" />
      {banner(c)}

      <Panel title={`${users.length} ${users.length === 1 ? 'account' : 'accounts'}`}>
        <DataTable columns={columns} rows={users} empty="No accounts yet." />
      </Panel>

      <Panel title="Invite a new user">
        <form method="post" action="/app/admin/users" class="ncc-stack">
          <input type="hidden" name="nc_csrf" value={session.csrfToken} />
          <div class="ncc-grid ncc-grid--2">
            <FormField label="Full name" name="fullName" required />
            <FormField label="Email" name="email" type="email" required />
            <FormField label="Phone" name="phone" hint="Optional." />
          </div>
          <fieldset class="ncc-fieldset">
            <legend>Roles</legend>
            <p class="ncc-hint">
              Permissions come from roles. A user with no role can sign in but sees an empty dashboard.
            </p>
            <div class="ncc-grid ncc-grid--2">
              {roles.map((role) => (
                <label class="ncc-check">
                  <input type="checkbox" name="roleIds" value={String(role.id)} />
                  <span>
                    <strong>{role.label}</strong>
                    {Number(role.require_2fa) === 1 ? <span class="ncc-muted"> requires two factor</span> : null}
                    {role.description ? <div class="ncc-muted">{role.description}</div> : null}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <p class="ncc-hint">
            The person receives a link to set their own password. No administrator ever sets or sees it.
          </p>
          <button class="ncc-btn ncc-btn--primary" type="submit">
            Create account and send invite
          </button>
        </form>
      </Panel>
    </AppShell>
  )
})

admin.post('/app/admin/users', requirePermission(PERMISSIONS.USERS_MANAGE), async (c) => {
  const body = await readBody(c)
  const parsed = createUserSchema.safeParse(body)
  if (!parsed.success) {
    return c.redirect(`/app/admin/users?error=${encodeURIComponent(firstError(parsed.error))}`, 303)
  }

  const result = await svc.createUser(c.get('db'), actorOf(c), {
    email: parsed.data.email,
    fullName: parsed.data.fullName,
    phone: parsed.data.phone,
    roleIds: parsed.data.roleIds,
    employeeId: parsed.data.employeeId,
  })

  // The link is shown to the administrator as well as emailed. SMTP on a
  // fresh Hostinger account is frequently not configured yet, and an invite
  // that exists only in a failed email means the account cannot be used.
  const message = `Account created. Invite link, valid 24 hours: ${result.inviteLink}`
  return c.redirect(`/app/admin/users/${result.userId}?ok=${encodeURIComponent(message)}`, 303)
})

admin.get('/app/admin/users/:id', requirePermission(PERMISSIONS.USERS_MANAGE), async (c) => {
  const db = c.get('db')
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) throw new NotFoundError('No such user.')

  const target = await q.findUser(db, id)
  if (!target) throw new NotFoundError('No such user.')

  const [roles, roleIds, overrides, permissions] = await Promise.all([
    q.allRoles(db),
    q.roleIdsFor(db, id),
    q.overridesFor(db, id),
    q.allPermissions(db),
  ])

  const user = currentUser(c)
  const session = currentSession(c)
  const perms = c.get('perms')
  const canManageRoles = perms.has(PERMISSIONS.ROLES_MANAGE)

  return c.html(
    <AppShell
      title={target.full_name}
      user={user}
      perms={perms}
      csrfToken={session.csrfToken}
      path="/app/admin/users"
      subtitle={target.email}
      actions={<a class="ncc-btn" href="/app/admin/users">Back to users</a>}
    >
      {banner(c)}

      <div class="ncc-grid ncc-grid--2">
        <Panel title="Account">
          <DefinitionList
            rows={[
              ['Status', <StatusBadge status={target.status} />],
              ['Two factor', target.totp_confirmed_at ? `Enrolled ${formatDate(target.totp_confirmed_at)}` : 'Not enrolled'],
              ['Must change password', Number(target.must_change_password) === 1 ? 'Yes' : 'No'],
              ['Last sign in', target.last_login_at ? formatDateTime(target.last_login_at) : 'Never'],
              ['Created', formatDateTime(target.created_at)],
            ]}
          />
          <form method="post" action={`/app/admin/users/${id}/status`} class="ncc-toolbar">
            <input type="hidden" name="nc_csrf" value={session.csrfToken} />
            <select name="status" class="ncc-input" aria-label="Account status">
              <option value="active" selected={target.status === 'active'}>
                Active
              </option>
              <option value="suspended" selected={target.status === 'suspended'}>
                Suspended
              </option>
              <option value="inactive" selected={target.status === 'inactive'}>
                Inactive
              </option>
            </select>
            <button class="ncc-btn" type="submit">
              Update status
            </button>
          </form>
          <p class="ncc-hint">
            Suspending signs the person out everywhere immediately. It does not delete anything they created.
          </p>
        </Panel>

        <Panel title="Roles">
          {canManageRoles ? (
            <form method="post" action={`/app/admin/users/${id}/roles`} class="ncc-stack">
              <input type="hidden" name="nc_csrf" value={session.csrfToken} />
              {roles.map((role) => (
                <label class="ncc-check">
                  <input
                    type="checkbox"
                    name="roleIds"
                    value={String(role.id)}
                    checked={roleIds.includes(Number(role.id))}
                  />
                  <span>
                    <strong>{role.label}</strong>
                    {Number(role.scope_to_assigned_projects) === 1 ? (
                      <div class="ncc-muted">Sees only assigned projects</div>
                    ) : null}
                  </span>
                </label>
              ))}
              <button class="ncc-btn ncc-btn--primary" type="submit">
                Save roles
              </button>
            </form>
          ) : (
            <>
              <ul>
                {roles
                  .filter((r) => roleIds.includes(Number(r.id)))
                  .map((r) => (
                    <li>{r.label}</li>
                  ))}
              </ul>
              <p class="ncc-hint">Changing roles needs the roles.manage permission.</p>
            </>
          )}
        </Panel>
      </div>

      {canManageRoles ? (
        <Panel title="Permission overrides">
          <p class="ncc-hint">
            An override changes this one person without changing anyone else with the same role. Effective
            permissions are the union of their roles, minus denies, plus grants.
          </p>

          {overrides.length > 0 ? (
            <DataTable
              columns={[
                { header: 'Permission', cell: (row) => <code>{row.key}</code> },
                { header: 'Effect', cell: (row) => <StatusBadge status={row.effect} /> },
                { header: 'Reason', cell: (row) => row.note },
                { header: 'Added', cell: (row) => formatDateTime(row.granted_at) },
                {
                  header: '',
                  cell: (row) => (
                    <form method="post" action={`/app/admin/overrides/${row.id}/remove`}>
                      <input type="hidden" name="nc_csrf" value={session.csrfToken} />
                      <button class="ncc-btn ncc-btn--small" type="submit">
                        Remove
                      </button>
                    </form>
                  ),
                },
              ]}
              rows={overrides}
              empty="No overrides."
            />
          ) : (
            <p class="ncc-muted">No overrides. This user's permissions come entirely from their roles.</p>
          )}

          <form method="post" action={`/app/admin/users/${id}/overrides`} class="ncc-stack">
            <input type="hidden" name="nc_csrf" value={session.csrfToken} />
            <div class="ncc-grid ncc-grid--2">
              <FormField
                label="Permission"
                name="permissionKey"
                required
                options={permissions.map((p) => ({ value: p.key, label: `${p.key} (${p.label})` }))}
              />
              <FormField
                label="Effect"
                name="effect"
                required
                options={[
                  { value: 'grant', label: 'Grant' },
                  { value: 'deny', label: 'Deny' },
                ]}
              />
            </div>
            <FormField
              label="Reason"
              name="note"
              rows={3}
              required
              hint="Recorded in the audit log. At least 10 characters."
            />
            <button class="ncc-btn" type="submit">
              Add override
            </button>
          </form>
        </Panel>
      ) : null}
    </AppShell>
  )
})

admin.post('/app/admin/users/:id/status', requirePermission(PERMISSIONS.USERS_MANAGE), async (c) => {
  const id = Number(c.req.param('id'))
  const parsed = statusSchema.safeParse(await readBody(c))
  if (!Number.isInteger(id) || !parsed.success) throw new NotFoundError('No such user.')

  await svc.setUserStatus(c.get('db'), actorOf(c), id, parsed.data.status)
  return c.redirect(`/app/admin/users/${id}?ok=${encodeURIComponent('Status updated.')}`, 303)
})

admin.post('/app/admin/users/:id/roles', requirePermission(PERMISSIONS.ROLES_MANAGE), async (c) => {
  const id = Number(c.req.param('id'))
  const parsed = rolesSchema.safeParse(await readBody(c))
  if (!Number.isInteger(id) || !parsed.success) throw new NotFoundError('No such user.')

  await svc.replaceUserRoles(c.get('db'), actorOf(c), id, parsed.data.roleIds)
  return c.redirect(`/app/admin/users/${id}?ok=${encodeURIComponent('Roles saved.')}`, 303)
})

admin.post('/app/admin/users/:id/overrides', requirePermission(PERMISSIONS.ROLES_MANAGE), async (c) => {
  const id = Number(c.req.param('id'))
  const parsed = overrideSchema.safeParse(await readBody(c))
  if (!Number.isInteger(id)) throw new NotFoundError('No such user.')
  if (!parsed.success) {
    return c.redirect(`/app/admin/users/${id}?error=${encodeURIComponent(firstError(parsed.error))}`, 303)
  }

  await svc.addOverride(c.get('db'), actorOf(c), id, parsed.data)
  return c.redirect(`/app/admin/users/${id}?ok=${encodeURIComponent('Override added.')}`, 303)
})

admin.post('/app/admin/overrides/:id/remove', requirePermission(PERMISSIONS.ROLES_MANAGE), async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) throw new NotFoundError('No such override.')
  await readBody(c)
  await svc.removeOverride(c.get('db'), actorOf(c), id)
  return c.redirect(`/app/admin/users?ok=${encodeURIComponent('Override removed.')}`, 303)
})

/* Roles ------------------------------------------------------------------- */

admin.get('/app/admin/roles', requirePermission(PERMISSIONS.ROLES_MANAGE), async (c) => {
  const roles = await q.allRoles(c.get('db'))
  const user = currentUser(c)
  const session = currentSession(c)

  return c.html(
    <AppShell
      title="Roles"
      user={user}
      perms={c.get('perms')}
      csrfToken={session.csrfToken}
      path="/app/admin/roles"
      subtitle="A role is a named bundle of permissions. Routes check permissions, never role names."
    >
      <Tabs tabs={ADMIN_TABS} active="/app/admin/roles" />
      {banner(c)}
      <Panel title="All roles">
        <DataTable
          columns={[
            {
              header: 'Role',
              cell: (row) => (
                <>
                  <a href={`/app/admin/roles/${row.id}`}>
                    <strong>{row.label}</strong>
                  </a>
                  <div class="ncc-muted">
                    <code>{row.key}</code>
                  </div>
                </>
              ),
            },
            { header: 'Description', cell: (row) => row.description ?? '' },
            {
              header: 'Two factor',
              cell: (row) => (Number(row.require_2fa) === 1 ? 'Required' : <span class="ncc-muted">Optional</span>),
            },
            {
              header: 'Project scope',
              cell: (row) =>
                Number(row.scope_to_assigned_projects) === 1 ? 'Assigned projects only' : 'All projects',
            },
          ]}
          rows={roles}
          empty="No roles."
        />
      </Panel>
    </AppShell>
  )
})

admin.get('/app/admin/roles/:id', requirePermission(PERMISSIONS.ROLES_MANAGE), async (c) => {
  const db = c.get('db')
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) throw new NotFoundError('No such role.')

  const roles = await q.allRoles(db)
  const role = roles.find((r) => Number(r.id) === id)
  if (!role) throw new NotFoundError('No such role.')

  const [permissions, held] = await Promise.all([q.allPermissions(db), q.permissionIdsForRole(db, id)])
  const heldSet = new Set(held)
  const isOwner = role.key === 'owner'

  const user = currentUser(c)
  const session = currentSession(c)

  return c.html(
    <AppShell
      title={role.label}
      user={user}
      perms={c.get('perms')}
      csrfToken={session.csrfToken}
      path="/app/admin/roles"
      subtitle={`Role key ${role.key}`}
      actions={<a class="ncc-btn" href="/app/admin/roles">Back to roles</a>}
    >
      {banner(c)}
      {isOwner ? (
        <Alert tone="warn">
          The owner role always holds every permission and cannot be edited. It is the recovery path if another
          role is misconfigured.
        </Alert>
      ) : null}

      <form method="post" action={`/app/admin/roles/${id}`} class="ncc-stack">
        <input type="hidden" name="nc_csrf" value={session.csrfToken} />
        {PERMISSION_MODULES.map((module) => {
          const inModule = permissions.filter((p) => p.module === module.key)
          if (inModule.length === 0) return null
          return (
            <Panel title={module.label}>
              <div class="ncc-grid ncc-grid--2">
                {inModule.map((p) => (
                  <label class="ncc-check">
                    <input
                      type="checkbox"
                      name="permissionIds"
                      value={String(p.id)}
                      checked={isOwner || heldSet.has(Number(p.id))}
                      disabled={isOwner}
                    />
                    <span>
                      {p.label}
                      <div class="ncc-muted">
                        <code>{p.key}</code>
                      </div>
                    </span>
                  </label>
                ))}
              </div>
            </Panel>
          )
        })}
        {isOwner ? null : (
          <button class="ncc-btn ncc-btn--primary" type="submit">
            Save permissions
          </button>
        )}
      </form>
    </AppShell>
  )
})

admin.post('/app/admin/roles/:id', requirePermission(PERMISSIONS.ROLES_MANAGE), async (c) => {
  const id = Number(c.req.param('id'))
  const parsed = rolePermissionsSchema.safeParse(await readBody(c))
  if (!Number.isInteger(id) || !parsed.success) throw new NotFoundError('No such role.')

  await svc.setRolePermissions(c.get('db'), actorOf(c), id, parsed.data.permissionIds)
  return c.redirect(`/app/admin/roles/${id}?ok=${encodeURIComponent('Permissions saved.')}`, 303)
})

/* Approval limits --------------------------------------------------------- */

admin.get('/app/admin/approval-limits', requirePermission(PERMISSIONS.ROLES_MANAGE), async (c) => {
  const limits = await q.approvalLimits(c.get('db'))
  const user = currentUser(c)
  const session = currentSession(c)

  return c.html(
    <AppShell
      title="Approval limits"
      user={user}
      perms={c.get('perms')}
      csrfToken={session.csrfToken}
      path="/app/admin/approval-limits"
      subtitle="What each role may approve, and above what value a second approver is required."
    >
      <Tabs tabs={ADMIN_TABS} active="/app/admin/approval-limits" />
      {banner(c)}
      <Alert tone="warn">
        These are seeded placeholders. The real figures are open question 8.2 in the build specification and need
        the owner's decision before the finance module is relied on.
      </Alert>
      <Panel title="Current limits">
        <DataTable
          columns={[
            { header: 'Document', cell: (row) => String(row.document_type).replace(/_/g, ' ') },
            { header: 'Role', cell: (row) => row.role_label ?? row.role_key },
            {
              header: 'Up to',
              numeric: true,
              cell: (row) =>
                row.document_type === 'quote_discount_pct'
                  ? `${Number(row.max_value) / 100}%`
                  : formatPaise(Number(row.max_value)),
            },
            {
              header: 'Second approver above',
              numeric: true,
              cell: (row) =>
                row.requires_second_approval_above === null ? (
                  <span class="ncc-muted">Never</span>
                ) : (
                  formatPaise(Number(row.requires_second_approval_above))
                ),
            },
            { header: 'Effective from', cell: (row) => formatDate(row.effective_from) },
          ]}
          rows={limits}
          empty="No limits configured."
        />
      </Panel>
    </AppShell>
  )
})

/* Settings ---------------------------------------------------------------- */

admin.get('/app/admin/settings', requirePermission(PERMISSIONS.REFERENCE_MANAGE), async (c) => {
  const rows = await allSettings(c.get('db'))
  const user = currentUser(c)
  const session = currentSession(c)

  return c.html(
    <AppShell
      title="Settings"
      user={user}
      perms={c.get('perms')}
      csrfToken={session.csrfToken}
      path="/app/admin/settings"
      subtitle="Company configuration. These values were previously hardcoded in the PHP pages."
    >
      <Tabs tabs={ADMIN_TABS} active="/app/admin/settings" />
      {banner(c)}
      <form method="post" action="/app/admin/settings" class="ncc-stack">
        <input type="hidden" name="nc_csrf" value={session.csrfToken} />
        <Panel title={`${rows.length} settings`}>
          {/* Rendered from data_type, so a new settings key needs a migration
              and no UI code at all (spec 6.2). */}
          <div class="ncc-stack">
            {rows.map((row) => {
              const value = parseJsonColumn(row.value_json)
              const name = `s_${row.key_name}`
              if (row.data_type === 'bool') {
                return (
                  <label class="ncc-check">
                    <input type="checkbox" name={name} checked={value === true} />
                    <span>
                      <strong>{row.label}</strong>
                      <div class="ncc-muted">
                        <code>{row.key_name}</code>
                      </div>
                    </span>
                  </label>
                )
              }
              const display =
                row.data_type === 'money'
                  ? String(Number(value ?? 0) / 100)
                  : row.data_type === 'json'
                    ? JSON.stringify(value)
                    : String(value ?? '')
              return (
                <FormField
                  label={row.label}
                  name={name}
                  value={display}
                  {...(row.data_type === 'json' ? { rows: 3 } : {})}
                  type={row.data_type === 'int' ? 'number' : 'text'}
                  hint={`${row.key_name}${row.data_type === 'money' ? ', in rupees' : ''}`}
                />
              )
            })}
          </div>
        </Panel>
        <button class="ncc-btn ncc-btn--primary" type="submit">
          Save settings
        </button>
      </form>
    </AppShell>
  )
})

admin.post('/app/admin/settings', requirePermission(PERMISSIONS.REFERENCE_MANAGE), async (c) => {
  const body = await readBody(c)
  const submitted: Record<string, string> = {}
  for (const [key, value] of Object.entries(body)) {
    if (key.startsWith('s_')) submitted[key] = typeof value === 'string' ? value : String(value ?? '')
  }
  const changed = await svc.saveSettings(c.get('db'), actorOf(c), submitted)
  const message = changed === 0 ? 'No changes to save.' : `${changed} ${changed === 1 ? 'setting' : 'settings'} saved.`
  return c.redirect(`/app/admin/settings?ok=${encodeURIComponent(message)}`, 303)
})

/* Reference data ---------------------------------------------------------- */

admin.get('/app/admin/reference', requirePermission(PERMISSIONS.REFERENCE_MANAGE), async (c) => {
  const db = c.get('db')
  const [costHeads, units, numbering] = await Promise.all([
    q.listCostHeads(db),
    q.listUnits(db),
    q.listNumbering(db),
  ])
  const user = currentUser(c)
  const session = currentSession(c)

  return c.html(
    <AppShell
      title="Reference data"
      user={user}
      perms={c.get('perms')}
      csrfToken={session.csrfToken}
      path="/app/admin/reference"
      subtitle="Cost heads, units and document numbering. Shared by projects, inventory and finance."
    >
      <Tabs tabs={ADMIN_TABS} active="/app/admin/reference" />
      {banner(c)}

      <Panel title={`Cost heads (${costHeads.length})`}>
        <p class="ncc-hint">
          A cost head that is in use cannot be deleted, only deactivated. Deleting one would orphan every budget
          line and expense that referenced it.
        </p>
        <DataTable
          columns={[
            { header: 'Code', cell: (row) => <code>{row.code}</code> },
            { header: 'Name', cell: (row) => row.name },
            { header: 'Type', cell: (row) => String(row.head_type).replace(/_/g, ' ') },
            { header: 'Direct cost', cell: (row) => (Number(row.is_direct_cost) === 1 ? 'Yes' : 'No') },
            { header: 'Active', cell: (row) => <StatusBadge status={Number(row.is_active) === 1 ? 'active' : 'inactive'} /> },
          ]}
          rows={costHeads}
          empty="No cost heads seeded."
        />
      </Panel>

      <div class="ncc-grid ncc-grid--2">
        <Panel title={`Units (${units.length})`}>
          <DataTable
            columns={[
              { header: 'Code', cell: (row) => <code>{row.code}</code> },
              { header: 'Name', cell: (row) => row.name },
              { header: 'Decimals', numeric: true, cell: (row) => String(row.decimal_places) },
            ]}
            rows={units}
            empty="No units seeded."
          />
        </Panel>

        <Panel title="Document numbering">
          <p class="ncc-hint">
            Numbers are allocated with a row lock inside the caller's transaction, so two concurrent submits
            cannot produce the same purchase order number.
          </p>
          <DataTable
            columns={[
              { header: 'Document', cell: (row) => String(row.doc_type).replace(/_/g, ' ') },
              { header: 'Prefix', cell: (row) => <code>{row.prefix}</code> },
              { header: 'Financial year', cell: (row) => row.financial_year },
              { header: 'Last used', numeric: true, cell: (row) => String(row.last_number) },
            ]}
            rows={numbering}
            empty="No numbering series yet. They are created on first use."
          />
        </Panel>
      </div>
    </AppShell>
  )
})

/* Audit ------------------------------------------------------------------- */

const AUDIT_PAGE_SIZE = 50

admin.get('/app/admin/audit', requirePermission(PERMISSIONS.AUDIT_VIEW), async (c) => {
  const db = c.get('db')
  const url = new URL(c.req.url)
  const parsed = auditFilterSchema.parse(Object.fromEntries(url.searchParams))

  const filter = {
    ...(parsed.userId !== undefined ? { userId: parsed.userId } : {}),
    ...(parsed.action ? { action: parsed.action } : {}),
    ...(parsed.entityType ? { entityType: parsed.entityType } : {}),
    ...(parsed.from ? { from: parsed.from } : {}),
    ...(parsed.to ? { to: parsed.to } : {}),
  }

  const [rows, total, actions, users] = await Promise.all([
    q.auditPage(db, { ...filter, limit: AUDIT_PAGE_SIZE, offset: (parsed.page - 1) * AUDIT_PAGE_SIZE }),
    q.auditCount(db, filter),
    q.distinctAuditActions(db),
    q.listUsers(db),
  ])

  const user = currentUser(c)
  const session = currentSession(c)

  return c.html(
    <AppShell
      title="Audit log"
      user={user}
      perms={c.get('perms')}
      csrfToken={session.csrfToken}
      path="/app/admin/audit"
      subtitle={`${total} recorded ${total === 1 ? 'event' : 'events'}`}
    >
      <Tabs tabs={ADMIN_TABS} active="/app/admin/audit" />

      <Panel title="Filter">
        <form method="get" action="/app/admin/audit" class="ncc-toolbar">
          <select name="userId" class="ncc-input" aria-label="User">
            <option value="">Anyone</option>
            {users.map((u) => (
              <option value={String(u.id)} selected={parsed.userId === u.id}>
                {u.full_name}
              </option>
            ))}
          </select>
          <select name="action" class="ncc-input" aria-label="Action">
            <option value="">Any action</option>
            {actions.map((a) => (
              <option value={a} selected={parsed.action === a}>
                {a}
              </option>
            ))}
          </select>
          <input type="date" name="from" class="ncc-input" value={parsed.from ?? ''} aria-label="From date" />
          <input type="date" name="to" class="ncc-input" value={parsed.to ?? ''} aria-label="To date" />
          <button class="ncc-btn" type="submit">
            Apply
          </button>
          <a class="ncc-btn" href="/app/admin/audit">
            Clear
          </a>
        </form>
      </Panel>

      <Panel title="Events">
        <DataTable
          columns={[
            { header: 'When', cell: (row) => <span class="ncc-muted">{formatDateTime(row.created_at)}</span> },
            {
              header: 'Who',
              cell: (row) =>
                row.user_name ? (
                  <>
                    {row.user_name}
                    <div class="ncc-muted">{row.user_email}</div>
                  </>
                ) : (
                  <span class="ncc-muted">System</span>
                ),
            },
            { header: 'Action', cell: (row) => <code>{row.action}</code> },
            {
              header: 'Entity',
              cell: (row) =>
                row.entity_type ? (
                  <>
                    {row.entity_type}
                    {row.entity_id ? <span class="ncc-muted"> #{row.entity_id}</span> : null}
                  </>
                ) : (
                  ''
                ),
            },
            {
              header: 'Change',
              cell: (row) => <FieldDiff before={row.before_json} after={row.after_json} />,
            },
          ]}
          rows={rows}
          empty="No events match that filter."
        />
        <Pager
          page={parsed.page}
          pageSize={AUDIT_PAGE_SIZE}
          total={total}
          baseHref={`/app/admin/audit?${new URLSearchParams(
            Object.fromEntries(
              [...url.searchParams.entries()].filter(([k]) => k !== 'page')
            )
          ).toString()}`}
        />
      </Panel>
    </AppShell>
  )
})

/**
 * Field-level diff of the audit JSON (spec 6.2).
 *
 * Showing two raw JSON blobs makes the reader diff them by eye, which is
 * exactly what nobody does at the moment they need the audit log. Only keys
 * that actually changed are listed.
 *
 * The props are `unknown` because audit_log.before_json and after_json arrive
 * already parsed (src/lib/json.ts). Typing them `string | null` and parsing was
 * the bug: an object is truthy, JSON.parse stringified it to "[object Object]"
 * and threw, and the catch rendered one `value` row holding the entire blob —
 * so the diff this component exists to produce never ran once.
 */
function FieldDiff(props: { before: unknown; after: unknown }) {
  const asRecord = (raw: unknown): Record<string, unknown> | null => {
    const value = parseJsonColumn(raw)
    if (value === null || value === undefined || value === '') return null
    // A scalar in the column is not a field map. Wrapping it keeps it visible
    // rather than rendering an empty diff.
    return typeof value === 'object' ? (value as Record<string, unknown>) : { value }
  }

  const before = asRecord(props.before)
  const after = asRecord(props.after)
  if (!before && !after) return <span class="ncc-muted">No detail</span>

  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])]
  const show = (value: unknown): string => {
    if (value === undefined) return 'not set'
    if (value === null) return 'empty'
    return typeof value === 'string' ? value : JSON.stringify(value)
  }

  const changed = keys.filter((key) => show(before?.[key]) !== show(after?.[key]))
  if (changed.length === 0) return <span class="ncc-muted">No field changed</span>

  return (
    <ul class="ncc-diff">
      {changed.map((key) => (
        <li>
          <code>{key}</code>{' '}
          {before === null ? (
            <ins>{show(after?.[key])}</ins>
          ) : after === null ? (
            <del>{show(before?.[key])}</del>
          ) : (
            <>
              <del>{show(before?.[key])}</del> <ins>{show(after?.[key])}</ins>
            </>
          )}
        </li>
      ))}
    </ul>
  )
}

/* Enquiries --------------------------------------------------------------- */

const ENQUIRY_PAGE_SIZE = 25

admin.get('/app/admin/enquiries', requirePermission(PERMISSIONS.ENQUIRIES_VIEW), async (c) => {
  const db = c.get('db')
  const url = new URL(c.req.url)
  const status = url.searchParams.get('status') ?? ''
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1)

  const [rows, total] = await Promise.all([
    q.enquiryPage(db, {
      ...(status ? { status } : {}),
      limit: ENQUIRY_PAGE_SIZE,
      offset: (page - 1) * ENQUIRY_PAGE_SIZE,
    }),
    q.enquiryCount(db, status || undefined),
  ])

  const user = currentUser(c)
  const session = currentSession(c)
  const canPromote = c.get('perms').has(PERMISSIONS.CRM_LEAD_MANAGE)

  return c.html(
    <AppShell
      title="Website enquiries"
      user={user}
      perms={c.get('perms')}
      csrfToken={session.csrfToken}
      path="/app/admin/enquiries"
      subtitle="Every submission from the public contact forms. Unlike the old site, none of these are lost."
    >
      <Tabs tabs={ADMIN_TABS} active="/app/admin/enquiries" />
      {banner(c)}

      <Panel title={`${total} ${total === 1 ? 'enquiry' : 'enquiries'}`}>
        <form method="get" action="/app/admin/enquiries" class="ncc-toolbar">
          <select name="status" class="ncc-input" aria-label="Status">
            <option value="">All</option>
            {['new', 'contacted', 'promoted', 'spam', 'closed'].map((s) => (
              <option value={s} selected={status === s}>
                {s}
              </option>
            ))}
          </select>
          <button class="ncc-btn" type="submit">
            Filter
          </button>
        </form>

        <DataTable
          columns={[
            { header: 'Received', cell: (row) => <span class="ncc-muted">{formatDateTime(row.created_at)}</span> },
            {
              header: 'From',
              cell: (row) => (
                <>
                  <strong>{row.name}</strong>
                  <div class="ncc-muted">
                    {row.email ? <a href={`mailto:${row.email}`}>{row.email}</a> : null}
                    {row.phone ? <> {row.phone}</> : null}
                  </div>
                </>
              ),
            },
            {
              header: 'Enquiry',
              cell: (row) => (
                <>
                  {row.service_interest ? <div>{row.service_interest}</div> : null}
                  <div>{row.message}</div>
                  <div class="ncc-muted">via {row.source_page}</div>
                </>
              ),
            },
            {
              header: 'Status',
              cell: (row) => (
                <>
                  <StatusBadge status={row.status} />
                  {row.handler ? <div class="ncc-muted">{row.handler}</div> : null}
                </>
              ),
            },
            {
              header: '',
              cell: (row) => (
                <form method="post" action={`/app/admin/enquiries/${row.id}/status`} class="ncc-stack">
                  <input type="hidden" name="nc_csrf" value={session.csrfToken} />
                  <select name="status" class="ncc-input" aria-label="Set status">
                    {['new', 'contacted', 'promoted', 'spam', 'closed'].map((s) => (
                      <option value={s} selected={row.status === s}>
                        {s}
                      </option>
                    ))}
                  </select>
                  <button class="ncc-btn ncc-btn--small" type="submit">
                    Update
                  </button>
                  {canPromote && row.status !== 'promoted' ? (
                    <a class="ncc-btn ncc-btn--small" href={`/app/crm/leads/new?enquiry=${row.id}`}>
                      Promote to lead
                    </a>
                  ) : null}
                </form>
              ),
            },
          ]}
          rows={rows}
          empty="No enquiries yet."
        />
        <Pager
          page={page}
          pageSize={ENQUIRY_PAGE_SIZE}
          total={total}
          baseHref={`/app/admin/enquiries?status=${encodeURIComponent(status)}`}
        />
      </Panel>
    </AppShell>
  )
})

admin.post('/app/admin/enquiries/:id/status', requirePermission(PERMISSIONS.ENQUIRIES_VIEW), async (c) => {
  const id = Number(c.req.param('id'))
  const parsed = enquiryStatusSchema.safeParse(await readBody(c))
  if (!Number.isInteger(id) || !parsed.success) throw new NotFoundError('No such enquiry.')

  await svc.setEnquiryStatus(c.get('db'), actorOf(c), id, parsed.data.status)
  return c.redirect(`/app/admin/enquiries?ok=${encodeURIComponent('Enquiry updated.')}`, 303)
})

export default admin
