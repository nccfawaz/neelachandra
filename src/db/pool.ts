import { createPool, type Pool, type RowDataPacket } from 'mysql2/promise'
import { env } from '../env.js'

/**
 * The single mysql2 pool for the process (spec 2.4).
 *
 * connectionLimit is 5 deliberately. Hostinger shared MariaDB caps concurrent
 * connections per user in the low tens, and one Node process serving ten
 * people never needs more; a larger pool just moves the failure from "wait
 * briefly for a connection" to "max_user_connections exceeded", which fails
 * the request instead of delaying it.
 *
 * dateStrings is on so DATE and DATETIME arrive as 'YYYY-MM-DD' strings in
 * Asia/Kolkata terms rather than as JS Date objects reinterpreted in the
 * process timezone. Every date in this application is a local Indian
 * business date, not an instant, and letting the driver build Date objects
 * is how a DPR filed on the 3rd starts displaying as the 2nd.
 */
let pool: Pool | undefined

export function getPool(): Pool {
  if (!pool) {
    pool = createPool({
      host: env.DB_HOST,
      port: env.DB_PORT,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME,
      charset: 'utf8mb4',
      connectionLimit: 5,
      waitForConnections: true,
      queueLimit: 0,
      dateStrings: ['DATE', 'DATETIME'],
      timezone: 'Z',
      supportBigNumbers: true,
      bigNumberStrings: false,
    })
  }
  return pool
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = undefined
  }
}

/** Boot check: fail fast if the database is unreachable or unmigrated. */
export async function assertDatabaseReady(): Promise<void> {
  const p = getPool()
  const [rows] = await p.query<Array<RowDataPacket & { n: number }>>(
    'SELECT COUNT(*) AS n FROM schema_migrations'
  )
  const applied = Number(rows[0]?.n ?? 0)
  if (applied === 0) {
    throw new Error('Database has no applied migrations. Run npm run db:migrate first.')
  }
}
