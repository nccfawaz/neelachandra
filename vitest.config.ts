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
 * Tests that need MariaDB are not written yet: there is no database in the
 * development environment this is built in, and a test suite that passes by
 * mocking the query builder would assert that Kysely composes strings, not that
 * the stock ledger balances. Those belong behind db:migrate against
 * ncc_platform_test.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup-env.ts'],
    environment: 'node',
    restoreMocks: true,
  },
})
