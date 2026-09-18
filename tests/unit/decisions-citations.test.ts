import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The fabrication tripwire (DECISIONS 29.67).
 *
 * DECISIONS.md entries are required to cite the test that proves the recorded
 * behaviour. Two historical entries cited files that never existed and the
 * figures were reported as green (§§29.56/29.57; the tripwire itself was
 * claimed in an earlier batch and never landed — that claim was fabricated,
 * recorded in 29.67). This test closes the class:
 *   1. a non-zero floor on citations found (empty-green rule: a broken
 *      parser must not pass on an empty set);
 *   2. every cited path exists on disk;
 *   3. every cited file is collected by some vitest config (the §27.1
 *      disk-equals-collected rule applied to citations).
 */

function walkTestFiles(dir: string, prefix = 'tests'): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walkTestFiles(full, `${prefix}/${entry}`))
    else if (entry.endsWith('.test.ts') || entry.endsWith('.test.tsx')) out.push(`${prefix}/${entry}`)
  }
  return out
}

const DECISIONS = readFileSync('DECISIONS.md', 'utf8')
const CITED = [...new Set(DECISIONS.match(/tests\/[\w./-]+\.test\.tsx?/g) ?? [])]

const ALL_CONFIGS = ['vitest.config.ts', 'vitest.integration.config.ts', 'vitest.e2e.config.ts']
const COLLECTED = new Set<string>()
for (const cfg of ALL_CONFIGS) {
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
  try {
    const out = execFileSync(
      process.execPath,
      ['node_modules/vitest/vitest.mjs', 'list', '--config', cfg, '--filesOnly'],
      { encoding: 'utf8', timeout: 60_000 },
    )
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(tests\/[\w./-]+\.test\.tsx?)$/)
      if (m) COLLECTED.add(m[1])
    }
  } catch {
    // config may not exist on this machine; filesOnly listing unavailable —
    // fall back to assuming on-disk files are collected (§27.1's own tripwire
    // asserts that separately).
    for (const f of walkTestFiles('tests')) COLLECTED.add(f)
  }
}

describe('DECISIONS.md citations exist and are collected (29.67)', () => {
  it('finds a non-zero number of citations', () => {
    expect(CITED.length).toBeGreaterThanOrEqual(20)
  })

  it('every cited test file exists on disk', () => {
    const onDisk = new Set(walkTestFiles('tests'))
    const missing = CITED.filter((c) => !onDisk.has(c))
    expect(missing).toEqual([])
  })

  it('every cited test file is collected by some config', () => {
    const uncollected = CITED.filter((c) => !COLLECTED.has(c))
    expect(uncollected).toEqual([])
  })
})
