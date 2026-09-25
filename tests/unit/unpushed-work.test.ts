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
 * this test measures the current branch against ITS OWN UPSTREAM and fails
 * while the local branch is ahead. A batch whose final state is
 * committed-but-unpushed now cannot pass `npm test`, so it cannot be reported
 * as complete.
 *
 * Why the upstream and not origin/main (amendment 2026-09-25): comparing to
 * origin/main specifically was correct only while work happened on main and
 * turned every feature branch red by construction — a branch is always ahead
 * of origin/main. Waiving the gate on a branch would defeat the tripwire, so
 * the comparison follows the branch's own tracking ref (`@{upstream}`)
 * instead. On main the upstream IS origin/main, so the guarantee is
 * unchanged there; on a feature branch it is that branch's remote copy. The
 * guarantee is the same at every width: every gate-green commit has been
 * pushed to the branch it belongs to.
 *
 * Deliberate shape:
 *
 *   - The test is SKIPPED, not failed, when the current branch has no
 *     upstream configured (a branch never pushed, a detached HEAD, a fresh
 *     clone with no tracking ref). Those are legitimate states; the tripwire
 *     exists to catch the illegitimate one: an upstream that exists and lags
 *     the work. The fix for a skip is `git push -u`, which is the same act
 *     the tripwire is enforcing — so a skip is self-correcting, not a hole.
 *   - It measures AHEAD only. The upstream ahead of HEAD is a pull/rebase
 *     situation, not unreported work, and failing the gate for it would
 *     push people to force-push rather than pull.
 *   - It fetches nothing. The measurement runs against the last-fetched
 *     tracking ref so the gate is deterministic and offline-safe; the report
 *     procedure is responsible for the `git fetch` before declaring parity,
 *     exactly as it is responsible for the push itself.
 */

const ROOT = process.cwd()

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
}

/**
 * The branch's own tracking ref (e.g. `origin/mobile-redesign`), or null when
 * the branch has no upstream configured — a branch never pushed, a detached
 * HEAD, or a fresh clone. `git rev-parse @{upstream}` exits non-zero in every
 * one of those cases, which is the skip signal.
 */
function upstreamRef(): string | null {
  try {
    const ref = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
    return ref.length > 0 ? ref : null
  } catch {
    return null
  }
}

describe('the unpushed-work tripwire (DECISIONS 31.8)', () => {
  it('the current branch is not ahead of its upstream — every gate-green commit has been pushed', () => {
    const upstream = upstreamRef()
    if (upstream === null) {
      console.warn(
        '[unpushed-work] the current branch has no upstream — skipped (never pushed, detached HEAD, ' +
          'or fresh clone). Set one with `git push -u origin <branch>`, which is the push this gate enforces.',
      )
      return
    }
    const head = git(['rev-parse', 'HEAD'])
    const up = git(['rev-parse', '@{upstream}'])
    const ahead = git(['rev-list', '--count', '@{upstream}..HEAD'])
    expect(
      Number(ahead),
      `local HEAD ${head.slice(0, 7)} is ${ahead} commit(s) ahead of its upstream ${upstream} ` +
        `${up.slice(0, 7)} — push before reporting the batch complete (git push), then re-run this gate. ` +
        'A green working tree says nothing about what the remote holds.',
    ).toBe(0)
    // And the parity claim itself is measured, not assumed: the two hashes
    // must be identical, which also fails if the upstream has diverged
    // sideways (different commit, same count) — that is a pull, not a push.
    expect(up, `the upstream ${upstream} must equal local HEAD for a batch to be complete`).toBe(head)
  })
})
