/**
 * The TOTP encryption key is its own secret (DECISIONS 29.50, resolving the
 * 29.44 cut-over blocker):
 *   - boot fails with a named error when TOTP_ENCRYPTION_KEY is absent or
 *     shorter than the 44-char floor (proven in a spawned subprocess with a
 *     doctored environment, not by reasoning);
 *   - a secret ciphertext round-trips under the TOTP key, and the derivation
 *     reads TOTP_ENCRYPTION_KEY only — so rotating SESSION_SECRET invalidates
 *     sessions but an enrolled user can still pass the challenge;
 *   - rotating TOTP_ENCRYPTION_KEY therefore refuses cleanly (the GCM auth
 *     failure surfaces as the 422 wrong-code path, i.e. recovery codes), the
 *     behaviour proven through the router in 29.44 and unchanged here.
 */
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { decryptSecret, encryptSecret, generateSecret } from '../../src/lib/totp.js'

function bootWith(totpKey: string | undefined): { code: number; output: string } {
  // A temp probe file importing src/env.ts by absolute file URL, run through
  // tsx in a clean process; the subprocess env is doctored per case.
  const dir = mkdtempSync(join(tmpdir(), 'totpkey-'))
  const probe = join(dir, 'probe.mts')
  const envUrl = pathToFileURL(join(process.cwd(), 'src', 'env.ts')).href
  writeFileSync(probe, `import("${envUrl}")\n`)
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test' }
  if (totpKey === undefined) delete env.TOTP_ENCRYPTION_KEY
  else env.TOTP_ENCRYPTION_KEY = totpKey
  try {
    execFileSync(
      process.execPath,
      [join('node_modules', 'tsx', 'dist', 'cli.mjs'), probe],
      { env, cwd: process.cwd(), stdio: 'pipe' },
    )
    return { code: 0, output: '' }
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer; stderr?: Buffer }
    return { code: e.status ?? 1, output: (e.stderr?.toString() ?? '') + (e.stdout?.toString() ?? '') }
  }
}

describe('the TOTP key is decoupled from SESSION_SECRET (DECISIONS 29.50)', () => {
  it('boot fails with a named error when TOTP_ENCRYPTION_KEY is absent or malformed', () => {
    const absent = bootWith(undefined)
    expect(absent.code).not.toBe(0)
    expect(absent.output).toContain('TOTP_ENCRYPTION_KEY')

    const short = bootWith('too-short')
    expect(short.code).not.toBe(0)
    expect(short.output).toContain('TOTP_ENCRYPTION_KEY')

    // And the healthy value boots clean.
    expect(bootWith(process.env.TOTP_ENCRYPTION_KEY).code).toBe(0)
  })

  it('a ciphertext round-trips under TOTP_ENCRYPTION_KEY', () => {
    const secret = generateSecret()
    const blob = encryptSecret(secret)
    expect(decryptSecret(blob)).toBe(secret)
  })

  it('the derivation reads TOTP_ENCRYPTION_KEY and never SESSION_SECRET', () => {
    const src = readFileSync(new URL('../../src/lib/crypto.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/scryptSync\(env\.TOTP_ENCRYPTION_KEY/)
    expect(src).not.toMatch(/scryptSync\(env\.SESSION_SECRET/)
  })
})
