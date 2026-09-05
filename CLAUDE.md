# Working notes for this repository

`DECISIONS.md` is the binding record of choices; `NCC_BUILD_SPEC.md` is the authority
and wins over any instruction in a prompt. This file holds only the things that have
already cost a session real time.

## Verification: a command that exits 0 having done nothing is not a pass

**The path is nested.** The extracted tree is
`C:\Users\HP\Downloads\neelachandra-main\neelachandra-main` — the project root is one
level *below* the directory of the same name. `tsconfig.json`, `package.json` and
`migrations/` are all in the inner one.

**Do not assume the working directory.** The harness prints `Shell cwd was reset to
C:\Users\HP\Downloads\neelachandra-main` after any `cd` out of the tree, and that path is
the *outer* directory. Whether a given call actually starts there or where the previous
one ended is not reliably observable, so treat it as unknown and make every verification
command carry its own `cd`:

```bash
cd /c/Users/HP/Downloads/neelachandra-main/neelachandra-main && npx tsc --noEmit
```

Run from the outer directory, `npx tsc --noEmit` finds no `tsconfig.json`, type-checks
nothing, prints nothing and **exits 0**. It is indistinguishable from a clean build in
every observable way except the one that matters. This has been reported as a green
once, on 2026-09-04, and caught only because the output was empty when 60 files should
have produced at least a file count.

That is the same shape as the pool hang of 2026-09-03 (fixed in `38ca44f`): every
Kysely query hung forever while `npm test` stayed green, because the suite never opened
a connection. Both are a gate that passes by not executing.

The rule that covers both: **a green is only a green if you can say what it executed.**
Before reporting a pass, check that the command found its config, that the counts are
non-zero, and that the number of files or tests is the number you expect. Prefer the
`package.json` scripts (`npm run typecheck`, `npm test`, `npm run test:integration`)
over bare binaries — they carry `-p tsconfig.json` and the config path with them, so
they fail loudly from the wrong directory instead of quietly.

## An exemption cites the spec or DECISIONS, never a comment

**A test may not justify a permitted row shape with a code or migration comment.** If an
assertion says some shape is permitted, exempt, intentional, by design, or deliberately
allowed, its stated basis must be `NCC_BUILD_SPEC.md` by line number or a `DECISIONS.md`
section. A comment in the code under test is not a basis.

This is not style. On 2026-09-05 a test in `hr-contractor-flow.test.ts` asserted that an
`expenses` row with `source_table` set and `source_id` NULL was permitted — a row claiming
to be the posting of an upstream document while pointing at nothing — and justified it with
*"the migration comment claims it, so it is asserted rather than assumed."* The comment and
the test were written in the same session by the same author. The circle closed on itself:
nothing outside the change confirmed the shape was wanted, and for a full slice the suite
**defended the defect against repair**. When migration 015 closed the hole, the suite went
red for doing the right thing, which is worse than having no test there at all — a red test
is an instruction to revert.

A spec line or a DECISIONS section can be wrong, but it was written before the code and by
a different act, so citing one is a real check. The test for whether a citation is load
bearing: **if the cited text vanished, would the assertion still look justified?** If yes,
it was decoration.

Two consequences worth stating:

- Prefer asserting the *refusal*. A test that pins what the database rejects fails when the
  rule weakens. A test that pins what it permits fails when the rule strengthens, and the
  cheapest way to make it pass again is to undo the strengthening.
- A registry of reasons is the same hazard, slower. `AUTO_JSON_CHECKS` in
  `tests/integration/schema-constraints.test.ts` carries a provenance header saying which
  of its reasons are inferred and which is grounded, for exactly this reason.

## The database is not optional to verification

`npm test` opens no connection: it is evidence about pure functions and form contracts
only. `npm run test:integration` needs the persistent dev MariaDB on port **3307** and
throws rather than falling back, which is deliberate. Do not tear that database down.
