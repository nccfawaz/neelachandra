import type { MiddlewareHandler } from 'hono'
import { ForbiddenError } from '../lib/errors.js'
import type { PermissionKey } from '../lib/permissions.js'
import type { AppEnv } from '../types.js'

/**
 * A single Set.has (spec 4.1). The permission set was computed once in
 * session middleware, so a guard costs no query.
 *
 * The parameter is PermissionKey rather than string, which is the point of
 * the PERMISSIONS const: requirePermission('projects.aprove') is a compile
 * error rather than a guard that silently admits nobody.
 */
export function requirePermission(...keys: PermissionKey[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const perms = c.get('perms')
    // Multiple keys are OR, not AND. A screen that either role can reach
    // lists both; a screen needing two permissions chains two middlewares.
    if (!keys.some((k) => perms.has(k))) {
      throw new ForbiddenError(
        keys.length === 1
          ? `This action needs the ${keys[0]} permission.`
          : `This action needs one of: ${keys.join(', ')}.`
      )
    }
    return next()
  }
}

/** Requires every key. Used where two unrelated capabilities must both hold. */
export function requireAllPermissions(...keys: PermissionKey[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const perms = c.get('perms')
    const missing = keys.filter((k) => !perms.has(k))
    if (missing.length > 0) {
      throw new ForbiddenError(`This action needs: ${missing.join(', ')}.`)
    }
    return next()
  }
}
