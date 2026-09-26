import { describe, expect, it } from 'vitest'
import {
  STAFF_ROLE_KEYS,
  isStaffSession,
  ttlFor,
  dueForRenewal,
  SESSION_TTL_SECONDS,
  STAFF_SESSION_TTL_SECONDS,
} from '../../src/lib/session.js'

/*
 * The two session flavours (DECISIONS 34.1), unit level.
 *
 * The integration suite exercises the whole login; these pin the DECISION
 * TABLE ITSELF: which roles get the rolling month, which keep the absolute
 * 12 hours, and exactly when the sliding renewal fires.
 */

const DAY = 24 * 60 * 60 * 1000

describe('session flavour from roles (34.1, extended 34.2)', () => {
  it('every operational role gets the long rolling session', () => {
    // The three original field roles (34.1) plus the five the owner moved on
    // 2026-09-26 (34.2): PMs, procurement, sales, ops and marketing all work
    // away from a shared office machine, so they get the rolling month.
    for (const role of [
      'site_engineer',
      'site_supervisor',
      'qa_qc',
      'project_manager',
      'procurement_executive',
      'sales_exec',
      'ops_manager',
      'digital_marketing',
    ]) {
      expect(STAFF_ROLE_KEYS).toContain(role)
      expect(isStaffSession([role]), `${role} must be staff flavour`).toBe(true)
    }
  })

  it('the privileged sensitive-data roles keep the absolute 12 hours (34.2)', () => {
    // Owner, admin, accounts_manager, hr_manager are DELIBERATELY excluded: a
    // 30-day cookie on a shared desk is the exposure the short flavour bounds
    // (company money, user/role administration, employee PII).
    for (const role of ['owner', 'admin', 'accounts_manager', 'hr_manager']) {
      expect(STAFF_ROLE_KEYS).not.toContain(role)
      expect(isStaffSession([role]), `${role} must be office flavour`).toBe(false)
    }
  })

  it('any staff role among several wins the long session', () => {
    expect(isStaffSession(['owner', 'site_supervisor'])).toBe(true)
  })

  it('an unknown role is office flavour, not staff', () => {
    expect(isStaffSession(['brand_new_role'])).toBe(false)
    expect(isStaffSession([])).toBe(false)
  })

  it('the TTLs are 30 days and 12 hours', () => {
    expect(STAFF_SESSION_TTL_SECONDS).toBe(30 * 24 * 60 * 60)
    expect(SESSION_TTL_SECONDS).toBe(12 * 60 * 60)
    expect(ttlFor(true)).toBe(STAFF_SESSION_TTL_SECONDS)
    expect(ttlFor(false)).toBe(SESSION_TTL_SECONDS)
  })
})

describe('sliding renewal at half-life (34.1)', () => {
  const now = 1_000_000_000_000

  it('renews when less than half the TTL remains', () => {
    // 10 days left of a 30-day session: below half-life.
    expect(dueForRenewal(now + 10 * DAY, STAFF_SESSION_TTL_SECONDS, now)).toBe(true)
    // One second left: certainly due.
    expect(dueForRenewal(now + 1000, STAFF_SESSION_TTL_SECONDS, now)).toBe(true)
  })

  it('does NOT renew while more than half remains', () => {
    // 20 days left: above half-life.
    expect(dueForRenewal(now + 20 * DAY, STAFF_SESSION_TTL_SECONDS, now)).toBe(false)
    // A brand-new session: nothing due for ~15 days.
    expect(dueForRenewal(now + STAFF_SESSION_TTL_SECONDS * 1000, STAFF_SESSION_TTL_SECONDS, now)).toBe(false)
  })

  it('an office session near expiry is excluded by the staff guard, not the clock', () => {
    // The middleware renews only when isStaffSession(roleKeys) is true; the
    // clock check alone is flavour-blind (2h left is well inside half of
    // 30 days). The integration suite pins that the OFFICE session's row is
    // never extended; this pins that an office role key is what gates it.
    expect(isStaffSession(['admin'])).toBe(false)
    // And the clock, had it been a staff session, WOULD be due:
    expect(dueForRenewal(now + 2 * 60 * 60 * 1000, STAFF_SESSION_TTL_SECONDS, now)).toBe(true)
  })

  it('an unparsable expiry never renews (fail closed)', () => {
    expect(dueForRenewal(0, STAFF_SESSION_TTL_SECONDS, now)).toBe(false)
  })
})
