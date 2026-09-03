#!/usr/bin/env node
/**
 * audit-rbac-seed.mjs
 *
 * Static analysis of the RBAC seed in migrations/002_rbac.sql.
 *
 * WHY THIS EXISTS: the grant blocks are `INSERT ... SELECT ... JOIN permissions
 * ON p.key IN (...)`, which is deliberately independent of AUTO_INCREMENT
 * values, but has one failure mode: a mistyped permission key matches no row
 * and silently grants nothing. MySQL reports success either way. The header
 * comment claims specific per-role counts, so this checks the SQL against its
 * own claim without needing a database.
 *
 * This is a PARSE, not a migration run. It proves the seed is internally
 * consistent; it does not prove the migration applies.
 *
 *   node scripts/audit-rbac-seed.mjs
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const sql = await readFile(join(ROOT, 'migrations', '002_rbac.sql'), 'utf8')

// --- roles -----------------------------------------------------------------
const rolesBlock = /INSERT INTO roles[\s\S]*?;/i.exec(sql)?.[0] ?? ''
const roles = [...rolesBlock.matchAll(/^\s*\('([a-z_]+)'\s*,/gim)].map(m => m[1])

// --- permissions -----------------------------------------------------------
const permsBlock = /INSERT INTO permissions[\s\S]*?;/i.exec(sql)?.[0] ?? ''
const perms = [...permsBlock.matchAll(/^\s*\('([a-z_.]+)'\s*,\s*'([a-z_]+)'/gim)]
  .map(m => ({ key: m[1], module: m[2] }))
const permKeys = new Set(perms.map(p => p.key))

// --- grants ---------------------------------------------------------------
const grants = []
for (const m of sql.matchAll(/INSERT INTO role_permissions[\s\S]*?WHERE r\.`key` = '([a-z_]+)';/gi)) {
  const body = m[0]
  const role = m[1]
  if (/CROSS JOIN permissions/i.test(body)) {
    grants.push({ role, mode: 'CROSS JOIN (all)', keys: [...permKeys], unknown: [], dupes: [] })
    continue
  }
  const inList = /ON p\.`key` IN \(([\s\S]*?)\)/i.exec(body)?.[1] ?? ''
  const keys = [...inList.matchAll(/'([a-z_.]+)'/g)].map(k => k[1])
  const seen = new Set(), dupes = []
  for (const k of keys) { if (seen.has(k)) dupes.push(k); seen.add(k) }
  grants.push({ role, mode: 'IN list', keys: [...seen],
    unknown: [...seen].filter(k => !permKeys.has(k)), dupes })
}

// The counts the file's own comment claims. The comment wraps across lines, so
// the leading "--" of each continuation is stripped before parsing; without
// that, "hr_manager\n-- 12" fails to pair and the role reports as unclaimed.
const claimed = /Grant counts:([\s\S]*?)Total (\d+)\./i.exec(sql)
const claimedPer = {}
if (claimed) {
  const flat = claimed[1].replace(/^\s*--/gm, ' ')
  for (const m of flat.matchAll(/([a-z_]+)\s+(\d+)/g)) claimedPer[m[1]] = Number(m[2])
}
const claimedTotal = claimed ? Number(claimed[2]) : null

// --- report ---------------------------------------------------------------
console.log('\nRBAC seed static audit  (migrations/002_rbac.sql)\n')
console.log(`  roles defined        ${roles.length}`)
console.log(`  permissions defined  ${perms.length}`)

const byModule = {}
for (const p of perms) byModule[p.module] = (byModule[p.module] ?? 0) + 1
console.log(`  permissions by module`)
for (const [k, v] of Object.entries(byModule)) console.log(`      ${k.padEnd(12)} ${String(v).padStart(3)}`)

const dupPerm = perms.length !== permKeys.size
console.log(`\n  role              grants  claimed  match  unknown-key  dupes`)
console.log('  ' + '-'.repeat(64))
let total = 0, problems = 0
for (const g of grants) {
  const n = g.keys.filter(k => permKeys.has(k)).length
  total += n
  const c = claimedPer[g.role]
  const ok = c === undefined ? null : c === n
  if (ok === false || g.unknown.length || g.dupes.length) problems++
  console.log(`  ${g.role.padEnd(18)}${String(n).padStart(5)}  ${String(c ?? '-').padStart(7)}` +
    `  ${(ok === null ? '?' : ok ? 'yes' : 'NO').padStart(5)}` +
    `  ${String(g.unknown.length).padStart(11)}  ${String(g.dupes.length).padStart(5)}`)
  for (const u of g.unknown) console.log(`      unknown permission key: ${u}  (grants 0 rows silently)`)
  for (const d of g.dupes) console.log(`      duplicate in IN list: ${d}  (no effect, IN de-duplicates)`)
}
console.log('  ' + '-'.repeat(64))
console.log(`  ${'TOTAL'.padEnd(18)}${String(total).padStart(5)}  ${String(claimedTotal ?? '-').padStart(7)}` +
  `  ${(claimedTotal === total ? 'yes' : 'NO').padStart(5)}`)

// Permissions granted to nobody but owner: worth knowing, not an error.
const heldByOthers = new Set()
for (const g of grants) if (g.role !== 'owner') for (const k of g.keys) heldByOthers.add(k)
const ownerOnly = [...permKeys].filter(k => !heldByOthers.has(k)).sort()
console.log(`\n  owner-only permissions (${ownerOnly.length}):`)
for (const k of ownerOnly) console.log(`      ${k}`)

if (dupPerm) console.log(`\n  WARNING duplicate permission keys in the permissions INSERT`)
console.log()
process.exit(problems || claimedTotal !== total || dupPerm ? 1 : 0)
