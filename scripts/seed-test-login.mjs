#!/usr/bin/env node
// scripts/seed-test-login.mjs --test-login
//
// Seeds two DEV-ONLY login accounts for manual testing of the authentication
// and 2FA paths (DECISIONS 29.48). These are NOT the §8.1 real staff rows,
// which stay fenced behind the cut-over; these accounts exist only in the dev
// database on localhost:3307.
//
//   - test.login@neelachandra.dev   role: ops_manager (require_2fa = 0)
//       reaches the dashboard immediately after sign-in.
//   - test.owner@neelachandra.dev   role: owner (require_2fa = 1)
//       is redirected to /2fa/enrol to exercise the two-factor path.
//
// Guarantees:
//   - Idempotent by email: re-running resets the password, nothing duplicates.
//   - Refuses to run unless the database host is local (localhost/127.0.0.1)
//     and the port is 3307, with a named error otherwise.
//   - Passwords come from NCC_TEST_LOGIN_PASSWORD / NCC_TEST_OWNER_PASSWORD if
//     set, otherwise a 22-char mixed-class value is generated and printed to
//     stdout exactly once.
//   - The password is never written to any file in the repo and never logged
//     into audit_log or email_log; only the argon2id hash reaches the DB.
//   - Both accounts are marked with the fixture full_name prefix so the test
//     sweep (tests/integration/fixture-markers.ts) can remove them.

import fs from 'node:fs'
import crypto from 'node:crypto'
import mysql from 'mysql2/promise'
import { hash as argonHash } from '@node-rs/argon2'

for (const line of fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, '')
}

if (!process.argv.includes('--test-login')) {
  console.error('Refusing to run without --test-login.')
  process.exit(2)
}

const host = process.env.DB_HOST || 'localhost'
const port = Number(process.env.DB_PORT || 3307)
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1']
// The machine's own LAN address also counts as local: an ssh port-forward
// tunnel squatting on 127.0.0.1:3307 once forced .env to name the host by its
// LAN IP to reach the same local MariaDB (2026-09-24). The list is matched
// against every address this machine actually holds, not just the string.
import { networkInterfaces } from 'node:os'
const ownAddresses = new Set(LOCAL_HOSTS)
for (const addrs of Object.values(networkInterfaces())) {
  for (const a of addrs ?? []) ownAddresses.add(a.address)
}
if (!ownAddresses.has(host) || port !== 3307) {
  console.error(
    `REFUSED: seed-test-login targets the dev database only (host must be one of ${LOCAL_HOSTS.join('/')} and port must be 3307); got ${host}:${port}.`
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
  const bytes = crypto.randomBytes(24)
  for (let i = 0; i < 20; i++) out += all[bytes[i] % all.length]
  // guarantee one of each class
  return (
    out +
    upper[crypto.randomInt(upper.length)] +
    lower[crypto.randomInt(lower.length)] +
    digits[crypto.randomInt(digits.length)] +
    symbols[crypto.randomInt(symbols.length)]
  )
}

const ACCOUNTS = [
  {
    email: 'test.login@neelachandra.dev',
    fullName: 'FIXTURE-TESTLOGIN Manual Tester (dev only)',
    roleKey: 'ops_manager',
    password: process.env.NCC_TEST_LOGIN_PASSWORD || generatePassword(),
  },
  {
    email: 'test.owner@neelachandra.dev',
    fullName: 'FIXTURE-TESTLOGIN Manual Owner (dev only)',
    roleKey: 'owner',
    password: process.env.NCC_TEST_OWNER_PASSWORD || generatePassword(),
  },
]

const conn = await mysql.createConnection({
  host,
  port,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  multipleStatements: false,
})

try {
  for (const acct of ACCOUNTS) {
    const [[role]] = await conn.query('SELECT id, require_2fa FROM roles WHERE `key` = ?', [acct.roleKey])
    if (!role) {
      console.error(`No '${acct.roleKey}' role found. Run the migrations and seed-reference first.`)
      process.exit(1)
    }

    const hash = await argonHash(acct.password)
    await conn.beginTransaction()
    try {
      const [[existing]] = await conn.query('SELECT id FROM users WHERE email = ?', [acct.email])
      let userId
      if (existing) {
        userId = existing.id
        // must_change_password stays 0 on purpose: these accounts are for
        // manual testing of login/2FA, not for the first-sign-in rotation flow.
        await conn.execute(
          `UPDATE users SET password_hash = ?, password_algo = 'argon2id',
             must_change_password = 0, password_changed_at = NOW(),
             status = 'active', failed_login_count = 0, locked_until = NULL,
             full_name = ?
           WHERE id = ?`,
          [hash, acct.fullName, userId]
        )
        await conn.execute('DELETE FROM user_roles WHERE user_id = ?', [userId])
      } else {
        const [res] = await conn.execute(
          `INSERT INTO users (email, full_name, password_hash, password_algo,
             must_change_password, password_changed_at, status)
           VALUES (?, ?, ?, 'argon2id', 0, NOW(), 'active')`,
          [acct.email, acct.fullName, hash]
        )
        userId = res.insertId
      }
      await conn.execute('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', [userId, role.id])
      // Passwords must never reach audit_log: no audit row is written here at
      // all, deliberately (the seed-owner script writes one; a test account
      // that is reseeded on every run would spam the log with user.seed rows).
      await conn.commit()
      console.log(`${acct.email}  role=${acct.roleKey} require_2fa=${role.require_2fa}  password=${acct.password}`)
    } catch (err) {
      await conn.rollback().catch(() => {})
      throw err
    }
  }
  console.log('')
  console.log('Both accounts are dev-only fixtures (FIXTURE-TESTLOGIN prefix); the test sweep removes them.')
} catch (err) {
  console.error(err.message)
  process.exit(1)
} finally {
  await conn.end()
}
