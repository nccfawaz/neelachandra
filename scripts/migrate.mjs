#!/usr/bin/env node
// scripts/migrate.mjs
// Applies migrations/NNN_name.sql in lexical order and tracks applied files
// in a schema_migrations table (spec 2.4: no generated migrations, the
// runner is the only thing that writes schema_migrations).
//
// Usage:
//   node scripts/migrate.mjs                    apply pending to $DB_NAME
//   node scripts/migrate.mjs --db NAME          apply pending to NAME instead
//
// The --db flag exists for the test database (ncc_platform_test), which the
// phase 2 test suite migrates separately from the dev database.
//
// Behaviour notes:
// - File names must match NNN_name.sql. Three digits keep lexical order
//   equal to numeric order, so a 10_ prefix cannot sort after 9_.
// - The checksum column catches edits to a migration that already ran.
//   Editing an applied migration is how schema drift starts, so a mismatch
//   is a hard failure, not a warning.
// - Each file runs inside a transaction that also writes its
//   schema_migrations row. MariaDB commits DDL implicitly, so a file that
//   fails halfway can leave its earlier CREATE TABLEs in place while no
//   tracking row is written. The next run then fails on the leftover table
//   by name, which is the loudest possible outcome and names the exact
//   table to drop before retrying. That is the recoverable failure mode;
//   silent partial application with a tracking row would not be.
// - Parameter binding is used for the tracking row. The migration files
//   themselves are static .sql text read from disk, which is the sanctioned
//   sql.raw exception for the runner in spec 2.10.
// - .env is loaded when present and never overrides real environment
//   variables, so the same script runs locally from .env and on Hostinger
//   from hPanel injected variables.

import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { createConnection } from 'mysql2/promise'

try {
  process.loadEnvFile()
} catch {
  // No .env file. Real environment variables only.
}

const MIGRATION_NAME_RE = /^\d{3}_[a-z0-9_]+\.sql$/

const args = process.argv.slice(2)
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

const migrationsDir = path.join(process.cwd(), 'migrations')

let files
try {
  files = await readdir(migrationsDir)
} catch (err) {
  console.error('Cannot read ' + migrationsDir + ': ' + err.message)
  process.exit(1)
}

const sqlFiles = files.filter((name) => name.endsWith('.sql')).sort()
const malformed = sqlFiles.filter((name) => !MIGRATION_NAME_RE.test(name))
if (malformed.length > 0) {
  console.error(
    'Migration file names must match NNN_name.sql. Rename: ' + malformed.join(', ')
  )
  process.exit(1)
}

const connection = await createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database,
  charset: 'utf8mb4',
  multipleStatements: true,
})

console.log('Target database: ' + database)

await connection.query(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name VARCHAR(255) PRIMARY KEY,
    checksum CHAR(64) NOT NULL,
    applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`)

const [appliedRows] = await connection.query(
  'SELECT name, checksum FROM schema_migrations'
)
const applied = new Map(appliedRows.map((row) => [row.name, row.checksum]))

let appliedNow = 0

for (const name of sqlFiles) {
  const sqlText = await readFile(path.join(migrationsDir, name), 'utf8')
  const checksum = createHash('sha256').update(sqlText).digest('hex')

  if (applied.has(name)) {
    if (applied.get(name) !== checksum) {
      console.error(
        name +
          ' was already applied but its content changed since. ' +
          'Edit drift is not supported: write a new migration instead, or ' +
          'verify the change and drop the schema_migrations row to re-run.'
      )
      await connection.end()
      process.exit(1)
    }
    continue
  }

  try {
    await connection.query('START TRANSACTION')
    await connection.query(sqlText)
    await connection.execute(
      'INSERT INTO schema_migrations (name, checksum) VALUES (?, ?)',
      [name, checksum]
    )
    await connection.query('COMMIT')
  } catch (err) {
    await connection.query('ROLLBACK').catch(() => {})
    console.error('Failed applying ' + name + ': ' + err.message)
    console.error(
      'No schema_migrations row was written for ' + name +
        '. MariaDB commits DDL implicitly, so any tables it created before ' +
        'the failure are still present and must be dropped by hand before ' +
        'retrying. See the error above for the statement that failed.'
    )
    await connection.end()
    process.exit(1)
  }

  console.log('Applied ' + name)
  appliedNow += 1
}

if (appliedNow === 0) {
  console.log('Up to date. ' + sqlFiles.length + ' migration files, none pending.')
}

await connection.end()
