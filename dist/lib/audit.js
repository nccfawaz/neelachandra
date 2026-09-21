import { ipToBuffer } from './crypto.js';
export async function writeAudit(db, entry) {
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
        .execute();
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
]);
function redact(value) {
    if (value === null || typeof value !== 'object')
        return value;
    if (Array.isArray(value))
        return value.map(redact);
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        out[k] = REDACTED_KEYS.has(k.toLowerCase()) ? '[redacted]' : redact(v);
    }
    return out;
}
/**
 * Field-level diff for the audit viewer. Returns only the keys whose value
 * changed, so a screen that submits forty unchanged fields does not render
 * forty rows of noise.
 */
export function diffFields(before, after) {
    const b = (before ?? {});
    const a = (after ?? {});
    const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
    const out = [];
    for (const key of [...keys].sort()) {
        const bv = b[key];
        const av = a[key];
        if (JSON.stringify(bv) !== JSON.stringify(av)) {
            out.push({ field: key, before: bv, after: av });
        }
    }
    return out;
}
