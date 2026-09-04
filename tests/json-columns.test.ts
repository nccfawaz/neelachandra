import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  JSON_COLUMNS,
  jsonColumnEquals,
  parseJsonColumn,
  parseJsonColumnArray,
} from '../src/lib/json.js'

/**
 * The guard on the JSON column class of bug.
 *
 * MariaDB declares a JSON column as LONGTEXT with a `json_valid` CHECK
 * constraint and tells the client so; mysql2 parses the value before any of our
 * code sees it. A `JSON.parse` on the result therefore stringifies an object to
 * "[object Object]" and throws. Four readers had their own version of that
 * mistake and each one swallowed its own SyntaxError, so the symptom was never
 * an error: the CRM refused every lead conversion, the printed quote showed no
 * payment terms, the audit screen diffed nothing, and the settings editor
 * rewrote every row on every save. See DECISIONS.md 11.2 and 12.
 *
 * None of that is visible to tsc — `src/db/types.ts` types these columns as
 * strings, which is what the writer puts in and not what comes back. So the
 * rule is enforced here instead: one reader, in src/lib/json.ts, and this file
 * fails if a second appears. Eight of the twelve columns have no reader yet, so
 * every module still to be built — HR, finance, marketing, dashboard snapshots,
 * site content — is a place this comes back.
 *
 * tests/integration/json-columns.test.ts is the other half: it checks
 * JSON_COLUMNS against the CHECK constraints in information_schema, so a
 * migration cannot add a JSON column without registering it here.
 */

const SRC = join(process.cwd(), 'src')
const READER = join('src', 'lib', 'json.ts')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full)
  }
  return out.sort()
}

/**
 * Source with comments removed, so the prose explaining this rule — in the
 * reader and at every call site that had the bug — does not read as a call.
 *
 * Block comments go first. Then any line whose content starts with `//` or `*`
 * is dropped whole, which is narrower than cutting at the first `//` on a line:
 * a line of code keeps its trailing comment and a URL in a string is not
 * mistaken for one, so nothing can hide a call from this scan.
 */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return !trimmed.startsWith('//') && !trimmed.startsWith('*')
    })
    .join('\n')
}

describe('one JSON reader in src/', () => {
  it('finds JSON.parse in no file but the shared reader', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => code(readFileSync(file, 'utf8')).includes('JSON.parse'))
      .map((file) => relative(process.cwd(), file))
    expect(offenders).toEqual([READER])
  })

  it('finds exactly one call inside the reader', () => {
    const calls = code(readFileSync(join(SRC, 'lib', 'json.ts'), 'utf8')).match(/JSON\.parse/g)
    expect(calls).toHaveLength(1)
  })
})

describe('the JSON column registry', () => {
  it('is sorted and free of duplicates, so a merge conflict is obvious', () => {
    expect([...JSON_COLUMNS]).toEqual([...new Set(JSON_COLUMNS)].sort())
  })

  it('names every entry as table.column', () => {
    for (const entry of JSON_COLUMNS) expect(entry).toMatch(/^[a-z_]+\.[a-z_]+$/)
  })

  it('includes the three columns a *_json grep would miss', () => {
    // The grep that found the first four bugs would not have found these, and
    // two of the three belong to a module nobody has written yet.
    expect(JSON_COLUMNS).toContain('project_documents.visible_to_roles')
    expect(JSON_COLUMNS).toContain('site_pages.schema_types')
    expect(JSON_COLUMNS).toContain('site_page_revisions.schema_types')
  })
})

describe('parseJsonColumn', () => {
  it('passes an already-parsed value through untouched', () => {
    // The normal path: mysql2 hands over the array, and re-encoding it to
    // compare or re-parse it is what broke four readers.
    const schedule = [{ name: 'Advance on signing', percent: 20 }]
    expect(parseJsonColumn(schedule)).toBe(schedule)
    const object = { gst: 18 }
    expect(parseJsonColumn(object)).toBe(object)
    expect(parseJsonColumn(45)).toBe(45)
    expect(parseJsonColumn(true)).toBe(true)
  })

  it('parses text that is unambiguously JSON structure', () => {
    expect(parseJsonColumn('[1,2]')).toEqual([1, 2])
    expect(parseJsonColumn('{"a":1}')).toEqual({ a: 1 })
    expect(parseJsonColumn('  {"a":1}  ')).toEqual({ a: 1 })
    expect(parseJsonColumn('"NCC/QT"')).toBe('NCC/QT')
    expect(parseJsonColumn('null')).toBe(null)
    expect(parseJsonColumn('true')).toBe(true)
    expect(parseJsonColumn('false')).toBe(false)
  })

  it('leaves a bare string alone rather than reinterpreting it', () => {
    // company.phone_primary arrives from the driver as a JS string. A reader
    // that parses every string turns "9876543210" into a number, and the next
    // caller to reach for .trim() on it throws.
    expect(parseJsonColumn('9876543210')).toBe('9876543210')
    expect(parseJsonColumn('18')).toBe('18')
    expect(parseJsonColumn('+91 78292 92929')).toBe('+91 78292 92929')
    expect(parseJsonColumn('')).toBe('')
  })

  it('returns malformed JSON as the string it is', () => {
    // A column the caller cannot use should still render on the page as
    // whatever is in it; rejecting it is the caller's decision, not the
    // parser's, which cannot tell a setting from an invoice schedule.
    expect(parseJsonColumn('{"a":')).toBe('{"a":')
    expect(parseJsonColumn('[oops]')).toBe('[oops]')
  })

  it('reads an absent column as null', () => {
    expect(parseJsonColumn(null)).toBe(null)
    expect(parseJsonColumn(undefined)).toBe(null)
  })
})

describe('parseJsonColumnArray', () => {
  it('returns arrays, from either shape', () => {
    expect(parseJsonColumnArray([{ percent: 20 }])).toEqual([{ percent: 20 }])
    expect(parseJsonColumnArray('[{"percent":20}]')).toEqual([{ percent: 20 }])
  })

  it('returns empty for anything that is not an array', () => {
    expect(parseJsonColumnArray({ percent: 20 })).toEqual([])
    expect(parseJsonColumnArray('not json')).toEqual([])
    expect(parseJsonColumnArray(null)).toEqual([])
  })
})

describe('jsonColumnEquals', () => {
  it('sees a stored value and its encoding as equal', () => {
    // The settings bug: `JSON.stringify(next) === row.value_json` compared JSON
    // text against a pre-parsed value, so nothing was ever equal and every save
    // rewrote every row on the form, audited each one and reported them all as
    // changed.
    expect(jsonColumnEquals([{ percent: 20 }], [{ percent: 20 }])).toBe(true)
    expect(jsonColumnEquals('NCC/QT', 'NCC/QT')).toBe(true)
    expect(jsonColumnEquals(45, 45)).toBe(true)
    expect(jsonColumnEquals('"NCC/QT"', 'NCC/QT')).toBe(true)
  })

  it('still sees a real change', () => {
    expect(jsonColumnEquals(45, 30)).toBe(false)
    expect(jsonColumnEquals('NCC/QT', 'NCC/QUOTE')).toBe(false)
    expect(jsonColumnEquals([{ percent: 20 }], [{ percent: 25 }])).toBe(false)
  })

  it('treats an absent column and an absent value as the same nothing', () => {
    expect(jsonColumnEquals(null, null)).toBe(true)
    expect(jsonColumnEquals(null, undefined)).toBe(true)
    expect(jsonColumnEquals(null, '')).toBe(false)
  })

  it('does not confuse a number with its text', () => {
    // A settings row declared int but holding "18" is a data defect, and the
    // comparison has to report it as a change rather than hide it.
    expect(jsonColumnEquals(18, '18')).toBe(false)
  })
})
