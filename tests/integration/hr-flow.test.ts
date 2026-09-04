import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getDb } from '../../src/db/kysely.js'
import { closePool } from '../../src/db/pool.js'
import { addDays, today } from '../../src/lib/dates.js'
import { parseJsonColumn } from '../../src/lib/json.js'
import * as q from '../../src/modules/hr/queries.js'
import * as svc from '../../src/modules/hr/service.js'
import {
  compensationSchema,
  documentSchema,
  employeeSchema,
  exitSchema,
  firstError,
} from '../../src/modules/hr/schemas.js'

/*
 * HR (spec 6.6), executed against MariaDB.
 *
 * Every function in service.ts is a transaction over four tables and two
 * enum-heavy columns, and none of that is observable to tsc or to a suite that
 * opens no connection. Four things here can only fail against a server, and
 * each has a test that fails loudly if it does:
 *
 *   - `aadhaar_last4` is CHAR(4). A schema that truncated instead of refusing
 *     would still pass a unit test; the column is asserted by reading it back.
 *   - `reviseCompensation` closes the previous period with a DATE arithmetic
 *     result. Off by one there is invisible until someone reads a payslip.
 *   - `runExit` deactivates a login and revokes sessions in the same
 *     transaction as the status change. The revoke is an UPDATE with two
 *     predicates and had never run.
 *   - rule 5 is structural: `findEmployee` must not carry a pay column at all,
 *     which is asserted on the returned row rather than on the SQL text.
 *
 * It also gives `audit_log.after_json` its first reader, through
 * `src/lib/json.ts` -- mysql2 parses that column before we see it, so the
 * assertion that the audit entry omits the identity and bank fields has to go
 * through `parseJsonColumn` or it reads properties off a string.
 *
 * Fixtures. Two obviously fake employees, two fake logins, one file row and one
 * employee advance, removed afterwards by id above a high-water mark captured
 * before anything is written. Open question 8.1 is unanswered, so no real name
 * appears. Kysely 0.27 has no savepoints and the services open their own
 * transactions, so an outer rollback is not available.
 */

const db = getDb()

/** Child before parent. This is also the delete order in cleanup. */
const TRACKED = [
  'employee_documents',
  'employee_compensation',
  'expenses',
  'employees',
  'files',
  'audit_log',
  'users',
] as const

const highWater = new Map<string, number>()

const HR_OFFICER = { email: 'fixture.hr.officer@example.invalid', full_name: 'Fixture HR Officer' }
const STAFF_LOGIN = { email: 'fixture.staff.beta@example.invalid', full_name: 'Fixture Employee Beta' }

/** CHAR(64), the sha256 of a cookie that never existed. */
const SESSION_ID = 'f0'.repeat(32)

let actor = { userId: 0, ip: '127.0.0.1' as string | null }
let staffLoginId = 0
let fileId = 0

let deptId = 0
let desigId = 0
let mgrDesigId = 0
let locationId: number | null = null

/* The two people, threaded through the suite in order. */
let bossId = 0
let staffId = 0

async function insertUser(u: { email: string; full_name: string }): Promise<number> {
  const row = await db
    .insertInto('users')
    .values({ email: u.email, full_name: u.full_name, status: 'active', must_change_password: 0 })
    .executeTakeFirst()
  return Number(row.insertId ?? 0)
}

beforeAll(async () => {
  for (const table of TRACKED) {
    const res = await sql<{ n: number | null }>`select max(id) as n from ${sql.table(table)}`.execute(db)
    highWater.set(table, Number(res.rows[0]?.n ?? 0))
  }

  actor = { userId: await insertUser(HR_OFFICER), ip: '127.0.0.1' }
  staffLoginId = await insertUser(STAFF_LOGIN)

  // A live session for the login the exit has to revoke. Twelve hours out and
  // revoked_at NULL, which is the only shape runExit's UPDATE matches.
  await db
    .insertInto('user_sessions')
    .values({
      id: SESSION_ID,
      user_id: staffLoginId,
      expires_at: `${today()} 23:59:59`,
      csrf_token: 'a1'.repeat(32),
      totp_verified: 1,
    })
    .execute()

  // A file row, because employee_documents.file_id is NOT NULL with a FK and
  // there is no upload route yet (see the documents test).
  const file = await db
    .insertInto('files')
    .values({
      storage_path: 'fixture/hr/safety-induction.pdf',
      original_name: 'safety-induction.pdf',
      mime: 'application/pdf',
      size_bytes: 4096,
      sha256: 'b3'.repeat(32),
      visibility: 'private',
      uploaded_by: actor.userId,
    })
    .executeTakeFirst()
  fileId = Number(file.insertId ?? 0)

  // Seeded reference data, looked up rather than assumed: 006 seeds seven
  // departments and eleven designations, 003 seeds the two non-project stores.
  const dept = await db.selectFrom('departments').select('id').where('code', '=', 'SITE').executeTakeFirstOrThrow()
  deptId = Number(dept.id)
  const desig = await db
    .selectFrom('designations')
    .select('id')
    .where('code', '=', 'SITE-ENGR')
    .executeTakeFirstOrThrow()
  desigId = Number(desig.id)
  const mgrDesig = await db
    .selectFrom('designations')
    .select('id')
    .where('code', '=', 'PROJ-MGR')
    .executeTakeFirstOrThrow()
  mgrDesigId = Number(mgrDesig.id)
  const location = await db.selectFrom('locations').select('id').orderBy('id').executeTakeFirst()
  locationId = location ? Number(location.id) : null
})

afterAll(async () => {
  // Two links have to be cut before the table deletes, both of them discovered
  // by this cleanup failing: employees.reporting_to_employee_id is
  // self-referential, so a single DELETE over the range can reach the manager
  // before the report, and users.employee_id points back at a row about to go.
  await sql`update employees set reporting_to_employee_id = null
            where id > ${highWater.get('employees') ?? 0}`.execute(db)
  await sql`update users set employee_id = null
            where employee_id > ${highWater.get('employees') ?? 0}`.execute(db)
  // user_sessions is keyed by a CHAR(64) hash and has no id, so it goes by the
  // user high-water mark and has to precede users.
  await sql`delete from user_sessions where user_id > ${highWater.get('users') ?? 0}`.execute(db)
  for (const table of TRACKED) {
    await sql`delete from ${sql.table(table)} where id > ${highWater.get(table) ?? 0}`.execute(db)
  }
  await closePool()
})

/**
 * The service takes parsed input, so every call exercises the schema on the way
 * in -- including the rupees-to-paise conversion and the PAN upper-casing.
 */
function employeeInput(over: Record<string, unknown> = {}) {
  return employeeSchema.parse({
    fullName: 'Fixture Employee Beta',
    fatherOrSpouseName: 'Fixture Parent Beta',
    dateOfBirth: '1994-06-15',
    gender: 'male',
    bloodGroup: 'B+',
    personalPhone: '9800000101',
    personalEmail: 'fixture.staff.beta@example.invalid',
    emergencyContactName: 'Fixture Next Of Kin',
    emergencyContactPhone: '9800000102',
    permanentAddress: 'Fixture plot 12, Nelamangala',
    currentAddress: 'Fixture plot 12, Nelamangala',
    departmentId: String(deptId),
    designationId: String(desigId),
    employmentType: 'permanent',
    dateOfJoining: '2026-04-01',
    probationUntil: '',
    baseLocationId: locationId === null ? '' : String(locationId),
    // Lower case on purpose: the schema upper-cases both, and CHAR(10)/CHAR(11)
    // would silently accept the wrong case if it did not.
    pan: 'abcde1234f',
    aadhaarLast4: '1234',
    uan: '100200300400',
    pfNumber: 'KN/BNG/0012345/001',
    esiNumber: '3100012345',
    bankAccountName: 'Fixture Employee Beta',
    bankAccountNo: '00112233445566',
    bankIfsc: 'hdfc0001234',
    ...over,
  })
}

describe('the employee master (6.6 rules 1 and 6)', () => {
  it('creates two employees and codes them from the row id', async () => {
    bossId = await svc.createEmployee(
      db,
      actor,
      employeeInput({
        fullName: 'Fixture Manager Alpha',
        personalEmail: 'fixture.manager.alpha@example.invalid',
        designationId: String(mgrDesigId),
        pan: 'aaaaa1111a',
        aadhaarLast4: '9876',
        bankAccountName: 'Fixture Manager Alpha',
      })
    )
    expect(bossId).toBeGreaterThan(0)

    staffId = await svc.createEmployee(db, actor, employeeInput({ reportingToEmployeeId: String(bossId) }))
    expect(staffId).toBeGreaterThan(bossId)

    // sequenceCode('EMP', id) against the new row's id, not a financial-year
    // series: an employee master record is not a 6.2 document.
    const boss = await q.findEmployee(db, bossId)
    const staff = await q.findEmployee(db, staffId)
    expect(boss?.employee_code).toBe(`EMP${String(bossId).padStart(4, '0')}`)
    expect(staff?.employee_code).toBe(`EMP${String(staffId).padStart(4, '0')}`)
    // The throwaway TMP- code is gone, which is the assertion that the second
    // statement in the transaction ran.
    expect(staff?.employee_code.startsWith('TMP-')).toBe(false)

    expect(staff?.reports_to_name).toBe('Fixture Manager Alpha')
    expect(staff?.department_name).toBe('Site execution')
    expect(staff?.designation_name).toBe('Site Engineer')
    expect(staff?.status).toBe('active')
    expect(staff?.employment_type).toBe('permanent')
    expect(String(staff?.date_of_joining)).toBe('2026-04-01')
  })

  it('stores four Aadhaar digits, and the columns the schema upper-cases', async () => {
    const staff = await q.findEmployee(db, staffId)
    // CHAR(4). A schema that truncated a twelve-digit paste would land here too,
    // which is why the refusal is asserted separately below.
    expect(staff?.aadhaar_last4).toBe('1234')
    expect(staff?.pan).toBe('ABCDE1234F')
    expect(staff?.bank_ifsc).toBe('HDFC0001234')
    expect(staff?.uan).toBe('100200300400')
  })

  it('refuses a full Aadhaar rather than truncating it to the last four', () => {
    const res = employeeSchema.safeParse({
      fullName: 'Fixture Employee Gamma',
      employmentType: 'permanent',
      dateOfJoining: '2026-04-01',
      aadhaarLast4: '123456789012',
    })
    expect(res.success).toBe(false)
    expect(res.success ? '' : firstError(res.error)).toMatch(/only the last four digits/i)
  })

  it('refuses the dates that contradict each other', () => {
    const probation = employeeSchema.safeParse({
      fullName: 'Fixture Employee Gamma',
      employmentType: 'probation',
      dateOfJoining: '2026-04-01',
      probationUntil: '2026-03-01',
    })
    expect(probation.success).toBe(false)
    expect(probation.success ? '' : firstError(probation.error)).toMatch(/before the date of joining/i)

    const birth = employeeSchema.safeParse({
      fullName: 'Fixture Employee Gamma',
      employmentType: 'permanent',
      dateOfJoining: '2026-04-01',
      dateOfBirth: '2026-06-01',
    })
    expect(birth.success).toBe(false)
    expect(birth.success ? '' : firstError(birth.error)).toMatch(/date of birth/i)
  })

  it('carries no pay column on the profile read at all (rule 5)', async () => {
    const staff = await q.findEmployee(db, staffId)
    expect(staff).toBeDefined()
    // Rule 5 held structurally: there is no canViewPay flag to get wrong,
    // because the query cannot return these columns.
    expect(staff).not.toHaveProperty('ctc_annual_paise')
    expect(staff).not.toHaveProperty('basic_paise')
    expect(staff).not.toHaveProperty('effective_from')

    const list = await q.listEmployees(db)
    expect(list.length).toBeGreaterThanOrEqual(2)
    // Nor does the list carry the identity numbers the detail read does.
    expect(list[0]).not.toHaveProperty('aadhaar_last4')
    expect(list[0]).not.toHaveProperty('bank_account_no')
    expect(list[0]).not.toHaveProperty('ctc_annual_paise')
  })

  it('audits the create without copying identity or bank columns into audit_log', async () => {
    const row = await db
      .selectFrom('audit_log')
      .select(['action', 'entity_type', 'entity_id', 'before_json', 'after_json'])
      .where('entity_type', '=', 'employee')
      .where('entity_id', '=', staffId)
      .where('action', '=', 'hr.employee_create')
      .executeTakeFirstOrThrow()

    // Through parseJsonColumn, because mysql2 parses a json_valid LONGTEXT
    // before we see it and Object.keys on the string would be the characters.
    const after = parseJsonColumn(row.after_json) as Record<string, unknown>
    expect(after.employee_code).toBe(`EMP${String(staffId).padStart(4, '0')}`)
    expect(after.full_name).toBe('Fixture Employee Beta')
    // audit.view is a wider grant than hr.employee_view, so these must not be
    // in the entry at all -- not blanked, absent.
    const keys = Object.keys(after)
    expect(keys).not.toContain('aadhaar_last4')
    expect(keys).not.toContain('pan')
    expect(keys).not.toContain('bank_account_no')
    expect(keys).not.toContain('bank_ifsc')
    expect(keys).not.toContain('personal_email')
    expect(parseJsonColumn(row.before_json)).toBeNull()
  })

  it('updates the employee and audits the before and after', async () => {
    await svc.updateEmployee(
      db,
      actor,
      staffId,
      employeeInput({ reportingToEmployeeId: String(bossId), employmentType: 'probation', probationUntil: '2026-10-01' })
    )

    const staff = await q.findEmployee(db, staffId)
    expect(staff?.employment_type).toBe('probation')
    expect(String(staff?.probation_until)).toBe('2026-10-01')

    const row = await db
      .selectFrom('audit_log')
      .select(['before_json', 'after_json'])
      .where('entity_type', '=', 'employee')
      .where('entity_id', '=', staffId)
      .where('action', '=', 'hr.employee_update')
      .executeTakeFirstOrThrow()
    const before = parseJsonColumn(row.before_json) as Record<string, unknown>
    const after = parseJsonColumn(row.after_json) as Record<string, unknown>
    expect(before.employment_type).toBe('permanent')
    expect(after.employment_type).toBe('probation')
  })
})

describe('the reporting line', () => {
  it('refuses an employee reporting to themselves', async () => {
    await expect(
      svc.updateEmployee(db, actor, staffId, employeeInput({ reportingToEmployeeId: String(staffId) }))
    ).rejects.toThrow(/report to themselves/i)
  })

  it('refuses a two-step cycle, walking the chain rather than checking one level', async () => {
    // Staff already reports to boss, so pointing boss at staff closes a loop
    // that a one-level check would accept -- and an org chart renderer would
    // then recurse until the stack ended.
    await expect(
      svc.updateEmployee(
        db,
        actor,
        bossId,
        employeeInput({
          fullName: 'Fixture Manager Alpha',
          designationId: String(mgrDesigId),
          reportingToEmployeeId: String(staffId),
        })
      )
    ).rejects.toThrow(/loops back on itself/i)

    // The refusal rolled the whole update back, not just the one column.
    const boss = await q.findEmployee(db, bossId)
    expect(boss?.reporting_to_employee_id).toBeNull()
    expect(boss?.full_name).toBe('Fixture Manager Alpha')
  })

  it('offers every employee still on the books as a manager, and no exited one', async () => {
    const options = await q.managerOptions(db)
    const ids = options.map((o) => Number(o.id))
    expect(ids).toContain(bossId)
    expect(ids).toContain(staffId)

    // The form excludes the employee being edited from their own manager list.
    const forStaff = await q.managerOptions(db, staffId)
    expect(forStaff.map((o) => Number(o.id))).not.toContain(staffId)
  })
})

/**
 * Rupees in the form, paise in the column, and one open period at a time.
 */
function compensationInput(over: Record<string, unknown> = {}) {
  return compensationSchema.parse({
    effectiveFrom: '2026-04-01',
    ctcAnnualPaise: '1200000',
    basicPaise: '40000',
    hraPaise: '16000',
    conveyancePaise: '1600',
    specialAllowancePaise: '8000',
    siteAllowancePaise: '',
    employerPfPaise: '1800',
    employerEsiPaise: '',
    revisionReason: 'Joining pay',
    ...over,
  })
}

describe('compensation as a revision history (6.6 rule 5)', () => {
  it('opens the first period', async () => {
    const id = await svc.reviseCompensation(db, actor, staffId, compensationInput())
    expect(id).toBeGreaterThan(0)

    const history = await q.compensationHistory(db, staffId)
    expect(history).toHaveLength(1)
    expect(String(history[0]!.effective_from)).toBe('2026-04-01')
    expect(history[0]!.effective_to).toBeNull()
    // Rs 12,00,000 and Rs 40,000, converted at the schema boundary.
    expect(Number(history[0]!.ctc_annual_paise)).toBe(120000000)
    expect(Number(history[0]!.basic_paise)).toBe(4000000)
    expect(Number(history[0]!.conveyance_paise)).toBe(160000)
    expect(history[0]!.site_allowance_paise).toBeNull()
    expect(history[0]!.approved_by_name).toBe('Fixture HR Officer')
  })

  it('closes the previous period the day before the new one starts', async () => {
    await svc.reviseCompensation(
      db,
      actor,
      staffId,
      compensationInput({
        effectiveFrom: '2026-10-01',
        ctcAnnualPaise: '1440000',
        basicPaise: '48000',
        revisionReason: 'Confirmation on completion of probation',
      })
    )

    const history = await q.compensationHistory(db, staffId)
    expect(history).toHaveLength(2)
    // Newest first, and the open row is the one that answers "what is he on now".
    expect(String(history[0]!.effective_from)).toBe('2026-10-01')
    expect(history[0]!.effective_to).toBeNull()
    // The day before, computed by addDays over a DATE. Off by one here is a
    // gap or an overlap in the history and nothing downstream re-checks it.
    expect(String(history[1]!.effective_to)).toBe('2026-09-30')
    expect(Number(history[0]!.ctc_annual_paise)).toBe(144000000)
  })

  it('refuses a revision that does not take effect after the open period', async () => {
    // Same date as the open row: silently reordering these is how a paid period
    // acquires two answers.
    await expect(
      svc.reviseCompensation(db, actor, staffId, compensationInput({ effectiveFrom: '2026-10-01' }))
    ).rejects.toThrow(/already starts on 2026-10-01/i)

    // And a backdated one over a period that has already been paid.
    await expect(
      svc.reviseCompensation(db, actor, staffId, compensationInput({ effectiveFrom: '2026-05-01' }))
    ).rejects.toThrow(/must take effect after it/i)

    expect(await q.compensationHistory(db, staffId)).toHaveLength(2)
  })

  it('refuses a breakdown that contradicts its own annual figure', () => {
    // Rs 60,000 a month against a Rs 6,00,000 CTC: twelve of them is Rs 7,20,000.
    const res = compensationSchema.safeParse({
      effectiveFrom: '2027-04-01',
      ctcAnnualPaise: '600000',
      basicPaise: '60000',
    })
    expect(res.success).toBe(false)
    expect(res.success ? '' : firstError(res.error)).toMatch(/exceed the annual CTC/i)
  })

  it('audits the figures, unlike the employee writes', async () => {
    const rows = await db
      .selectFrom('audit_log')
      .select(['before_json', 'after_json'])
      .where('action', '=', 'hr.compensation_revise')
      .where('id', '>', highWater.get('audit_log') ?? 0)
      .orderBy('id', 'desc')
      .execute()
    expect(rows).toHaveLength(2)

    const after = parseJsonColumn(rows[0]!.after_json) as Record<string, unknown>
    const before = parseJsonColumn(rows[0]!.before_json) as Record<string, unknown>
    expect(Number(after.ctc_annual_paise)).toBe(144000000)
    expect(after.revision_reason).toBe('Confirmation on completion of probation')
    // hr.payroll_view is the narrower grant, so what the previous figure was
    // belongs in the entry: a pay revision with no record of what changed is
    // the one an owner asks about.
    expect(Number(before.ctc_annual_paise)).toBe(120000000)
  })
})

describe('the document register (6.6 rule 6, second table)', () => {
  it('attaches a document against an existing file row', async () => {
    const id = await svc.addEmployeeDocument(
      db,
      actor,
      bossId,
      documentSchema.parse({
        docType: 'safety_training',
        documentNo: 'ST/2026/0091',
        issuedOn: today(),
        expiresOn: addDays(today(), 180),
        fileId: String(fileId),
      })
    )
    expect(id).toBeGreaterThan(0)

    const docs = await q.employeeDocuments(db, bossId)
    expect(docs).toHaveLength(1)
    expect(docs[0]!.doc_type).toBe('safety_training')
    expect(docs[0]!.file_name).toBe('safety-induction.pdf')
    expect(String(docs[0]!.expires_on)).toBe(addDays(today(), 180))
    // Nobody has verified it, which is what the register shows as blank rather
    // than as verified-by-whoever-uploaded-it.
    expect(docs[0]!.verified_on).toBeNull()
    expect(docs[0]!.verified_by_name).toBeNull()
  })

  it('records an Aadhaar document with the masked number only', async () => {
    await svc.addEmployeeDocument(
      db,
      actor,
      staffId,
      documentSchema.parse({ docType: 'aadhaar', documentNo: '1234', fileId: String(fileId) })
    )
    const docs = await q.employeeDocuments(db, staffId)
    expect(docs).toHaveLength(1)
    expect(docs[0]!.document_no).toBe('1234')
  })

  it('refuses a full Aadhaar on a document row too', () => {
    // document_no is VARCHAR(60): the column that refuses twelve digits on the
    // employee row accepts them here, for the same person.
    const res = documentSchema.safeParse({
      docType: 'aadhaar',
      documentNo: '123456789012',
      fileId: '1',
    })
    expect(res.success).toBe(false)
    expect(res.success ? '' : firstError(res.error)).toMatch(/only the last four digits/i)

    // The same twelve digits under any other type are a passport or a licence
    // number and are none of this rule's business.
    expect(documentSchema.safeParse({ docType: 'other', documentNo: '123456789012', fileId: '1' }).success).toBe(
      true
    )
  })

  it('refuses an expiry before the issue date, and a missing attachment', async () => {
    const res = documentSchema.safeParse({
      docType: 'medical_fitness',
      issuedOn: '2026-06-01',
      expiresOn: '2026-05-01',
      fileId: '1',
    })
    expect(res.success).toBe(false)
    expect(res.success ? '' : firstError(res.error)).toMatch(/cannot expire before it was issued/i)

    // fileId is required, because a document record with no scan is a claim
    // that a document exists rather than a record of one.
    expect(documentSchema.safeParse({ docType: 'pan', fileId: '' }).success).toBe(false)

    // And a file id that no longer resolves is refused by the service before the
    // FK gets a chance to, so the user sees a sentence rather than a 500.
    await expect(
      svc.addEmployeeDocument(
        db,
        actor,
        staffId,
        documentSchema.parse({ docType: 'pan', fileId: '999999999' })
      )
    ).rejects.toThrow(/attachment no longer exists/i)
  })

  it('keeps the document number out of the audit entry', async () => {
    const rows = await db
      .selectFrom('audit_log')
      .select(['after_json'])
      .where('action', '=', 'hr.document_add')
      .where('id', '>', highWater.get('audit_log') ?? 0)
      .execute()
    expect(rows).toHaveLength(2)

    for (const row of rows) {
      const after = parseJsonColumn(row.after_json) as Record<string, unknown>
      expect(Object.keys(after)).not.toContain('document_no')
      expect(after.file_id).toBeDefined()
      expect(after.doc_type).toBeDefined()
    }
  })
})

describe('the exit checklist (6.6 rule 7)', () => {
  it('finds the login through the link 6.1 actually writes', async () => {
    // users.employee_id is the half createUser populates; employees.user_id has
    // no writer anywhere in the codebase. Linking it this way round is the
    // production shape, and it is what employeeLoginId exists for.
    await db.updateTable('users').set({ employee_id: staffId }).where('id', '=', staffLoginId).execute()

    const staff = await q.findEmployee(db, staffId)
    expect(staff?.login_email).toBe('fixture.staff.beta@example.invalid')
    expect(staff?.login_status).toBe('active')
    // The column on the employee row is still null, which is the point.
    expect(staff?.user_id).toBeNull()
    expect(await q.employeeLoginId(db, staffId, null)).toBe(staffLoginId)
  })

  it('reports a clean checklist before anything is outstanding', async () => {
    const blockers = await q.exitBlockers(db, staffId)
    expect(q.blockerCount(blockers)).toBe(0)
    // All five lists execute, which is the half of this that tsc cannot see:
    // two of them join on a free-text name and three on ids.
    expect(blockers.assignments).toEqual([])
    expect(blockers.materialIssues).toEqual([])
    expect(blockers.equipment).toEqual([])
    expect(blockers.expensesRaised).toEqual([])
    expect(blockers.advancesOutstanding).toEqual([])
  })

  it('picks up an unsettled advance as a blocker', async () => {
    await db
      .insertInto('expenses')
      .values({
        expense_no: 'FIXTURE/ADV/0001',
        expense_date: today(),
        expense_type: 'other',
        payee_type: 'employee',
        employee_id: staffId,
        payee_name: 'Fixture Employee Beta',
        status: 'approved',
        taxable_paise: 5000000,
        total_paise: 5000000,
        net_payable_paise: 5000000,
        paid_paise: 0,
        narration: 'Fixture site advance, unsettled.',
        created_by: actor.userId,
      })
      .execute()

    const blockers = await q.exitBlockers(db, staffId)
    expect(q.blockerCount(blockers)).toBe(1)
    expect(blockers.advancesOutstanding).toHaveLength(1)
    expect(blockers.advancesOutstanding[0]!.expense_no).toBe('FIXTURE/ADV/0001')
    expect(Number(blockers.advancesOutstanding[0]!.net_payable_paise)).toBe(5000000)
  })

  it('refuses the exit while the advance is outstanding and no reason is given', async () => {
    await expect(
      svc.runExit(
        db,
        actor,
        staffId,
        exitSchema.parse({ dateOfExit: today(), exitType: 'resigned', exitReason: 'Moving out of state.' })
      )
    ).rejects.toThrow(/1 item still sits with this employee/i)

    const staff = await q.findEmployee(db, staffId)
    expect(staff?.status).toBe('active')
    expect(staff?.date_of_exit).toBeNull()
  })

  it('refuses an exit dated before the joining date', async () => {
    await expect(
      svc.runExit(
        db,
        actor,
        staffId,
        exitSchema.parse({ dateOfExit: '2026-03-31', exitType: 'resigned', override: 'Advance being recovered.' })
      )
    ).rejects.toThrow(/cannot fall before the date of joining/i)
  })

  it('completes the exit on a recorded override, and closes the login with it', async () => {
    const result = await svc.runExit(
      db,
      actor,
      staffId,
      exitSchema.parse({
        dateOfExit: today(),
        exitType: 'resigned',
        exitReason: 'Moving out of state.',
        override: 'Advance of Rs 50,000 to be recovered from the final settlement.',
      })
    )
    expect(result.overridden).toBe(true)
    expect(q.blockerCount(result.blockers)).toBe(1)

    const staff = await q.findEmployee(db, staffId)
    expect(staff?.status).toBe('exited')
    expect(String(staff?.date_of_exit)).toBe(today())
    expect(staff?.exit_type).toBe('resigned')

    // The two assertions this transaction exists for. An employee row marked
    // exited beside a live session is the failure it prevents.
    const login = await db
      .selectFrom('users')
      .select(['status', 'employee_id'])
      .where('id', '=', staffLoginId)
      .executeTakeFirstOrThrow()
    expect(login.status).toBe('inactive')

    const session = await db
      .selectFrom('user_sessions')
      .select(['revoked_at', 'user_id'])
      .where('id', '=', SESSION_ID)
      .executeTakeFirstOrThrow()
    // Revoked, not deleted: 6.1's session table still shows that it existed.
    expect(session.revoked_at).not.toBeNull()
  })

  it('records the override and the outstanding count in the audit entry', async () => {
    const row = await db
      .selectFrom('audit_log')
      .select(['before_json', 'after_json'])
      .where('action', '=', 'hr.employee_exit')
      .where('entity_id', '=', staffId)
      .executeTakeFirstOrThrow()

    const after = parseJsonColumn(row.after_json) as Record<string, unknown>
    expect(after.status).toBe('exited')
    expect(after.login_deactivated).toBe(true)
    expect(Number(after.blockers_outstanding)).toBe(1)
    // Not a boolean. An exit forced through with money outstanding is exactly
    // the case somebody reads six months later.
    expect(String(after.override_reason)).toMatch(/Rs 50,000/)
    expect((parseJsonColumn(row.before_json) as Record<string, unknown>).status).toBe('active')
  })

  it('refuses a second exit, and refuses to revise the pay of an exited employee', async () => {
    await expect(
      svc.runExit(db, actor, staffId, exitSchema.parse({ dateOfExit: today(), exitType: 'terminated' }))
    ).rejects.toThrow(/already exited/i)

    await expect(
      svc.reviseCompensation(db, actor, staffId, compensationInput({ effectiveFrom: '2027-04-01' }))
    ).rejects.toThrow(/has exited/i)
  })

  it('drops the exited employee out of the manager list and the default filter', async () => {
    expect((await q.managerOptions(db)).map((o) => Number(o.id))).not.toContain(staffId)

    const exited = await q.listEmployees(db, { status: 'exited' })
    expect(exited.map((r) => Number(r.id))).toContain(staffId)
    const active = await q.listEmployees(db, { status: 'active' })
    expect(active.map((r) => Number(r.id))).not.toContain(staffId)
  })
})

/*
 * The read side. Weak on content and strong on execution, deliberately: what
 * these catch is the class of error tsc cannot see -- a renamed column, an enum
 * value the schema does not have, a GROUP BY that ONLY_FULL_GROUP_BY rejects.
 * Every one of those is a 500 on a page that typechecks.
 */
describe('every read the HR screens use', () => {
  it('applies each list filter', async () => {
    expect((await q.listEmployees(db, { departmentId: deptId })).length).toBeGreaterThanOrEqual(2)
    expect(await q.listEmployees(db, { q: 'Fixture Manager Alpha' })).toHaveLength(1)
    expect(await q.listEmployees(db, { q: 'Fixture Manager Alpha', status: 'exited' })).toHaveLength(0)
    expect(await q.listEmployees(db, { status: 'on_notice' })).toHaveLength(0)
  })

  it('reads every option list the employee form needs', async () => {
    // 006 seeds seven departments and eleven designations; the assertion is a
    // floor, because a later slice may add to the seed.
    expect((await q.departmentOptions(db)).length).toBeGreaterThanOrEqual(7)
    expect((await q.designationOptions(db)).length).toBeGreaterThanOrEqual(11)
    expect(Array.isArray(await q.locationOptions(db))).toBe(true)
  })

  it('aggregates the module dashboard', async () => {
    const data = await q.hrDashboard(db)

    const byStatus = new Map(data.headcount.map((r) => [r.status, Number(r.n)]))
    expect(byStatus.get('exited')).toBeGreaterThanOrEqual(1)
    expect(byStatus.get('active')).toBeGreaterThanOrEqual(1)

    // attendance and job_openings are empty until the later HR slices, so these
    // assert that the two aggregates execute, not that they count anything.
    expect(data.unapprovedAttendance).toBe(0)
    expect(data.openPositions).toBe(0)

    // The expiry list excludes exited employees, so the staff Aadhaar record is
    // absent (no expiry) and the manager's safety card is present.
    const expiring = data.expiringDocuments.map((r) => `${r.employee_code} ${r.doc_type}`)
    expect(expiring).toContain(`EMP${String(bossId).padStart(4, '0')} safety_training`)
  })
})

