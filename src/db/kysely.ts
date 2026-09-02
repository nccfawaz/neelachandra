import { Kysely, MysqlDialect, type Transaction } from 'kysely'
import { getPool } from './pool.js'
import type { Database } from './types.js'

/**
 * The Kysely instance (spec 2.4). It wraps the same mysql2 pool as
 * src/db/pool.ts, so there is one connection pool in the process and a raw
 * query and a Kysely query cannot deadlock against each other by holding
 * connections from two pools.
 */
let instance: Kysely<Database> | undefined

export function getDb(): Kysely<Database> {
  if (!instance) {
    instance = new Kysely<Database>({
      dialect: new MysqlDialect({ pool: getPool() }),
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
