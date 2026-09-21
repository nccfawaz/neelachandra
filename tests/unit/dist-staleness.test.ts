import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * The dist staleness tripwire (DECISIONS 29.70).
 *
 * dist/ is COMMITTED because the production host copies repo files and
 * runs nothing — a stale or absent artifact means the deployment serves
 * old code or cannot start. The tripwire rebuilds dist/ IN PLACE with the
 * same tsc invocation npm run build uses, then asks git two questions:
 * does HEAD know every dist/ file (untracked = the artifact was never
 * committed) and does any committed file differ from a fresh emit. The
 * diff form is used rather than `git status` because status compares
 * bytes and flags line-ending churn (checkout restores CRLF, tsc emits
 * LF) while `git diff` normalizes. The working tree is restored in the
 * afterAll hook so the test never leaves the repo dirty.
 */
const ROOT = process.cwd()
const DIST = join(ROOT, 'dist')
const ENTRY = join(DIST, 'server.js')

let dirty = false

function gitOut(args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
}

describe('dist staleness (29.70)', () => {
  it('committed dist/ exists and contains the entry point', () => {
    expect(existsSync(DIST), 'dist/ is not on disk — run npm run build and commit it').toBe(true)
    expect(existsSync(ENTRY), 'dist/server.js missing — the production entry point').toBe(true)
  })

  it(
    'committed dist/ is not stale against a fresh tsc build',
    { timeout: 180_000 },
    () => {
      expect(existsSync(ENTRY)).toBe(true)
      // Same invocation as npm run build's first step (plain `tsc --outDir`
      // elsewhere drops the dashboard .tsx emit).
      execFileSync(
        process.execPath,
        ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'],
        { cwd: ROOT, stdio: 'pipe' },
      )
      const untracked = gitOut(['ls-files', '--others', '--exclude-standard', '--', 'dist/'])
        .split('\n')
        .filter(Boolean)
      const modified = gitOut(['diff', '--name-only', 'HEAD', '--', 'dist/'])
        .split('\n')
        .filter(Boolean)
      dirty = untracked.length > 0 || modified.length > 0
      expect(
        [...untracked.map((f) => `untracked: ${f}`), ...modified.map((f) => `modified: ${f}`)],
        'committed dist/ is STALE against src/ — rebuild with npm run build and commit dist/',
      ).toEqual([])
    },
  )

  afterAll(() => {
    // Never leave the tree dirty: restore dist/ to its committed state.
    if (dirty) {
      execFileSync('git', ['checkout', '--', 'dist/'], { cwd: ROOT, stdio: 'pipe' })
      execFileSync('git', ['clean', '-fd', '--', 'dist/'], { cwd: ROOT, stdio: 'pipe' })
      dirty = false
    }
  })
})
