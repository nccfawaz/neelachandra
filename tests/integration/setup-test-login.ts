/**
 * Loads the manual-test login credentials (tests/integration/.test-login.env,
 * written by scripts/seed-test-login.mjs, gitignored — 29.48) if present.
 * Kept out of setup-db-env.ts so the hermetic gate's contract is untouched.
 */
import fs from 'node:fs'
try {
  const text = fs.readFileSync(new URL('./.test-login.env', import.meta.url), 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/)
    if (m) process.env[m[1]!] = m[2]!
  }
} catch {
  // File absent: test-login-accounts.test.ts will skip via beforeAll failure.
}
