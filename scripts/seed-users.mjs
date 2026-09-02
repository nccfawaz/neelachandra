#!/usr/bin/env node
// scripts/seed-users.mjs --owner
//
// Creates the first owner account. Nothing else in the system can create it:
// user creation requires users.manage, which requires a signed-in user, which
// requires this script to have run once. It is idempotent, so re-running it on
// an existing owner resets the password rather than failing.
//
// The password is generated, printed once, and stored only as an argon2id
// hash. must_change_password is set so the first sign-in forces a rotation,
// which means the value printed to this terminal stops being a credential the
// moment it is used.

import fs from 'node:fs'
import mysql from 'mysql2/promise'
import { hash as argonHash } from '@node-rs/argon2'
import crypto from 'node:crypto'

// .env is read by hand rather than through dotenv: this script runs before
// the build, so it cannot rely on the compiled env module, and adding a
// dependency for six lines of parsing is not worth the install.
for (const line of fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, '')
}

const email = process.env.OWNER_EMAIL || 'owner@neelachandra.com'
const fullName = process.env.OWNER_NAME || 'Neelachandra Owner'
const password = process.env.OWNER_PASSWORD || crypto.randomBytes(12).toString('base64url')

if (!process.argv.includes('--owner')) {
  console.error('Refusing to run without --owner. This script creates a privileged account.')
  process.exit(2)
}

const conn = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  multipleStatements: false,
})

try {
  const hash = await argonHash(password)

  const [[role]] = await conn.query('SELECT id FROM roles WHERE `key` = ?', ['owner'])
  if (!role) {
    console.error("No 'owner' role found. Run the migrations and seed-reference first.")
    process.exit(1)
  }

  await conn.beginTransaction()

  const [[existing]] = await conn.query('SELECT id FROM users WHERE email = ?', [email])
  let userId
  if (existing) {
    userId = existing.id
    await conn.execute(
      `UPDATE users SET password_hash = ?, password_algo = 'argon2id',
         must_change_password = 1, password_changed_at = NOW(),
         status = 'active', failed_login_count = 0, locked_until = NULL
       WHERE id = ?`,
      [hash, userId]
    )
  } else {
    const [res] = await conn.execute(
      `INSERT INTO users (email, full_name, password_hash, password_algo,
         must_change_password, password_changed_at, status)
       VALUES (?, ?, ?, 'argon2id', 1, NOW(), 'active')`,
      [email, fullName, hash]
    )
    userId = res.insertId
  }

  await conn.execute('INSERT IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', [
    userId,
    role.id,
  ])

  await conn.execute(
    `INSERT INTO audit_log (user_id, action, entity_type, entity_id, created_at)
     VALUES (?, 'user.seed_owner', 'users', ?, NOW())`,
    [userId, userId]
  )

  await conn.commit()

  console.log('')
  console.log('Owner account ready.')
  console.log('  email:    ' + email)
  console.log('  password: ' + password)
  console.log('')
  console.log('You will be asked to change this on first sign-in.')
} catch (err) {
  await conn.rollback().catch(() => {})
  console.error(err.message)
  process.exit(1)
} finally {
  await conn.end()
}
