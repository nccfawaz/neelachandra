/**
 * Environment for the database integration run — HERMETIC about everything
 * except the database itself.
 *
 * The deliberate difference from tests/setup-env.ts: that file forces fake
 * database credentials because no unit test opens a pool. This file must NOT
 * invent a database — an integration suite that silently connects to a
 * default is an integration suite that can pass against the wrong database —
 * or, worse, be reported as green when it never ran. So the DB_* keys still
 * require a real source: a local .env or real exported variables.
 *
 * DECISIONS 29.2: the non-database keys used ??=, deferring to whatever the
 * shell had exported, and the machine's ambient PORT=0 beat the schema
 * default and failed every suite at import ("Number must be greater than or
 * equal to 1"). A gate that depends on environment it does not set is the
 * same defect class as a gate that depends on a service it does not start
 * (CLAUDE.md). The non-DB keys src/env.ts validates are now FORCED here —
 * process.env[key] = value, no ??=. The DB_* keys keep their real-source
 * contract and are never forced.
 *
 * Two DB sources, in this order:
 *   - a local .env, for a developer machine. Values from .env are written
 *     with = (force) so an exported DB_PORT=0 cannot poison the run, but the
 *     .env still wins over nothing: it is only read when present.
 *   - real environment variables, for CI, where the workflow sets them from
 *     the MariaDB service container's credentials and there is no .env at
 *     all. Exported DB_* values are honoured as-is in that case (the
 *     workflow is trusted the way a shell is not, because CI is the
 *     environment of record).
 */

const DB_KEYS = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'] as const

let hadDotenv = false
try {
  process.loadEnvFile()
  hadDotenv = true
} catch {
  // No .env file. Real environment variables only, which is the CI case.
}

if (hadDotenv) {
  // The developer's .env is the environment of record on a machine with one:
  // force the DB keys from it so a hostile exported value (PORT=0 taught us
  // shells carry poison) cannot override the file the developer maintains.
  const dotenv: Record<string, string> = {}
  const fs = require('node:fs') as typeof import('node:fs')
  for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/)
    if (m) dotenv[m[1]!] = m[2]!
  }
  for (const key of DB_KEYS) {
    if (dotenv[key] !== undefined) process.env[key] = dotenv[key]!
  }
}

const missing = DB_KEYS.filter((key) => !process.env[key])
if (missing.length > 0) {
  throw new Error(
    `The database integration suite needs a real MariaDB and ${missing.join(', ')} ` +
      `${missing.length === 1 ? 'is' : 'are'} not set.\n` +
      'Locally: copy .env.example to .env, point it at a migrated database, and ' +
      'run `npm run db:migrate`.\n' +
      'In CI: the db-smoke job in .github/workflows/gates.yml sets these from its ' +
      'MariaDB service container.\n' +
      'This suite has no fallback on purpose. See vitest.integration.config.ts.'
  )
}

// Not database configuration, but src/env.ts validates them at import time and
// throws on anything invalid, so the module graph will not load without them.
// Forced, not defaulted: a hostile exported PORT or NODE_ENV must not reach a
// test (DECISIONS 29.2).
const NON_DB_FORCED: Record<string, string> = {
  SESSION_SECRET: 'integration-suite-session-secret-not-real!!!!',
  CRON_SECRET: 'integration-suite-cron-secret-32-chars-min',
  SMTP_HOST: 'smtp.hostinger.com',
  SMTP_PORT: '465',
  SMTP_USER: '',
  SMTP_PASSWORD: '',
  UPLOAD_PUBLIC_DIR: './uploads/public',
  UPLOAD_PRIVATE_DIR: './uploads/private',
  INDEXNOW_KEY: '0123456789abcdef0123456789abcdef',
  APP_BASE_URL: 'http://localhost:3000',
  NODE_ENV: 'test',
  PORT: '3000',
}

for (const [key, value] of Object.entries(NON_DB_FORCED)) {
  process.env[key] = value
}
