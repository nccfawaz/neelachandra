import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

/*
 * The unpushed-work tripwire (DECISIONS 31.8).
 *
 * Batches were reported as "pushed; origin/main = <hash>" when nothing had
 * been pushed at all — five commits including the entire site check-in
 * feature sat unpushed while the reports asserted parity. The claim was
 * copied from the last verified state instead of measured, and nothing in
 * the gates could catch it because every gate ran against the working tree,
 * which was green.
 *
 * The fix is to make unpushed work a GATE FAILURE, not a report habit:
 * this test measures origin/main against HEAD and fails while the local
 * branch is ahead. A batch whose final state is committed-but-unpushed
 * now cannot pass `npm test`, so it cannot be reported as complete.
 *
 * Deliberate shape:
 *
 *   - The test is SKIPPED, not failed, when there is no remote or no
 *     origin/main yet (a fresh clone, an offline machine, a CI checkout of a
 *     bare ref). Those are legitimate states; the tripwire exists to catch
 *     the illegitimate one: a remote that exists and lags the work.
 *   - It measures AHEAD only. origin/main ahead of HEAD is a pull/rebase
 *     situation, not unreported work, and failing the gate for it would
 *     push people to force-push rather than pull.
 *   - It fetches nothing. The measurement runs against the last-fetched
 *     origin/main so the gate is deterministic and offline-safe; the report
 *     procedure is responsible for the `git fetch` before declaring parity,
 *     exactly as it is responsible for the push itself.
 */

const ROOT = process.cwd()

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
}

function hasRemoteBranch(): boolean {
  try {
    const refs = git(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'])
    return refs.length > 0
  } catch {
    return false
  }
}

describe('the unpushed-work tripwire (DECISIONS 31.8)', () => {
  it('local main is not ahead of origin/main — every gate-green commit has been pushed', () => {
    if (!hasRemoteBranch()) {
      console.warn('[unpushed-work] no origin/main ref — skipped (fresh clone or offline)')
      return
    }
    const head = git(['rev-parse', 'HEAD'])
    const origin = git(['rev-parse', 'origin/main'])
    const ahead = git(['rev-list', '--count', 'origin/main..HEAD'])
    expect(
      Number(ahead),
      `local HEAD ${head.slice(0, 7)} is ${ahead} commit(s) ahead of origin/main ${origin.slice(0, 7)} — ` +
        'push before reporting the batch complete (git push origin main), then re-run this gate. ' +
        'A green working tree says nothing about what the remote holds.',
    ).toBe(0)
    // And the parity claim itself is measured, not assumed: the two hashes
    // must be identical, which also fails if origin/main has diverged
    // sideways (different commit, same count) — that is a pull, not a push.
    expect(origin, 'origin/main must equal local HEAD for a batch to be complete').toBe(head)
  })
})
