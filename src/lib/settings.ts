import type { Queryable } from '../db/kysely.js'
import { parseJsonColumn } from './json.js'

/**
 * Reading the settings table (spec 6.2).
 *
 * Values are stored as JSON, so a money setting is a number and a bool is a
 * boolean, rather than everything being a string that each caller parses its
 * own way. data_type drives the admin editor, not the read path.
 *
 * Cached in process for sixty seconds. These are read on nearly every
 * request that renders a phone number or an email, they change a few times a
 * year, and the alternative is a query per page for a value that is
 * effectively constant. Sixty seconds means an owner who edits a setting
 * sees it take effect while they are still on the page, without a restart.
 */

const TTL_MS = 60_000

let cache: Map<string, unknown> | null = null
let loadedAt = 0
let inflight: Promise<Map<string, unknown>> | null = null

async function load(db: Queryable): Promise<Map<string, unknown>> {
  const rows = await db.selectFrom('settings').select(['key_name', 'value_json']).execute()
  const map = new Map<string, unknown>()
  for (const row of rows) map.set(row.key_name, parseJsonColumn(row.value_json))
  cache = map
  loadedAt = Date.now()
  return map
}

async function current(db: Queryable): Promise<Map<string, unknown>> {
  if (cache && Date.now() - loadedAt < TTL_MS) return cache
  // Collapse a stampede: on a cold process every concurrent request would
  // otherwise issue the same full-table read.
  inflight ??= load(db).finally(() => {
    inflight = null
  })
  return inflight
}

export async function getSetting<T>(db: Queryable, key: string, fallback: T): Promise<T> {
  const map = await current(db)
  const value = map.get(key)
  return (value === undefined || value === null ? fallback : value) as T
}

export async function getSettings(db: Queryable, keys: readonly string[]): Promise<Record<string, unknown>> {
  const map = await current(db)
  const out: Record<string, unknown> = {}
  for (const key of keys) out[key] = map.get(key) ?? null
  return out
}

export async function allSettings(db: Queryable) {
  return db
    .selectFrom('settings')
    .select(['id', 'key_name', 'value_json', 'data_type', 'is_secret', 'label', 'updated_at'])
    .orderBy('key_name')
    .execute()
}

export async function setSetting(
  db: Queryable,
  key: string,
  value: unknown,
  updatedBy: number | null
): Promise<void> {
  await db
    .updateTable('settings')
    .set({ value_json: JSON.stringify(value), updated_by: updatedBy })
    .where('key_name', '=', key)
    .execute()
  invalidateSettings()
}

/** Called by the settings editor so the next read is not stale for a minute. */
export function invalidateSettings(): void {
  cache = null
  loadedAt = 0
}

/** Coerces a form string according to the row's declared data_type. */
export function coerceSetting(dataType: string, raw: string): unknown {
  switch (dataType) {
    case 'int':
      return Number.parseInt(raw, 10) || 0
    case 'money':
      // Settings hold money as paise, same as every other money value.
      return Math.round(Number.parseFloat(raw) * 100) || 0
    case 'bool':
      return raw === 'on' || raw === 'true' || raw === '1'
    case 'json':
      // Form input, so this really is a string — but it goes through the same
      // reader as the column so there is one JSON.parse in src/ and the test
      // that enforces that can stay simple.
      return parseJsonColumn(raw)
    default:
      return raw
  }
}
