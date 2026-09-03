import type { Queryable } from '../db/kysely.js'

/**
 * Notifications, addressed by permission rather than by role.
 *
 * Extracted from src/modules/inventory/service.ts when CRM needed the same
 * thing. The reason it moved rather than being copied — this tree's default is
 * to copy a helper rather than share it — is that usersWithPermission encodes
 * the deny-before-grant override precedence, which is a fact about how RBAC
 * resolves and has to agree with loadEffectivePermissions in lib/permissions.ts.
 * A second copy of that precedence is a second place for it to drift. A Zod
 * trim helper is a local idiom; this is not.
 */

/**
 * The users who should hear about something, resolved by permission key rather
 * than by role name.
 *
 * The module specs name recipients as "the procurement lead", "the owner" and
 * "accounts". Open question 8.1 has not settled the role list, so matching on a
 * role key would break the day a role is renamed. A permission key is the
 * durable identity of a duty here.
 *
 * The precedence matches loadEffectivePermissions: a deny override removes a
 * user the role granted, and a grant override adds one, with deny subtracted
 * before grant is added.
 */
export async function usersWithPermission(db: Queryable, key: string): Promise<number[]> {
  const viaRole = await db
    .selectFrom('users')
    .innerJoin('user_roles', 'user_roles.user_id', 'users.id')
    .innerJoin('role_permissions', 'role_permissions.role_id', 'user_roles.role_id')
    .innerJoin('permissions', 'permissions.id', 'role_permissions.permission_id')
    .select('users.id')
    .where('permissions.key', '=', key)
    .where('users.status', '=', 'active')
    .execute()

  const overrides = await db
    .selectFrom('user_permission_overrides')
    .innerJoin('permissions', 'permissions.id', 'user_permission_overrides.permission_id')
    .innerJoin('users', 'users.id', 'user_permission_overrides.user_id')
    .select(['user_permission_overrides.user_id', 'user_permission_overrides.effect'])
    .where('permissions.key', '=', key)
    .where('users.status', '=', 'active')
    .execute()

  const ids = new Set(viaRole.map((r) => Number(r.id)))
  for (const o of overrides) if (o.effect === 'deny') ids.delete(Number(o.user_id))
  for (const o of overrides) if (o.effect === 'grant') ids.add(Number(o.user_id))
  return [...ids]
}

/**
 * Writes one notification per recipient, skipping the actor.
 *
 * Nobody needs telling about their own action, and a self-notification in an
 * approval queue is how a queue stops being read.
 */
export async function notify(
  db: Queryable,
  opts: {
    userIds: readonly number[]
    exceptUserId?: number
    kind: string
    title: string
    body?: string | null
    linkPath?: string | null
    severity?: 'info' | 'warn' | 'critical'
  }
): Promise<void> {
  const targets = [...new Set(opts.userIds)].filter((id) => id !== opts.exceptUserId)
  if (targets.length === 0) return

  await db
    .insertInto('notifications')
    .values(
      targets.map((userId) => ({
        user_id: userId,
        kind: opts.kind,
        title: opts.title.slice(0, 200),
        body: opts.body ?? null,
        link_path: opts.linkPath ?? null,
        severity: opts.severity ?? 'info',
      }))
    )
    .execute()
}

/** Notifies whoever holds a permission. One query, then one insert. */
export async function notifyPermission(
  db: Queryable,
  key: string,
  opts: {
    actorId: number
    kind: string
    title: string
    body?: string | null
    linkPath?: string | null
    severity?: 'info' | 'warn' | 'critical'
  }
): Promise<void> {
  const userIds = await usersWithPermission(db, key)
  await notify(db, { ...opts, userIds, exceptUserId: opts.actorId })
}
