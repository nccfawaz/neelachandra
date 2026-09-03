#!/usr/bin/env node
// scripts/reconcile-stock.mjs
// Replays stock_ledger and checks that item_stock matches (spec 6.4 rule 1:
// stock_ledger is append-only and authoritative, item_stock is a rebuildable
// cache with exactly one writer).
//
// Usage:
//   node scripts/reconcile-stock.mjs                 check $DB_NAME, exit 1 on drift
//   node scripts/reconcile-stock.mjs --db NAME       check NAME instead
//   node scripts/reconcile-stock.mjs --verbose       print every pair, not just drift
//
// There is deliberately no --fix. Rule 1 says postStockMovement is the only
// thing that writes item_stock, and a repair flag here would make that false in
// the one script whose whole job is to prove it. A drift is a bug in whatever
// wrote the cache; rebuilding the row hides it and loses the evidence. If a row
// genuinely has to be rebuilt, that is a considered manual operation with the
// ledger in front of you, not a nightly cron side effect.
//
// The replay is a line-by-line copy of postStockMovement's arithmetic, in
// stock_ledger.id order per (item_id, location_id):
//   balance_after = round3(qty + qty_in - qty_out)
//   wac           = qty > 0 ? value / qty : 0
//   in  -> value += round(rate_paise * qty_in)          [stored rate: it came
//                                                        from a form or a GRN,
//                                                        so it is an input the
//                                                        replay cannot derive]
//   out -> value -= (balance_after <= 0 ? value : round(wac * qty_out))
//   value         = max(0, value)
// Any change to that block in service.ts has to be made here in the same
// commit, or this script starts reporting drift that is not there. That
// duplication is the point: two independent implementations disagreeing is the
// signal.
//
// What is checked, per (item_id, location_id):
//   1. every ledger row's own balance_after matches the running balance
//      (a mismatch means rows were deleted, edited, or inserted out of order,
//      all of which an append-only table forbids)
//   2. every ledger row's value_paise matches the computed magnitude
//   3. every out-movement's rate_paise matches the weighted average at the time
//   4. item_stock.qty_on_hand and value_paise match the replayed totals
//   5. item_stock.last_txn_id is the highest ledger id for that pair
//   6. no item_stock row holds quantity or value with no ledger behind it
//
// .env is loaded when present and never overrides real environment variables,
// so the same script runs locally and from Hostinger cron.

import { createConnection } from 'mysql2/promise'

try {
  process.loadEnvFile()
} catch {
  // No .env file. Real environment variables only.
}

const args = process.argv.slice(2)
const verbose = args.includes('--verbose')
const dbFlagIndex = args.indexOf('--db')
let dbNameOverride
if (dbFlagIndex !== -1) {
  dbNameOverride = args[dbFlagIndex + 1]
  if (!dbNameOverride) {
    console.error('--db requires a database name')
    process.exit(1)
  }
}

const requiredEnv = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME']
const missingEnv = requiredEnv.filter((key) => !process.env[key])
if (missingEnv.length > 0) {
  console.error('Missing environment variables: ' + missingEnv.join(', '))
  process.exit(1)
}

const database = dbNameOverride || process.env.DB_NAME

/** Quantities are DECIMAL(14,3). Mirrors round3 in modules/inventory/service.ts. */
const round3 = (n) => Math.round(n * 1000) / 1000

/** A quantity difference under half the last decimal place is representation, not drift. */
const QTY_EPSILON = 0.0005

const problems = []
const report = (key, message) => problems.push(key + ': ' + message)

const connection = await createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database,
  charset: 'utf8mb4',
  // Matches the app pool: DECIMAL arrives as a string and every arithmetic
  // site wraps it in Number(), so the replay sees exactly what the app sees.
  dateStrings: true,
})

console.log('Target database: ' + database)

const [ledgerRows] = await connection.query(`
  SELECT sl.id, sl.item_id, sl.location_id, sl.txn_type, sl.ref_table, sl.ref_id,
         sl.qty_in, sl.qty_out, sl.rate_paise, sl.value_paise, sl.balance_after,
         i.code AS item_code, l.name AS location_name
    FROM stock_ledger sl
    JOIN items i ON i.id = sl.item_id
    JOIN locations l ON l.id = sl.location_id
   ORDER BY sl.item_id, sl.location_id, sl.id
`)

const [cacheRows] = await connection.query(`
  SELECT s.item_id, s.location_id, s.qty_on_hand, s.value_paise, s.last_txn_id,
         i.code AS item_code, l.name AS location_name
    FROM item_stock s
    JOIN items i ON i.id = s.item_id
    JOIN locations l ON l.id = s.location_id
`)

await connection.end()

const cache = new Map()
for (const row of cacheRows) {
  cache.set(Number(row.item_id) + ':' + Number(row.location_id), row)
}

/** Replayed state per pair, built in one pass because the rows arrive sorted. */
const replayed = new Map()
let current = null

const finish = () => {
  if (current !== null) replayed.set(current.key, current)
}

for (const row of ledgerRows) {
  const key = Number(row.item_id) + ':' + Number(row.location_id)
  if (current === null || current.key !== key) {
    finish()
    current = { key, label: row.item_code + ' @ ' + row.location_name, qty: 0, value: 0, lastId: 0, rows: 0 }
  }

  const qtyIn = Number(row.qty_in)
  const qtyOut = Number(row.qty_out)
  const balanceAfter = round3(current.qty + qtyIn - qtyOut)
  const wac = current.qty > 0 ? current.value / current.qty : 0

  let valueDelta
  if (qtyIn > 0) {
    valueDelta = Math.round(Number(row.rate_paise ?? 0) * qtyIn)
  } else {
    const expectedRate = Math.round(wac)
    if (row.rate_paise !== null && Number(row.rate_paise) !== expectedRate) {
      report(
        current.label,
        `ledger row ${row.id} (${row.txn_type} from ${row.ref_table}#${row.ref_id}) went out at ` +
          `${Number(row.rate_paise)} paise, but the store's weighted average at that point was ${expectedRate}. ` +
          'An out-movement is valued at the average the store holds, never at a typed rate.'
      )
    }
    valueDelta = -(balanceAfter <= 0 ? current.value : Math.round(wac * qtyOut))
  }

  if (Math.abs(Number(row.balance_after) - balanceAfter) > QTY_EPSILON) {
    report(
      current.label,
      `ledger row ${row.id} records balance_after ${Number(row.balance_after)} but replaying every earlier row ` +
        `gives ${balanceAfter}. stock_ledger is append-only, so this means a row was deleted, edited, or ` +
        'inserted with an id out of chronological order.'
    )
  }

  if (Number(row.value_paise ?? 0) !== Math.abs(valueDelta)) {
    report(
      current.label,
      `ledger row ${row.id} records value_paise ${Number(row.value_paise ?? 0)} but the replay computes ` +
        `${Math.abs(valueDelta)}.`
    )
  }

  current.qty = balanceAfter
  current.value = Math.max(0, current.value + valueDelta)
  current.lastId = Number(row.id)
  current.rows += 1
}
finish()

for (const [key, state] of replayed) {
  const cached = cache.get(key)
  if (cached === undefined) {
    report(
      state.label,
      `${state.rows} ledger rows leave ${state.qty} on hand, but item_stock has no row for this ` +
        'item and store at all. The cache row is created by postStockMovement before it locks, so a ' +
        'missing row means the cache was truncated or the ledger was written by something else.'
    )
    continue
  }

  if (Math.abs(Number(cached.qty_on_hand) - state.qty) > QTY_EPSILON) {
    report(
      state.label,
      `item_stock says ${Number(cached.qty_on_hand)} on hand, the ledger says ${state.qty} ` +
        `(difference ${round3(Number(cached.qty_on_hand) - state.qty)} over ${state.rows} rows).`
    )
  }

  if (Number(cached.value_paise) !== state.value) {
    report(
      state.label,
      `item_stock holds ${Number(cached.value_paise)} paise of value, the ledger replays to ${state.value} ` +
        `(difference ${Number(cached.value_paise) - state.value} paise).`
    )
  }

  if (Number(cached.last_txn_id ?? 0) !== state.lastId) {
    report(
      state.label,
      `item_stock.last_txn_id is ${Number(cached.last_txn_id ?? 0)}, but the newest ledger row for this pair ` +
        `is ${state.lastId}. Either a movement did not update the cache or the cache points at another pair's row.`
    )
  }

  if (verbose) {
    console.log(`  ok  ${state.label}: ${state.qty} on hand, ${state.value} paise, ${state.rows} ledger rows`)
  }
}

// A cache row with no ledger behind it is only legitimate at zero: that is the
// placeholder postStockMovement inserts before it locks, and a movement that
// then fails validation leaves it committed at zero by the outer rollback's
// absence. Anything non-zero is stock that no document accounts for.
for (const [key, cached] of cache) {
  if (replayed.has(key)) continue
  const qtyOnHand = Number(cached.qty_on_hand)
  const value = Number(cached.value_paise)
  if (Math.abs(qtyOnHand) > QTY_EPSILON || value !== 0) {
    report(
      cached.item_code + ' @ ' + cached.location_name,
      `item_stock holds ${qtyOnHand} and ${value} paise with no stock_ledger row behind it. Nothing but ` +
        'postStockMovement may write that table, and it always writes a ledger row first.'
    )
  }
}

console.log(
  `${ledgerRows.length} ledger rows replayed across ${replayed.size} item/store pairs, ` +
    `${cacheRows.length} item_stock rows checked.`
)

if (problems.length > 0) {
  console.error('')
  console.error(`${problems.length} problem${problems.length === 1 ? '' : 's'} found:`)
  for (const problem of problems) console.error('  - ' + problem)
  console.error('')
  console.error(
    'stock_ledger is the authority. Do not edit it to agree with the cache. Find what wrote item_stock ' +
      'outside postStockMovement first: this script is the canary for exactly that, and rebuilding the ' +
      'cache before the cause is known only buys silence until tomorrow night.'
  )
  process.exit(1)
}

console.log('No drift. item_stock agrees with stock_ledger on every pair.')
