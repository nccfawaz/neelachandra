import { sql } from 'kysely'
import type { Kysely } from 'kysely'

/**
 * The fixture marker (DECISIONS 29.4).
 *
 * Every integration fixture row carries a stable, greppable marker:
 * full_name / name / email begins with FIXTURE_MARKER ('[fixture]'). The
 * teardown deletes by that marker CHILD-FIRST — roles before users, FK
 * references nulled before invoices — so a crashed run leaves nothing a
 * later run trips over, and no row a suite counts is invisible to cleanup.
 *
 * Why a marker rather than high-water ids alone: a suite that dies mid-run
 * leaves rows behind, and a user row without its user_roles row is visible
 * to every suite that counts users (29.4: crm-flow's assignableUsers read 4
 * where 2 was true). High-water cleanup is correct only when it runs; the
 * marker cleanup is idempotent — nextSuite Can run it before AND after.
 *
 * The accounting_periods collision is the other half: a period's identity is
 * (financial_year, month), not an id, so high-water cleanup by id misses
 * nothing but a fixture year must still be unique per run. Fixture periods
 * use the FIXTURE_PERIOD_YEARS prefix and cleanup deletes any
 * 'TF-'-prefixed year, so a crashed run's period cannot collide with the
 * next run's.
 */
export const FIXTURE_MARKER = '[fixture]'
export const FIXTURE_PERIOD_PREFIX = 'TF-'

/** A fixture user email: unique per run, marked for cleanup. */
export function fixtureEmail(basename: string): string {
  return `fixture.${basename}.${Math.random().toString(36).slice(2, 10)}@example.invalid`
}

/** A fixture full_name or other name-like column: marked for cleanup. */
export function fixtureName(base: string): string {
  return `${FIXTURE_MARKER} ${base}`
}

/**
 * The shared sweep: deletes fixture rows child-first, by marker, from the
 * tables every integration suite touches. Idempotent — call it at the start
 * of beforeAll (clearing a crashed predecessor) as well as in afterAll.
 *
 * Tables deliberately absent: expenses, payments, client_invoices, projects,
 * clients, leads — each suite owns those through its own high-water cleanup
 * keyed on ids it captured, and a global delete by marker there would reach
 * across suites. The user row is the cross-suite hazard (it is counted by
 * name in crm-flow's assignableUsers) so it is swept globally here, and the
 * period rows are swept globally because their uniqueness is per-year.
 */
export async function sweepFixtures(db: Kysely<any>): Promise<void> {
  // Children before parents. Users are referenced by created_by across many
  // tables (vendors, items, projects, clients, expenses, audit_log), and items
  // are referenced by package_spec_lines/item_stock/item_brands — a crashed
  // run leaves exactly these, so the sweep removes them before the users and
  // items themselves.
  await sql`delete a from audit_log a join users u on a.user_id = u.id where u.full_name like ${FIXTURE_MARKER + '%'}`.execute(db)
  await sql`delete v from vendors v join users u on v.created_by = u.id where u.full_name like ${FIXTURE_MARKER + '%'}`.execute(db)
  await sql`delete e from expenses e join users u on e.created_by = u.id where u.full_name like ${FIXTURE_MARKER + '%'}`.execute(db)
  await sql`delete p from projects p join users u on p.created_by = u.id where u.full_name like ${FIXTURE_MARKER + '%'}`.execute(db)
  await sql`delete c from clients c join users u on c.created_by = u.id where u.full_name like ${FIXTURE_MARKER + '%'}`.execute(db)
  await sql`delete i from items i join users u on i.created_by = u.id where u.full_name like ${FIXTURE_MARKER + '%'}`.execute(db)
  await sql`delete psl from package_spec_lines psl join items i on psl.item_id = i.id where i.name like ${FIXTURE_MARKER + '%'}`.execute(db)
  await sql`delete ur from user_roles ur join users u on ur.user_id = u.id where u.full_name like ${FIXTURE_MARKER + '%'}`.execute(db)
  await sql`delete from users where full_name like ${FIXTURE_MARKER + '%'}`.execute(db)
  await sql`delete from accounting_periods where financial_year like ${FIXTURE_PERIOD_PREFIX + '%'}`.execute(db)
}
