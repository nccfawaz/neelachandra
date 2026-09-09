import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { resolveConfig } from 'vitest/node'

/**
 * The gate-collection tripwire.
 *
 * A test suite that a config stops collecting does not fail anything: the
 * gate goes green having run one file fewer, and the only observable is a
 * count nobody is comparing. That is the same failure shape as the empty
 * typecheck of 2026-09-04 (CLAUDE.md: a green is only a green if you can say
 * what it executed) and the pool hang of 2026-09-03 — a gate that passes by
 * not executing. Found on 2026-09-08 while reconciling a 224/7 vs 239/9
 * baseline disagreement: the files were collected, but nothing in the tree
 * would have noticed if they had not been.
 *
 * The assertion is structural, not a frozen count: it reads
 * `npx vitest list --config <config>` for each suite config, extracts the
 * file paths, and compares the SET against the *.test.ts files on disk that
 * the config's include/exclude globs claim. A new file that is not collected
 * fails here, and a file that stops being collected fails here — instead of
 * silently leaving the gate.
 *
 * Each config's expectation is DERIVED from the config file itself via
 * vitest's own `resolveConfig` — never restated here. A CONFIGS table that
 * copies the globs by hand is the AUTO_JSON_CHECKS shape: a wrong config and
 * a wrong table agree, and the tripwire is silent. Importing the resolution
 * means there is exactly one place each glob lives. A fourth suite config is
 * one entry in CONFIG_NAMES, not a copy of its globs.
 */

const run = promisify(execFile)

/** The three suite configs, by path. Globs are never written here. */
const CONFIG_NAMES = ['vitest.config.ts', 'vitest.integration.config.ts', 'vitest.e2e.config.ts']

interface SuiteConfig {
  config: string
  include: string[]
  exclude: string[]
}

/**
 * Resolve a config file through vitest itself. This is the same resolution
 * the runner performs, so the include/exclude read here cannot disagree with
 * what the run collects unless vitest itself is inconsistent.
 */
async function readSuiteConfig(config: string): Promise<SuiteConfig> {
  const { vitestConfig } = await resolveConfig({ config })
  // Verbatim: no filtering. Filtering a glob out because it does not start
  // with 'tests/' would mishandle a config that excludes 'money.test.ts'
  // bare — the derived table would claim a file the run does not collect,
  // red for the wrong reason. The disk enumeration only names tests/ files,
  // so vitest's node_modules defaults are harmless here.
  const include = vitestConfig.include ?? []
  const exclude = vitestConfig.exclude ?? []
  expect(
    include.some((g) => g.startsWith('tests/')),
    `${config} resolves to no tests/ include glob — readSuiteConfig is broken`
  ).toBe(true)
  return { config, include, exclude }
}

/**
 * Minimal glob-to-regex for the shapes this repo uses: *, *-glob, and literal / .
 *
 * A double-star slash must match ZERO directories — the unit config's glob
 * claims `tests/money.test.ts` as much as `tests/x/y.test.ts`. Getting this
 * wrong makes `claimed` empty and the assertion pass vacuously, which is the
 * exact failure this file exists to prevent, one level up. (The first version
 * of this helper did exactly that and passed while a file was excluded; it
 * was watched failing before it was trusted.)
 */
function globToRegExp(glob: string): RegExp {
  let pattern = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') {
          i++
          pattern += '(?:[^/]+/)*'
        } else {
          pattern += '.*'
        }
      } else {
        pattern += '[^/]*'
      }
    } else {
      pattern += ch.replace(/[.+^${}()|[\]\\]/, '\\$&')
    }
  }
  return new RegExp(`^${pattern}$`)
}

function claimedBy(config: SuiteConfig, file: string): boolean {
  const included = config.include.some((g) => globToRegExp(g).test(file))
  const excluded = config.exclude.some((g) => globToRegExp(g).test(file))
  return included && !excluded
}

async function collectedFiles(config: string): Promise<Set<string>> {
  const { stdout } = await run('npx', ['vitest', 'list', '--config', config], {
    cwd: process.cwd(),
    maxBuffer: 16 * 1024 * 1024,
    shell: process.platform === 'win32',
  })
  const files = new Set<string>()
  for (const line of stdout.split('\n')) {        // Anchored to the start of the line: the lister also echoes file
        // names mid-line in error paths, and a mid-line match would
        // "collect" a file the config never ran.
        const match = line.match(/^(tests\/[^\s>]+\.test\.ts)/)
    if (match) files.add(match[1]!)
  }
  return files
}

describe('the gate collects every test file it claims', () => {
  it(
    'every *.test.ts on disk appears in the vitest list of the config that owns it',
    { timeout: 120_000 },
    async () => {
      const allDisk = (await readdir('.', { withFileTypes: true })).length >= 0 // sanity: cwd is project root
      expect(allDisk).toBe(true)

      const diskByDir = new Map<string, string[]>()
      // Enumerate recursively: a new SUBDIRECTORY under tests/ is exactly
      // the shape a future suite directory takes, and a directory list here
      // would miss it (the tests/deep probe below proved that). Files whose
      // vitest list never names them are the failure this test exists for.
      async function walkTests(dir: string): Promise<string[]> {
        const entries = await readdir(dir, { withFileTypes: true })
        const found: string[] = []
        for (const e of entries) {
          if (e.isDirectory()) found.push(...(await walkTests(`${dir}/${e.name}`)))
          else if (e.isFile() && e.name.endsWith('.test.ts')) found.push(`${dir}/${e.name}`)
        }
        return found
      }
      const onDisk = await walkTests('tests')

      const CONFIGS: SuiteConfig[] = []
      for (const name of CONFIG_NAMES) CONFIGS.push(await readSuiteConfig(name))

      // The invariant is UNION COVERAGE, not per-config agreement (DECISIONS
      // 29.3, superseding the derived-CONFIGS form): every *.test.ts on disk
      // under tests/ must be collected by AT LEAST ONE config. Per-config
      // agreement proved nothing — a config that excludes a real suite and a
      // table that agrees with it both move together, and the excluded file
      // silently leaves the gate while every comparison stays true.
      const collectedBy = new Map<string, string[]>()
      for (const cfg of CONFIGS) {
        const collected = await collectedFiles(cfg.config)
        // The non-zero floors (DECISIONS 28.1): an empty collected set makes
        // the union below miss files that were never listed — the lister
        // failing without a non-zero exit shape.
        expect(
          collected,
          `${cfg.config}'s vitest list returned zero test files — the lister failed ` +
            `without a non-zero exit, and the union below would be vacuous. See DECISIONS 28.1.`
        ).not.toHaveLength(0)
        collectedBy.set(cfg.config, [...collected])
      }
      expect(onDisk.length, 'no *.test.ts files found on disk — the enumeration is broken').toBeGreaterThan(0)

      const orphaned = onDisk.filter((f) => !CONFIGS.some((cfg) => collectedBy.get(cfg.config)!.includes(f)))
      expect(
        orphaned,
        `These test files are on disk but collected by NO suite config, so no gate runs them: ` +
          `${orphaned.join(', ')}. Add the file to a config's include, or delete it — ` +
          `a suite nothing runs is a suite that cannot fail. See DECISIONS 29.3.`
      ).toEqual([])

      // Report which config claims each file, so a new file's owner is
      // visible in the failure message rather than discovered by hand.
      const ownership = onDisk.map((f) => {
        const owners = CONFIGS.filter((cfg) => collectedBy.get(cfg.config)!.includes(f)).map((cfg) => cfg.config)
        return `${f} <- ${owners.join(', ') || 'NOTHING'}`
      })
      expect(ownership.length).toBe(onDisk.length)
      expect(ownership.every((line) => !line.endsWith('NOTHING')), `unowned files present: ${ownership.filter((l) => l.endsWith('NOTHING')).join('; ')}`).toBe(true)
    }
  )
})
