/**
 * The one reader for every JSON column in the schema.
 *
 * MariaDB declares a JSON column as LONGTEXT with a `json_valid` CHECK
 * constraint, and reports it to the client with metadata saying so. mysql2 acts
 * on that metadata and parses the value before we ever see it, so a column
 * written with `JSON.stringify` comes back as a live object or array — not as
 * the string that `src/db/types.ts` types it, and not as the string the writer
 * put in.
 *
 * That asymmetry is invisible to the type checker and to any test that does not
 * touch a database, and it fails in the least helpful way available: calling
 * `JSON.parse` on the returned array stringifies it to "[object Object]" and
 * throws a SyntaxError, which every reader in this codebase caught and turned
 * into an empty result. Four readers were wrong in four different ways before
 * this file existed — one of them refused every lead conversion in the CRM, and
 * one of them silently rewrote every settings row on every save. See
 * DECISIONS.md 11.2 and 12.
 *
 * So there is one function, and `tests/json-columns.test.ts` fails the build if
 * `JSON.parse` appears anywhere in src/ except here.
 */

/**
 * Every JSON column in the schema, as `table.column`.
 *
 * Kept in sync with the database by `tests/integration/json-columns.test.ts`,
 * which reads the `json_valid` CHECK constraints out of information_schema and
 * fails if this list and the database disagree. A migration that adds a JSON
 * column therefore cannot land without registering it here, which is how the
 * next module discovers that the column it is about to read needs this reader.
 */
export const JSON_COLUMNS = [
  'audit_log.after_json',
  'audit_log.before_json',
  'dashboard_daily_snapshot.detail_json',
  'email_log.response_json',
  'project_documents.visible_to_roles',
  'quotes.payment_schedule_json',
  'settings.value_json',
  'site_page_revisions.content_json',
  'site_page_revisions.schema_types',
  'site_pages.content_json',
  'site_pages.schema_types',
  'site_services.body_json',
] as const

/**
 * Reads a JSON column value, whatever shape the driver hands over.
 *
 * Already-parsed values pass through untouched, which is the normal path for
 * every column in JSON_COLUMNS.
 *
 * A string is parsed only when it is unambiguously JSON structure — it starts
 * with `[`, `{` or `"`, or it is exactly `null`, `true` or `false`. That covers
 * a row written by hand in a SQL client and a server or driver that reports the
 * column as plain text, without the failure mode of parsing everything: a
 * `company.phone` of "9876543210" arrives from the driver as a JS string, and
 * a reader that parses every string turns it into a number, which then throws
 * the first time anything calls .trim() on it. Bare text and bare numbers are
 * therefore returned as the strings they are.
 *
 * Malformed JSON comes back as the string it was rather than throwing or
 * becoming null. Callers know the shape they need and check for it — an
 * unreadable setting should still render on the page as whatever is in the
 * column, and an unreadable payment schedule should be rejected by the caller
 * that was going to raise invoices against it, not by a parser that cannot know
 * which of those two situations it is in.
 */
export function parseJsonColumn(raw: unknown): unknown {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'string') return raw
  const text = raw.trim()
  const structural = text.startsWith('[') || text.startsWith('{') || text.startsWith('"')
  if (!structural && text !== 'null' && text !== 'true' && text !== 'false') return raw
  try {
    return JSON.parse(text)
  } catch {
    return raw
  }
}

/** `parseJsonColumn` for a column that must hold an array; anything else is empty. */
export function parseJsonColumnArray(raw: unknown): unknown[] {
  const parsed = parseJsonColumn(raw)
  return Array.isArray(parsed) ? parsed : []
}

/**
 * The canonical encoding of a column value, for comparing what is stored
 * against what is about to be written.
 *
 * `JSON.stringify(next) === row.value_json` is the shape of the bug this
 * prevents: the left side is JSON text and the right side is a parsed value, so
 * they never compare equal and the caller writes a row it did not need to.
 */
export function jsonColumnEquals(raw: unknown, next: unknown): boolean {
  return JSON.stringify(parseJsonColumn(raw)) === JSON.stringify(next === undefined ? null : next)
}
