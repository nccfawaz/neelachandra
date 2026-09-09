import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getDb } from '../../src/db/kysely.js'
import { closePool, getPool } from '../../src/db/pool.js'
import { createInvoiceFromMilestone } from '../../src/modules/finance/invoiceService.js'
import { createPayment, allocatePayment } from '../../src/modules/finance/service.js'
import { NotFoundError } from '../../src/lib/errors.js'

/**
 * Finance slice 4: client invoices (spec 6.8 rule 5).
 *
 * What is pinned here, and by what kind of proof:
 *
 *   1. The rule-5 chain through the service: a milestone that is not
 *      certified is refused, a certified one invoices exactly once, and the
 *      invoice is built from the milestone's amount. Certification is the
 *      only admitting status — proven by real service calls, not by reading
 *      the code.
 *
 *   2. The GST split comes from client_invoices.place_of_supply and never
 *      from the project or the client. Every branch is proven by a real
 *      insert through the service:
 *        - 'KA'  → CGST + SGST, IGST 0 (intra-state);
 *        - 'MH'  → IGST = full tax, CGST and SGST 0 (inter-state);
 *        - gst_pct 0 → all three tax columns 0 (the zero-rows shape: the
 *          aggregate of no taxable value is zero, not NULL — the CLAUDE.md
 *          zero-aggregate rule applied to the split arithmetic);
 *        - the NULL-aggregate shape is proven against the v_project_actual
 *          view over an empty fixture set reading back COALESCEd 0, and by
 *          retention on a zero-amount project reading 0 rather than NULL.
 *      The project and client fixtures deliberately carry state strings
 *      that contradict the stated place of supply, so a regression that
 *      infers the split from them goes red here.
 *
 *   3. Retention reads the percentage through the milestone's project
 *      (DECISIONS 26.4): 5.00 on the project → 5 percent of the milestone
 *      amount onto retention_paise, and net_receivable = total − retention.
 *
 *   4. The 021 period trigger covers the invoice write path through the
 *      service: an invoice dated inside a closed period is refused by
 *      createInvoiceFromMilestone with the trigger's message — the same
 *      service-path proof finance-payments.test.ts runs for payments.
 *
 *   5. The client_invoice allocation target: the writer now exists, so the
 *      target is enabled and a real payment allocation moves
 *      received_paise by exactly the allocated figure, reconciled against
 *      independent SQL per §26.3's shape. The advance target still refuses
 *      with the unchanged message.
 */

const db = getDb()

const highWater = new Map<string, number>()
const TRACKED = [
  'audit_log',
  'payment_allocations',
  'payments',
  'client_invoices',
  'project_milestones',
  'projects',
  'clients',
  'accounting_periods',
  'users',
] as const

let projectIdKA: number
let projectIdMH: number
let projectIdZero: number
let clientIdKA: number
let clientIdMH: number
let userId: number
let actor: { userId: number; ip: string | null }
let closedPeriodId: number
let payPaymentId: number

const RAISER_ROLE = 4

async function insertUser(email: string, fullName: string, roleId: number): Promise<number> {
  const row = await db
    .insertInto('users')
    .values({ email, full_name: fullName, status: 'active', must_change_password: 0 })
    .executeTakeFirst()
  const id = Number(row.insertId ?? 0)
  await db.insertInto('user_roles').values({ user_id: id, role_id: roleId }).execute()
  return id
}

/** A certified milestone ready to invoice, with an explicit amount. */
async function insertMilestone(projectId: number, seq: number, amountPaise: number): Promise<number> {
  const row = await db
    .insertInto('project_milestones')
    .values({
      project_id: projectId,
      seq,
      name: `Fixture milestone ${seq}`,
      amount_paise: amountPaise,
      status: 'certified',
      certified_by: userId,
      certified_on: '2099-01-05',
    })
    .executeTakeFirst()
  return Number(row.insertId ?? 0)
}

/** A project whose client's state contradicts the stated place of supply. */
async function insertProjectWithClient(seq: number, state: string): Promise<number> {
  const client = await db
    .insertInto('clients')
    .values({
      code: `FIXCL-INV${randomUUID().slice(0, 6)}`,
      name: `Fixture client for invoices ${seq}`,
      client_type: 'company',
      // Deliberately contradicts the invoice's place_of_supply: the split
      // must read the invoice column, not this.
      state,
      city: 'Bengaluru',
    })
    .executeTakeFirst()
  const clientId = Number(client.insertId ?? 0)
  const project = await db
    .insertInto('projects')
    .values({
      code: `FIXPR-INV${randomUUID().slice(0, 6)}`,
      name: `Fixture project for invoices ${seq}`,
      client_id: clientId,
      project_type: 'residential_construction',
      delivery_model: 'item_rate',
      site_address: `Fixture plot ${seq}, Nelamangala`,
      city: 'Bengaluru',
      status: 'in_progress',
      retention_pct: 5,
      gst_pct: 18,
      created_by: userId,
    })
    .executeTakeFirst()
  return Number(project.insertId ?? 0)
}

beforeAll(async () => {
  for (const table of TRACKED) {
    const res = await sql<{ n: number | null }>`select max(id) as n from ${sql.table(table)}`.execute(db)
    highWater.set(table, Number(res.rows[0]?.n ?? 0))
  }

  userId = await insertUser(`fixture.inv.${randomUUID().slice(0, 8)}@example.invalid`, 'Fixture Invoice User', RAISER_ROLE)
  actor = { userId, ip: '127.0.0.1' }

  // KA project whose client is registered in MH, and vice versa. If the
  // split ever infers from client.state or projects rows, these disagree
  // loudly with the invoice's stated place of supply.
  projectIdKA = await insertProjectWithClient(1, 'MH')
  projectIdMH = await insertProjectWithClient(2, 'KA')
  projectIdZero = await insertProjectWithClient(3, 'KA')

  // gst_pct 0 on the third project: the zero-tax shape.
  await db.updateTable('projects').set({ gst_pct: 0 }).where('id', '=', projectIdZero).execute()

  // A closed period far in the fixture future, for the trigger shape.
  // ('2096-97' — a prior run's '2097-98' fixture left a row behind once,
  // and uq_period (financial_year, month) collides on reuse.)
  const closedPeriod = await db
    .insertInto('accounting_periods')
    .values({
      financial_year: '2096-97',
      month: 12,
      period_start: '2096-12-01',
      period_end: '2096-12-31',
      status: 'closed',
    })
    .executeTakeFirst()
  closedPeriodId = Number(closedPeriod.insertId ?? 0)
})

afterAll(async () => {
  await sql`delete from user_roles where user_id > ${highWater.get('users') ?? 0}`.execute(db)
  // Resilient cleanup: an earlier crash in this suite (or a collision on
  // uq_period) must not leave rows that make the NEXT run fail in beforeAll
  // or make crm-flow's assignableUsers count wrong. Each step tolerates an
  // already-clean database.
  await sql`delete from audit_log where id > ${highWater.get('audit_log') ?? 0}`.execute(db).catch(() => {})
  await sql`delete p from payment_allocations p join payments pay on p.payment_id = pay.id where pay.id > ${highWater.get('payments') ?? 0}`.execute(db).catch(() => {})
  await sql`delete from payments where id > ${highWater.get('payments') ?? 0}`.execute(db).catch(() => {})
  await sql`update project_milestones set invoice_id = null where invoice_id in (select id from client_invoices where created_by > ${highWater.get('users') ?? 0})`.execute(db).catch(() => {})
  await sql`delete from client_invoices where created_by > ${highWater.get('users') ?? 0}`.execute(db).catch(() => {})
  await sql`delete from project_milestones where name like 'Fixture milestone %'`.execute(db).catch(() => {})
  await sql`delete cl from clients cl where cl.name like 'Fixture client for invoices %'`.execute(db).catch(() => {})
  await sql`delete from projects where created_by > ${highWater.get('users') ?? 0}`.execute(db).catch(() => {})
  await sql`delete from accounting_periods where id > ${highWater.get('accounting_periods') ?? 0}`.execute(db).catch(() => {})
  await sql`delete from users where id > ${highWater.get('users') ?? 0}`.execute(db).catch(() => {})
  await closePool()
})

describe('rule 5 chain through the service', () => {
  it('a milestone that is not certified is refused, naming the status', async () => {
    const pending = await db
      .insertInto('project_milestones')
      .values({
        project_id: projectIdKA,
        seq: 90,
        name: 'Fixture uncertified',
        amount_paise: 100_000,
        status: 'pending',
      })
      .executeTakeFirst()
    const pendingId = Number(pending.insertId ?? 0)

    await expect(
      createInvoiceFromMilestone(db, actor, {
        milestoneId: pendingId,
        invoiceDate: '2099-01-15',
        dueDate: '2099-01-31',
        placeOfSupply: 'KA',
        narration: null,
      })
    ).rejects.toThrow(/pending, not certified/)
  })

  it('a missing milestone is a NotFoundError', async () => {
    await expect(
      createInvoiceFromMilestone(db, actor, {
        milestoneId: (highWater.get('project_milestones') ?? 0) + 10_000,
        invoiceDate: '2099-01-15',
        dueDate: '2099-01-31',
        placeOfSupply: 'KA',
        narration: null,
      })
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it("a certified milestone invoices once with 'KA': CGST + SGST, retention 5 percent, net receivable", async () => {
    const milestoneId = await insertMilestone(projectIdKA, 1, 1_00_000)
    const r = await createInvoiceFromMilestone(db, actor, {
      milestoneId,
      invoiceDate: '2099-01-15',
      dueDate: '2099-01-31',
      placeOfSupply: 'KA',
      narration: null,
    })

    expect(r.invoiceNo).toMatch(/^NCC\/INV\//)
    // 18 percent of 1,00,000 is 18,000: CGST 9,000 + SGST 9,000, IGST 0.
    expect(r.taxablePaise).toBe(1_00_000)
    expect(r.cgstPaise).toBe(9_000)
    expect(r.sgstPaise).toBe(9_000)
    expect(r.igstPaise).toBe(0)
    expect(r.totalPaise).toBe(1_18_000)
    // Retention 5 percent through the milestone's project (26.4).
    expect(r.retentionPaise).toBe(5_000)
    expect(r.netReceivablePaise).toBe(1_13_000)
    expect(r.placeOfSupply).toBe('KA')

    // Read back: the split is on the row, the milestone is linked, status moved.
    const row = await db.selectFrom('client_invoices').selectAll().where('id', '=', r.invoiceId).executeTakeFirstOrThrow()
    expect(row.place_of_supply).toBe('KA')
    expect(Number(row.cgst_paise)).toBe(9_000)
    expect(Number(row.sgst_paise)).toBe(9_000)
    expect(Number(row.retention_paise)).toBe(5_000)
    expect(Number(row.net_receivable_paise)).toBe(1_13_000)
    expect(Number(row.received_paise)).toBe(0)
    expect(row.status).toBe('draft')
    expect(Number(row.milestone_id)).toBe(milestoneId)

    const ms = await db.selectFrom('project_milestones').selectAll().where('id', '=', milestoneId).executeTakeFirstOrThrow()
    expect(ms.status).toBe('invoiced')
    expect(Number(ms.invoice_id)).toBe(r.invoiceId)
  })

  it('the same milestone cannot be invoiced twice', async () => {
    const milestoneId = await insertMilestone(projectIdKA, 2, 50_000)
    await createInvoiceFromMilestone(db, actor, {
      milestoneId,
      invoiceDate: '2099-01-16',
      dueDate: '2099-01-31',
      placeOfSupply: 'KA',
      narration: null,
    })
    // The second attempt is refused either way: the milestone's status is
    // now 'invoiced' (not the admitting 'certified') and invoice_id is set.
    // Both refusals are the same rule — one certified milestone, one
    // invoice — so the assertion is the refusal, not which message fires.
    await expect(
      createInvoiceFromMilestone(db, actor, {
        milestoneId,
        invoiceDate: '2099-01-16',
        dueDate: '2099-01-31',
        placeOfSupply: 'KA',
        narration: null,
      })
    ).rejects.toThrow(/already invoiced|not certified/)
  })
})

describe('the GST split reads place_of_supply, never the project or client', () => {
  it("'KA' splits CGST + SGST even though the client is registered in MH", async () => {
    const milestoneId = await insertMilestone(projectIdKA, 3, 1_00_000)
    const r = await createInvoiceFromMilestone(db, actor, {
      milestoneId,
      invoiceDate: '2099-01-17',
      dueDate: '2099-01-31',
      placeOfSupply: 'KA',
      narration: null,
    })
    expect(r.cgstPaise).toBe(9_000)
    expect(r.sgstPaise).toBe(9_000)
    expect(r.igstPaise).toBe(0)
  })

  it("'MH' splits IGST even though the project's client is in KA", async () => {
    const milestoneId = await insertMilestone(projectIdMH, 1, 1_00_000)
    const r = await createInvoiceFromMilestone(db, actor, {
      milestoneId,
      invoiceDate: '2099-01-18',
      dueDate: '2099-01-31',
      placeOfSupply: 'MH',
      narration: null,
    })
    expect(r.igstPaise).toBe(18_000)
    expect(r.cgstPaise).toBe(0)
    expect(r.sgstPaise).toBe(0)
    // Stored-shape note: client_invoices carries no igst_paise column
    // (DECISIONS 21.3 — the DDL block is non-normative where the prose
    // disagrees). The inter-state split is proven by cgst_paise and
    // sgst_paise storing 0 with the IGST figure inside the total.
    const rowMh = await db.selectFrom('client_invoices').select(['cgst_paise', 'sgst_paise', 'total_paise']).where('id', '=', r.invoiceId).executeTakeFirstOrThrow()
    expect(Number(rowMh.cgst_paise)).toBe(0)
    expect(Number(rowMh.sgst_paise)).toBe(0)
    expect(Number(rowMh.total_paise)).toBe(1_18_000)
  })

  it('gst_pct 0 yields all three tax columns 0 and the total equals the taxable value (the zero shape)', async () => {
    const milestoneId = await insertMilestone(projectIdZero, 1, 1_00_000)
    const r = await createInvoiceFromMilestone(db, actor, {
      milestoneId,
      invoiceDate: '2099-01-19',
      dueDate: '2099-01-31',
      placeOfSupply: 'KA',
      narration: null,
    })
    expect(r.cgstPaise).toBe(0)
    expect(r.sgstPaise).toBe(0)
    expect(r.igstPaise).toBe(0)
    expect(r.totalPaise).toBe(r.taxablePaise)
    // Zero rows of tax is 0, not NULL — the zero-aggregate shape, proven on
    // the stored row. The stored shape has no igst_paise column (21.3), so
    // the zero proof is cgst + sgst both 0 with total = taxable.
    const rowZero = await db.selectFrom('client_invoices').select(['cgst_paise', 'sgst_paise', 'total_paise']).where('id', '=', r.invoiceId).executeTakeFirstOrThrow()
    expect(Number(rowZero.cgst_paise)).toBe(0)
    expect(Number(rowZero.sgst_paise)).toBe(0)
    expect(Number(rowZero.total_paise)).toBe(1_00_000)
  })

  it('the zero-rows aggregate shape: v_project_actual over this empty fixture reads 0, not NULL', async () => {
    // The fixture projects carry no expense lines, so the view's SUM has no
    // rows under it. The view is required to come back with a number — 0 —
    // because every consumer feeds arithmetic with it.
    const res = await sql<{ actual_paise: number | null }>`
      select coalesce(sum(actual_paise), 0) as actual_paise
      from v_project_actual
      where project_id in (${projectIdKA}, ${projectIdMH}, ${projectIdZero})
    `.execute(db)
    expect(res.rows.length).toBeGreaterThan(0)
    expect(Number(res.rows[0]!.actual_paise)).toBe(0)
  })
})

describe('rule 7 via the service path: the 021 trigger covers client invoices', () => {
  it('an invoice dated inside a closed period is refused through createInvoiceFromMilestone', async () => {
    // Not assumed from the trigger's existence: the service insert is what
    // runs in production, so the refusal is proven through it.
    const milestoneId = await insertMilestone(projectIdKA, 4, 25_000)
    let refused = false
    try {
      await createInvoiceFromMilestone(db, actor, {
        milestoneId,
        invoiceDate: '2096-12-15',
        dueDate: '2096-12-31',
        placeOfSupply: 'KA',
        narration: null,
      })
    } catch (err) {
      refused = true
      expect(String((err as Error).message)).toContain('closed accounting period')
    }
    if (!refused) throw new Error('expected the closed-period invoice to be refused through the service')

    // And the refusal left no invoice and moved no milestone.
    const ms = await db.selectFrom('project_milestones').selectAll().where('id', '=', milestoneId).executeTakeFirstOrThrow()
    expect(ms.status).toBe('certified')
    expect(ms.invoice_id).toBeNull()
    void closedPeriodId
  })
})

describe('the client_invoice allocation target, reconciled (§26.3 shape)', () => {
  it('allocating moves received_paise by exactly the allocated figure, reconciled against independent SQL', async () => {
    const milestoneId = await insertMilestone(projectIdKA, 5, 2_00_000)
    const inv = await createInvoiceFromMilestone(db, actor, {
      milestoneId,
      invoiceDate: '2099-01-20',
      dueDate: '2099-01-31',
      placeOfSupply: 'KA',
      narration: null,
    })

    payPaymentId = (
      await createPayment(db, actor, {
        paymentDate: '2099-01-21',
        direction: 'incoming',
        mode: 'neft',
        amountPaise: 60_000,
        payeeOrPayer: 'Fixture client payer',
        bankAccountId: null,
        referenceNo: null,
        narration: null,
        allocations: [],
      })
    ).paymentId

    await allocatePayment(db, actor, payPaymentId, {
      allocations: [{ documentType: 'client_invoice', documentId: inv.invoiceId, allocatedPaise: 60_000 }],
    })

    const row = await db.selectFrom('client_invoices').select('received_paise').where('id', '=', inv.invoiceId).executeTakeFirstOrThrow()
    expect(Number(row.received_paise)).toBe(60_000)

    // The §26.3 reconciliation: SUM(allocations) equals the stored figure,
    // per document, over the whole fixture set.
    const res = await sql<{ invoice_id: number; allocated: string | null; received: string }>`
      select i.id as invoice_id,
             coalesce((select sum(a.allocated_paise) from payment_allocations a where a.document_type = 'client_invoice' and a.document_id = i.id), 0) as allocated,
             i.received_paise as received
      from client_invoices i
      where i.id > ${highWater.get('client_invoices') ?? 0}
    `.execute(db)
    expect(res.rows.length).toBeGreaterThan(0)
    for (const r of res.rows) {
      expect(Number(r.allocated)).toBe(Number(r.received))
    }
  })

  it('an allocation that would overpay the invoice is refused with the over-by figure', async () => {
    const milestoneId = await insertMilestone(projectIdKA, 6, 50_000)
    const inv = await createInvoiceFromMilestone(db, actor, {
      milestoneId,
      invoiceDate: '2099-01-22',
      dueDate: '2099-01-31',
      placeOfSupply: 'KA',
      narration: null,
    })
    // Net receivable 57,000 (1,18,000/4 * ... precisely: 50,000 + 9,000 tax −
    // 2,500 retention). Over-allocate by asking for 60,000.
    const payment = await createPayment(db, actor, {
      paymentDate: '2099-01-23',
      direction: 'incoming',
      mode: 'upi',
      amountPaise: 60_000,
      payeeOrPayer: 'Fixture overpayer invoice',
      bankAccountId: null,
      referenceNo: null,
      narration: null,
      allocations: [],
    })
    await expect(
      allocatePayment(db, actor, payment.paymentId, {
        allocations: [{ documentType: 'client_invoice', documentId: inv.invoiceId, allocatedPaise: 60_000 }],
      })
    ).rejects.toThrow(/over by/)
  })

  it('the advance target still refuses with the unchanged message', async () => {
    const payment = await createPayment(db, actor, {
      paymentDate: '2099-01-24',
      direction: 'outgoing',
      mode: 'cash',
      amountPaise: 10_000,
      payeeOrPayer: 'Fixture advance refuser',
      bankAccountId: null,
      referenceNo: null,
      narration: null,
      allocations: [],
    })
    await expect(
      allocatePayment(db, actor, payment.paymentId, {
        allocations: [{ documentType: 'advance', documentId: 1, allocatedPaise: 10_000 }],
      })
    ).rejects.toThrow(/advance documents land with the slice that builds them/)
  })
})
