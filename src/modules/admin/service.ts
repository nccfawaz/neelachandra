import type { Db } from '../../db/kysely.js'
import { writeAudit } from '../../lib/audit.js'
import { destroyAllUserSessions } from '../../lib/session.js'
import { BadRequestError, ConflictError, NotFoundError } from '../../lib/errors.js'
import { issueInvite } from '../auth/service.js'
import { invalidateSettings, coerceSetting } from '../../lib/settings.js'
import { otherActiveOwnerCount, userByEmail } from './queries.js'

/**
 * Admin policy (spec 6.2).
 *
 * Every mutation here runs in a transaction with its audit row, because these
 * are the changes that alter who can do what. An audit log that is missing
 * the grant which caused an incident is not an audit log.
 */

export interface Actor {
  userId: number
  ip: string | null
}

export async function createUser(
  db: Db,
  actor: Actor,
  input: { email: string; fullName: string; phone: string | null; roleIds: number[]; employeeId: number | null }
): Promise<{ userId: number; inviteLink: string }> {
  const existing = await userByEmail(db, input.email)
  if (existing) throw new ConflictError('An account with that email already exists.')

  const userId = await db.transaction().execute(async (trx) => {
    const inserted = await trx
      .insertInto('users')
      .values({
        email: input.email.toLowerCase(),
        full_name: input.fullName,
        phone: input.phone,
        // No password is set here. The account is created in the invited
        // state and the person chooses their own password from the invite
        // link, so no administrator ever knows a user's password (spec 4.5).
        status: 'invited',
        must_change_password: 0,
        employee_id: input.employeeId,
      })
      .executeTakeFirst()

    const id = Number(inserted.insertId ?? 0)
    if (!id) throw new Error('User insert returned no id')

    if (input.roleIds.length > 0) {
      await trx
        .insertInto('user_roles')
        .values(input.roleIds.map((roleId) => ({ user_id: id, role_id: roleId, granted_by: actor.userId })))
        .execute()
    }

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'user.create',
      entityType: 'user',
      entityId: id,
      after: { email: input.email, fullName: input.fullName, roleIds: input.roleIds },
      ip: actor.ip,
    })

    return id
  })

  // The invite is issued after the transaction commits. Inside it, a mail
  // failure would roll back the user, and the token row must be visible to
  // the link before the email can be acted on.
  const inviteLink = await issueInvite(db, userId, input.email, input.fullName, actor.ip)
  return { userId, inviteLink }
}

export async function setUserStatus(
  db: Db,
  actor: Actor,
  userId: number,
  status: 'active' | 'suspended' | 'inactive'
): Promise<void> {
  if (userId === actor.userId && status !== 'active') {
    // Locking yourself out is not a permission question, it is a mistake
    // that needs another administrator to undo.
    throw new BadRequestError('You cannot suspend or deactivate your own account.')
  }

  await db.transaction().execute(async (trx) => {
    const before = await trx
      .selectFrom('users')
      .select(['id', 'email', 'status'])
      .where('id', '=', userId)
      .forUpdate()
      .executeTakeFirst()
    if (!before) throw new NotFoundError('No such user.')

    // Removing the last active owner would leave nobody able to grant
    // permissions, which is unrecoverable without database access.
    if (before.status === 'active' && status !== 'active') {
      const isOwner = await trx
        .selectFrom('user_roles')
        .innerJoin('roles', 'roles.id', 'user_roles.role_id')
        .select('roles.key')
        .where('user_roles.user_id', '=', userId)
        .where('roles.key', '=', 'owner')
        .executeTakeFirst()
      if (isOwner && (await otherActiveOwnerCount(trx, userId)) === 0) {
        throw new ConflictError('This is the last active owner. Grant the owner role to someone else first.')
      }
    }

    await trx.updateTable('users').set({ status }).where('id', '=', userId).execute()

    // Suspension deletes sessions in the same transaction (spec 6.2). Doing
    // it afterwards leaves a window in which a suspended user is still
    // browsing with a live cookie.
    if (status !== 'active') await destroyAllUserSessions(trx, userId)

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'user.status',
      entityType: 'user',
      entityId: userId,
      before: { status: before.status },
      after: { status },
      ip: actor.ip,
    })
  })
}

export async function replaceUserRoles(
  db: Db,
  actor: Actor,
  userId: number,
  roleIds: number[]
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const user = await trx
      .selectFrom('users')
      .select(['id', 'status'])
      .where('id', '=', userId)
      .forUpdate()
      .executeTakeFirst()
    if (!user) throw new NotFoundError('No such user.')

    const before = await trx.selectFrom('user_roles').select('role_id').where('user_id', '=', userId).execute()
    const beforeIds = before.map((r) => Number(r.role_id))

    const ownerRole = await trx.selectFrom('roles').select('id').where('key', '=', 'owner').executeTakeFirst()
    const ownerId = ownerRole ? Number(ownerRole.id) : null

    // Blocks removing the last owner (spec 6.2).
    if (ownerId !== null && beforeIds.includes(ownerId) && !roleIds.includes(ownerId)) {
      if ((await otherActiveOwnerCount(trx, userId)) === 0) {
        throw new ConflictError('This is the last owner. Grant the owner role to someone else first.')
      }
    }

    // Reject unknown ids rather than silently dropping them, so a stale form
    // does not quietly remove a role the admin thought they were keeping.
    if (roleIds.length > 0) {
      const valid = await trx.selectFrom('roles').select('id').where('id', 'in', roleIds).execute()
      if (valid.length !== roleIds.length) throw new BadRequestError('One of those roles no longer exists.')
    }

    await trx.deleteFrom('user_roles').where('user_id', '=', userId).execute()
    if (roleIds.length > 0) {
      await trx
        .insertInto('user_roles')
        .values(roleIds.map((roleId) => ({ user_id: userId, role_id: roleId, granted_by: actor.userId })))
        .execute()
    }

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'user.roles',
      entityType: 'user',
      entityId: userId,
      before: { roleIds: beforeIds },
      after: { roleIds },
      ip: actor.ip,
    })
  })
}

export async function addOverride(
  db: Db,
  actor: Actor,
  userId: number,
  input: { permissionKey: string; effect: 'grant' | 'deny'; note: string }
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const permission = await trx
      .selectFrom('permissions')
      .select(['id', 'key'])
      .where('key', '=', input.permissionKey)
      .executeTakeFirst()
    if (!permission) throw new BadRequestError('No such permission.')

    const user = await trx.selectFrom('users').select('id').where('id', '=', userId).executeTakeFirst()
    if (!user) throw new NotFoundError('No such user.')

    // One override per user per permission. A grant and a deny for the same
    // key would make the effective set depend on row order.
    await trx
      .deleteFrom('user_permission_overrides')
      .where('user_id', '=', userId)
      .where('permission_id', '=', Number(permission.id))
      .execute()

    await trx
      .insertInto('user_permission_overrides')
      .values({
        user_id: userId,
        permission_id: Number(permission.id),
        effect: input.effect,
        granted_by: actor.userId,
        note: input.note,
      })
      .execute()

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'user.override_add',
      entityType: 'user',
      entityId: userId,
      after: { permission: permission.key, effect: input.effect, note: input.note },
      ip: actor.ip,
    })
  })
}

export async function removeOverride(db: Db, actor: Actor, overrideId: number): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('user_permission_overrides')
      .innerJoin('permissions', 'permissions.id', 'user_permission_overrides.permission_id')
      .select([
        'user_permission_overrides.id',
        'user_permission_overrides.user_id',
        'user_permission_overrides.effect',
        'permissions.key',
      ])
      .where('user_permission_overrides.id', '=', overrideId)
      .executeTakeFirst()
    if (!row) throw new NotFoundError('No such override.')

    await trx.deleteFrom('user_permission_overrides').where('id', '=', overrideId).execute()

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'user.override_remove',
      entityType: 'user',
      entityId: Number(row.user_id),
      before: { permission: row.key, effect: row.effect },
      ip: actor.ip,
    })
  })
}

export async function setRolePermissions(
  db: Db,
  actor: Actor,
  roleId: number,
  permissionIds: number[]
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const role = await trx
      .selectFrom('roles')
      .select(['id', 'key', 'label', 'is_system'])
      .where('id', '=', roleId)
      .forUpdate()
      .executeTakeFirst()
    if (!role) throw new NotFoundError('No such role.')

    // The owner role is the recovery path. If its permissions could be
    // edited, one bad save could remove roles.manage from the only account
    // that can restore it.
    if (role.key === 'owner') {
      throw new ConflictError('The owner role always holds every permission and cannot be edited.')
    }

    const before = await trx
      .selectFrom('role_permissions')
      .select('permission_id')
      .where('role_id', '=', roleId)
      .execute()

    await trx.deleteFrom('role_permissions').where('role_id', '=', roleId).execute()
    if (permissionIds.length > 0) {
      await trx
        .insertInto('role_permissions')
        .values(permissionIds.map((permissionId) => ({ role_id: roleId, permission_id: permissionId })))
        .execute()
    }

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'role.permissions',
      entityType: 'role',
      entityId: roleId,
      before: { permissionIds: before.map((r) => Number(r.permission_id)) },
      after: { permissionIds },
      ip: actor.ip,
    })
  })
}

export async function saveSettings(
  db: Db,
  actor: Actor,
  submitted: Record<string, string>
): Promise<number> {
  const rows = await db.selectFrom('settings').select(['id', 'key_name', 'value_json', 'data_type']).execute()
  let changed = 0

  await db.transaction().execute(async (trx) => {
    for (const row of rows) {
      const raw = submitted[`s_${row.key_name}`]
      // A bool that is off is absent from a form post, so undefined means
      // "unchecked" for bool and "not on this form" for everything else.
      if (raw === undefined && row.data_type !== 'bool') continue

      const next = coerceSetting(row.data_type, raw ?? '')
      const nextJson = JSON.stringify(next)
      if (nextJson === row.value_json) continue

      await trx
        .updateTable('settings')
        .set({ value_json: nextJson, updated_by: actor.userId })
        .where('id', '=', row.id)
        .execute()

      await writeAudit(trx, {
        userId: actor.userId,
        action: 'setting.update',
        entityType: 'setting',
        entityId: Number(row.id),
        before: { key: row.key_name, value: row.value_json },
        after: { key: row.key_name, value: nextJson },
        ip: actor.ip,
      })
      changed += 1
    }
  })

  invalidateSettings()
  return changed
}

export async function setEnquiryStatus(
  db: Db,
  actor: Actor,
  enquiryId: number,
  status: 'new' | 'contacted' | 'promoted' | 'spam' | 'closed'
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const before = await trx
      .selectFrom('enquiries')
      .select(['id', 'status'])
      .where('id', '=', enquiryId)
      .forUpdate()
      .executeTakeFirst()
    if (!before) throw new NotFoundError('No such enquiry.')

    await trx
      .updateTable('enquiries')
      .set({ status, handled_by: actor.userId })
      .where('id', '=', enquiryId)
      .execute()

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'enquiry.status',
      entityType: 'enquiry',
      entityId: enquiryId,
      before: { status: before.status },
      after: { status },
      ip: actor.ip,
    })
  })
}
