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
      body = (await c.req.parseBody()) as Record<string, unknown>
      c.set('parsedBody', body)
    } else if (!isMultipart && contentType.includes('application/json')) {
      try {
        body = (await c.req.json()) as Record<string, unknown>
      } catch {
        body = null
      }
      c.set('parsedBody', body)
    }

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
 */
export async function readBody(c: {
  get: (k: 'parsedBody') => Record<string, unknown> | null | undefined
  req: { parseBody: () => Promise<unknown> }
}): Promise<Record<string, unknown>> {
  const cached = c.get('parsedBody')
  if (cached) return cached
  return (await c.req.parseBody()) as Record<string, unknown>
}
