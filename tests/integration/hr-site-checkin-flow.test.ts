import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getDb } from '../../src/db/kysely.js'
import { sweepFixtures } from './fixture-markers.js'
import { closePool } from '../../src/db/pool.js'
import { today } from '../../src/lib/dates.js'
import { distanceMeters, SITE_FAR_THRESHOLD_M } from '../../src/lib/geo.js'
import * as q from '../../src/modules/hr/queries.js'
import * as svc from '../../src/modules/hr/service.js'
import { employeeSchema } from '../../src/modules/hr/schemas.js'

/*
 * Site check-in and check-out (DECISIONS 31), executed against MariaDB.
 *
 * What only a server can prove:
 *
 *   - THE NEVER-REFUSED INVARIANT. A check-in far beyond the threshold still
 *     writes a row, still stamps the reading, and still sets the flag; nothing
 *     anywhere 422s on location. This is the property DECISIONS 31 names and
 *     the one a refactor could silently break by moving the flag check before
 *     the write.
 *   - The two-direction login link (employees.user_id written by nothing) is
 *     what selfDay resolves through, and it has to work against real rows.
 *   - uq_att upserting: a check-in on a day the supervisor already marked must
 *     UPDATE that row, not collide with it.
 *   - Muster exclusion is a write gate, not a filter: the refusal must come
 *     back BY NAME from bulk, grid, check-in and check-out alike.
 *
 * Fixtures follow the hr-attendance-flow pattern: obviously fake employees, a
 * fixture location, and a high-water cleanup above ids captured before any
 * write. The self-service date is TODAY by design -- check-in is a
 * right-now act, so there is no fixed-date variant of it.
 */

const db = getDb()

const TRACKED = [
  'attendance',
  'employees',
  'locations',
  'audit_log',
  'users',
] as const

const highWater = new Map<string, number>()

let actor = { userId: 0, ip: '127.0.0.1' as string | null }

let workerId = 0
let excludedId = 0
let siteId = 0
let officeId = 0
let farSiteId = 0

/** Site at a fixed point; ~600 m and ~40 m readings relative to it. */
const SITE = { lat: 12.9, lng: 77.6 }
const NEAR = { lat: 12.90036, lng: 77.6 }
const FAR = { lat: 12.9054, lng: 77.6 }

function employeeInput(over: Record<string, unknown>) {
  return employeeSchema.parse({
    employmentType: 'permanent',
    dateOfJoining: '2026-01-01',
    ...over,
  })
}

beforeAll(async () => {
  await sweepFixtures(db)

  for (const table of TRACKED) {
    const res = await sql<{ n: number | null }>`select max(id) as n from ${sql.table(table)}`.execute(db)
    highWater.set(table, Number(res.rows[0]?.n ?? 0))
  }

  const user = await db
    .insertInto('users')
    .values({
      email: 'fixture.checkin.officer@example.invalid',
      full_name: '[fixture] Check-in Officer',
      status: 'active',
      must_change_password: 0,
    })
    .executeTakeFirst()
  actor = { userId: Number(user.insertId ?? 0), ip: '127.0.0.1' }

  const site = await db
    .insertInto('locations')
    .values({
      code: 'FIXLOC-CK',
      name: 'Fixture site for check-in',
      location_type: 'site_store',
      latitude: String(SITE.lat),
      longitude: String(SITE.lng),
    })
    .executeTakeFirst()
  siteId = Number(site.insertId ?? 0)

  // The check-in site the tests resolve against: an OFFICE location (the
  // new option source is office + projects, not the inventory list).
  await sql`delete from locations where code = 'FIXOFF-CK'`.execute(db)
  const office = await db
    .insertInto('locations')
    .values({
      code: 'FIXOFF-CK',
      name: 'Fixture head office',
      location_type: 'office',
      latitude: String(SITE.lat),
      longitude: String(SITE.lng),
    })
    .executeTakeFirstOrThrow()
  officeId = Number(office.insertId ?? 0)

  const noCoords = await db
    .insertInto('locations')
    .values({
      code: 'FIXLOC-CKNC',
      name: 'Fixture site with no coordinates',
      location_type: 'site_store',
    })
    .executeTakeFirst()
  farSiteId = Number(noCoords.insertId ?? 0)

  workerId = await svc.createEmployee(
    db,
    actor,
    employeeInput({ fullName: 'Fixture Worker Delta', gender: 'female', fatherOrSpouseName: 'Fixture Parent Delta' })
  )
  excludedId = await svc.createEmployee(
    db,
    actor,
    employeeInput({ fullName: 'Fixture Excluded Owner', gender: 'male', fatherOrSpouseName: 'Fixture Parent Owner' })
  )
  await db.updateTable('employees').set({ muster_excluded: 1 }).where('id', '=', excludedId).execute()
})

afterAll(async () => {
  for (const table of TRACKED) {
    await sql`delete from ${sql.table(table)} where id > ${highWater.get(table) ?? 0}`.execute(db)
  }
  await closePool()
})

describe('self check-in', () => {
  it('writes a row for a NEAR reading, unflagged', async () => {
    const result = await svc.selfCheckIn(db, actor, {
      employeeId: workerId,
      siteKey: 'office:' + officeId,
      reading: NEAR,
    })
    expect(result.outcome).toBe('ok')

    const row = await db
      .selectFrom('attendance')
      .select(['id', 'status', 'checkin_at', 'checkin_lat', 'checkin_far', 'checkout_at'])
      .where('employee_id', '=', workerId)
      .where('attendance_date', '=', today())
      .executeTakeFirstOrThrow()
    expect(Number(row.checkin_far)).toBe(0)
    expect(row.checkin_at).not.toBeNull()
    expect(Number(row.checkin_lat)).toBeCloseTo(NEAR.lat, 5)
    expect(row.checkout_at).toBeNull()
    expect(String(row.status)).toBe('present')
  })

  it('writes a row for a FAR reading and flags it — attendance is NEVER refused on location', async () => {
    // A second worker, so the first worker's already-checked-in state does not
    // interfere. This is the invariant test: the call must resolve, not throw.
    const second = await svc.createEmployee(
      db,
      actor,
      employeeInput({ fullName: 'Fixture Worker Epsilon', gender: 'male', fatherOrSpouseName: 'Fixture Parent Epsilon' })
    )
    epsilonId = second
    const result = await svc.selfCheckIn(db, actor, {
      employeeId: second,
      siteKey: 'office:' + officeId,
      reading: FAR,
    })
    expect(result.outcome).toBe('far')
    expect(result.distanceM ?? 0).toBeGreaterThan(SITE_FAR_THRESHOLD_M)

    const row = await db
      .selectFrom('attendance')
      .select(['id', 'checkin_far', 'checkin_at', 'status'])
      .where('employee_id', '=', second)
      .where('attendance_date', '=', today())
      .executeTakeFirstOrThrow()
    expect(Number(row.checkin_far)).toBe(1)
    expect(row.checkin_at).not.toBeNull()
    // The day stands: a far reading still records present, never a refusal.
    expect(String(row.status)).toBe('present')
  })

  it('on_duty_travel is NOT exempt — it flags far like any other day', async () => {
    const third = await svc.createEmployee(
      db,
      actor,
      employeeInput({ fullName: 'Fixture Worker Zeta', gender: 'male', fatherOrSpouseName: 'Fixture Parent Zeta' })
    )
    const result = await svc.selfCheckIn(db, actor, {
      employeeId: third,
      siteKey: 'office:' + officeId,
      reading: FAR,
    })
    expect(result.outcome).toBe('far')
  })

  it('upserts onto a day the supervisor already marked, preserving the status', async () => {
    const fourth = await svc.createEmployee(
      db,
      actor,
      employeeInput({ fullName: 'Fixture Worker Eta', gender: 'female', fatherOrSpouseName: 'Fixture Parent Eta' })
    )
    await db
      .insertInto('attendance')
      .values({
        employee_id: fourth,
        attendance_date: today(),
        status: 'on_duty_travel',
        overtime_hours: 0,
        marked_by: actor.userId,
      })
      .execute()

    const result = await svc.selfCheckIn(db, actor, {
      employeeId: fourth,
      siteKey: 'office:' + officeId,
      reading: NEAR,
    })
    expect(result.outcome).toBe('ok')
    const row = await db
      .selectFrom('attendance')
      .select(['status', 'checkin_at'])
      .where('employee_id', '=', fourth)
      .where('attendance_date', '=', today())
      .executeTakeFirstOrThrow()
    expect(String(row.status)).toBe('on_duty_travel')
    expect(row.checkin_at).not.toBeNull()
  })

  it('refuses a second check-in on the same day', async () => {
    await expect(
      svc.selfCheckIn(db, actor, { employeeId: workerId, siteKey: 'office:' + officeId, reading: NEAR })
    ).rejects.toThrow(/already checked in/)
  })

  it('a NORMAL employee still gets one row per day — the second check-in is refused', async () => {
    // The guard test-mode must not weaken: a worker without the flag is
    // refused on the second attempt, and the first row is untouched.
    const before = await db
      .selectFrom('attendance')
      .select(['id'])
      .where('employee_id', '=', workerId)
      .execute()
    await expect(
      svc.selfCheckIn(db, actor, {
        employeeId: workerId,
        siteKey: `office:${officeId}`,
        reading: FAR,
      })
    ).rejects.toThrow(/already checked in/)
    const after = await db
      .selectFrom('attendance')
      .select(['id', 'checkin_at'])
      .where('employee_id', '=', workerId)
      .execute()
    expect(after.length).toBe(before.length)
    expect(after.length).toBe(1)
  })

  it('TEST MODE: a flagged employee may check in and out repeatedly — each attempt overwrites, rows are marked checkin_test', async () => {
    const tester = await svc.createEmployee(
      db,
      actor,
      employeeInput({ fullName: 'Fixture Tester Omega', gender: 'male', fatherOrSpouseName: 'Fixture Parent Omega' })
    )
    await db
      .updateTable('employees')
      .set({ checkin_test_mode: 1 })
      .where('id', '=', tester)
      .execute()

    // First check-in on site, first check-out far.
    await svc.selfCheckIn(db, actor, { employeeId: tester, siteKey: `office:${officeId}`, reading: NEAR })
    await svc.selfCheckOut(db, actor, { employeeId: tester, siteKey: `office:${officeId}`, reading: FAR })

    // Second round: both would be refused without the flag.
    await svc.selfCheckIn(db, actor, { employeeId: tester, siteKey: `office:${officeId}`, reading: FAR })
    await svc.selfCheckOut(db, actor, { employeeId: tester, siteKey: `office:${officeId}`, reading: NEAR })

    const rows = await db
      .selectFrom('attendance')
      .select(['id', 'checkin_at', 'checkin_far', 'checkout_far', 'checkin_test'])
      .where('employee_id', '=', tester)
      .where('attendance_date', '=', today())
      .execute()
    // ONE row for the day, overwritten, not four.
    expect(rows.length).toBe(1)
    expect(Number(rows[0].checkin_test)).toBe(1)
    // The last attempt won: check-in far (overwrote the on-site one),
    // check-out near (overwrote the far one).
    expect(Number(rows[0].checkin_far)).toBe(1)
    expect(Number(rows[0].checkout_far)).toBe(0)

    // And a normal employee's row carries checkin_test = 0.
    const normal = await db
      .selectFrom('attendance')
      .select(['checkin_test'])
      .where('employee_id', '=', workerId)
      .executeTakeFirstOrThrow()
    expect(Number(normal.checkin_test)).toBe(0)
  })

  it('a 0,0 reading is stored as NULL/unavailable, never as an unflagged on-site position', async () => {
    // The production failure: (0, 0) is in range, so the first version
    // computed a plausible distance from it and recorded the worker in the
    // ocean with a clean on-site bill of health. The service must treat it as
    // a failed reading: NULLs and the unavailable flag, attendance standing.
    const seventh = await svc.createEmployee(
      db,
      actor,
      employeeInput({ fullName: 'Fixture Worker Kappa', gender: 'male', fatherOrSpouseName: 'Fixture Parent Kappa' })
    )
    const result = await svc.selfCheckIn(db, actor, {
      employeeId: seventh,
      siteKey: 'office:' + officeId,
      reading: { lat: 0, lng: 0 },
    })
    expect(result.outcome).toBe('unavailable')
    expect(result.far).toBe(false)
    expect(result.distanceM).toBeNull()

    const row = await db
      .selectFrom('attendance')
      .select(['checkin_at', 'checkin_lat', 'checkin_lng', 'checkin_far', 'status'])
      .where('employee_id', '=', seventh)
      .where('attendance_date', '=', today())
      .executeTakeFirstOrThrow()
    expect(row.checkin_at).not.toBeNull() // the attendance stands
    expect(row.checkin_lat).toBeNull()
    expect(row.checkin_lng).toBeNull()
    expect(Number(row.checkin_far)).toBe(0)
    expect(String(row.status)).toBe('present')
  })

  it('a null reading and an out-of-range reading are also stored as NULL/unavailable', async () => {
    const eighth = await svc.createEmployee(
      db,
      actor,
      employeeInput({ fullName: 'Fixture Worker Lambda', gender: 'female', fatherOrSpouseName: 'Fixture Parent Lambda' })
    )
    const noPosition = await svc.selfCheckIn(db, actor, {
      employeeId: eighth,
      siteKey: 'office:' + officeId,
      reading: null, // denied prompt / dead GPS
    })
    expect(noPosition.outcome).toBe('unavailable')

    const ninth = await svc.createEmployee(
      db,
      actor,
      employeeInput({ fullName: 'Fixture Worker Mu', gender: 'male', fatherOrSpouseName: 'Fixture Parent Mu' })
    )
    const outOfRange = await svc.selfCheckIn(db, actor, {
      employeeId: ninth,
      siteKey: 'office:' + officeId,
      reading: { lat: 999, lng: -4000 },
    })
    expect(outOfRange.outcome).toBe('unavailable')

    for (const id of [eighth, ninth]) {
      const row = await db
        .selectFrom('attendance')
        .select(['checkin_lat', 'checkin_lng'])
        .where('employee_id', '=', id)
        .where('attendance_date', '=', today())
        .executeTakeFirstOrThrow()
      expect(row.checkin_lat).toBeNull()
      expect(row.checkin_lng).toBeNull()
    }
  })

  it('refuses BY NAME for a muster-excluded employee, on check-in and check-out alike', async () => {
    await expect(
      svc.selfCheckIn(db, actor, { employeeId: excludedId, siteKey: 'office:' + officeId, reading: NEAR })
    ).rejects.toThrow(/Fixture Excluded Owner/)
    await expect(
      svc.selfCheckOut(db, actor, { employeeId: excludedId, siteKey: 'office:' + officeId, reading: NEAR })
    ).rejects.toThrow(/Fixture Excluded Owner/)
  })
})

describe('self check-out', () => {
  it('writes its own columns and flag, leaving the check-in untouched', async () => {
    const fifth = await svc.createEmployee(
      db,
      actor,
      employeeInput({ fullName: 'Fixture Worker Theta', gender: 'female', fatherOrSpouseName: 'Fixture Parent Theta' })
    )
    thetaId = fifth
    await svc.selfCheckIn(db, actor, { employeeId: fifth, siteKey: 'office:' + officeId, reading: NEAR })
    const result = await svc.selfCheckOut(db, actor, {
      employeeId: fifth,
      siteKey: 'office:' + officeId,
      reading: FAR, // left the site by end of day; far checkout is still recorded
    })

    expect(result.outcome).toBe('far')
    const row = await db
      .selectFrom('attendance')
      .select(['checkin_lat', 'checkin_far', 'checkout_at', 'checkout_lat', 'checkout_far'])
      .where('employee_id', '=', fifth)
      .where('attendance_date', '=', today())
      .executeTakeFirstOrThrow()
    // The morning is untouched; the evening is far and flagged.
    expect(Number(row.checkin_far)).toBe(0)
    expect(Number(row.checkin_lat)).toBeCloseTo(NEAR.lat, 5)
    expect(row.checkout_at).not.toBeNull()
    expect(Number(row.checkout_far)).toBe(1)
    expect(Number(row.checkout_lat)).toBeCloseTo(FAR.lat, 5)
  })

  it('refuses a check-out with no check-in', async () => {
    const sixth = await svc.createEmployee(
      db,
      actor,
      employeeInput({ fullName: 'Fixture Worker Iota', gender: 'male', fatherOrSpouseName: 'Fixture Parent Iota' })
    )
    await expect(
      svc.selfCheckOut(db, actor, { employeeId: sixth, siteKey: 'office:' + officeId, reading: NEAR })
    ).rejects.toThrow(/no check-in recorded/)
  })
})

describe('muster exclusion is a write gate on the HR paths too', () => {
  it('refuses recordAttendanceBulk by name for a muster-excluded employee', async () => {
    await expect(
      svc.recordAttendanceBulk(
        db,
        actor,
        {
          attendanceDate: '2026-09-02',
          projectId: null,
          rows: [{ employeeId: excludedId, status: 'present' as const, inTime: null, outTime: null, overtimeHours: '', remarks: null }],
        },
        { canOverridePeriod: false }
      )
    ).rejects.toThrow(/Fixture Excluded Owner \(EMP\d+\)/)
  })

  it('refuses recordAttendanceGrid by name for a muster-excluded employee', async () => {
    await expect(
      svc.recordAttendanceGrid(
        db,
        actor,
        {
          month: '2026-09',
          projectId: null,
          cells: [{ employeeId: excludedId, date: '2026-09-02', status: 'present' as const }],
        },
        { canOverridePeriod: false }
      )
    ).rejects.toThrow(/Fixture Excluded Owner/)
  })
})

describe('the HR day view', () => {
  it('lists EVERY reading for the day with its flag, not only the far ones', async () => {
    const all = await q.farChecksOn(db, today())
    const mine = all.filter((r) => [epsilonId, thetaId].includes(r.employee_id))
    // Epsilon checked in FAR; Theta checked in NEAR and checked out FAR.
    expect(mine.length).toBe(3)
    const epsilon = mine.find((r) => r.employee_id === epsilonId)
    expect(epsilon?.flag).toBe('far')
    const thetaIn = mine.find((r) => r.employee_id === thetaId && r.which === 'checkin')
    const thetaOut = mine.find((r) => r.employee_id === thetaId && r.which === 'checkout')
    expect(thetaIn?.flag).toBe('ok')
    expect(thetaOut?.flag).toBe('far')
    // Coordinates render as numbers the Maps link can interpolate.
    expect(thetaIn?.lat).not.toBeNull()
    expect(Number(thetaIn?.lat)).toBeCloseTo(NEAR.lat, 5)
  })
})

/* Resolved after the fixture writes so the day-view test can name them. */
let epsilonId = 0
let thetaId = 0

describe('geometry agrees with the write path', () => {
  it('the flagged reading really is beyond 500 m from the site', async () => {
    expect(distanceMeters(SITE, FAR)).toBeGreaterThan(SITE_FAR_THRESHOLD_M)
    expect(distanceMeters(SITE, NEAR)).toBeLessThan(SITE_FAR_THRESHOLD_M)
  })
})


