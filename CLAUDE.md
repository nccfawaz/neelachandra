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
nothing runs it.

The `src/`-wide sweep this clause asked for was done on 2026-09-05 and is DECISIONS 23. Of 169 lines in
`src/` mentioning a rule by number, nineteen used one as the basis for an ordering, a refusal or a
quotation; five of those nineteen were wrong. **The most useful thing it found, for the next sweep: four
of the five were wrong about the *scope* of a real rule rather than about which rule it was.** A quoted
fragment that is not in the spec at all, a rule naming five stages cited for nine, a schema strictness
that belongs to a sibling function, a rule cited for a mechanism when it only requires the property. Only
one was the `queries.ts` shape of citing the wrong number outright. So the grep that finds these is not
"is there a rule number here" — it is **read the cited line and ask what it does not say**.

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

**SUM over zero rows is NULL, not 0 — and an aggregate feeding arithmetic is the
shape where it bites.** `SUM(x)` with no rows under it returns NULL; only
`COUNT` returns 0. The instance: §6.8 rule 2's two views (migration 020)
aggregate committed and actual cost per project per cost head, and the prose
specifies the variance as `budget - (committed + actual)`. Without a COALESCE,
a project with no POs and no expenses makes every derived figure NULL — not
zero, and not an error, just a blank where a number was expected, silently,
on every report the views feed.The rule: **an aggregate whose result feeds arithmetic or a NOT NULL expectation is wrapped in COALESCE at the point of
aggregation, and the zero-rows case is proven by evaluating the aggregate
expression against an empty set — not by reading the definition.**
`tests/integration/finance-views.test.ts` ("SUM over zero rows is 0, not
NULL") runs `select coalesce(sum(amount_paise), 0)` against a non-matching
`expense_id` and asserts `not.toBeNull()` and `0`, which is the evaluation
shape the CHECK-tripwire section asks for, applied to aggregates.

**A CHECK that returns NULL on NULL cannot police the column it guards — and
the driver can hand the writer a shape the binding mangles before the CHECK
ever sees it.** Two halves, one incident (DECISIONS 29.29, 2026-09-11):

- The NULL half is the three-valued-logic rule above wearing a JSON column:
  `json_valid(NULL)` is UNKNOWN, so the CHECK admits any NULL. On a nullable
  JSON column that is the *wanted* behaviour — but it means the CHECK says
  nothing about what else got in, so "the column is guarded" must be proven
  by observing the stored bytes, never by reading the DDL.
- The binding half is invisible to the server until too late: mysql2 parses
  JSON columns into live objects on READ, and Kysely stringifies a bare
  object on WRITE as the literal `[object Object]` — which json_valid then
  refuses (`CONSTRAINT site_page_revisions.content_json failed`, all nine
  cms-revisions tests red on the first live run). A round-trip through a
  JSON column and back is not identity: read object → write object is a
  guaranteed constraint failure.

The rule: **the one reader (`parseJsonColumn`) and the one writer encoder
(`toJsonText`), both in `src/lib/json.ts`, are the only sanctioned shapes for
JSON column values in `src/`** — every write path sends either a string the
caller built with `JSON.stringify` or the value through `toJsonText`, and
`tests/integration/json-columns.test.ts` scans all twelve columns for stored
`[object Object]` or json_valid failures so the class is caught at the gate,
not at the first live suite run.


## A tripwire on a constraint's shape has to evaluate the clause, not match its text

**MariaDB stores a CHECK re-rendered from its parse tree, so the clause you wrote is not
the clause you can string-match.** `information_schema.CHECK_CONSTRAINTS.CHECK_CLAUSE`
comes back with identifiers backquoted, keywords lower-cased, and **redundant parentheses
dropped**. Migration 019 wrote:

```sql
AND (uom <> 'lumpsum' OR (quantity IS NOT NULL AND quantity = 1))
```

and the server stores ``and (`uom` <> 'lumpsum' or `quantity` is not null and `quantity` =
1)``. The inner pair is gone — `AND` binds tighter than `OR`, so it changed nothing about
the parse and the server does not keep it. The grouping 019 exists to establish is exactly
what the stored text will not show you.

That breaks a text tripwire in both directions, and one of them is silent. Matching the
written form fails immediately, which is survivable because it is loud. Matching a
substring instead — ``/`quantity` is not null/`` anywhere in the clause — passes while
saying nothing about *which* conjunct governs which comparison, which is the same defect
as the section above wearing a test's clothes. Presence is not governance.

**The rule: read the clause, cut out the fragment, and make the server evaluate it over a
synthetic row.** Assert FALSE (`0`) against UNKNOWN (`NULL`), not text. The pattern to copy
is the second tripwire in the lumpsum test in
`tests/integration/hr-contractor-flow.test.ts`, and four details in it are load bearing:

- Extract with a regex that tolerates one level of nesting —
  ``/\(`uom` <> 'lumpsum'(?:[^()]|\([^()]*\))*\)/``. A `[^)]*` body stops at the first close
  paren, so it truncates the fragment on any server that *does* keep the inner pair, and a
  truncated fragment still parses.
- Evaluate it alone: `select (<fragment>) as v from (select 'lumpsum' as uom, NULL as
  quantity) t`, through `sql.raw` on schema text this repository wrote. Evaluating the
  whole clause proves nothing here — the whole clause was already FALSE under 018, which
  is what made the dependency invisible.
- Keep NULL distinguishable from 0. `Number(null)` is 0, so coercing the result destroys
  the one distinction the test exists for.
- Assert the positive control as well (`('lumpsum', 1)` → `1`). A fragment that is
  constantly false satisfies the FALSE assertion while enforcing nothing.

**Then prove the tripwire can fail.** Swap the live clause back to the old text, run the
one test, watch it go red *for the stated reason*, swap it forward. 019's failed with
`expected null to be +0`, which is the disjunct returning UNKNOWN. A tripwire nobody has
watched fail is a green of the kind the first section of this file is about.

## A tripwire that enumerates its subject must refuse to pass on an empty enumeration

**An enumeration over zero rows makes every set comparison vacuously true, and the tripwire
go green while asserting nothing.** Three instances, all found on 2026-09-08 in one sweep
(DECISIONS 28.1):

- `tests/gate-collection.test.ts`'s first glob-to-regex turned a double-star glob into a regex
  that required a slash, so the *claimed* set was **empty for every config** and the
  not-collected comparison passed against nothing — it stayed green with a file excluded.
- `npx vitest list`, run outside the suite's own environment, **fails environment validation
  and exits 0** (the empty-green of the first section of this file, wearing a subcommand).
  Any tripwire that parses its output gets empty input and the same vacuous pass.
- The general shape: `expect(missing).toEqual([])` where `missing = claimed.filter(...)` is
  the assertion; make `claimed` empty and it is true of every subject in the world.

The first instance passed *with the defect in place* and was caught only by watching it fail —
reading it found nothing, because each line is individually correct.

The rule: **before comparing an enumerated set against anything, assert a non-zero floor on
the enumeration itself** — `expect(claimed.length).toBeGreaterThan(0)` (or the expected
minimum for that subject) before the comparison runs. The floor turns an empty enumeration
into a red test naming the empty source, instead of a green test that compared nothing. The
floor is not decoration either: assert the smallest number that would make the comparison
meaningful, and make a future reader able to tell an empty source from a legitimately small
one by the failure message.

## A CHECK clause's text is not even its own truth: collation joins the list

Beside the CHECK_CLAUSE normalisation note above: **the clause you can read is not the clause
the server evaluates, for reasons that have nothing to do with NULL or parenthesis
normalisation.** Migration 022's `chk_inv_pos_shape` was written `place_of_supply REGEXP
'^[A-Z]{2}$'` — read correctly, stored verbatim (modulo the usual backquoting) — and **admitted
'ka'**, because MariaDB evaluates REGEXP under the column's case-insensitive collation, where
`A–Z` matches `a–z` too. Proven by insert against the live server on 2026-09-08 before commit
(the first draft shipped the hole); the fix is `CAST(place_of_supply AS BINARY) REGEXP ...`,
which the server stores as `cast(\`place_of_supply\` as char charset binary) regexp ...`.

This is the first case where the clause's **appearance** and its **evaluation** diverge for a
reason other than normalisation: 019's stored clause is a re-rendering of the same parse tree,
but this one evaluates differently from what any rendering says. The rule extends accordingly:
**a character-class or string-comparison constraint is proven against the live server with a
case-flipped probe, not just a shape probe** — `'ka'` and `'KA'`, not only `'KAR'` and `'KA '`.
The three-valued-logic section covers UNKNOWN; the parenthesisation section covers re-rendering;
this covers the collation the comparison inherits from a column it never mentions.


## A gate must not depend on services it does not start

The e2e-in-unit-gate defect (DECISIONS 29.1) is a special case of a wider rule:
**a test gate may not depend on a service — a database, a dev server, a browser
binary, a network peer — that the gate itself does not start or explicitly
require to be present.** A suite that silently needs Chromium, or silently needs
a server already listening, produces a count that is a property of the machine
and not of the tree, and a count that varies by machine is not a gate. A suite
that needs an external service names that requirement in its config header and
fails loudly, at a named point, when the service is absent — as
`vitest.integration.config.ts` does for MariaDB and `chromium.launch()` does for
a missing browser. What it may never do is appear inside a gate whose contract
says the dependency does not exist.
The same rule governs environment: **a gate must not depend on environment it
does not set.** A suite whose values survive by `??=` inherits whatever the
shell has exported, and the shell is not part of the tree.

The rule extends to a gate with a real external dependency: **a gate
depending on a real source must name that dependency when it is unmet** —
the required keys, where the gate looked for them, and the fix. An
integration suite that dies in a connection timeout when .env is absent
reports a wrong subject; the failure has to name DB_HOST…DB_NAME and the
searched paths before any connection is attempted (the integration
setup does, proven by moving .env aside and reading the error).
 The instance:
the machine exported `PORT=0`, which beat the schema default and failed five
suites at import with "Number must be greater than or equal to 1" (DECISIONS
29.2). Test setup files now FORCE every value a run requires — the suite
passes with nothing handed to it, and a hostile exported variable cannot
reach a test. A count produced under inherited environment was a property of
the machine, not of the tree: every count reported before this fix was
machine-dependent in exactly that sense.


## A sweep must state its scope and prove the scope covers the claim

Four instances of one mistake:

- the gate-collection disk enumeration listed four fixed directories, so a
  new subdirectory under tests/ was invisible to the union-coverage claim
  (29.3b) — found only because a probe was planted where no include
  reached;
- the §20.3 citation sweep grepped tests/ only and missed
  queries.ts:1020, a rule citation sitting in src/ where the next reader
  would act on it;
- the early CHECK migration grep saw one of the thirteen CHECKs the
  schema actually carries, and reported a clean sweep;
- the 29.7 source-type sweep was accused of the same shape (it was not —
  §18.8 had accurately deferred the writer — but the accusation was only
  dismissible by tracing approveContractorBill end to end, which is the
  proof the sweep itself should have attached).

The rule: **before reporting a sweep clean, write down what the search
covered, and show that the coverage matches the claim.** "Every CHECK in
the schema" is claimed by information_schema, not by grep over
migrations/. "Every citation in the codebase" covers src/ and tests/, not
tests/ alone. "Every test file on disk" is a recursive walk, not a
directory list. A scope narrower than the claim is a clean report about
the wrong subject — the same empty-green as a gate that executes
nothing, wearing a survey's clothes.


## OR widens the audience

A permission check that ORs two permissions admits the union of their
audiences, so the weaker arm decides who gets in. Writing
`perms: [MONEY_PERMISSION, COMMON_PERMISSION]` hands the money figure to
every COMMON_PERMISSION holder. The founding instance: the
`receivables_ageing` dashboard widget listed
`finance.invoice_manage OR finance.view_company_pnl`, and project_manager
holds invoice_manage — so company-wide receivables rendered on a project
manager’s dashboard (DECISIONS 29.12). Rule: a company-scale money figure
is gated by its money permission ALONE; where a screen serves two
audiences, gate the money cell inside the route with the single stronger
permission (the canValue/canRates/canPay pattern) rather than widening the
entry check. The sweep’s full enumeration and the pinning test are in
DECISIONS 29.14 and tests/unit/or-audience.test.ts.
