import { defineConfig } from 'vitest/config'

/**
 * Unit tests only, and deliberately no database.
 *
 * A separate file from vite.config.ts because that config exists to minify the
 * dashboard stylesheet into public/ (spec 2.11) and none of its build settings
 * mean anything to a test run; vitest would otherwise inherit them.
 *
 * setupFiles fills in the sixteen environment variables src/env.ts validates at
 * import. Anything that reaches lib/crypto, lib/session or the db pool imports
 * that module, so without the setup a test of a pure function two levels down
 * fails on environment validation rather than on the thing being tested.
 *
 * Tests that need MariaDB live in tests/integration/ behind
 * vitest.integration.config.ts and `npm run test:integration`, which requires a
 * migrated database and refuses to fall back to one. They are excluded here so
 * this run keeps passing on a machine with no database. Mocking the query
 * builder instead was rejected: it would assert that Kysely composes strings,
 * not that the stock ledger balances.
 *
 * tests/db-wiring.test.ts is the exception that belongs in this run. It pins
 * the pool-object mistake that made every query hang before 38ca44f, and it
 * needs no server to do it.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration/**'],
    setupFiles: ['tests/setup-env.ts'],
    environment: 'node',
    restoreMocks: true,
  },
})
