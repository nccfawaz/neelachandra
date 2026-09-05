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

**Second clause: a citation covers the shape it names and no adjacent shape.** A test
asserting a neighbouring case needs its own basis, even where the citation above it is real.
This is the clause that would actually have caught the expenses hole — the first one would
not have. The docstring over that test quotes rule 1 correctly and cites DECISIONS 19.1, and
it is right about what it says: rule 1 is about two rows carrying the *same* pair, and a
UNIQUE index over nullable columns is the mechanism for it. The child test then asserted
something about *half* a pair, a shape rule 1 does not mention, and inherited the parent's
credibility for it. So the defect passed a citation check while being justified by nothing.
A cited docstring makes the tests under it look grounded; each assertion still owes its own
line.

**Third clause: the rule covers comments in `src/` that justify a business rule, not only test
assertions.** The 20.3 sweep that triaged six comment-justified assertions searched `tests/` only, and so
missed `queries.ts:1020` — `applicableRate`'s own comment justifying rate precedence by "rule 3", which is
contractor compliance blocking deployment and has nothing to do with rates. A wrong citation in a module
is worse than one in a test, because it is what the next person reads before changing the behaviour and
nothing runs it. **A `src/`-wide sweep for rule-number citations is owed and has not been done.**

Two consequences worth stating:

- Prefer asserting the *refusal*. A test that pins what the database rejects fails when the
  rule weakens. A test that pins what it permits fails when the rule strengthens, and the
  cheapest way to make it pass again is to undo the strengthening.
- A registry of reasons is the same hazard, slower. `AUTO_JSON_CHECKS` in
  `tests/integration/schema-constraints.test.ts` carries a provenance header saying which
  of its reasons are inferred and which is grounded, for exactly this reason.

## A record of current behaviour cites the test that holds it there

**A `DECISIONS.md` sentence describing what the tree does *now* must name the assertion that proves
it** — the test, by file, and by line where that helps. Not the migration, not the module. A
description with nothing executable behind it is prose that cannot go red, and prose that cannot go
red drifts silently.

§19.1 is the instance, found on 2026-09-05. Its last paragraph described the integration suite
inserting *"two with `source_table` set and `source_id` NULL — half a pair is exempt by the same
rule"*. Migration 015 made those two inserts fail and the test was changed to assert `errno 4025`
against `chk_exp_source_pair`. The paragraph was not changed, and it went on giving a confident
account of a suite that no longer existed. Nothing was red, because a paragraph is not executable —
which is why the rule has to be about what the paragraph *says* rather than about running anything.

Why a citation is enough on its own: a cited test either still asserts what the sentence claims, or
somebody had to edit it — and editing it is the moment the sentence gets re-read. An uncited
description never gets that moment. The citation is not evidence, it is a tripwire on the prose.

Two clauses that decide which sentences this applies to:

- **A decision and a description of behaviour are different sentences, and one paragraph should not
  hold both.** "Rule 1 says the pair is unique where both are non-null" is a decision: it stays true
  whatever the tree does. "The suite inserts five rows with no `source_id`" is behaviour, and it
  needs the citation. §19.1's stale paragraph was the two welded together, which is how the false
  half borrowed credibility from the true half.
- **Counts are behaviour.** Test counts, row counts, "three tests in", "the eight nullable columns" —
  each is a fact about the tree at one moment. Cite where it is asserted, or date it.

## The database is not optional to verification

`npm test` opens no connection: it is evidence about pure functions and form contracts
only. `npm run test:integration` needs the persistent dev MariaDB on port **3307** and
throws rather than falling back, which is deliberate. Do not tear that database down.

## A nullable column inside a CHECK or a UNIQUE key weakens it silently

Three instances now, the same mistake in different clothes. All three read as correct.

- **A CHECK admits UNKNOWN.** `chk_ca_quantity` as migration 013 wrote it ended
  `quantity > 0`. A CHECK refuses a row only when its expression is FALSE, and
  `NULL > 0` is UNKNOWN, so the one row the constraint existed to refuse — a measured
  line with no measure to multiply — was the row it let through. Migration 014 exists
  for nothing but to put `quantity IS NOT NULL AND` in front of it.
- **A UNIQUE index exempts every row with a NULL in it, including the nonsense ones.**
  `uq_exp_source (source_table, source_id)`, migration 012. The NULL-NULL exemption is
  wanted: a manual expense has no upstream document and there are many of them. *Half*
  a pair is exempt by the same rule, so the table admitted any number of rows naming a
  source table and pointing at no id — each claiming to be the posting of an upstream
  document with nothing at the other end. No index can refuse that, because the row is
  wrong on its own rather than a duplicate of another, which is why 015 had to add
  `chk_exp_source_pair` beside the index rather than fixing the index.
- **A nullable member makes a widened key weaker than the narrow one it replaced.**
  `work_type` was `VARCHAR(120) NULL` and NULL on every per-day row when 016 was asked
  to add it to `uq_ca`. Done as instructed, the five-column key would have stopped
  refusing two identical per-day rows — the commonest shape in the table, and a
  double-billing path — in the course of permitting the pair it was widened for.
  Adding a nullable column to a UNIQUE key does not widen the key. It punches a hole
  in it.

The rule: **before writing a migration that puts a nullable column inside a CHECK or a
UNIQUE key, prove the current behaviour with a real insert against the live server, and
state that proof in the report.** Not a reading of the clause and not what the previous
migration's header claims — the insert, and what the server said back. For 016 that was
three identical `(1, NULL)` rows accepted and `(1, 'x')` refused 1062: two commands,
and they turned an instruction that would have removed a guarantee into one that added
one.

The reason it has to be a proof and not care taken is that none of the three is visible
to reading. The clause reads correctly. The index names the columns it should. The
widened key contains strictly more columns than the old one. Each is wrong for a reason
that lives in SQL's three-valued logic rather than in the text, and `tsc` and the pure
suite cannot see any of it.

Two shapes are safe once the proof shows a hole. Make the column NOT NULL with a
sentinel default and a CHECK that keeps the sentinel unreachable where it would mean
something (016: `''` on a day row, `chk_ca_work_type`). Or add a CHECK beside the index
for the shape an index cannot express (015). Prefer the first: it needs no second
constraint to stay true.
