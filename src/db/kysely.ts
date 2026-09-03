import { Kysely, MysqlDialect, type MysqlPool, type Transaction } from 'kysely'
import { getPool } from './pool.js'
import type { Database } from './types.js'

/**
 * The Kysely instance (spec 2.4). It wraps the same mysql2 pool as
 * src/db/pool.ts, so there is one connection pool in the process and a raw
 * query and a Kysely query cannot deadlock against each other by holding
 * connections from two pools.
 *
 * `.pool` unwraps the promise wrapper, and the cast is load-bearing.
 *
 * getPool() returns mysql2/promise's PromisePool, whose getConnection() takes
 * no callback and returns a promise. Kysely's MysqlDialect calls
 * pool.getConnection(cb) and waits for the callback, so passing the promise
 * wrapper makes every query hang forever with no error and no timeout.
 * TypeScript accepted it because a zero-parameter function is assignable to a
 * one-parameter function type, which is why this survived until the first
 * query ran against a real database.
 *
 * `.pool` is the underlying callback-style Pool — the same connection pool, so
 * the one-pool guarantee above still holds. It needs the cast because mysql2's
 * `query` is a set of overloads while Kysely's MysqlPoolConnection declares two
 * specific signatures; the two are not assignable in either direction even
 * though the runtime shapes match. The cast is what makes queries execute
 * rather than hang, and scripts/verify-inventory.ts is what proves it.
 */
let instance: Kysely<Database> | undefined

export function getDb(): Kysely<Database> {
  if (!instance) {
    instance = new Kysely<Database>({
      dialect: new MysqlDialect({ pool: getPool().pool as unknown as MysqlPool }),
    })
  }
  return instance
}

export type Db = Kysely<Database>
export type Trx = Transaction<Database>

/**
 * Anything that can run a query: the top level instance or a transaction.
 * Service functions take this type so the same function works standalone and
 * inside a caller's transaction, which is what makes writeAudit and
 * nextNumber composable rather than each opening their own transaction.
 */
export type Queryable = Db | Trx
