import { sql } from 'kysely'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { getDb } from '../src/db/kysely.js'
import { closePool, getPool } from '../src/db/pool.js'

/**
 * The pool handed to Kysely must be the callback-style one.
 *
 * This is a regression test for the worst bug found in this codebase so far
 * (fixed in 38ca44f). src/db/kysely.ts built its MysqlDialect from getPool(),
 * which returns mysql2/promise's PromisePool. Kysely's driver calls
 * pool.getConnection(callback) and awaits the callback; PromisePool's
 * getConnection takes no callback and returns a promise, so the callback never
 * fired. Every query in the application hung forever — no error, no timeout,
 * no log line. The fix passes getPool().pool, the callback pool underneath the
 * wrapper, which is the same physical pool.
 *
 * Nothing in the repository caught it: tsc accepted the assignment because a
 * zero-parameter function is assignable to a one-parameter function type, and
 * the unit suite never opened a connection.
 *
 * These two tests need no database, which is the point — they run in the
 * ordinary `npm test`, so the mistake cannot be reintroduced and merged. The
 * connection attempt here is expected to be refused; what is asserted is which
 * object Kysely called and with what, not whether the query succeeded.
 * tests/integration/db-smoke.test.ts proves the query itself against a real
 * MariaDB.
 */

type CallbackPool = { getConnection: (...args: unknown[]) => unknown }

/** The callback-style pool underneath mysql2/promise's wrapper. */
function innerPool(): CallbackPool {
  return (getPool() as unknown as { pool: CallbackPool }).pool
}

afterAll(async () => {
  // The pool never established a connection, so there is nothing meaningful to
  // learn from a failure to close it.
  await closePool().catch(() => undefined)
})

describe('db pool wiring', () => {
  it('distinguishes the promise wrapper from the callback pool by arity', () => {
    // The whole bug in one line: these two objects have a getConnection with
    // the same name and incompatible calling conventions, and TypeScript
    // considers the wrong one assignable to the right one.
    expect(getPool().getConnection).toHaveLength(0)
    expect(innerPool().getConnection.length).toBeGreaterThanOrEqual(1)
  })

  it('makes Kysely acquire connections from the callback pool', async () => {
    // Spying on the inner pool alone would prove nothing: PromisePool.getConnection
    // delegates to this.pool.getConnection(cb), so the inner method is called
    // either way and with a callback either way. The decisive question is
    // whether the wrapper was in the path at all, so that is what is asserted.
    const wrapperSpy = vi.spyOn(getPool(), 'getConnection')
    const innerSpy = vi.spyOn(innerPool(), 'getConnection')

    const query = sql`select 1`.execute(getDb()).catch(() => undefined)

    // Bounded, because the failure being guarded against is a hang rather than
    // an exception: with the wrapper wired in, the query never settles and this
    // test has to fail on the assertions instead of on the suite timeout.
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      query.finally(() => clearTimeout(timer)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 2_000)
      }),
    ])

    expect(innerSpy).toHaveBeenCalled()
    // Called with a callback, which is the convention the pool given to the
    // dialect has to honour.
    expect(innerSpy.mock.calls[0]![0]).toBeTypeOf('function')

    // The reverted bug in one assertion. If src/db/kysely.ts is ever
    // "simplified" back to getPool(), the promise wrapper appears here and
    // every query in the application hangs.
    expect(wrapperSpy).not.toHaveBeenCalled()
  })
})
