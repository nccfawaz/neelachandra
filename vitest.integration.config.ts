import { defineConfig } from 'vitest/config'

/**
 * The database integration suite. Separate from vitest.config.ts because that
 * run must stay pure: it has to pass on a laptop with no MariaDB, in a
 * pre-commit hook, and in a CI job with no service container.
 *
 * This one is the opposite. It requires a migrated database and fails loudly
 * without one, because the whole point is that it cannot be satisfied by a
 * mock. On 2026-09-03 every Kysely query in the application hung forever —
 * src/db/kysely.ts handed MysqlDialect the mysql2/promise wrapper, whose
 * getConnection() takes no callback, so the dialect's callback never fired.
 * tsc was green (a zero-parameter function is assignable to a one-parameter
 * type) and all 148 unit tests were green (none opens a connection). Nothing
 * in the repository could have caught it. This suite is what closes that gap.
 *
 * testTimeout matters as much as the assertions. The failure mode of a wiring
 * bug at this layer is a hang, not an exception, and a hang with no bound is
 * a job that burns the runner's six-hour default rather than a red build. Ten
 * seconds is far longer than any query here needs and far shorter than anyone's
 * patience, so the hang class of bug reports as a timeout failure naming the
 * test. The workflow adds timeout-minutes as the outer bound.
 *
 * singleFork because src/db/pool.ts caps the pool at 5 connections and every
 * file in this suite shares one database; parallel files would contend for
 * connections and for the same rows, and a flaky integration gate gets ignored.
 */
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    setupFiles: ['tests/integration/setup-db-env.ts'],
    environment: 'node',
    restoreMocks: true,
    testTimeout: 10_000,
    hookTimeout: 20_000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
})
