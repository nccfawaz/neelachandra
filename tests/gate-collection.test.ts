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
  for (const line of stdout.split('\n')) {
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
      for (const dir of ['tests', 'tests/integration', 'tests/e2e', 'tests/middleware']) {
        const entries = await readdir(dir, { withFileTypes: true })
        diskByDir.set(
          dir,
          entries.filter((e) => e.isFile() && e.name.endsWith('.test.ts')).map((e) => `${dir}/${e.name}`)
        )
      }
      const onDisk = [...diskByDir.values()].flat()

      const CONFIGS: SuiteConfig[] = []
      for (const name of CONFIG_NAMES) CONFIGS.push(await readSuiteConfig(name))

      for (const cfg of CONFIGS) {
        const claimed = onDisk.filter((f) => claimedBy(cfg, f))
        const collected = await collectedFiles(cfg.config)
        // The non-zero floors (DECISIONS 28.1): an empty claimed set or an
        // empty collected set makes the missing-comparison below vacuously
        // true, and the first draft of this test passed green for exactly
        // that reason while a file was excluded. The floor on `collected`
        // also catches the npx-vitest-list-exits-0-on-env-failure shape —
        // error output parses to zero files and the tripwire would otherwise
        // report a missing set the size of everything.
        expect(
          claimed,
          `${cfg.config}'s include/exclude globs claim zero test files — the glob ` +
            `mapping is broken and the comparison below would be vacuous. See DECISIONS 28.1.`
        ).not.toHaveLength(0)
        expect(
          collected,
          `${cfg.config}'s vitest list returned zero test files — the lister failed ` +
            `without a non-zero exit, and the comparison below would be vacuous. See DECISIONS 28.1.`
        ).not.toHaveLength(0)
        const missing = claimed.filter((f) => !collected.has(f))
        expect(
          missing,
          `${cfg.config} claims ${claimed.length} files but collects only ${collected.size}; ` +
            `not collected: ${missing.join(', ')}. A suite that stops running fails the gate ` +
            `instead of disappearing — see DECISIONS 27.1.`
        ).toEqual([])
      }
    }
  )
})