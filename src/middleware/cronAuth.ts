import type { MiddlewareHandler } from 'hono'
import { timingSafeEqual } from 'node:crypto'
import { UnauthorisedError } from '../lib/errors.js'
import { env } from '../env.js'
import type { AppEnv } from '../types.js'

export const CRON_HEADER = 'x-cron-key'

/**
 * Guards /internal/cron/* (spec 3, src/internal/cron).
 *
 * The cron endpoints are HTTP because Hostinger's scheduler runs curl, not
 * node. That means they are reachable from the internet and the shared secret
 * is the only thing between a stranger and "run the daily rollup 500 times".
 * timingSafeEqual rather than === so the comparison does not leak the prefix
 * length of the key.
 */
export function cronAuth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const supplied = c.req.header(CRON_HEADER) ?? ''
    const expected = env.CRON_SECRET

    const a = Buffer.from(supplied)
    const b = Buffer.from(expected)

    // timingSafeEqual throws on a length mismatch, so the length check comes
    // first and returns the same error as a wrong value.
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorisedError('Invalid cron key')
    }

    // Cron responses are machine-read and must never be cached by anything
    // between the scheduler and the process.
    c.header('Cache-Control', 'no-store')
    return next()
  }
}
