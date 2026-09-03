import type { MiddlewareHandler } from 'hono'
import { CSRF_FIELD, requiresCsrf, verifyToken } from '../lib/csrf.js'
import { ForbiddenError } from '../lib/errors.js'
import type { AppEnv } from '../types.js'

/**
 * Verifies the synchroniser token on every state-changing request under /app
 * (spec 2.5).
 *
 * The body is parsed here and cached on c.var so the handler does not parse
 * it a second time. A Request body is a one-shot stream, so a second
 * parseBody in the handler would throw, and the alternative of not parsing
 * here means the guard cannot see the hidden field.
 *
 * `{ all: true }` is not optional. Without it Hono keeps only the last value
 * of a repeated field, so a purchase order typed with eight lines would post
 * eight itemId fields and reach the service with one. With it a field that
 * appears once is still a plain string, so nothing that reads a scalar
 * changes; only repeated fields become arrays, which is what the line-grid
 * schemas expect.
 */

declare module 'hono' {
  interface ContextVariableMap {
    parsedBody: Record<string, unknown> | null
  }
}

const SKIP_CONTENT_TYPES = ['multipart/form-data']

export function csrfProtect(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!requiresCsrf(c.req.method)) return next()

    const session = c.get('session')
    const contentType = c.req.header('content-type') ?? ''

    // A file upload is streamed, so it cannot be buffered here without
    // holding 15 MB in memory before the guard runs. Those routes carry the
    // token in the x-csrf-token header instead, checked below without a body
    // parse.
    const isMultipart = SKIP_CONTENT_TYPES.some((t) => contentType.includes(t))

    let body: Record<string, unknown> | null = null
    if (!isMultipart && contentType.includes('form-urlencoded')) {
      body = (await c.req.parseBody({ all: true })) as Record<string, unknown>
      c.set('parsedBody', body)
    } else if (!isMultipart && contentType.includes('application/json')) {
      try {
        body = (await c.req.json()) as Record<string, unknown>
      } catch {
        body = null
      }
      c.set('parsedBody', body)
    }

    // A non-string here means the field was sent twice, which no template in
    // the app does. Falling through to the header (and then failing
    // verification) is the fail-closed direction, and a Forbidden on submit is
    // a findable bug in a way a silently accepted duplicate is not.
    const suppliedFromBody = body?.[CSRF_FIELD]
    const supplied =
      typeof suppliedFromBody === 'string' && suppliedFromBody.length > 0
        ? suppliedFromBody
        : c.req.header('x-csrf-token')

    if (!session) throw new ForbiddenError('Your session has ended. Sign in again.')
    verifyToken(session.csrfToken, supplied)

    return next()
  }
}

/**
 * Reads the body the guard already consumed, or parses it if the guard did
 * not run for this route. Handlers call this instead of c.req.parseBody().
 *
 * The fallback repeats `{ all: true }` so a handler reached without the guard
 * sees the same shape as one reached through it — otherwise a form would work
 * or drop its lines depending on which middleware ran.
 */
export async function readBody(c: {
  get: (k: 'parsedBody') => Record<string, unknown> | null | undefined
  req: { parseBody: (options: { all: true }) => Promise<unknown> }
}): Promise<Record<string, unknown>> {
  const cached = c.get('parsedBody')
  if (cached) return cached
  return (await c.req.parseBody({ all: true })) as Record<string, unknown>
}
