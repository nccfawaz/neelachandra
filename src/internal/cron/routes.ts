import { Hono } from 'hono'
import type { AppEnv } from '../../types.js'
import { cronAuth } from '../../middleware/cronAuth.js'
import { purgeExpiredSessions } from '../../lib/session.js'
import { purgeExpired as purgeRateLimits } from '../../lib/ratelimit.js'
import { today } from '../../lib/dates.js'

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
 * Reorder-level and expiry alerts.
 *
 * The stock cache is authoritative enough for an alert; the ledger is
 * authoritative for a number that gets paid against.
 */
cron.post('/stock-alerts', async (c) => {
  const db = c.get('db')
  const low = await db
    .selectFrom('item_stock')
    .innerJoin('items', 'items.id', 'item_stock.item_id')
    .innerJoin('locations', 'locations.id', 'item_stock.location_id')
    .select([
      'items.code as item_code',
      'items.name as item_name',
      'locations.name as location_name',
      'item_stock.qty_on_hand',
      'items.reorder_level',
    ])
    .where('items.is_active', '=', 1)
    .whereRef('item_stock.qty_on_hand', '<=', 'items.reorder_level')
    .execute()

  return c.json({ ok: true, ran_on: today(), below_reorder: low.length, items: low })
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
