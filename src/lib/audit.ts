import type { Queryable } from '../db/kysely.js'
import { ipToBuffer } from './crypto.js'

/**
 * Audit writing (spec: src/lib/audit.ts, "called inside transactions").
 *
 * writeAudit takes the caller's transaction rather than opening its own, so
 * the audit row and the change it describes commit or roll back together. An
 * audit log that records approvals which were then rolled back is worse than
 * no audit log, because it looks authoritative.
 */

export interface AuditEntry {
  userId: number | null
  action: string
  entityType?: string | null
  entityId?: number | null
  before?: unknown
  after?: unknown
  ip?: string | null
}

export async function writeAudit(db: Queryable, entry: AuditEntry): Promise<void> {
  await db
    .insertInto('audit_log')
    .values({
      user_id: entry.userId,
      action: entry.action,
      entity_type: entry.entityType ?? null,
      entity_id: entry.entityId ?? null,
      before_json: entry.before === undefined ? null : JSON.stringify(redact(entry.before)),
      after_json: entry.after === undefined ? null : JSON.stringify(redact(entry.after)),
      ip: ipToBuffer(entry.ip ?? null),
    })
    .execute()
}

/**
 * Fields that must never reach the audit log even as a "before" value. A
 * password hash in audit_log defeats the point of hashing it, and a TOTP
 * secret there is a second copy outside the encrypted column.
 */
const REDACTED_KEYS = new Set([
  'password',
  'password_hash',
  'password_confirm',
  'new_password',
  'current_password',
  'totp_secret',
  'totp_code',
  'code_hash',
  'token',
  'token_hash',
  'recovery_code',
  'csrf_token',
  'bank_account_no',
  'aadhaar',
])

function redact(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(redact)
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACTED_KEYS.has(k.toLowerCase()) ? '[redacted]' : redact(v)
  }
  return out
}

/**
 * Field-level diff for the audit viewer. Returns only the keys whose value
 * changed, so a screen that submits forty unchanged fields does not render
 * forty rows of noise.
 */
export function diffFields(
  before: unknown,
  after: unknown
): Array<{ field: string; before: unknown; after: unknown }> {
  const b = (before ?? {}) as Record<string, unknown>
  const a = (after ?? {}) as Record<string, unknown>
  const keys = new Set([...Object.keys(b), ...Object.keys(a)])
  const out: Array<{ field: string; before: unknown; after: unknown }> = []
  for (const key of [...keys].sort()) {
    const bv = b[key]
    const av = a[key]
    if (JSON.stringify(bv) !== JSON.stringify(av)) {
      out.push({ field: key, before: bv, after: av })
    }
  }
  return out
}

export function parseAuditJson(raw: unknown): unknown {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}
