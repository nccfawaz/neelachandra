/**
 * Environment for the unit test run — HERMETIC.
 *
 * src/env.ts parses process.env at import time and throws on anything missing,
 * which is the right behaviour for a server that must not boot half-configured
 * and the wrong behaviour for a test of a pure function. These values are
 * obvious fakes: nothing here connects to anything, and the database credentials
 * in particular are never used because no test in this suite opens a pool.
 *
 * DECISIONS 29.2: this file used ??=, deferring to whatever the shell had
 * exported, and the machine's ambient PORT=0 beat the schema default and
 * killed five suites with "Number must be greater than or equal to 1". A gate
 * that depends on environment it does not set is the same defect class as a
 * gate that depends on a service it does not start (CLAUDE.md). So every key
 * src/env.ts validates is FORCED here — process.env[key] = value, no ??=.
 * A hostile PORT, DATABASE_URL, NODE_ENV or APP_BASE_URL in the shell cannot
 * reach a test.
 *
 * The one key this file must not invent is a real database: no test in this
 * suite opens a pool, so the fake DB_* credentials are safe to force. The
 * integration suite (setup-db-env.ts) keeps its real-credentials contract.
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

for (const [key, value] of Object.entries(TEST_ENV)) {
  process.env[key] = value
}
