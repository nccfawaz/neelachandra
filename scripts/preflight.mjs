// scripts/preflight.mjs — §7.6 production preflight (DECISIONS 29.70).
//
// Checks the deployment target, not this machine: point it at a database and
// environment with the production .env and it reports whether cut-over can
// proceed. Exit 0 = go, 1 = blocker found, 2 = the environment itself is
// unusable (cannot even check).
//
// Usage: node scripts/preflight.mjs [--env path/to/.env]
// Without --env it reads .env from the repo root if present.
//
// Read-only: it SELECTs and SHOWs, it never writes. It deliberately refuses
// the dev database's own shape of failure — fixture rows, test-login accounts,
// a TOTP key still equal to the dev one — because those are exactly the rows
// that must not survive into production (DECISIONS 29.62: the fence stays in
// force for production).

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const mysql = require('mysql2/promise')

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const envIdx = args.indexOf('--env')
const envPath = envIdx >= 0 ? resolve(args[envIdx + 1] ?? '') : resolve(here, '../.env')

const blockers = []
const warnings = []
const goods = []

function good(msg) { goods.push(msg) }
function block(msg) { blockers.push(msg) }
function warn(msg) { warnings.push(msg) }

// ---- environment -----------------------------------------------------------
if (envIdx >= 0 && !existsSync(envPath)) {
  console.error(`REFUSED: --env ${envPath} does not exist.`)
  process.exit(2)
}
if (!existsSync(envPath)) {
  console.error('REFUSED: no .env found at the repo root. Pass --env path/to/.env with the production values.')
  process.exit(2)
}
const raw = readFileSync(envPath, 'utf8')
const env = {}
for (const line of raw.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

const REQUIRED = [
  'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME',
  'SESSION_SECRET', 'TOTP_ENCRYPTION_KEY', 'CRON_SECRET',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD',
  'UPLOAD_PUBLIC_DIR', 'UPLOAD_PRIVATE_DIR', 'INDEXNOW_KEY', 'APP_BASE_URL', 'NODE_ENV',
]
const SECRET_MIN = { SESSION_SECRET: 32, TOTP_ENCRYPTION_KEY: 32, CRON_SECRET: 16 }

for (const k of REQUIRED) {
  if (!env[k] || !String(env[k]).trim()) block(`env ${k} is empty`)
}
for (const [k, min] of Object.entries(SECRET_MIN)) {
  if (env[k] && String(env[k]).length < min) block(`env ${k} is shorter than ${min} characters (${String(env[k]).length})`)
}
if (env.NODE_ENV !== 'production') block(`NODE_ENV is "${env.NODE_ENV ?? '(unset)'}", must be "production"`)
if (!/^https?:\/\//.test(env.APP_BASE_URL ?? '')) block('APP_BASE_URL must be an absolute origin')
if (env.DB_PORT && Number(env.DB_PORT) === 3307) warn('DB_PORT is 3307 — that is the dev database port; production uses 3306 on hPanel')

// ---- dev-vs-prod secret provenance (29.50/29.44) ---------------------------
// The dev .env lives in the repo checkout; if the production key equals it,
// the production TOTP cipher is derived from a value that has sat in a dev
// checkout. Read dev .env when it exists for the comparison.
const devEnvPath = resolve(here, '../.env.dev-reference')
let devSecrets = null
for (const cand of [resolve(here, '../.env'), process.env.NCC_DEV_ENV_REF && resolve(process.env.NCC_DEV_ENV_REF)]) {
  if (cand && existsSync(cand) && cand !== envPath) {
    let st
    try { st = (await import('node:fs')).statSync(cand) } catch { continue }
    if (!st.isFile()) continue
    const devRaw = readFileSync(cand, 'utf8')
    devSecrets = {}
    for (const line of devRaw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m) devSecrets[m[1]] = m[2]
    }
    break
  }
}
if (devSecrets) {
  for (const k of ['SESSION_SECRET', 'TOTP_ENCRYPTION_KEY', 'CRON_SECRET']) {
    if (env[k] && devSecrets[k] && env[k] === devSecrets[k]) {
      if (k === 'TOTP_ENCRYPTION_KEY') block(`TOTP_ENCRYPTION_KEY equals the development value — set a fresh key BEFORE first 2FA enrolment (29.44/29.50)`)
      else warn(`${k} equals the development value — rotate before cut-over`)
    }
  }
} else {
  warn('could not locate a dev .env to compare secrets against; verify TOTP_ENCRYPTION_KEY is fresh by hand')
}

// ---- database --------------------------------------------------------------
let conn = null
try {
  conn = await mysql.createConnection({
    host: env.DB_HOST, port: Number(env.DB_PORT ?? 3306),
    user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME,
    connectTimeout: 8000,
  })
  good(`database ${env.DB_NAME} at ${env.DB_HOST}:${env.DB_PORT} reachable`)
} catch (e) {
  block(`database unreachable: ${e.message}`)
  report()
}

const q = async (sql) => (await conn.query(sql))[0]

// migrations
const migTables = await q(`SHOW TABLES LIKE 'schema_migrations'`)
if (migTables.length === 0) {
  block('schema_migrations table does not exist — migrations have never run on this database')
} else {
  const applied = await q(`SELECT name FROM schema_migrations ORDER BY name`)
  const { readdirSync } = await import('node:fs')
  const migDir = resolve(here, '../migrations')
  const files = readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort()
  const appliedNames = new Set(applied.map((r) => r.name))
  const pending = files.filter((f) => !appliedNames.has(f))
  if (applied.length !== files.length) block(`migrations: ${applied.length} applied vs ${files.length} on disk (${pending.length} pending: ${pending.slice(0, 4).join(', ')}${pending.length > 4 ? '…' : ''})`)
  else good(`all ${files.length} migrations applied`)
}

// approval_limits must exist but stay empty until 8.2 is answered (§8.2)
try {
  const al = await q(`SELECT COUNT(*) AS n FROM approval_limits`)
  const n = Number(al[0].n)
  if (n > 0) warn(`approval_limits holds ${n} row(s) — §8.2 numbers must be owner-supplied before these mean anything`)
  else good('approval_limits is empty (§8.2 unanswered, as it should be at cut-over)')
} catch { block('approval_limits table missing') }

// fixture rows — any hit is a blocker
const fixtureChecks = [
  [`users with fixture-marker names`, `SELECT COUNT(*) AS n FROM users WHERE full_name LIKE '[fixture]%'`],
  [`users on example.invalid emails`, `SELECT COUNT(*) AS n FROM users WHERE email LIKE '%@example.invalid'`],
  [`test-login accounts (test.login@ / test.owner@)`, `SELECT COUNT(*) AS n FROM users WHERE email IN ('test.login@neelachandra.dev','test.owner@neelachandra.dev')`],
  [`dormant break-glass admin`, `SELECT COUNT(*) AS n FROM users WHERE email = 'dormant.admin@neelachandra.dev'`],
]
for (const [label, sql] of fixtureChecks) {
  try {
    const r = await q(sql)
    const n = Number(r[0].n)
    if (n > 0) block(`${label}: ${n} row(s) present — run the sweep / drop these before cut-over`)
    else good(`no ${label}`)
  } catch { warn(`could not check ${label} (table shape differs?)`) }
}

// 2FA posture: who is enrolled, so the operator knows what the key protects
try {
  const enrolled = await q(`SELECT COUNT(*) AS n FROM users WHERE totp_secret IS NOT NULL`)
  const n = Number(enrolled[0].n)
  if (n > 0) warn(`${n} user(s) already enrolled in 2FA — TOTP_ENCRYPTION_KEY is now load-bearing; its offline backup must exist before go-live`)
  else good('no accounts enrolled in 2FA yet — set the production TOTP_ENCRYPTION_KEY before the first enrolment')
} catch { /* column may differ; not a blocker */ }

conn.end()
report()

function report() {
  console.log('')
  console.log('=== §7.6 preflight (DECISIONS 29.70) ===')
  for (const g of goods) console.log(`  ok       ${g}`)
  for (const w of warnings) console.log(`  warn     ${w}`)
  for (const b of blockers) console.log(`  BLOCKER  ${b}`)
  console.log('')
  if (blockers.length > 0) { console.log(`RESULT: REFUSE — ${blockers.length} blocker(s).`); process.exit(1) }
  console.log(`RESULT: GO (${warnings.length} warning(s) to acknowledge).`)
  process.exit(0)
}
