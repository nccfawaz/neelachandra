/**
 * Environment for the database integration run.
 *
 * The deliberate difference from tests/setup-env.ts: that file fills in fake
 * database credentials so a test of a pure function does not fail on
 * environment validation. This file fills in nothing that points at a
 * database. If DB_* is absent the suite must fail with an explanation, because
 * an integration suite that silently connects to a default is an integration
 * suite that can pass against the wrong database — or, worse, be reported as
 * green when it never ran.
 *
 * Two sources, in this order:
 *   - a local .env, for a developer machine. process.loadEnvFile() never
 *     overwrites an existing variable, so exported values still win.
 *   - real environment variables, for CI, where the workflow sets them from
 *     the MariaDB service container's credentials and there is no .env at all.
 *
 * The non-database keys src/env.ts also validates (SESSION_SECRET and friends)
 * are filled with obvious fakes when missing: they are required for the module
 * to import, and nothing in this suite signs a session or sends mail.
 */

const DB_KEYS = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'] as const

try {
  process.loadEnvFile()
} catch {
  // No .env file. Real environment variables only, which is the CI case.
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
// throws on anything missing, so the module graph will not load without them.
const NON_DB_FALLBACKS: Record<string, string> = {
  SESSION_SECRET: 'integration-suite-session-secret-not-real!!!!',
  CRON_SECRET: 'integration-suite-cron-secret-32-chars-min',
  INDEXNOW_KEY: '0123456789abcdef0123456789abcdef',
  APP_BASE_URL: 'http://localhost:3000',
  NODE_ENV: 'test',
}

for (const [key, value] of Object.entries(NON_DB_FALLBACKS)) {
  process.env[key] ??= value
}
