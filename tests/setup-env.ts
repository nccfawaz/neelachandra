/**
 * Environment for the unit test run.
 *
 * src/env.ts parses process.env at import time and throws on anything missing,
 * which is the right behaviour for a server that must not boot half-configured
 * and the wrong behaviour for a test of a pure function. These values are
 * obvious fakes: nothing here connects to anything, and the database credentials
 * in particular are never used because no test in this suite opens a pool.
 *
 * Real values are never committed. If a future integration suite needs a live
 * ncc_platform_test database, it reads its credentials from the developer's own
 * .env, which this file does not override: existing variables win.
 */

const TEST_ENV: Record<string, string> = {
  DB_HOST: '127.0.0.1',
  DB_PORT: '3306',
  DB_USER: 'ncc_test',
  DB_PASSWORD: 'not-a-real-password',
  DB_NAME: 'ncc_platform_test',
  // 44 characters, the minimum env.ts accepts, so the scrypt derivation in
  // lib/crypto has something of the right shape to work with.
  SESSION_SECRET: 'test-session-secret-not-used-in-any-real-run!',
  CRON_SECRET: 'test-cron-secret-thirty-two-chars-min',
  INDEXNOW_KEY: '0123456789abcdef0123456789abcdef',
  APP_BASE_URL: 'http://localhost:3000',
  NODE_ENV: 'test',
}

for (const [key, value] of Object.entries(TEST_ENV)) {
  process.env[key] ??= value
}
