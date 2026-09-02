import type { Db } from './db/kysely.js'
import type { ScopeContext } from './lib/scope.js'

/**
 * The Hono context shape for the whole application.
 *
 * Everything here is set by src/middleware/session.ts on every request and
 * read by handlers. Nothing recomputes the permission set inside a handler
 * (spec 4.1), so `perms` being a plain Set is the contract: one Set.has per
 * guard, no queries.
 */

export interface CurrentUser {
  id: number
  email: string
  fullName: string
  status: 'invited' | 'active' | 'suspended' | 'inactive'
  mustChangePassword: boolean
  totpConfirmed: boolean
  employeeId: number | null
}

export interface SessionInfo {
  id: string
  csrfToken: string
  totpVerified: boolean
  expiresAt: string
}

export interface AppVariables {
  db: Db
  requestId: string
  clientIp: string | null
  user: CurrentUser | null
  session: SessionInfo | null
  perms: Set<string>
  roleKeys: string[]
  scope: ScopeContext | null
  requires2fa: boolean
}

export interface AppEnv {
  Variables: AppVariables
}

/**
 * Convenience readers. They throw rather than return null, because they are
 * only called downstream of requireAuth, and a null there is a routing bug
 * that should be loud rather than a page rendering as a guest.
 */
export function currentUser(c: { get: (k: 'user') => CurrentUser | null }): CurrentUser {
  const u = c.get('user')
  if (!u) throw new Error('currentUser called outside an authenticated route')
  return u
}

export function currentSession(c: { get: (k: 'session') => SessionInfo | null }): SessionInfo {
  const s = c.get('session')
  if (!s) throw new Error('currentSession called outside an authenticated route')
  return s
}

export function currentScope(c: { get: (k: 'scope') => ScopeContext | null }): ScopeContext {
  const s = c.get('scope')
  if (!s) throw new Error('currentScope called outside an authenticated route')
  return s
}
