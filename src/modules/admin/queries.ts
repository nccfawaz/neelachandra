import { sql } from 'kysely'
import type { Db, Queryable } from '../../db/kysely.js'

/** Data access for the admin module. No policy, no rendering (spec 3). */

export interface UserListRow {
  id: number
  email: string
  full_name: string
  status: 'invited' | 'active' | 'suspended' | 'inactive'
  last_login_at: string | null
  locked_until: string | null
  totp_confirmed_at: string | null
  employee_name: string | null
  roles: string | null
}

export async function listUsers(db: Queryable): Promise<UserListRow[]> {
  // GROUP_CONCAT rather than a second query per user. Ten users makes the
  // N+1 harmless in practice, but the list is also the page an admin refreshes
  // while granting roles, and one round trip is one round trip.
  const rows = await sql<UserListRow>`
    SELECT u.id, u.email, u.full_name, u.status, u.last_login_at, u.locked_until,
           u.totp_confirmed_at, e.full_name AS employee_name,
           GROUP_CONCAT(r.label ORDER BY r.label SEPARATOR ', ') AS roles
      FROM users u
      LEFT JOIN employees e ON e.id = u.employee_id
      LEFT JOIN user_roles ur ON ur.user_id = u.id
      LEFT JOIN roles r ON r.id = ur.role_id
     GROUP BY u.id
     ORDER BY u.full_name
  `.execute(db)
  return rows.rows
}

export async function findUser(db: Queryable, id: number) {
  return db
    .selectFrom('users')
    .select([
      'id',
      'email',
      'full_name',
      'phone',
      'status',
      'must_change_password',
      'totp_confirmed_at',
      'employee_id',
      'last_login_at',
      'locked_until',
      'created_at',
    ])
    .where('id', '=', id)
    .executeTakeFirst()
}

export async function userByEmail(db: Queryable, email: string) {
  return db
    .selectFrom('users')
    .select(['id', 'email', 'status'])
    .where('email', '=', email.toLowerCase())
    .executeTakeFirst()
}

export async function allRoles(db: Queryable) {
  return db
    .selectFrom('roles')
    .select([
      'id',
      'key',
      'label',
      'description',
      'require_2fa',
      'scope_to_assigned_projects',
      'is_system',
    ])
    .orderBy('id')
    .execute()
}

export async function roleIdsFor(db: Queryable, userId: number): Promise<number[]> {
  const rows = await db.selectFrom('user_roles').select('role_id').where('user_id', '=', userId).execute()
  return rows.map((r) => Number(r.role_id))
}

export async function allPermissions(db: Queryable) {
  return db
    .selectFrom('permissions')
    .select(['id', 'key', 'label', 'module'])
    .orderBy('module')
    .orderBy('key')
    .execute()
}

export async function permissionIdsForRole(db: Queryable, roleId: number): Promise<number[]> {
  const rows = await db
    .selectFrom('role_permissions')
    .select('permission_id')
    .where('role_id', '=', roleId)
    .execute()
  return rows.map((r) => Number(r.permission_id))
}

export async function overridesFor(db: Queryable, userId: number) {
  return db
    .selectFrom('user_permission_overrides')
    .innerJoin('permissions', 'permissions.id', 'user_permission_overrides.permission_id')
    .select([
      'user_permission_overrides.id',
      'user_permission_overrides.effect',
      'user_permission_overrides.note',
      'user_permission_overrides.granted_at',
      'permissions.key',
      'permissions.label',
    ])
    .where('user_permission_overrides.user_id', '=', userId)
    .orderBy('permissions.key')
    .execute()
}

/**
 * How many active owners there are, excluding one user.
 *
 * Used to refuse the last owner's removal. Counted with the exclusion in SQL
 * rather than fetching the list and filtering, so the check and the write can
 * sit in the same transaction and see the same rows.
 */
export async function otherActiveOwnerCount(db: Queryable, excludeUserId: number): Promise<number> {
  const row = await db
    .selectFrom('user_roles')
    .innerJoin('roles', 'roles.id', 'user_roles.role_id')
    .innerJoin('users', 'users.id', 'user_roles.user_id')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('roles.key', '=', 'owner')
    .where('users.status', '=', 'active')
    .where('user_roles.user_id', '!=', excludeUserId)
    .executeTakeFirst()
  return Number(row?.n ?? 0)
}

export async function approvalLimits(db: Queryable) {
  // Joined on role_key, not a role id: approval_limits is keyed by the stable
  // role key so a limit row survives a role being recreated, and so a limit
  // can be seeded before the roles table has ids assigned.
  return db
    .selectFrom('approval_limits')
    .leftJoin('roles', 'roles.key', 'approval_limits.role_key')
    .select([
      'approval_limits.id',
      'approval_limits.role_key',
      'approval_limits.document_type',
      'approval_limits.max_value',
      'approval_limits.requires_second_approval_above',
      'approval_limits.effective_from',
      'approval_limits.effective_to',
      'roles.label as role_label',
    ])
    .orderBy('approval_limits.document_type')
    .orderBy('approval_limits.role_key')
    .execute()
}

export interface AuditFilter {
  userId?: number
  action?: string
  entityType?: string
  from?: string
  to?: string
  limit: number
  offset: number
}

export async function auditPage(db: Queryable, filter: AuditFilter) {
  let q = db
    .selectFrom('audit_log')
    .leftJoin('users', 'users.id', 'audit_log.user_id')
    .select([
      'audit_log.id',
      'audit_log.action',
      'audit_log.entity_type',
      'audit_log.entity_id',
      'audit_log.before_json',
      'audit_log.after_json',
      'audit_log.created_at',
      'users.full_name as user_name',
      'users.email as user_email',
    ])
    .orderBy('audit_log.id', 'desc')

  if (filter.userId !== undefined) q = q.where('audit_log.user_id', '=', filter.userId)
  if (filter.action) q = q.where('audit_log.action', '=', filter.action)
  if (filter.entityType) q = q.where('audit_log.entity_type', '=', filter.entityType)
  if (filter.from) q = q.where('audit_log.created_at', '>=', `${filter.from} 00:00:00`)
  if (filter.to) q = q.where('audit_log.created_at', '<=', `${filter.to} 23:59:59`)

  return q.limit(filter.limit).offset(filter.offset).execute()
}

export async function auditCount(db: Queryable, filter: Omit<AuditFilter, 'limit' | 'offset'>) {
  let q = db.selectFrom('audit_log').select((eb) => eb.fn.countAll<number>().as('n'))
  if (filter.userId !== undefined) q = q.where('user_id', '=', filter.userId)
  if (filter.action) q = q.where('action', '=', filter.action)
  if (filter.entityType) q = q.where('entity_type', '=', filter.entityType)
  if (filter.from) q = q.where('created_at', '>=', `${filter.from} 00:00:00`)
  if (filter.to) q = q.where('created_at', '<=', `${filter.to} 23:59:59`)
  const row = await q.executeTakeFirst()
  return Number(row?.n ?? 0)
}

export async function distinctAuditActions(db: Queryable): Promise<string[]> {
  const rows = await db.selectFrom('audit_log').select('action').distinct().orderBy('action').execute()
  return rows.map((r) => r.action)
}

export interface EnquiryFilter {
  status?: string
  limit: number
  offset: number
}

export async function enquiryPage(db: Queryable, filter: EnquiryFilter) {
  let q = db
    .selectFrom('enquiries')
    .leftJoin('users', 'users.id', 'enquiries.handled_by')
    .select([
      'enquiries.id',
      'enquiries.name',
      'enquiries.phone',
      'enquiries.email',
      'enquiries.city',
      'enquiries.service_interest',
      'enquiries.message',
      'enquiries.source_page',
      'enquiries.status',
      'enquiries.created_at',
      'users.full_name as handler',
    ])
    .orderBy('enquiries.id', 'desc')
  if (filter.status) q = q.where('enquiries.status', '=', filter.status as 'new')
  return q.limit(filter.limit).offset(filter.offset).execute()
}

export async function enquiryCount(db: Queryable, status?: string) {
  let q = db.selectFrom('enquiries').select((eb) => eb.fn.countAll<number>().as('n'))
  if (status) q = q.where('status', '=', status as 'new')
  const row = await q.executeTakeFirst()
  return Number(row?.n ?? 0)
}

export async function referenceCounts(db: Db) {
  const [costHeads, units, numbering] = await Promise.all([
    db.selectFrom('cost_heads').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst(),
    db.selectFrom('units').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst(),
    db.selectFrom('document_numbering').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst(),
  ])
  return {
    costHeads: Number(costHeads?.n ?? 0),
    units: Number(units?.n ?? 0),
    numbering: Number(numbering?.n ?? 0),
  }
}

export async function listCostHeads(db: Queryable) {
  return db
    .selectFrom('cost_heads')
    .select(['id', 'code', 'name', 'parent_id', 'head_type', 'is_direct_cost', 'sort_order', 'is_active'])
    .orderBy('sort_order')
    .orderBy('code')
    .execute()
}

export async function listUnits(db: Queryable) {
  return db.selectFrom('units').select(['id', 'code', 'name', 'decimal_places']).orderBy('code').execute()
}

export async function listNumbering(db: Queryable) {
  return db
    .selectFrom('document_numbering')
    .select(['id', 'doc_type', 'prefix', 'fy_reset', 'financial_year', 'last_number'])
    .orderBy('doc_type')
    .orderBy('financial_year', 'desc')
    .execute()
}
