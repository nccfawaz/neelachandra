#!/usr/bin/env node
// scripts/seed-staff.mjs
//
// Seeds the fourteen real staff accounts (DECISIONS 29.63, fence lift 29.62).
// These are REAL PEOPLE — bootstrap rows for the development database only.
//
// Guarantees:
//   - Idempotent by email: re-running repairs the role and employee linkage,
//     nothing duplicates.
//   - Refuses to run unless the database host is local (localhost/127.0.0.1)
//     and the port is 3307, with a named error naming the host it got.
//   - Passwords come from NCC_STAFF_PASSWORD (one for everyone) if set,
//     otherwise a 24-char mixed-class value is generated per person and
//     printed to stdout exactly once. Only the argon2id hash reaches the
//     database; no audit_log or email_log row is written; must_change_password
//     = 1 so the printed value stops being a credential at first sign-in.
//   - approval_limits is NOT touched (§8.2): seeding a person grants nothing
//     about money authority.
//
// Usage: node scripts/seed-staff.mjs [--reset-passwords]
//   --reset-passwords  regenerate every password and print the new values to
//     THIS terminal (use it if an earlier output was ever shared). Runs on the
//     operator's own machine so the values never pass through any chat or log.

import fs from 'node:fs'
import crypto from 'node:crypto'
import mysql from 'mysql2/promise'
import { hash as argonHash } from '@node-rs/argon2'

for (const line of fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, '')
}

const host = process.env.DB_HOST || 'localhost'
const port = Number(process.env.DB_PORT || 3307)
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1']
if (!LOCAL_HOSTS.includes(host) || port !== 3307) {
  console.error(
    `REFUSED: seed-staff writes REAL PEOPLE and targets the dev database only (host must be one of ${LOCAL_HOSTS.join('/')} and port must be 3307); got ${host}:${port}. The fence (DECISIONS 29.62) stays in force for any other host until the §7.6 cut-over.`
  )
  process.exit(3)
}

function generatePassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  const lower = 'abcdefghijkmnopqrstuvwxyz'
  const digits = '23456789'
  const symbols = '!@#$%^&*'
  const all = upper + lower + digits + symbols
  let out = ''
  const bytes = crypto.randomBytes(32)
  for (let i = 0; i < 24; i++) out += all[bytes[i] % all.length]
  return out + upper[crypto.randomInt(upper.length)] + lower[crypto.randomInt(lower.length)] + digits[crypto.randomInt(digits.length)] + symbols[crypto.randomInt(symbols.length)]
}

// Fourteen people. roleKey: the existing role each maps to (29.63 mapping).
// designationCode: a designations.code from migrations/006_hr.sql where one
// fits; null where the roster's title has no designation row yet.
// employeeCode: NCC-###, unique (uq_emp_code) — this is what disambiguates
// the two Sunils everywhere a name appears.
const PEOPLE = [
  { name: 'Chandrashekar', email: 'chandrashekar@neelachandra.dev', roleKey: 'owner', designationCode: 'FOUNDER', employeeCode: 'NCC-001', dept: 'MGMT' },
  { name: 'Sushma', email: 'sushma@neelachandra.dev', roleKey: 'hr_manager', designationCode: 'HR-MGR', employeeCode: 'NCC-002', dept: 'HR' },
  { name: 'Ramesh', email: 'ramesh@neelachandra.dev', roleKey: 'project_manager', designationCode: 'PROJ-MGR', employeeCode: 'NCC-003', dept: 'SITE' },
  { name: 'Vinay', email: 'vinay@neelachandra.dev', roleKey: 'ops_manager', designationCode: 'PROC-LEAD', employeeCode: 'NCC-004', dept: 'PROC' },
  { name: 'Karthik', email: 'karthik@neelachandra.dev', roleKey: 'ops_manager', designationCode: 'STOREKEEPER', employeeCode: 'NCC-005', dept: 'PROC' },
  { name: 'Sunil H M', email: 'sunil.hm@neelachandra.dev', roleKey: 'site_supervisor', designationCode: 'SITE-ENGR', employeeCode: 'NCC-006', dept: 'SITE' },
  { name: 'Sunil Mylarappa', email: 'sunil.mylarappa@neelachandra.dev', roleKey: 'site_supervisor', designationCode: 'SITE-ENGR', employeeCode: 'NCC-007', dept: 'SITE' },
  { name: 'Dinesh', email: 'dinesh@neelachandra.dev', roleKey: 'site_supervisor', designationCode: 'SITE-ENGR', employeeCode: 'NCC-008', dept: 'SITE' },
  { name: 'Anil Kumar', email: 'anil.kumar@neelachandra.dev', roleKey: 'site_supervisor', designationCode: 'SITE-ENGR', employeeCode: 'NCC-009', dept: 'SITE' },
  { name: 'Shridhar', email: 'shridhar@neelachandra.dev', roleKey: 'ops_manager', designationCode: null, employeeCode: 'NCC-010', dept: 'SITE' },
  { name: 'Sunil', email: 'sunil@neelachandra.dev', roleKey: 'sales_exec', designationCode: null, employeeCode: 'NCC-011', dept: 'SALES' },
  { name: 'Chaitra', email: 'chaitra@neelachandra.dev', roleKey: 'accounts_manager', designationCode: 'ACCT-MGR', employeeCode: 'NCC-012', dept: 'ACCT' },
  { name: 'Shishir', email: 'shishir@neelachandra.dev', roleKey: 'site_supervisor', designationCode: 'SITE-SUP', employeeCode: 'NCC-013', dept: 'SITE' },
  { name: 'Fawaz B H', email: 'fawaz@neelachandra.dev', roleKey: 'admin', designationCode: null, employeeCode: 'NCC-014', dept: 'OPS' },
]

const RESET_PASSWORDS = process.argv.includes('--reset-passwords')

const conn = await mysql.createConnection({
  host,
  port,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  multipleStatements: false,
})

try {
  // Designation lookup (code -> id). A person whose designation is null is
  // left with designation_id NULL rather than inventing a reference row.
  const [desigs] = await conn.query('SELECT id, code FROM designations')
  const desigId = new Map(desigs.map((d) => [d.code, d.id]))

  for (const person of PEOPLE) {
    const [[role]] = await conn.query('SELECT id, require_2fa FROM roles WHERE `key` = ?', [person.roleKey])
    if (!role) {
      console.error(`No '${person.roleKey}' role found. Run the migrations first.`)
      process.exit(1)
    }
    await conn.beginTransaction()
    try {
      const [[existing]] = await conn.query('SELECT id, employee_id FROM users WHERE email = ?', [person.email])
      let userId
      const password = process.env.NCC_STAFF_PASSWORD || generatePassword()
      const hash = await argonHash(password)
      if (existing) {
        userId = existing.id
        await conn.execute(
          `UPDATE users SET full_name = ?, password_algo = 'argon2id', status = 'active',
             failed_login_count = 0, locked_until = NULL,
             password_hash = COALESCE(CASE WHEN ? THEN ? END, password_hash)
           WHERE id = ?`,
          [person.name, RESET_PASSWORDS ? 1 : 0, hash, userId]
        )
        if (RESET_PASSWORDS) console.log(`${person.email}  password=${password}`)
      } else {
        const [res] = await conn.execute(
          `INSERT INTO users (email, full_name, password_hash, password_algo,
             must_change_password, password_changed_at, status)
           VALUES (?, ?, ?, 'argon2id', 1, NOW(), 'active')`,
          [person.email, person.name, hash]
        )
        userId = res.insertId
        console.log(`${person.email}  role=${person.roleKey}  password=${password}`)
      }

      await conn.execute('DELETE FROM user_roles WHERE user_id = ?', [userId])
      await conn.execute('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', [userId, role.id])

      // Employee row, linked from users.employee_id. Idempotent on employee_code.
      let employeeId = existing ? existing.employee_id : null
      if (!employeeId) {
        const [empRes] = await conn.execute(
          `INSERT INTO employees (employee_code, user_id, full_name, designation_id,
             employment_type, date_of_joining, status)
           VALUES (?, ?, ?, ?, 'permanent', CURDATE(), 'active')`,
          [person.employeeCode, userId, person.name, person.designationCode ? desigId.get(person.designationCode) ?? null : null]
        )
        employeeId = empRes.insertId
        await conn.execute('UPDATE users SET employee_id = ? WHERE id = ?', [employeeId, userId])
      } else {
        await conn.execute(
          `UPDATE employees SET full_name = ?, designation_id = COALESCE(?, designation_id),
             status = 'active' WHERE id = ?`,
          [person.name, person.designationCode ? desigId.get(person.designationCode) ?? null : null, employeeId]
        )
      }

      // No audit_log row: the seed writes bootstrap state, not a user action,
      // and a re-run must not spam the log (same policy as seed-test-login).
      await conn.commit()
    } catch (err) {
      await conn.rollback().catch(() => {})
      throw err
    }
  }

  const [[limits]] = await conn.query('SELECT COUNT(*) AS n FROM approval_limits')
  console.log(`\n14 people seeded (idempotent). approval_limits rows: ${limits.n} — untouched per §8.2.`)
  if (!RESET_PASSWORDS) console.log('Passwords printed above for NEW accounts only; use --reset-passwords to regenerate all of them on this terminal.')
} catch (err) {
  console.error(err.message)
  process.exit(1)
} finally {
  await conn.end()
}
