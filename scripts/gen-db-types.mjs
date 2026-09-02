#!/usr/bin/env node
// scripts/gen-db-types.mjs
// Generates src/db/types.ts from information_schema of the migrated database.
//
// The spec calls src/db/types.ts "generated table interfaces" (section 3), so
// this is that generator. It reads the schema the migrations actually
// produced rather than a parallel hand-maintained list, which is the only way
// the types cannot silently drift from the tables.
//
// Mapping rules:
//   BIGINT/INT/SMALLINT/TINYINT/DECIMAL -> number
//     DECIMAL is number, not string. Every DECIMAL column in this schema is a
//     quantity or a percentage, never money: money is BIGINT paise
//     (spec 2.4). Quantities at DECIMAL(14,3) are exactly representable well
//     past any construction quantity, so float rounding is not a risk here.
//   DATE/DATETIME/TIME -> string
//     The pool is configured with dateStrings, see src/db/pool.ts.
//   JSON -> unknown, so a consumer has to narrow it.
//   VARBINARY -> Buffer.
//   ENUM -> a union of its literal values, which is what makes a bad status
//     string a compile error rather than a silent no-op UPDATE.
//
// Columns with a DEFAULT or auto_increment become Generated<T>, and nullable
// columns become T | null.

import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createConnection } from 'mysql2/promise'

try {
  process.loadEnvFile()
} catch {
  // Real environment variables only.
}

const database = process.argv.includes('--db')
  ? process.argv[process.argv.indexOf('--db') + 1]
  : process.env.DB_NAME

const connection = await createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database,
  charset: 'utf8mb4',
})

const [columns] = await connection.query(
  `SELECT table_name, column_name, data_type, column_type, is_nullable,
          column_default, extra, ordinal_position
     FROM information_schema.columns
    WHERE table_schema = ?
    ORDER BY table_name, ordinal_position`,
  [database]
)

await connection.end()

function pascal (snake) {
  return snake.split('_').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('')
}

function tsType (col) {
  const dt = col.data_type.toLowerCase()
  if (dt === 'enum') {
    // column_type looks like enum('a','b')
    const inner = col.column_type.slice(5, -1)
    const values = inner.split(',').map((v) => v.trim().replace(/^'|'$/g, ''))
    return values.map((v) => `'${v.replace(/'/g, "\\'")}'`).join(' | ')
  }
  if (['bigint', 'int', 'smallint', 'tinyint', 'mediumint', 'decimal', 'float', 'double'].includes(dt)) {
    return 'number'
  }
  if (['date', 'datetime', 'timestamp', 'time', 'year'].includes(dt)) {
    return 'string'
  }
  if (dt === 'json') return 'unknown'
  if (['varbinary', 'binary', 'blob', 'longblob', 'mediumblob', 'tinyblob'].includes(dt)) {
    return 'Buffer'
  }
  return 'string'
}

const byTable = new Map()
for (const col of columns) {
  const t = col.table_name
  if (!byTable.has(t)) byTable.set(t, [])
  byTable.get(t).push(col)
}

const tableNames = [...byTable.keys()].sort()

const lines = []
lines.push('// GENERATED FILE. Do not edit by hand.')
lines.push('// Regenerate with: npm run db:types')
lines.push('//')
lines.push('// Kysely table interfaces read from information_schema after the migrations')
lines.push('// in migrations/ have been applied. See scripts/gen-db-types.mjs for the')
lines.push('// SQL to TypeScript mapping rules and why each one is what it is.')
lines.push('')
lines.push("import type { ColumnType, Generated } from 'kysely'")
lines.push('')
lines.push('/**')
lines.push(' * DATE and DATETIME arrive as strings because the pool sets dateStrings')
lines.push(' * (src/db/pool.ts). Inserts accept a string or a Date so a caller can hand')
lines.push(' * over either without a cast.')
lines.push(' *')
lines.push(' * There are three variants of each rather than one wrapped in')
lines.push(' * Generated<>, because Generated<ColumnType<...>> nests two ColumnTypes')
lines.push(' * and Kysely then reads the outer one only: comparisons against a plain')
lines.push(' * string stop type checking. Spelling the optional insert out here keeps')
lines.push(' * eb(col, ">=", "2026-04-01") legal.')
lines.push(' */')
lines.push('type SqlDate = ColumnType<string, string | Date, string | Date>')
lines.push('type SqlDateGen = ColumnType<string, string | Date | undefined, string | Date>')
lines.push('type SqlDateNull = ColumnType<string | null, string | Date | null | undefined, string | Date | null>')
lines.push('type SqlJson = ColumnType<unknown, string, string>')
lines.push('type SqlJsonGen = ColumnType<unknown, string | undefined, string>')
lines.push('type SqlJsonNull = ColumnType<unknown, string | null | undefined, string | null>')
lines.push('')

for (const table of tableNames) {
  if (table === 'schema_migrations') continue
  const iface = pascal(table) + 'Table'
  lines.push(`export interface ${iface} {`)
  for (const col of byTable.get(table)) {
    const dt = col.data_type.toLowerCase()
    const nullable = col.is_nullable === 'YES'
    const generated =
      String(col.extra ?? '').includes('auto_increment') ||
      col.column_default !== null ||
      nullable

    let finalType
    if (['date', 'datetime', 'timestamp'].includes(dt)) {
      finalType = nullable ? 'SqlDateNull' : generated ? 'SqlDateGen' : 'SqlDate'
    } else if (dt === 'json') {
      finalType = nullable ? 'SqlJsonNull' : generated ? 'SqlJsonGen' : 'SqlJson'
    } else {
      let t = tsType(col)
      if (nullable) t = `${t} | null`
      finalType = generated ? `Generated<${t}>` : t
    }
    lines.push(`  ${col.column_name}: ${finalType}`)
  }
  lines.push('}')
  lines.push('')
}

lines.push('export interface Database {')
for (const table of tableNames) {
  if (table === 'schema_migrations') continue
  lines.push(`  ${table}: ${pascal(table)}Table`)
}
lines.push('}')
lines.push('')

const out = path.join(process.cwd(), 'src', 'db', 'types.ts')
await writeFile(out, lines.join('\n'), 'utf8')
console.log(
  'Wrote ' + out + ': ' + (tableNames.length - 1) + ' tables, ' + columns.length + ' columns.'
)
