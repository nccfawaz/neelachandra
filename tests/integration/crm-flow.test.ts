import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getDb } from '../../src/db/kysely.js'
import { closePool } from '../../src/db/pool.js'
import { addDays, today } from '../../src/lib/dates.js'
import * as q from '../../src/modules/crm/queries.js'
import * as svc from '../../src/modules/crm/service.js'
import { leadSchema, quoteSchema, visitCompleteSchema } from '../../src/modules/crm/schemas.js'

/*
 * The CRM module, executed against MariaDB.
 *
 * tests/crm-score.test.ts pins the arithmetic and none of it touches a
 * database. That is the gap this file closes: every function in service.ts is a
 * transaction and every function in queries.ts is a join, and neither tsc nor a
 * unit test can tell whether a column exists, an enum accepts a value, a
 * FOR UPDATE deadlocks, or a foreign key refuses an insert. The 2026-09-03 hang
 * that tests/integration/db-smoke.test.ts records is the precedent: green
 * everywhere, broken against a server.
 *
 * So this suite walks the sale end to end in the order a sales executive would,
 * and asserts the refusals as hard as the successes. Three of them are the point
 * of the exercise:
 *
 *   - changeStage into quote_sent is refused with no completed site visit, and
 *     createQuote is refused for the same reason. They are separate holes:
 *     without the first, a lead sits in quote_sent with no quote in existence
 *     and the pipeline reports a document nobody sent.
 *   - approveQuote refuses the person who raised the quote.
 *   - convertLeadToProject refuses a lead that already became a project.
 *
 * Fixtures. The dev database has no users, leads, clients or projects, so this
 * file creates the two users it needs and one approval_limits row, both with
 * obviously fake names, and removes them afterwards. Cleanup is by id above a
 * high-water mark captured before anything is written, which deletes exactly the
 * rows this run created and nothing that was there first. Kysely 0.27 has no
 * savepoints, so wrapping the service calls in one outer rollback is not
 * available: the services open their own transactions and an outer one would
 * deadlock against them.
 *
 * approval_limits is seeded empty pending open question 8.2. The row created
 * here is a fixture for the escalation path, not a decision about anyone's real
 * ceiling: 250 bps, low enough that the 5% discount below has to escalate.
 */

const db = getDb()

/** Child before parent. This is also the delete order in cleanup. */
const TRACKED = [
  'quote_lines',
  'quotes',
  'lead_activities',
  'lead_stage_history',
  'site_visits',
  'leads',
  'project_milestones',
  'project_stages',
  'locations',
  'projects',
  'clients',
  'competitors',
  'enquiries',
  'notifications',
  'audit_log',
  'email_log',
  'approval_limits',
  'users',
] as const

const highWater = new Map<string, number>()

/** Fake staff. Open question 8.1 is unanswered, so no real name appears here. */
const SELLER = { email: 'fixture.seller@example.invalid', full_name: 'Fixture Seller One' }
const APPROVER = { email: 'fixture.approver@example.invalid', full_name: 'Fixture Approver Two' }
const SALES_EXEC_ROLE = 8

let seller = { userId: 0, ip: '127.0.0.1' as string | null }
let approver = { userId: 0, ip: '127.0.0.1' as string | null }

/* The sale, threaded through the suite in order. */
let leadId = 0
let leadNo = ''
let visitId = 0
let quoteId = 0
let projectId = 0

async function insertUser(u: { email: string; full_name: string }): Promise<number> {
  const row = await db
    .insertInto('users')
    .values({ email: u.email, full_name: u.full_name, status: 'active', must_change_password: 0 })
    .executeTakeFirst()
  const id = Number(row.insertId ?? 0)
  await db.insertInto('user_roles').values({ user_id: id, role_id: SALES_EXEC_ROLE }).execute()
  return id
}

beforeAll(async () => {
  for (const table of TRACKED) {
    const res = await sql<{ n: number | null }>`select max(id) as n from ${sql.table(table)}`.execute(db)
    highWater.set(table, Number(res.rows[0]?.n ?? 0))
  }

  seller = { userId: await insertUser(SELLER), ip: '127.0.0.1' }
  approver = { userId: await insertUser(APPROVER), ip: '127.0.0.1' }

  await db
    .insertInto('approval_limits')
    .values({
      role_key: 'sales_exec',
      document_type: 'quote_discount_pct',
      max_value: 250,
      effective_from: '2026-04-01',
    })
    .execute()
})

afterAll(async () => {
  // Scoped to this run's rows. user_roles has no id column, so it goes by the
  // user high-water mark and has to precede users.
  await sql`delete from user_roles where user_id > ${highWater.get('users') ?? 0}`.execute(db)
  for (const table of TRACKED) {
    await sql`delete from ${sql.table(table)} where id > ${highWater.get(table) ?? 0}`.execute(db)
  }
  await closePool()
})

/** The service takes parsed input, so the schemas are exercised on the way in. */
function leadInput(over: Record<string, string> = {}) {
  return leadSchema.parse({
    contactName: 'Fixture Client Alpha',
    phone: '9800000001',
    email: 'fixture.client.alpha@example.invalid',
    enquiryType: 'residential_construction',
    siteCity: 'Bengaluru',
    siteLocality: 'Nelamangala',
    plotAreaSqft: '2400',
    targetBuiltUpSqft: '2000',
    floorsWanted: '2',
    plotOwnership: 'owned_clear_title',
    hasSanctionedPlan: '1',
    // Rupees in the form, paise in the column. The ceiling has to clear
    // 2000 sqft x Rs 3099 = Rs 61,98,000 for the budget signal to score full.
    budgetMinPaise: '5500000',
    budgetMaxPaise: '6500000',
    preferredPackageId: '3',
    fundingMode: 'loan_sanctioned',
    expectedStart: 'immediate',
    leadSourceId: '1',
    ...over,
  })
}

/**
 * A Gold-package quote: 2000 sqft at Rs 3099, one addon line, 5% off.
 *
 * The discount is 500 bps against the fixture ceiling of 250, so submitQuote has
 * to escalate rather than self-approve — which is the branch worth executing,
 * since it is the only one that writes a notification and leaves the quote in
 * pending_approval for a second person.
 */
function quoteInput(over: Record<string, unknown> = {}) {
  return quoteSchema.parse({
    leadId: String(leadId),
    packageId: '3',
    quoteDate: today(),
    validUntil: addDays(today(), 15),
    pricingBasis: 'per_sqft',
    builtUpAreaSqft: '2000',
    ratePerSqft: '3099',
    discountPct: '5',
    gstPct: '18',
    exclusions: 'Compound wall\nLandscaping\nSolar water heater\nModular kitchen',
    lineType: ['addon'],
    lineDescription: ['Borewell, 300 ft'],
    lineQty: [''],
    lineUnitId: [''],
    lineRate: ['185000'],
    lineCostHeadId: [''],
    scheduleName: ['Advance on signing', 'Roof slab cast', 'Handover'],
    schedulePercent: ['20', '50', '30'],
    scheduleStageSeq: ['', '', ''],
    ...over,
  })
}

describe('the sale, end to end against MariaDB', () => {
  it('creates a lead, numbers it and scores it', async () => {
    const out = await svc.createLead(db, seller, leadInput(), seller.userId)
    leadId = out.leadId
    leadNo = out.leadNo

    expect(leadId).toBeGreaterThan(0)
    // NCC/LEAD/2026-27/001 — the prefix comes from document_numbering, which
    // nextNumber inserts for the financial year on first use.
    expect(out.leadNo).toMatch(/\/2\d{3}-\d{2}\/\d{3}$/)
    // Everything but the served-area and budget signals is answered, and both of
    // those are too: 100 is the whole of rule 1.
    expect(out.score).toBe(100)

    const lead = await q.findLead(db, leadId, true)
    expect(lead?.stage).toBe('new')
    expect(lead?.temperature).toBe('hot')
    // expected_value_paise is 2000 x Rs 3099 from the preferred package.
    expect(Number(lead?.expected_value_paise)).toBe(619800000)
  })

  it('records the opening stage in the history rather than inferring it', async () => {
    const history = await q.leadStageHistory(db, leadId)
    expect(history).toHaveLength(1)
    expect(history[0]!.from_stage).toBeNull()
    expect(history[0]!.to_stage).toBe('new')
  })

  it('logs the first activity and marks it as the first response', async () => {
    const out = await svc.logActivity(db, seller, leadId, {
      // 'call' is not a member: the column splits the direction, and logActivity
      // casts to 'call_out' because that is the enum's outbound member.
      activityType: 'call_out',
      occurredAt: `${today()} 09:30:00`,
      durationMinutes: 6,
      outcome: 'connected',
      summary: 'Called back. Plot is registered, sanction plan in hand, wants to start this month.',
      nextAction: 'Book the site visit',
      nextActionDate: today(),
    })

    expect(out.activityId).toBeGreaterThan(0)
    expect(out.firstResponse).toBe(true)

    const second = await svc.logActivity(db, seller, leadId, {
      activityType: 'note',
      occurredAt: `${today()} 09:45:00`,
      durationMinutes: null,
      outcome: null,
      summary: 'Sent the package comparison over WhatsApp.',
      nextAction: null,
      nextActionDate: null,
    })
    // first_response_at is stamped once. A second activity is not a first
    // response, or the 4-hour report would never show a breach.
    expect(second.firstResponse).toBe(false)
  })

  it('moves the lead forward through the open stages', async () => {
    const out = await svc.changeStage(db, seller, leadId, { stage: 'qualified', note: 'Plot and funding confirmed.' })
    expect(out.from).toBe('new')
    expect(out.to).toBe('qualified')

    const lead = await q.findLead(db, leadId, true)
    // Rule 2: the stage sets the probability, replacing any override.
    expect(Number(lead?.probability_pct)).toBe(20)
  })

  it('refuses quote_sent with no completed site visit', async () => {
    // The gate this suite exists for. Without it the lead reads as quoted on the
    // board while no quote row exists.
    await expect(
      svc.changeStage(db, seller, leadId, { stage: 'quote_sent', note: null })
    ).rejects.toThrow(/no completed site visit/i)

    const lead = await q.findLead(db, leadId, true)
    expect(lead?.stage).toBe('qualified')
  })

  it('refuses to price a quote for the same reason', async () => {
    // A different hole through the same wall: this one would create the document.
    await expect(svc.createQuote(db, seller, quoteInput())).rejects.toThrow(/site visit/i)

    expect(await q.countQuotes(db, { all: true, userId: seller.userId }, {})).toBe(0)
  })

  it('books a site visit and moves the lead with it', async () => {
    const out = await svc.scheduleVisit(db, seller, {
      leadId,
      scheduledAt: `${today()} 11:00:00`,
      visitedBy: seller.userId,
    })
    visitId = out.visitId
    expect(visitId).toBeGreaterThan(0)

    const visit = await q.findVisit(db, visitId)
    expect(visit?.status).toBe('scheduled')
    expect(Number(visit?.lead_id)).toBe(leadId)
    expect(await q.hasCompletedVisit(db, leadId)).toBe(false)
  })

  it('completes the visit with a feasibility verdict', async () => {
    const input = visitCompleteSchema.parse({
      visitedAt: `${today()}T11:20`,
      visitedBy: String(seller.userId),
      soilType: 'Red loam over hard rock at 6 ft',
      roadAccess: 'narrow',
      waterAvailability: 'borewell',
      powerAvailability: '1',
      neighbouringStructures: 'Two-storey house on the north edge, shared wall.',
      levelDifferenceFt: '3.5',
      demolitionRequired: '0',
      treeCuttingPermissionNeeded: '1',
      accessConstraints: 'Transit mixer cannot turn at the last 40 m. Pump needed.',
      feasibility: 'feasible_with_conditions',
      conditionsNotes: 'Retaining wall on the north edge and a concrete pump for every pour.',
      estimatedExtraCostPaise: '75000',
    })

    const out = await svc.completeVisit(db, seller, visitId, input)
    expect(out.leadId).toBe(leadId)

    // The datetime-local transform has to produce something MariaDB stores as
    // given: dateStrings is on, so a bad transform shows up as a string here.
    const visit = await q.findVisit(db, visitId)
    expect(visit?.status).toBe('completed')
    expect(String(visit?.visited_at)).toBe(`${today()} 11:20:00`)
    expect(Number(visit?.level_difference_ft)).toBe(3.5)
    expect(Number(visit?.estimated_extra_cost_paise)).toBe(7500000)

    expect(await q.hasCompletedVisit(db, leadId)).toBe(true)

    const lead = await q.findLead(db, leadId, true)
    expect(lead?.stage).toBe('site_visit_done')
    expect(Number(lead?.probability_pct)).toBe(35)

    // The visit writes its own timeline row, so the follow-up cron does not
    // read a visited lead as silence.
    const acts = await q.leadActivities(db, leadId)
    expect(acts.some((a) => a.activity_type === 'site_visit')).toBe(true)
  })

  it('prices the quote from the package rate, the lines and the visit extras', async () => {
    const out = await svc.createQuote(db, seller, quoteInput())
    quoteId = out.quoteId

    // 2000 x Rs 3099 = 619,800,000 base. Borewell Rs 1,85,000 plus the
    // surveyor's Rs 75,000 = 26,000,000 extras. 5% off both, then 18% GST.
    expect(out.totals.basePaise).toBe(619800000)
    expect(out.totals.extrasPaise).toBe(26000000)
    expect(out.totals.discountPaise).toBe(32290000)
    expect(out.totals.subtotalPaise).toBe(613510000)
    expect(out.totals.gstPaise).toBe(110431800)
    expect(out.totals.totalPaise).toBe(723941800)

    const quote = await q.findQuote(db, quoteId)
    expect(quote?.status).toBe('draft')
    expect(Number(quote?.revision)).toBe(1)
    // BIGINT paise through mysql2 arrives as a number here, but Number() is
    // applied everywhere in the codebase for the same reason DECIMAL is.
    expect(Number(quote?.total_paise)).toBe(723941800)

    const lines = await q.quoteLines(db, quoteId)
    // One typed addon plus the four exclusion notes, generated from the textarea.
    expect(lines.filter((l) => l.line_type === 'addon')).toHaveLength(1)
    expect(lines.filter((l) => l.line_type === 'exclusion_note')).toHaveLength(4)

    // The schedule has to survive the round trip in the shape the conversion
    // reads, because it generates the project's milestones from it and refuses
    // the whole conversion if it comes back empty. Asserted on the raw column,
    // not on the input — and the assertion is that it arrives *parsed*, which is
    // the fact the two readers had wrong.
    const raw = await db
      .selectFrom('quotes')
      .select('payment_schedule_json')
      .where('id', '=', quoteId)
      .executeTakeFirst()
    const stored = raw?.payment_schedule_json as unknown
    // MariaDB 11.4 reports this column as JSON and mysql2 parses it into an
    // Array; a server that reported it as plain text would hand back the string.
    // Both readers accept either, so this accepts either too — pinning the
    // driver's choice here would fail the build on a version difference that is
    // not a defect. What must hold is the content, and that the conversion below
    // can read it: three milestones, named, summing to 100.
    const rows = (typeof stored === 'string' ? JSON.parse(stored) : stored) as Array<
      Record<string, unknown>
    >
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.map((m) => m.name)).toEqual(['Advance on signing', 'Roof slab cast', 'Handover'])
    expect(rows.reduce((n, m) => n + Number(m.percent), 0)).toBe(100)
  })

  it('escalates a discount above the fixture ceiling instead of self-approving', async () => {
    const out = await svc.submitQuote(db, seller, quoteId, ['sales_exec'])

    expect(out.status).toBe('pending_approval')
    expect(out.discountPct).toBe(5)
    // 250 bps from the fixture row. The lookup is by role_key and
    // document_type = quote_discount_pct with effective_from in the past.
    expect(out.limitBps).toBe(250)
  })

  it('refuses the approval to the person who raised the quote', async () => {
    await expect(svc.approveQuote(db, seller, quoteId)).rejects.toThrow(/you raised this quote/i)

    const quote = await q.findQuote(db, quoteId)
    expect(quote?.status).toBe('pending_approval')
  })

  it('approves on a second pair of eyes', async () => {
    const out = await svc.approveQuote(db, approver, quoteId)
    expect(out.revision).toBe(1)
    expect(out.totalPaise).toBe(723941800)

    const quote = await q.findQuote(db, quoteId)
    expect(quote?.status).toBe('approved')
    expect(Number(quote?.approved_by)).toBe(approver.userId)
  })

  it('sends the quote, commits the status, and reports the mail failure', async () => {
    const out = await svc.sendQuote(db, seller, quoteId)

    expect(out.recipient).toBe('fixture.client.alpha@example.invalid')
    // SMTP_USER and SMTP_PASSWORD are empty in .env, so src/lib/mailer.ts builds
    // no transport and returns an error instead of opening a socket. This asserts
    // the design in the sendQuote doc comment: the status move commits first and
    // the mail outcome is reported, not rolled back.
    expect(out.emailed).toBe(false)
    expect(out.emailError).not.toBeNull()

    const quote = await q.findQuote(db, quoteId)
    expect(quote?.status).toBe('sent')
    expect(quote?.sent_at).not.toBeNull()

    const logged = await sql<{ n: number }>`
      select count(*) as n from email_log where id > ${highWater.get('email_log') ?? 0}
    `.execute(db)
    expect(Number(logged.rows[0]!.n)).toBeGreaterThan(0)
  })

  it('accepts the quote and moves the lead to verbal agreement', async () => {
    const out = await svc.acceptQuote(db, seller, quoteId, 'Client confirmed on the phone.')
    expect(out.leadId).toBe(leadId)

    const quote = await q.findQuote(db, quoteId)
    expect(quote?.status).toBe('accepted')

    const accepted = await q.acceptedQuotes(db, leadId)
    expect(accepted).toHaveLength(1)
  })
})

describe('conversion (one transaction, spec 6.7 rule 6)', () => {
  it('opens the project, the client, the stages, the milestones and the site store', async () => {
    const out = await svc.convertLeadToProject(db, seller, leadId, {
      plannedStart: addDays(today(), 21),
      contractSignedOn: today(),
    })
    projectId = out.projectId

    expect(out.projectCode).toMatch(/\/2\d{3}-\d{2}\/\d{3}$/)
    expect(out.clientCreated).toBe(true)
    expect(out.clientId).toBeGreaterThan(0)
    // Template 1 (residential construction, standard) has 12 stages seeded.
    expect(out.stageCount).toBe(12)
    expect(out.milestoneCount).toBe(3)
    // The contract value is the quote subtotal. GST is collected on top and held
    // as gst_pct, so booking it here would inflate every 6.8 margin by 18%.
    expect(out.contractValuePaise).toBe(613510000)

    const project = await db
      .selectFrom('projects')
      .select(['id', 'code', 'status', 'client_id', 'contract_value_paise', 'gst_pct', 'city', 'planned_start'])
      .where('id', '=', projectId)
      .executeTakeFirstOrThrow()
    expect(project.status).toBe('mobilising')
    expect(Number(project.contract_value_paise)).toBe(613510000)
    expect(Number(project.gst_pct)).toBe(18)
    expect(project.city).toBe('Bengaluru')
    expect(String(project.planned_start)).toBe(addDays(today(), 21))

    const stages = await db
      .selectFrom('project_stages')
      .select(({ fn }) => fn.countAll<number>().as('n'))
      .where('project_id', '=', projectId)
      .executeTakeFirstOrThrow()
    expect(Number(stages.n)).toBe(12)

    // generateMilestones apportions the contract value by weightage, so the
    // milestone amounts have to sum back to it exactly — the rounding is where a
    // paise goes missing.
    const milestones = await db
      .selectFrom('project_milestones')
      .select(['name', 'percent_of_contract', 'amount_paise'])
      .where('project_id', '=', projectId)
      .orderBy('id')
      .execute()
    expect(milestones.map((m) => m.name)).toEqual(['Advance on signing', 'Roof slab cast', 'Handover'])
    expect(milestones.map((m) => Number(m.percent_of_contract))).toEqual([20, 50, 30])
    expect(milestones.reduce((sum, m) => sum + Number(m.amount_paise), 0)).toBe(613510000)

    const store = await db
      .selectFrom('locations')
      .select(['code', 'location_type', 'city'])
      .where('project_id', '=', projectId)
      .executeTakeFirstOrThrow()
    expect(store.location_type).toBe('site_store')
    expect(store.code).toMatch(/^ST-\d{3}$/)
  })

  it('marks the lead won and points it at the project', async () => {
    const lead = await q.findLead(db, leadId, true)
    expect(lead?.stage).toBe('won')
    expect(Number(lead?.probability_pct)).toBe(100)
    expect(Number(lead?.converted_project_id)).toBe(projectId)
    expect(Number(lead?.client_id)).toBeGreaterThan(0)

    // leadStageHistory reads newest first, because the timeline renders that
    // way. The conversion's own row is therefore [0], not the tail.
    const history = await q.leadStageHistory(db, leadId)
    expect(history[0]!.to_stage).toBe('won')
    expect(history[0]!.from_stage).toBe('verbal_agreement')
    expect(history[history.length - 1]!.to_stage).toBe('new')
  })

  it('notified the people who can see projects', async () => {
    // Proves the notifyPermission join ran and inserted: sales_exec holds
    // projects.view, and the actor is not notified about their own action.
    const rows = await db
      .selectFrom('notifications')
      .select(['user_id', 'kind'])
      .where('id', '>', highWater.get('notifications') ?? 0)
      .where('kind', '=', 'project_from_lead')
      .execute()
    expect(rows.map((r) => Number(r.user_id))).toEqual([approver.userId])
  })

  it('refuses a second conversion of the same lead', async () => {
    await expect(svc.convertLeadToProject(db, seller, leadId)).rejects.toThrow(/already/i)
  })

  it('refuses to move a won lead by hand', async () => {
    await expect(
      svc.changeStage(db, seller, leadId, { stage: 'negotiation', note: null })
    ).rejects.toThrow(/final/i)
  })
})

describe('the paths a sale takes when it does not close', () => {
  let enquiryId = 0
  let lostLeadId = 0
  let lostQuoteId = 0

  it('promotes an enquiry into a lead without retyping the contact', async () => {
    const inserted = await db
      .insertInto('enquiries')
      .values({
        name: 'Fixture Client Beta',
        phone: '9800000002',
        email: 'fixture.client.beta@example.invalid',
        city: 'Tumakuru',
        service_interest: 'Residential construction',
        message: 'Looking for a 1800 sqft duplex on a 30x40 site.',
        status: 'new',
      })
      .executeTakeFirst()
    enquiryId = Number(inserted.insertId ?? 0)

    const before = await q.enquiriesWithoutLead(db)
    expect(before.some((e) => Number(e.id) === enquiryId)).toBe(true)

    const out = await svc.leadFromEnquiry(db, seller, enquiryId, seller.userId)
    lostLeadId = out.leadId
    expect(out.leadNo).not.toBe(leadNo)

    const lead = await q.findLead(db, lostLeadId, true)
    expect(lead?.contact_name).toBe('Fixture Client Beta')
    expect(lead?.phone).toBe('9800000002')
    expect(lead?.site_city).toBe('Tumakuru')

    // The enquiry is marked promoted, so it stops appearing on the untouched list.
    const after = await q.enquiriesWithoutLead(db)
    expect(after.some((e) => Number(e.id) === enquiryId)).toBe(false)
    const enq = await q.findEnquiry(db, enquiryId)
    expect(enq?.status).toBe('promoted')
  })

  it('finds the duplicate by phone', async () => {
    // Lives in service.ts, not queries.ts: it is the check the lead form runs
    // before it writes, not a screen's read.
    const dupes = await svc.duplicatesByPhone(db, '9800000002')
    expect(dupes.map((d) => Number(d.id))).toEqual([lostLeadId])
    expect(await svc.duplicatesByPhone(db, '9800000002', lostLeadId)).toHaveLength(0)
  })

  it('reassigns the lead and takes an overridden probability', async () => {
    await svc.assignLead(db, seller, lostLeadId, { assignedTo: approver.userId, note: 'Handing over.' })
    await svc.changeStage(db, approver, lostLeadId, { stage: 'qualified', note: null })

    const out = await svc.setProbability(db, approver, lostLeadId, {
      probabilityPct: 45,
      note: 'Client has a competing quote in hand.',
    })
    expect(out.previousPct).toBe(20)

    const lead = await q.findLead(db, lostLeadId, true)
    expect(Number(lead?.assigned_to)).toBe(approver.userId)
    expect(Number(lead?.probability_pct)).toBe(45)
  })

  it('cancels a visit through the status route and refuses completion by it', async () => {
    const first = await svc.scheduleVisit(db, approver, {
      leadId: lostLeadId,
      scheduledAt: `${addDays(today(), 2)} 10:00:00`,
      visitedBy: approver.userId,
    })

    await expect(
      svc.setVisitStatus(db, approver, first.visitId, { status: 'completed', scheduledAt: null })
    ).rejects.toThrow(/feasibility form/i)

    await svc.setVisitStatus(db, approver, first.visitId, { status: 'cancelled', scheduledAt: null })
    expect((await q.findVisit(db, first.visitId))?.status).toBe('cancelled')
    // A cancelled visit is not a completed one, so the quote gate still holds.
    expect(await q.hasCompletedVisit(db, lostLeadId)).toBe(false)
  })

  it('self-approves a quote with no discount at all', async () => {
    const second = await svc.scheduleVisit(db, approver, {
      leadId: lostLeadId,
      scheduledAt: `${today()} 15:00:00`,
      visitedBy: approver.userId,
    })
    await svc.completeVisit(
      db,
      approver,
      second.visitId,
      visitCompleteSchema.parse({
        visitedAt: `${today()}T15:30`,
        feasibility: 'feasible',
        roadAccess: 'good',
        waterAvailability: 'corporation',
      })
    )

    const created = await svc.createQuote(
      db,
      approver,
      quoteSchema.parse({
        leadId: String(lostLeadId),
        packageId: '1',
        quoteDate: today(),
        validUntil: addDays(today(), 10),
        pricingBasis: 'per_sqft',
        builtUpAreaSqft: '1800',
        ratePerSqft: '',
        discountPct: '0',
        gstPct: '18',
        exclusions: 'Compound wall\nInterior furniture',
        lineType: [],
        lineDescription: [],
        lineQty: [],
        lineUnitId: [],
        lineRate: [],
        lineCostHeadId: [],
        scheduleName: ['Advance', 'On completion'],
        schedulePercent: ['40', '60'],
        scheduleStageSeq: ['', ''],
      })
    )
    lostQuoteId = created.quoteId
    // No rate posted, so the Silver package rate stands: 1800 x Rs 2299.
    expect(created.totals.basePaise).toBe(413820000)

    // Nothing is being given away, so there is nothing to approve.
    const submitted = await svc.submitQuote(db, approver, lostQuoteId, ['sales_exec'])
    expect(submitted.status).toBe('approved')
    expect(submitted.limitBps).toBeNull()
  })

  it('records a client rejection and revises onto a new revision', async () => {
    await svc.sendQuote(db, approver, lostQuoteId)
    await svc.rejectQuote(db, approver, lostQuoteId, 'Too high against the competitor.')
    expect((await q.findQuote(db, lostQuoteId))?.status).toBe('rejected')

    const revised = await svc.reviseQuote(
      db,
      approver,
      lostQuoteId,
      quoteSchema.parse({
        leadId: String(lostLeadId),
        packageId: '1',
        quoteDate: today(),
        validUntil: addDays(today(), 10),
        pricingBasis: 'per_sqft',
        builtUpAreaSqft: '1800',
        ratePerSqft: '2150',
        discountPct: '0',
        gstPct: '18',
        exclusions: 'Compound wall\nInterior furniture',
        lineType: [],
        lineDescription: [],
        lineQty: [],
        lineUnitId: [],
        lineRate: [],
        lineCostHeadId: [],
        scheduleName: ['Advance', 'On completion'],
        schedulePercent: ['40', '60'],
        scheduleStageSeq: ['', ''],
      })
    )
    // Same quote number, next revision, and the old one is superseded rather
    // than deleted: the client was shown it.
    expect(revised.revision).toBe(2)
    expect(revised.quoteNo).toBe((await q.findQuote(db, lostQuoteId))?.quote_no)
    expect((await q.findQuote(db, lostQuoteId))?.status).toBe('superseded')

    const revisions = await q.quoteRevisions(db, revised.quoteNo)
    expect(revisions).toHaveLength(2)
    expect(await q.leadQuotes(db, lostLeadId)).toHaveLength(2)
  })

  it('loses the lead and creates the competitor it was lost to', async () => {
    const out = await svc.loseLead(db, approver, lostLeadId, {
      lostReason: 'competitor',
      lostToCompetitor: 'Fixture Builders LLP',
      lostNotes: 'Quoted Rs 2050 a foot with the same specification.',
      competitorRatePerSqftPaise: 205000,
    })
    expect(out.competitorId).toBeGreaterThan(0)

    const lead = await q.findLead(db, lostLeadId, true)
    expect(lead?.stage).toBe('lost')
    expect(lead?.lost_reason).toBe('competitor')

    const rivals = await q.listCompetitors(db)
    const rival = rivals.find((r) => r.name === 'Fixture Builders LLP')
    expect(rival).toBeDefined()
    expect(Number(rival?.typical_rate_per_sqft_paise)).toBe(205000)
  })
})

/*
 * The read side. These run last so the aggregates have rows to aggregate: a
 * funnel report over an empty table proves the SQL parses and nothing else.
 *
 * Most of the assertions here are deliberately weak on content and strong on
 * execution. What they are for is the class of error tsc cannot see — a column
 * renamed, an enum value the schema does not have, a GROUP BY that MariaDB's
 * ONLY_FULL_GROUP_BY rejects, a join to a table that was dropped. Every one of
 * those is a 500 on a page that typechecks.
 */
describe('every read query the CRM screens use', () => {
  const ALL = { all: true, userId: 0 }

  it('lists and counts leads under both scopes', async () => {
    const all = await q.listLeads(db, ALL, { canViewValue: true, limit: 25, offset: 0 })
    expect(all.length).toBeGreaterThanOrEqual(2)
    expect(await q.countLeads(db, ALL, {})).toBe(all.length)

    // The gated column is absent from the select rather than blanked, so a page
    // without crm.view_pipeline_value cannot leak it through a template slip.
    const withoutValue = await q.listLeads(db, ALL, { canViewValue: false, limit: 25 })
    expect(withoutValue[0]).not.toHaveProperty('expected_value_paise')

    // Row-level scope: the won lead is the seller's, so the approver's own-only
    // scope must not return it.
    const mine = await q.listLeads(db, { all: false, userId: approver.userId }, { canViewValue: true })
    expect(mine.map((l) => Number(l.id))).not.toContain(leadId)

    expect(await q.leadVisible(db, ALL, leadId)).toBe(true)
    expect(await q.leadVisible(db, { all: false, userId: approver.userId }, leadId)).toBe(false)
  })

  it('applies each lead filter', async () => {
    expect(await q.countLeads(db, ALL, { stage: 'won' })).toBe(1)
    expect(await q.countLeads(db, ALL, { stage: 'lost' })).toBe(1)
    expect(await q.countLeads(db, ALL, { temperature: 'hot' })).toBeGreaterThanOrEqual(0)
    expect(await q.countLeads(db, ALL, { q: 'Fixture Client Alpha' })).toBe(1)
    expect(await q.countLeads(db, ALL, { assignedTo: seller.userId })).toBeGreaterThanOrEqual(1)
    expect(await q.countLeads(db, ALL, { source: 1 })).toBeGreaterThanOrEqual(1)
    expect(await q.countLeads(db, ALL, { unassigned: true })).toBe(0)
  })

  it('reads a lead timeline, its visits and its quotes', async () => {
    expect((await q.leadActivities(db, leadId)).length).toBeGreaterThan(0)
    expect((await q.leadStageHistory(db, leadId)).length).toBeGreaterThan(0)
    expect((await q.leadVisits(db, leadId)).length).toBe(1)
    expect((await q.leadQuotes(db, leadId)).length).toBe(1)
  })

  it('lists and counts visits with every filter', async () => {
    const visits = await q.listVisits(db, ALL, { limit: 25, offset: 0 })
    expect(visits.length).toBeGreaterThanOrEqual(3)
    expect(await q.countVisits(db, ALL, {})).toBe(visits.length)
    expect(await q.countVisits(db, ALL, { status: 'completed' })).toBe(2)
    expect(await q.countVisits(db, ALL, { status: 'cancelled' })).toBe(1)
    expect(
      await q.countVisits(db, ALL, { from: addDays(today(), -1), to: addDays(today(), 7) })
    ).toBeGreaterThanOrEqual(3)
  })

  it('lists and counts quotes with every filter', async () => {
    expect((await q.listQuotes(db, ALL, { limit: 25, offset: 0 })).length).toBe(3)
    expect(await q.countQuotes(db, ALL, {})).toBe(3)
    expect(await q.countQuotes(db, ALL, { status: 'accepted' })).toBe(1)
    expect(await q.countQuotes(db, ALL, { leadId })).toBe(1)
    expect(await q.countQuotes(db, ALL, { q: 'Fixture Client Alpha' })).toBe(1)
    expect((await q.quoteLines(db, quoteId)).length).toBeGreaterThan(0)
  })

  it('reads the package catalogue the quote builder offers', async () => {
    const packages = await q.packageOptions(db)
    expect(packages.length).toBeGreaterThan(0)

    const gold = await q.findEffectivePackage(db, 3)
    expect(gold?.name).toBe('Gold')
    expect(Number(gold?.rate_per_sqft_paise)).toBe(309900)
    // A package with no rate in effect on the date is not returned, which is what
    // insertPricedQuote turns into a refusal rather than a null rate.
    expect(await q.findEffectivePackage(db, 3, '2020-01-01')).toBeUndefined()

    // The printed quote enumerates this. It may be empty in the dev seed; what
    // matters here is that the two-table join executes.
    expect(Array.isArray(await q.packageSpec(db, 3))).toBe(true)
  })

  it('aggregates the board, the pipeline and the KPI strip', async () => {
    const totals = await q.pipelineTotals(db, ALL)
    // Only the open stages count toward pipeline value; both fixture leads have
    // closed, so this is an assertion about the filter, not about emptiness.
    expect(totals.every((t) => t.stage !== 'won' && t.stage !== 'lost')).toBe(true)

    const cards = await q.boardCards(db, ALL, { canViewValue: true, limit: 100 })
    expect(cards.every((card) => card.stage !== 'won')).toBe(true)
    expect(await q.boardCards(db, ALL, { canViewValue: false })).toBeDefined()

    const kpis = await q.crmKpis(db, ALL, { canViewValue: true })
    expect(kpis.openLeads).toBe(0)
    expect(kpis.quotesPending).toBe(0)
    expect(kpis.weightedPaise).not.toBeNull()

    // The weighted figure is the one crm.view_pipeline_value gates, so it comes
    // back null rather than zero when the caller may not see money.
    const hidden = await q.crmKpis(db, ALL, { canViewValue: false })
    expect(hidden.weightedPaise).toBeNull()
  })

  it('runs the three reports and the three work lists', async () => {
    const from = addDays(today(), -30)
    const to = today()

    const funnel = await q.funnelReport(db, from, to)
    expect(funnel.length).toBeGreaterThan(0)

    const sources = await q.sourceReport(db, from, to)
    expect(sources.some((s) => Number(s.leads) > 0)).toBe(true)

    const losses = await q.lossReport(db, from, to)
    expect(losses.some((l) => l.lost_reason === 'competitor')).toBe(true)

    expect(Array.isArray(await q.dueFollowups(db, ALL))).toBe(true)
    expect(Array.isArray(await q.dueFollowups(db, null))).toBe(true)
    expect(Array.isArray(await q.firstResponseBreaches(db, 4))).toBe(true)
    expect(Array.isArray(await q.firstResponseBreaches(db, 4, ALL))).toBe(true)
    expect(Array.isArray(await q.dormantCandidates(db))).toBe(true)
  })

  it('reads every option list the forms need', async () => {
    expect((await q.leadSourceOptions(db)).length).toBeGreaterThan(0)
    expect(Array.isArray(await q.campaignOptions(db))).toBe(true)
    // A client exists now, created by the conversion.
    expect((await q.clientOptions(db)).length).toBeGreaterThan(0)
    expect((await q.assignableUsers(db)).length).toBe(2)
    expect((await q.stageTemplateOptions(db)).length).toBe(3)
    expect((await q.unitOptions(db)).length).toBeGreaterThan(0)
    expect((await q.costHeadOptions(db)).length).toBeGreaterThan(0)
  })

  it('runs the follow-up cron end to end', async () => {
    // /internal/cron/crm-followups calls this. It is four aggregate writes over
    // leads and notifications and had never executed against a server.
    const out = await svc.runCrmFollowups(db)
    expect(out.ranOn).toBe(today())
    expect(out.dormancyDays).toBeGreaterThan(0)
    // Both fixture leads are closed, so nothing here should have moved. What is
    // being tested is that eight aggregates and a digest insert all execute.
    expect(out.wentDormant).toBe(0)
    expect(out.quotesExpired).toBe(0)
    expect(Number(out.notified)).toBeGreaterThanOrEqual(0)
  })
})
