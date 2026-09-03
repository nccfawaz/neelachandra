import { Hono } from 'hono'
import type { AppEnv } from '../../types.js'
import { cronAuth } from '../../middleware/cronAuth.js'
import { purgeExpiredSessions } from '../../lib/session.js'
import { purgeExpired as purgeRateLimits } from '../../lib/ratelimit.js'
import { today } from '../../lib/dates.js'
import { stockAlerts } from '../../modules/inventory/service.js'
import { runCrmFollowups } from '../../modules/crm/service.js'

/**
 * Scheduled jobs, invoked by Hostinger cron over HTTP with X-Cron-Key.
 *
 * They are HTTP routes rather than separate processes because the shared
 * hosting plan gives one Node process, and a second one competing for the
 * same pool would be the first thing to exhaust the connection limit.
 *
 * Each job is idempotent, so a cron that fires twice or retries after a
 * timeout cannot double-count anything.
 */

const cron = new Hono<AppEnv>()

cron.use('*', cronAuth())

/** Housekeeping: expired sessions and spent rate-limit rows. */
cron.post('/housekeeping', async (c) => {
  const db = c.get('db')
  const sessions = await purgeExpiredSessions(db)
  const limits = await purgeRateLimits(db)
  return c.json({ ok: true, ran_on: today(), sessions_purged: sessions, rate_limits_purged: limits })
})

/**
 * Reorder level, batch expiry, equipment service and insurance — the four
 * things the spec's route table puts behind this one endpoint.
 *
 * It calls inventory's stockAlerts rather than querying here, so the daily
 * email and the storekeeper's dashboard cannot disagree about what is low. The
 * scope argument is null: a cron has no user, and an alert that a job silently
 * narrowed to one project's stores is worse than no alert.
 *
 * The stock cache is authoritative enough for an alert; the ledger is
 * authoritative for a number that gets paid against.
 *
 * `negative_balances` should always be zero. Anything else means item_stock has
 * drifted from stock_ledger or something wrote the cache outside
 * postStockMovement, so it is returned at the top level where a cron log
 * scraper will see it rather than buried in the payload.
 */
cron.post('/stock-alerts', async (c) => {
  const alerts = await stockAlerts(c.get('db'), null)

  return c.json({
    ok: true,
    ran_on: today(),
    below_reorder: alerts.lowStock.length,
    expiring_batches: alerts.expiring.length,
    equipment_due: alerts.equipment.length,
    negative_balances: alerts.negative.length,
    low_stock: alerts.lowStock,
    expiring: alerts.expiring,
    equipment: alerts.equipment,
    negative: alerts.negative,
  })
})

/**
 * CRM follow-ups: rule 9's dormancy sweep, overdue next actions, unassigned
 * enquiries and quotes near expiry.
 *
 * `went_dormant` is the one figure worth watching over time. A number that keeps
 * climbing is not a cron problem, it is leads arriving faster than anyone is
 * calling them, which is exactly what spec 6.7 rule 9 exists to make visible.
 */
cron.post('/crm-followups', async (c) => {
  const result = await runCrmFollowups(c.get('db'))

  return c.json({
    ok: true,
    ran_on: result.ranOn,
    dormancy_days: result.dormancyDays,
    went_dormant: result.wentDormant,
    quotes_expired: result.quotesExpired,
    quotes_near_expiry: result.quotesNearExpiry,
    overdue_actions: result.overdueActions,
    unassigned_enquiries: result.unassignedEnquiries,
    unassigned_leads: result.unassignedLeads,
    notifications_written: result.notified,
  })
})

/** Document expiry: contractor licences, WC policies and employee documents. */
cron.post('/document-expiry', async (c) => {
  const db = c.get('db')
  const on = today()

  const licences = await db
    .selectFrom('labour_contractors')
    .select(['id', 'name', 'licence_valid_until', 'wc_policy_valid_until'])
    .where('status', '=', 'active')
    .where((eb) =>
      eb.or([
        eb('licence_valid_until', '<', on),
        eb('wc_policy_valid_until', '<', on),
      ])
    )
    .execute()

  return c.json({ ok: true, ran_on: on, expired_contractor_documents: licences.length, contractors: licences })
})

export default cron
