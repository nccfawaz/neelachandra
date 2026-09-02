import type { MiddlewareHandler } from 'hono'
import { NotFoundError } from '../lib/errors.js'
import { hasProjectAccess } from '../lib/scope.js'
import type { AppEnv } from '../types.js'

/**
 * Resolves :projectId and enforces project_assignments for scoped roles
 * (spec 4.4).
 *
 * The failure is 404, never 403. A site supervisor probing /app/projects/57
 * must not learn that project 57 exists, because the project name is itself
 * commercially sensitive: "Honda Cars India Phase 3" tells a competitor who
 * the client is.
 */
export function requireProjectAccess(param = 'projectId'): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const raw = c.req.param(param)
    const projectId = Number(raw)
    if (!raw || !Number.isInteger(projectId) || projectId < 1) {
      throw new NotFoundError('Project not found')
    }

    const scope = c.get('scope')
    if (!scope) throw new NotFoundError('Project not found')

    const ok = await hasProjectAccess(c.get('db'), scope, projectId)
    if (!ok) throw new NotFoundError('Project not found')

    return next()
  }
}
