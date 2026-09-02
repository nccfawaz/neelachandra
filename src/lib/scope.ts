import type { Queryable } from '../db/kysely.js'
import { today } from './dates.js'

/**
 * Row level project scoping (spec 4.4).
 *
 * The rule that matters: list endpoints do not filter in JavaScript. The
 * scope becomes a subquery in the WHERE clause, because filtering after the
 * fetch leaks row counts and pagination totals even when it hides the rows.
 */

export interface ScopeContext {
  userId: number
  scopeToAssignedProjects: boolean
}

/**
 * Project ids the user is assigned to on a given business date. An
 * assignment counts when from_date has passed and to_date is either open or
 * still in the future, so removing somebody from a project is a dated act
 * rather than a delete.
 */
export async function assignedProjectIds(
  db: Queryable,
  userId: number,
  onDate: string = today()
): Promise<number[]> {
  const rows = await db
    .selectFrom('project_assignments')
    .select('project_id')
    .distinct()
    .where('user_id', '=', userId)
    .where('from_date', '<=', onDate)
    .where((eb) => eb.or([eb('to_date', 'is', null), eb('to_date', '>=', onDate)]))
    .execute()

  return rows.map((r) => Number(r.project_id))
}

/**
 * Whether a scoped user may see one project. Callers turn false into 404,
 * never 403: a supervisor must not learn that a project exists by probing
 * ids (spec 4.4).
 */
export async function hasProjectAccess(
  db: Queryable,
  ctx: ScopeContext,
  projectId: number,
  onDate: string = today()
): Promise<boolean> {
  if (!ctx.scopeToAssignedProjects) {
    const exists = await db
      .selectFrom('projects')
      .select('id')
      .where('id', '=', projectId)
      .executeTakeFirst()
    return exists !== undefined
  }

  const row = await db
    .selectFrom('project_assignments')
    .select('id')
    .where('user_id', '=', ctx.userId)
    .where('project_id', '=', projectId)
    .where('from_date', '<=', onDate)
    .where((eb) => eb.or([eb('to_date', 'is', null), eb('to_date', '>=', onDate)]))
    .executeTakeFirst()

  return row !== undefined
}

/**
 * The scope for a list query.
 *
 * null means unscoped: add no project predicate at all.
 * An array means restrict to those ids. A scoped user with zero assignments
 * gets [], never null, so an unassigned supervisor sees an empty list rather
 * than the whole company.
 */
export async function projectScopeFilter(
  db: Queryable,
  ctx: ScopeContext,
  onDate: string = today()
): Promise<number[] | null> {
  if (!ctx.scopeToAssignedProjects) return null
  return assignedProjectIds(db, ctx.userId, onDate)
}

/**
 * Locations a scoped user may touch: the site stores of their projects, plus
 * the permanent locations that are not tied to a project (central store,
 * transit, office). Without transit in the list a scoped user could not
 * receive an inbound transfer, which is half of the two-step transfer.
 */
export async function accessibleLocationIds(
  db: Queryable,
  ctx: ScopeContext,
  onDate: string = today()
): Promise<number[] | null> {
  if (!ctx.scopeToAssignedProjects) return null

  const projectIds = await assignedProjectIds(db, ctx.userId, onDate)

  let q = db.selectFrom('locations').select('id').where('is_active', '=', 1)

  q = q.where((eb) =>
    eb.or(
      projectIds.length > 0
        ? [eb('project_id', 'is', null), eb('project_id', 'in', projectIds)]
        : [eb('project_id', 'is', null)]
    )
  )

  const rows = await q.execute()
  return rows.map((r) => Number(r.id))
}
