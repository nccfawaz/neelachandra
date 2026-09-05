# Decisions

Binding record of every choice made where `NCC_BUILD_SPEC.md` was silent, was in
tension with itself, or was overridden by an instruction. Written because the
spec is the authority and a prompt is not: where the two disagree the conflict is
recorded here and escalated, not resolved silently.

- **Status:** provisional. Every entry in section 2 is revisited when §8.11 lands.
- **Last verified:** 2026-09-03, from real runs on the machine described in §7.
  Section 6 is the 2026-09-02 record and is left as written; section 10 is the
  2026-09-03 record and supersedes it where the two differ.
- **Precedence rule in force:** the more specific spec section governs the more
  general one. §6's per-module tables beat the §6 preamble; the §6 preamble beats
  §2's stack narrative — except where §2 names a platform constraint §6 assumes
  away, in which case the constraint wins because it is a fact about Hostinger
  rather than a preference. Section 4 records each application of this rule.

---

## 1. What is settled

| # | Decision | Where it came from |
|---|---|---|
| 1 | Node 22 LTS, Hono 4, `@hono/node-server`, `hono/jsx` server-rendered public site, htmx 2 + Alpine 3 dashboard | §2.1–2.3 |
| 2 | MariaDB via `mysql2/promise` (`connectionLimit: 5`) + Kysely 0.27; hand-written SQL in `migrations/NNN_name.sql` applied by `scripts/migrate.mjs` tracking `schema_migrations` | §2.4 |
| 3 | Permissions checked at the route, never roles; `user_permission_overrides` for exceptions; row-level project scoping via `requireProjectAccess` | §4.1, §4.4 |
| 4 | Sessions in MySQL, not memory, because Hostinger stops the idle process | §2.5 |
| 5 | Projects is the hub. §5 dependency order is followed: inventory → crm → hr → finance → marketing | §5 |
| 6 | The five stub modules replicate the projects module shape (`queries.ts` / `schemas.ts` / `service.ts` / `routes.tsx`) exactly. Not redesigned. | instruction |

---

## 2. Provisional decisions

Each is a choice made to keep building while an §8 question is open. Each names
the trigger that would reopen it. None is load-bearing on data that exists yet.

### 2.1 Collation: `utf8mb4_unicode_ci`

All 110 tables on disk use `utf8mb4_unicode_ci`. The §6 preamble names
`utf8mb4_0900_ai_ci`, which is a MySQL 8 collation MariaDB does not implement, and
§1.9 confirms Hostinger runs MariaDB on this plan. A migration using it would
fail on the target server, so §2.4 governs. `migrations/001_core_auth.sql` already
records this reconciliation in its header.

**Reopens if:** §8.11 confirms the plan is MySQL 8 rather than MariaDB. Cost of the
change then: one `ALTER` per table, or a re-run against an empty database.

### 2.2 Money: `BIGINT` paise, columns suffixed `_paise`

§2.4 says `DECIMAL(14,2)` for all money. The §6 preamble says `BIGINT` in paise with
a `_paise` suffix, and gives the reason: `DECIMAL` drifts through Node's JSON layer,
and INR at construction scale only exceeds `Number.MAX_SAFE_INTEGER` above roughly
90,000 crore. §6 governs. On disk: 87 `_paise` columns, zero `DECIMAL(14,2)`.

Quantities stay `DECIMAL(14,3)` per the §6 preamble — 27 columns — because cement is
in bags, steel in tonnes to three decimals, sand in cubic metres. Rates are `BIGINT`
paise per unit. `src/lib/money.ts` owns all parsing, Indian digit grouping and GST
arithmetic; no route handler divides.

**Reopens if:** never, on current information. This is the one conflict where the
direction of precedence is opposite to §2.1, so both are recorded explicitly to
stop a future reader inferring a general "§2.4 always wins" or "§6 always wins" rule.

### 2.3 Migration numbering follows what is on disk, which is not §6

Three numbering schemes exist in the source material and none of them agree:

| Scheme | 005 | 006 | 007 | 008 | 009 |
|---|---|---|---|---|---|
| §3 folder tree | — | finance | hr | marketing | seed_reference_data |
| §6 section order | inventory | marketing | hr | crm | finance |
| **on disk** | **inventory** | **hr** | **marketing** | **crm** | **finance** |

Disk is authoritative because `schema_migrations` records applied filenames: renaming
an applied migration makes the tracking table disagree with the directory and the
next `migrate.mjs` run re-applies it. The files self-identify correctly in their
headers (`006_hr.sql` says "Spec 6.6", `007_marketing.sql` says "Spec 6.5"), so the
mapping is unambiguous even though the numbers are not in §6's order.

There is also no `009_seed_reference_data.sql`; reference seeding lives in
`003_reference.sql`, and §3's tree lists a `002_public_content.sql` that does not
exist. **Flagged, not resolved.**

**Reopens if:** the owner wants disk renumbered to match §3 or §6. That is safe only
before the first production migrate. It has not been run anywhere yet, so the window
is open now and closes at first deploy.

### 2.4 §8.7 assumed answered "yes": idempotency keys from the first route

§8.7 (offline capability for site staff) is marked blocking for phase 3 and is
unanswered. Assumed yes, because retrofitting idempotency onto write routes after
they exist means revisiting every handler and every htmx form, whereas carrying an
unused `Idempotency-Key` costs one nullable column and one uniqueness check.

**Reopens if:** §8.7 comes back "no". The keys then become dead weight, not a defect.

### 2.5 RBAC seed: 8 roles, 60 permissions, 204 grants, provisional

Seeded from the §4.3 matrix as written. Verified internally consistent by
`scripts/audit-rbac-seed.mjs` (see §6.2 below). Provisional because §8.1 — the actual
org chart — is unanswered, so the roles are the spec's model of the business rather
than the business.

**Reopens if:** §8.1 lands. Expect role renames and possibly a ninth role; the grant
blocks join on `permissions.key`, not on ids, so re-seeding is cheap.

### 2.6 Corrections are applied on the way out, never written into golden

`legacy/golden/` is the audit record of what the old site actually served and stays
byte-identical to it forever. Owner-approved corrections live in
`scripts/lib/corrections.mjs` as reviewable transforms that `build-site.mjs` applies
when assembling the deployable root, and that `parity-check.mjs` applies to the
golden side before comparing. Consequence, stated plainly: the freeze is enforced
against **golden + corrections**, not raw golden. Anything differing from that
baseline is something nobody approved.

**Reopens if:** §8.12 defines the freeze scope differently. See section 4.4.

### 2.7 Stock valuation: weighted average, with the cache as one writer

§6.4 rule 1 fixes the shape — `stock_ledger` append-only, `item_stock` a rebuildable
cache — but names no costing method. Weighted average cost was chosen over FIFO:

- Cement, steel and aggregate are fungible. FIFO layers would model a distinction the
  storekeeper cannot make when the lorry tips a heap onto an existing one.
- WAC is one row per `(item_id, location_id)`, so an issue is a single locked read.
  FIFO needs open layers per receipt, and an issue that spans four of them is four
  writes and a partial-consumption rule for each.
- A layer table is a second thing that can drift from the ledger. The point of the
  one-writer rule is to have exactly one.

Consequences, stated so they are not discovered later: an issue is valued at the
average, never at what that specific batch cost; batch numbers are tracked for
traceability and expiry, not for costing; and a stock-out drives the balance to zero
by taking the whole remaining value rather than leaving a rounding tail
(`postStockMovement`, out-movement branch).

**Reading the ledger without being misled.** The first consequence above is the one
that looks like a bug to anyone who does not know the rule, so it is worth spelling
out. Three issue lines naming three different batches will show the same
`rate_paise` — 39677 against BATCH-A, BATCH-B and BATCH-C is the rule working, not a
data fault. A batch-named row carries the store's weighted average at the moment of
issue. It does not carry that batch's cost.

Batch cost is not lost, it is just somewhere else:

| Want | Read |
| --- | --- |
| What a batch was received at | `grn_lines.rate_paise` |
| What an issue was valued at | `issue_lines.rate_paise`, `stock_ledger.rate_paise` |
| Current average at a store | `item_stock.value_paise / item_stock.qty_on_hand` |

Joining `stock_ledger.batch_no` to `grn_lines.batch_no` recovers the receipt rate, so
recomputing batch-level or FIFO cost from history stays possible.

`migrations/010_costing_comments.sql` carries the same statement as `COMMENT` text on
each of those columns, so `SHOW FULL COLUMNS` answers the question at the point
someone is most likely to ask it. It is a comments-only migration: 005 has already run
on live databases and the runner checksums applied files, so annotating 005 in place
would break the next `migrate` rather than document anything.

Structural enforcement, since the rule is only as good as what stops a second writer:
`postStockMovement` in `src/modules/inventory/service.ts` is the only function that
touches `item_stock`, it takes `SELECT ... FOR UPDATE` on the cache row, and
`scripts/reconcile-stock.mjs` replays the ledger independently and fails if the cache
disagrees. That script deliberately has no `--fix` — a repair flag in the one script
whose job is to prove the single-writer rule would falsify it.

**Reopens if:** the owner needs batch-level costing for a claim or a dispute. The
ledger keeps `batch_no` on every row, so the history to compute it is not lost.

### 2.8 Blank percentage cells fall back; explicit zero does not

A defect found by `tests/inventory-schemas.test.ts` and fixed in
`src/modules/inventory/schemas.ts`: `pctAt()` read a purchase-order GST cell with
`Number(raw)`, and `Number('')` is `0` — finite, and inside the accepted 0..100 range.
An untouched GST cell therefore booked the line at **0 percent** rather than the
documented 18, and a purchase order with no tax on it reads as a cheap quote rather
than as a bug. The empty string is now tested before the conversion. An explicit `'0'`
still means zero, which nil-rated items need.

Recorded because the same `Number('')` shape is available in every other numeric
field, and the next module's schemas should be read with it in mind.

---

## 3. Fences

Preserved verbatim. These are not summarised, softened, or re-derived.

> Do not deploy, cut over, or run §7.6 step 5. public_html is not archived.

> Do not create rows for real named staff. §8.1 unanswered.

> TOLERANCE stays 0 on the parity gate. No new masks or exclusions.

Observed consequences:

- Nothing in this repository has been deployed. `build-site.mjs` writes to the local
  web root only.
- `scripts/seed-users.mjs` is only ever run with `--owner`, and only against a local
  database. No employee, staff or contact row names a real person.
- `parity-check.mjs` still reads `TOLERANCE` from `--tolerance=` with a default of 0
  and prints the value used in every report, so a relaxed run cannot be mistaken for
  a strict one. No run has used a non-zero value.
- The `assetRefs()` change in section 5.1 **widens** what the gate inspects. It adds
  no mask and no exclusion, so it is consistent with the third fence.

---

## 4. Spec conflicts found

Flagged for a decision, with the working resolution stated so building can continue.
Nothing here has been quietly settled.

### 4.1 Collation
§2.4 `utf8mb4_unicode_ci` vs §6 preamble `utf8mb4_0900_ai_ci`. Resolved toward §2.4
because MariaDB cannot execute the §6 value. Detail in section 2.1.

### 4.2 Money representation
§2.4 `DECIMAL(14,2)` vs §6 preamble `BIGINT` paise. Resolved toward §6, which is the
opposite direction to 4.1. Detail in section 2.2.

### 4.3 Migration numbering
§3's folder tree, §6's section order and the files on disk are three different
schemes. Detail in section 2.3.

### 4.4 Freeze scope vs the corrections layer
§3.2 and §8.5 describe a strict freeze in which public content is preserved and not
fixed — §8.5 is titled "Public content risks I am preserving, not fixing".
`corrections.mjs` now changes **visible copy**: the invented 4.8 rating is rewritten
to a verified 4.0 in prose and in two stat cards across four pages, and a `/login`
nav item is added to all ten pages. Both were owner-approved (CQ-1), and leaving a
false rating claim on screen while correcting only its JSON-LD would have made every
page contradict its own structured data.

This is a real narrowing of §8.5 and it is the owner's call, not the toolchain's.
Recorded so the gate's baseline is never mistaken for the untouched legacy site.

### 4.5 §3.2 axis 7 enumerates too few asset sources
§3.2 point 7 defines the asset axis as "the full asset reference set from `img`,
`source`, `link` and `script`". That enumeration is incomplete: it misses CSS
`url()` and `<meta content>`, and four real assets escaped the archive through those
two gaps (section 5.1). The gate has been widened past the literal wording of §3.2
because the sentence's intent — "the full asset reference set" — is not satisfied by
its own list. **Flagged as an intentional deviation from the letter of §3.2.**

### 4.6 `engines.node` is `22.x`; this machine runs Node 24
`package.json` pins `22.x` per §2.1. Everything verified in section 6 ran on
v24.19.0. Nothing observed depends on the difference, but no result in this file is
evidence about Node 22 behaviour.

### 4.7 The §6.4 route table's read permissions are narrower than the sidebar's
The spec guards `/app/inventory/items` with `inventory.item_manage` and
`/app/inventory/po` with `inventory.po_create`. Both are **write** keys, and gating a
list page on them means a storekeeper with `inventory.view` cannot see the item master
they issue against. Resolved as `requirePermission` is OR-shaped: the list and detail
pages take `inventory.view` **or** the write key; `new`, `edit` and every POST take the
write key alone. `src/dashboard/nav.ts` shows both entries to `inventory.view`, which
is now true rather than a dead link. **Flagged, not silently resolved:** if the intent
was that the item master is confidential, the fix is the opposite one and the nav
entries come out.

### 4.8 No equipment-write permission key exists
§6.4 gives equipment deploy and return their own routes, and the RBAC seed (§2.5) has
no `inventory.equipment_*` key of any kind. Deploy and return therefore take
`inventory.transfer`, on the reasoning that moving a mixer between sites is the same
authority as moving cement between them. **Flagged:** if equipment needs its own key,
it is a seed change plus one line per route, not a redesign.

### 4.9 §6.4 line 1353 names files the projects module does not use
The spec asks for `src/modules/inventory/pages/*.tsx` and named components
`ItemPicker`, `LineItemGrid`, `StockBadge`, `VarianceBar`, `BatchSelector`. The
projects module — the pattern the work order says to replicate and not redesign —
keeps its JSX inline in `routes.tsx` and has no `pages/` directory. The work order's
"do not redesign the pattern" was taken to win over the spec's file layout, since two
different layouts across five modules is worse than either one consistently.
**Flagged:** this is the one place a prompt instruction was allowed to outrank the
spec, and it was a layout question, not a behaviour one.

### 4.10 `items.tracking_mode` in §6.4 vs `is_batch_tracked` on disk
§6.4 specifies `items.tracking_mode ENUM('quantity','batch','serial')`. The migration
and the generated types have `is_batch_tracked TINYINT(1)`, which cannot express
serial tracking at all. The code follows the migration, per §2.3. **Consequence:**
serial-numbered assets have no representation in the item master; equipment is tracked
in its own table, which covers the cases named in the spec's own examples. A migration
widening the column is a schema decision and was not made unasked.

### 4.11 §6.4 has a purchase-order approve route and no reject route
The route table lists approve; there is no reject, and no `rejectPo` in the service.
The approval screen is therefore approve-only, and the way to stop an order that
should not proceed is short-close with a reason (`poShortCloseSchema`, minimum ten
characters). **Flagged** because an approver who wants to send a PO back to the raiser
has no way to do it, and that is a workflow the owner may expect.

### 4.12 §6.7's CRM route table is narrower than the module needs to work
Eight route-level departures, all recorded in the header comment of
`src/modules/crm/routes.tsx` and repeated here because they are spec conflicts, not
style:

1. **Quote reads take either quote key.** Same shape as 4.7: `crm.quote_create` **or**
   `crm.quote_approve` opens `/app/crm/quotes`, because `nav.ts` shows that link to
   both and an approver who could not open the list would be looking at a link that
   403s. Every write keeps its own narrow key.
2. **PATCH is registered alongside POST** on stage and assign. An HTML form submits GET
   or POST only, and `requiresCsrf()` covers every method that is not GET, HEAD or
   OPTIONS, so the documented verb still works for an API client and is still
   token-checked.
3. **Writes redirect instead of returning JSON.** `errorHandler.wantsJson()` answers
   any `/api/` path with JSON and §6.7 puts every write under `/api/`, while the only
   client posting to them is a form in this file. Rule 3's site-visit refusal would
   otherwise reach a sales executive as a JSON body in a blank tab. The `guard` helper
   turns an `AppError` into a flash and rethrows everything else. The same latent
   problem exists in inventory's `/api/po/...` handlers and is reported, not changed.
4. **Routes added that the table omits:** `GET /app/crm/leads/new` (already linked from
   admin/routes.tsx with `?enquiry=`), lead edit GET and POST, `GET
   /app/crm/quotes/new`, `GET /app/crm/quotes/:id/revise`, `POST
   /api/crm/site-visits/:id/status`, `POST /api/crm/quotes/:id/accept` and `/reject`,
   `POST /api/crm/leads/:id/probability`, and `GET /app/crm/reports/losses`. The accept
   route is not optional: rule 6 refuses to convert a lead without an accepted quote,
   so without it conversion is unreachable. Declining a discount is **not** a new
   route — `/approve` reads the shared `ApprovalBar`'s `decision` field, so approve and
   decline are one endpoint and one permission, which is what the single row says.
5. **`convertSchema` is wider than `convertLeadToProject` accepts** — see 4.13.
6. **No htmx in the module.** §6.7 drags board cards and recalculates quote totals over
   htmx. htmx and Alpine are loaded by the shell, so both are available; no module uses
   them yet and inventory built its line grids as plain forms. The board gives each
   card one "advance" button, the accessible equivalent of dragging it one column
   right. A live total would be a second implementation of `computeQuoteTotals` in the
   browser, and two copies of a price calculation is how a client is shown a figure the
   database will not agree with.
7. **NextActionBar's client-side guard is a server-side warning.** "Will not let the
   page be left without a next action set" needs client code; the lead detail shows a
   warning instead when the stage is past contacted and no next action is set.
8. **No `pages/` directory**, per 4.9.

### 4.13 §6.7's conversion form retypes what rule 6 says must not be retyped
The spec's `convertSchema` accepts a project name, type, address, contract value, rate,
area and delivery model. `convertLeadToProject` accepts `{ plannedStart,
contractSignedOn }` and derives every other field from the lead and the accepted quote,
which is rule 6's own "nothing is retyped". The two cannot both be right. The service
wins: the conversion form posts the two dates through a narrower
`convertOverridesSchema`, and `convertSchema` is left in place untouched in case
another caller is intended for it. **Flagged rather than resolved** — the alternative
fix is to widen the service, and that would let a converting user type a contract value
that disagrees with the quote the client signed.

### 4.14 Rule 1 names the scoring signals and none of the weights
`computeLeadScore` apportions 100 points across the six signals rule 1 names: plot
ownership 25, funding 20, sanctioned plan 15, expected start 15, budget fit 15, served
area 10. The direction is the spec's ("clear title highest, not-yet-purchased near
zero"); the numbers are mine. Ownership and funding carry most because they are the two
that stop a job dead, and the served-area check carries least because it is a logistics
cost rather than a reason the sale fails. `tests/crm-score.test.ts` pins all six and
asserts the maxima sum to 100, so a weight cannot drift without a failing test.
**Flagged:** these weights decide every lead's temperature, and they are a judgement
call the owner may want to set differently.

### 4.15 `crm.first_response_target_hours` was a setting with no reader
The seed writes it; nothing in the tree read it. `firstResponseBreaches(db, targetHours,
scope)` takes it as an argument, and before the funnel report existed nobody passed it.
`/app/crm/reports/funnel` now reads it through `getSetting` with a fallback of 4.
**Also noted:** the followup cron does not read it either, so a breach is reported on
the funnel page and does not notify anybody. That is the spec's design — rule 9's cron
handles dormancy and followups, not response time — and is left as it stands.

### 4.16 `markQuoteViewed` is unreachable, so the `viewed` status never occurs
`quotes.status` has a `viewed` member and `service.ts` exports `markQuoteViewed` to set
it. Setting it needs a client-side read receipt or a tracked link, neither of which
exists: quotes go out as an email with a printable link behind the staff login. The
function has no caller, and every screen that switches on status treats `sent` and
`viewed` identically so that the dead member cannot strand a quote. **Flagged, not
deleted** — a public tokenised quote link is a plausible later feature and this is the
hook for it.

---

## 5. Deliberate deviations, with reasons

### 5.1 `assetRefs()` widened to CSS `url()`, inline `background-image` and social images

**Defect.** `assetRefs()` in `scripts/lib/normalise.mjs` scanned only four HTML
attributes. `scripts/capture-assets.mjs` imports that same function to decide what to
mirror permanently, so anything referenced by an unscanned mechanism was never even
requested from the live server — it appears in `assets-manifest.json` neither as a
success nor as a 404. `build-site.mjs` then copies the mirror to the web root, so the
assembled site was missing those files too.

**Scope, measured rather than assumed.** An exhaustive extraction of every
same-origin asset path from the ten golden pages by any mechanism found 72 distinct
references: 62 mirrored, 6 recorded upstream 404s, **4 invisible to the gate**.

| Missing asset | Referenced by | Live bytes |
|---|---|---|
| `/assets/images/about/hero.webp` | inline CSS `background-image` | 132,946 |
| `/assets/images/packages/hero.webp` | inline CSS `background-image` | 57,900 |
| `/assets/images/services/hero.webp` | inline CSS `background-image` | 95,100 |
| `/og.webp` | `<meta property="og:image">` / `twitter:image` | 1,091,756 |

The handoff described three hero WebPs. It is four files: `og.webp` escaped through a
second unscanned mechanism, `<meta content>`. That file is the one §7.5 item 6
requires to be carried across "at its current 1,091,756 bytes" and §3's tree marks
`UNCHANGED, byte-identical`, and the live size matches exactly.

**Severity was higher than an archival gap.** All four were also absent from the
deployed web root, so `/about-us`, `/construction-packages-in-bengaluru` and
`/construction-services-in-bengaluru` rendered with broken hero backgrounds, and
`og:image` 404'd on all ten pages.

**Not fixed, recorded instead:** `<img srcset>` is still unscanned (27 occurrences).
Every one duplicates its own `src`, so no asset is lost through it today. A future
`srcset` carrying a density variant not present in `src` would be missed.

### 5.2 Windows path resolution in four scripts

`capture-golden.mjs`, `parity-check.mjs` and `selftest-parity.mjs` built their root
path from `new URL('..', import.meta.url).pathname`, which on Windows yields
`/C:/...`; `join()` turns that into `\C:\...` and `fs` resolves it against the current
drive as `C:\C:\...`. All three threw `ENOENT` before reading anything, so **the §3.2
self-test had never executed on this machine**. Changed to `fileURLToPath`, which is
identical on POSIX. This is a portability fix, not a change to any assertion.

---

## 6. Verification record, 2026-09-02

Exact results from real runs. Nothing in this section is estimated, and nothing that
could not run is reported as a pass.

### 6.1 `tsc -p tsconfig.json --noEmit`
**0 errors, exit 0.** 60 `.ts`/`.tsx` files. Ran after `npm ci --ignore-scripts`
(117 packages from `package-lock.json`).

### 6.2 `npm run db:migrate`
**Did not run.** Exit 1:
`Missing environment variables: DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME`.
There is no MariaDB or MySQL server, client binary, Docker daemon or `.env` on this
machine, and nothing is listening on 3306. **No table, role, permission or grant
count in this file comes from an applied migration.**

What can be stated is a static parse of the SQL, which is a weaker claim:

| | count | source |
|---|---|---|
| tables (`CREATE TABLE`) | 110 | `grep` over `migrations/*.sql` |
| roles | 8 | `INSERT INTO roles` in `002_rbac.sql` |
| permissions | 60 | `INSERT INTO permissions` in `002_rbac.sql` |
| role→permission grants | 204 | 8 `INSERT ... SELECT` blocks |

Per-migration tables: 001 core_auth 8, 002 rbac 6, 003 reference 9, 004 projects 14,
005 inventory 22, 006 hr 18, 007 marketing 15, 008 crm 7, 009 finance 11.
Permissions by module: auth 4, admin 5, projects 9, inventory 10, marketing 5, hr 10,
crm 8, finance 9. Grants per role: owner 60, admin 14, ops_manager 43,
project_manager 28, site_supervisor 10, accounts_manager 26, hr_manager 12,
sales_exec 11.

`scripts/audit-rbac-seed.mjs` was written for this. The grant blocks are
`INSERT ... SELECT ... JOIN permissions ON p.key IN (...)`, deliberately independent
of `AUTO_INCREMENT` values but with one silent failure mode: a mistyped key matches no
row, grants nothing, and MySQL still reports success. The audit cross-checks every
key against the `permissions` insert and against the per-role counts claimed in the
file's own comment. Result: **0 unknown keys, 0 duplicates, all 8 per-role counts
match, total 204 matches the claimed 204.** One permission is owner-only:
`crm.quote_discount_override`.

This proves the seed is internally consistent. It does not prove the migrations apply.

### 6.3 `npm test`
**Exit 1: "No test files found."** The repository contains zero test files —
`tests/` holds only `parity-out/report.json`. `vitest` is configured and installed;
there is nothing for it to run. This is a genuine fail, not an environment limit.

**Superseded 2026-09-03 — see section 10.2.** Five test files now exist and the suite
passes. The entry above stands as the record of what was true on 2026-09-02.

### 6.4 `npm run test:htaccess`
**Exit 1 at the first request: `TypeError: fetch failed`, `ECONNREFUSED`** against
`http://localhost:8081`. The script asserts real Apache behaviour — 29 assertion
sites, sending `X-Forwarded-Proto: https` because Hostinger terminates TLS upstream.
No Apache or httpd binary exists on this machine. **0 of 29 assertions executed.**
Writing a stand-in interpreter for the rewrite rules would be a green by
substitution, so it was not done.

### 6.5 `npm run parity:selftest`
**16 of 16 mutations pass, exit 0** — but only after the fix in section 5.2; it threw
`ENOENT` before that. A coverage gap was found while reading the output and is now
closed (section 5.1): the `image renamed` mutation was caught by the JSON-LD value
axis and scored **0 on the asset axis**, meaning `assetRefs()` had no mutation
actually exercising it.

### 6.6 `npm run parity` (the full §3.2 gate)
**Cannot run here.** It needs a candidate origin serving the site over HTTP, and the
pixel axis needs Playwright browser binaries (installed with `--ignore-scripts`, so
absent). The HTML axes would run against a local server; no server has been started.

---

## 7. Environment, and what it cannot prove

| | |
|---|---|
| OS | Windows 11 Pro 10.0.26200 |
| Node | v24.19.0 (`engines.node` pins `22.x`) |
| npm | 11.17.0 |
| `node_modules` | installed 2026-09-02, `npm ci --ignore-scripts`, 117 packages |
| database | none |
| Apache | none |
| Playwright browsers | not downloaded (`--ignore-scripts`) |
| git | **not a repository** — see 8.2 |

Runnable here: `typecheck`, `parity:selftest`, `capture:assets`, `capture:golden`,
`build:site`, `build:site:check`, `audit-rbac-seed`, and the HTML axes of `parity`
given a candidate origin.

Not runnable here: `db:migrate`, `db:types`, `seed:owner`, `test:htaccess`, `test:e2e`,
the pixel axis of `parity`, and `test` (which has nothing to run in any environment).

---

## 8. Repository facts that contradict the handoff

Recorded because the handoff was used as the basis for the work order, and four of its
premises do not hold on disk.

### 8.1 `CLAUDE.md` does not exist
The agent-instructions document was supplied inline in a prompt. There is no
`CLAUDE.md`, `AGENTS.md` or equivalent anywhere in the tree, so the instructions are
not versioned with the code and the next agent will not receive them. This file is now
the durable record of the parts that constrain the build; the instructions document
itself should be committed if it is meant to bind.

### 8.2 This is not a git repository
`git rev-parse` fails: `fatal: not a git repository`, and there is no `.git` directory
in the tree or in any parent. Consequences:

- The handoff's "commit ccf2828" cannot be verified and does not exist locally.
- **"Commit per module" cannot be honoured as asked.** `git init` would create a repo
  whose first commit contains the entire history-free tree, which is a different thing
  from committing per module onto an existing line of history, and it would need a
  decision about `.gitignore` scope, whether `legacy/golden/` is tracked, and what the
  initial commit represents. Initialising a repository and rewriting the project's
  version-control history is not a call the toolchain should make unasked, so it was
  not done. **Escalated.**
- `.gitignore` and `.gitattributes` exist and are configured, which suggests the tree
  was exported from a repository rather than never having been in one.

**Resolved 2026-09-02, after escalation.** The owner supplied the repository:
`https://github.com/nccfawaz/neelachandra`, branch `main`, cloned to
`C:\Users\HP\Downloads\ncc`. That clone is where commits happen; the working tree at
`C:\Users\HP\Downloads\neelachandra-main\neelachandra-main` is still not a repository
and files are copied across before each commit. `git remote -v` is checked before every
push, on standing instruction, and no remote has been added or changed by the
toolchain. "Commit per module" is now honoured as asked.

### 8.3 There are no tests
The handoff implies a working test suite. There are zero test files. `npm test` has
never passed, because it has never had anything to run. Any statement of the form
"tests pass" about this repository has been false.

**Closed 2026-09-03.** Five files, 148 tests, exit 0 (section 10.2). The sentence above
was true when written and is the reason no earlier claim of a green suite should be
believed. What is still true: nothing in the suite touches a database, so it is
evidence about pure functions and form contracts only.

### 8.4 Two `package.json` scripts point at files that do not exist
`seed:reference` → `scripts/seed-reference.mjs` and `reconcile:stock` →
`scripts/reconcile-stock.mjs`. Both are absent. `reconcile:stock` is the §6.4 stock
reconciliation job; `seed:reference` overlaps `003_reference.sql`, which already seeds
units, cost heads, locations, departments, designations, leave types, lead sources,
item categories, brands and accounting periods. Left alone: deleting the scripts or
writing the files are both decisions beyond the current work order.

**Half closed 2026-09-03.** `scripts/reconcile-stock.mjs` now exists and is written
(section 10.4); it parses, and its replay logic has never run against data because
there is no database here. `seed:reference` is still a script entry pointing at
nothing. It stays that way rather than being deleted: `003_reference.sql` already
covers the reference data, so the likely correct fix is removing the script line, and
that is a `package.json` change nobody asked for.

---

## 9. Open questions blocking work

| § | Question | Blocks | Effect now |
|---|---|---|---|
| 8.1 | Actual org chart and roles | phase 2 | roles are provisional (2.5); no real staff rows exist; two specific grants now need a ruling, see 9.1 |
| 8.2 | Approval limits | phase 7 | finance approval thresholds unseeded |
| 8.3 | Stage templates and payment milestones | phase 3 | `stage_templates` seeded from the spec's example only |
| 8.4 | Material consumption norms | phase 4 rule 4 | consumption variance cannot be computed |
| 8.7 | Offline capability | phase 3 | assumed yes (2.4) |
| 8.11 | Hosting plan specifics | phase 0 | MariaDB assumed; collation depends on it (2.1) |
| 8.12 | Freeze scope, and the sign-off owner | phase 1, 9 | no named owner to sign off a gate failure (4.4) |

### 9.1 §8.1, two grants that need the owner's ruling

Added 2026-09-04, from building §6.6. Both are tensions **inside the spec** — the §4.3
permission matrix against the §6.6 route table — not defects in
`migrations/002_rbac.sql`. The seed reproduces the matrix exactly in both cases, and
**the seed is left as it is.**

**1. `accounts_manager` has `hr.payroll_view` and no `hr.employee_view`.**
§4.3 line 613 gives that role `hr.payroll_view` (R); line 608 withholds
`hr.employee_view` from it. `002_rbac.sql:274` matches. But every §6.6 route that
renders a pay figure hangs off `/app/hr/employees/:id`, which requires
`hr.employee_view` (spec line 1718), so the role the matrix trusts with payroll has no
screen on which to use it. There is a reading in which this is deliberate: §6.8 rule 10
(line 2155) routes staff cost to that role in aggregate, as `accrued_staff_cost` inside
`getProjectMargin`, "visible only to `owner` and `accounts_manager`". *Question: should
`accounts_manager` reach an individual employee's pay history at all, or only the
aggregate through finance?*

**2. The attendance grid is gated on a permission the two roles that record attendance
do not hold.** §4.3 line 610 gives `hr.attendance_record` to `project_manager` and
`site_supervisor` (W+S) and line 608 gives neither of them `hr.employee_view`; spec line
1723 gates `GET /app/hr/attendance` on `hr.employee_view`. `002_rbac.sql:244` and `:260`
match the matrix. So the two roles whose job is entering the day's attendance cannot open
the grid it is entered on; only `ops_manager` and `hr_manager` hold both keys. *Question:
does a site supervisor see the month grid for their own site, or only a single-day entry
form for it?*

Neither is resolved here. Granting a role a key the matrix withholds is the quiet
resolution section 4 exists to prevent, and both fixes are one line whenever the answer
arrives — widen the route guard, or add the grant to 002's successor. What ships instead
is 14.4 and 14.5: the pay figures simply stay unreachable for `accounts_manager`, and the
dashboard withholds the attendance link from anyone who would receive a 403 on it rather
than offering it and then refusing.

**Blocks:** attendance and payroll closing on real roles. Neither blocks *building* them
— `hr_manager` and `ops_manager` hold both keys, and the integration tests exercise
permissions as sets rather than through a seeded role.

---

## 10. Verification record, 2026-09-03 — inventory module

Every number below is from a run in this environment on this date. Nothing is
inferred from a previous run, and where a gate cannot run here it says so instead of
reporting a substitute.

### 10.1 `npx tsc --noEmit -p tsconfig.json`
**Exit 0, zero errors.** Note what this does *not* cover: `tsconfig.json` has
`exclude: ["tests", "scripts", ...]`, so no test file and no `.mjs` script is
typechecked by this gate. Three errors were found and fixed on the way to this
result — two `<Alert tone="info">` uses against a component whose tone union is
`'error' | 'ok' | 'warn'`, and `openingStockSchema.rate` yielding `number | null`
into a `postOpeningStock(ratePaise: number)` parameter.

### 10.2 `npm test`
**Exit 0. 5 files, 148 tests, 148 passed, 0 failed**, 1.02s.

| File | Tests | Covers |
|---|---|---|
| `tests/money.test.ts` | 22 | `roundPaise` half-away-from-zero, `rupeesToPaise` exact for every two-decimal input 0..2000 paise, Indian grouping, the CGST/SGST remainder paisa, `computeVoucher` TDS on taxable not gross |
| `tests/dates.test.ts` | 24 | the +05:30 conversion, midnight as `00` not `24`, `addMonths` clamping, the financial-year boundary and its round trip |
| `tests/inventory-schemas.test.ts` | 34 | both `parseBody({ all: true })` shapes, rupees→paise exactly once, blank rows skipped, `Line N:` messages, the GST fallback of section 2.8 |
| `tests/nav.test.ts` | 47 | `visibleNav` OR semantics and empty-group dropping, `activeHref` longest-prefix, and one generated test per sidebar item asserting its href is a registered route path |
| `tests/csrf.test.ts` | 21 | `verifyToken` throwing on every wrong input rather than returning false, `extractToken` field-then-header order, `constantTimeEquals` not throwing on unequal lengths |

Three of my own assertions were wrong before this was green, and in all three cases the
code was right: `rupeesToPaise(1.005)` is 100 because `1.005 * 100` is
`100.49999999999999`; `formatPaiseCompact` needs paise not rupees for a 1.24 Cr figure;
`18:30Z` is `00:00` IST, not `00:30`. The float case was rewritten as a documented
boundary plus the exhaustive two-decimal loop.

**What the suite is not.** No test opens a database. `tests/setup-env.ts` fills the
environment variables `src/env.ts` validates at import — with obvious fakes, using
`??=` so a developer's real `.env` wins — and no pool is ever created. A suite that
reached the ledger through a mocked Kysely would assert that Kysely composes strings,
not that stock balances, so it was not written. `vitest.config.ts` is separate from
`vite.config.ts` because that file exists only to minify the dashboard stylesheet and
its build settings mean nothing to a test run.

### 10.3 The two audit scripts
- `node scripts/selftest-parity.mjs` → **20 of 20 mutations caught, exit 0.**
- `node scripts/audit-rbac-seed.mjs` → **exit 0, 204 of 204 grants** verified, one
  owner-only permission (`crm.quote_discount_override`).

### 10.4 `scripts/reconcile-stock.mjs` — written, never executed against data
`node --check` passes. Running it stops at
`Missing environment variables: DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME`,
which is the correct behaviour and also the whole limit: **its replay logic has never
processed a single ledger row.** It checks six things per `(item_id, location_id)`,
replaying `stock_ledger` in `id` order with arithmetic copied line-for-line from
`postStockMovement`: each row's `balance_after`, each row's `value_paise`, that an
out-movement's `rate_paise` equals the weighted average at that moment,
`item_stock.qty_on_hand` and `value_paise`, that `last_txn_id` is the newest ledger id,
and cache rows with no ledger behind them. `QTY_EPSILON = 0.0005`, half of the
`DECIMAL(14,3)` resolution. The duplicated arithmetic is the point: two independent
implementations disagreeing is the signal.

### 10.5 Still not runnable here
`db:migrate`, `db:types`, `seed:owner`, `reconcile:stock`, `test:htaccess` (no Apache),
`test:e2e` and the pixel axis of `parity` (no Playwright binaries), and the full
`parity` gate (no candidate origin). Section 7's table is unchanged. **No line of the
inventory module has been executed against a database.**

### 10.6 CI does not exist
`.github/workflows` is absent, so `tsc --noEmit` and the suite are green because they
were run by hand here and reported above, not because anything enforces them on push.
Outstanding.

**Superseded 2026-09-04 by `1542b67`.** `.github/workflows/ci.yml` now runs `tsc --noEmit`,
the unit suite and the DB integration suite on push, the last against a MariaDB service
container that the workflow migrates first. The gate is enforced. What 10.5 says about
this workstation is unchanged.

## 11. Verification record, 2026-09-04 — CRM module

### 11.1 What was executed against a real database
The whole module, for the first time. `tests/integration/crm-flow.test.ts` drives the sale
end to end against the local MariaDB 11.4.4 — lead, activity, stage moves, site visit,
quote, submit, approve, send, accept, conversion, and the losing paths — then re-reads
every screen query. **42 integration tests pass** (36 CRM + 6 db-smoke), alongside 188 unit
tests and a clean `tsc --noEmit`.

This is the difference section 10.5 was describing. The unit suite was green on the CRM
module before any of it had touched SQL, and it stayed green through four real defects.

### 11.2 mysql2 hands back MariaDB JSON columns already parsed
The finding worth carrying into every remaining module. `quotes.payment_schedule_json` is
declared `longtext` and written with `JSON.stringify`, and `src/db/types.ts` types it
`Generated<string | null>` — but the driver returns a live JS `Array`. Verified by reading
the column back through Kysely in the integration test, which now asserts it.

`JSON.parse` on that value stringifies it to `"[object Object]"` and throws, and every
reader here catches its own `SyntaxError` and returns empty. The two CRM readers did:

- `parsePaymentSchedule` (`src/modules/crm/service.ts`) returned `[]`, so
  `convertLeadToProject` refused **every** conversion with "has no payment schedule". Rule 6
  was unreachable. Fixed.
- `readSchedule` (`src/modules/crm/routes.tsx`) returned `[]`, so the printed quote showed no
  payment terms and revising a quote silently dropped the milestones it was meant to carry
  forward. Fixed.

Both now treat the parsed value as the main path and the string as the fallback, which is
the shape `src/lib/settings.ts` and `src/lib/audit.ts` already use for their own JSON
columns — those two were written defensively and are correct.

**Two readers outside this module have the same bug and are not fixed**, because admin is not
this module and changing it means re-verifying it:

- `src/modules/admin/routes.tsx:882` `FieldDiff` takes `before: string | null` and is called
  with the raw `audit_log.before_json` / `after_json`. Both arrive parsed, so the per-key
  diff never runs and the audit screen renders one `value` row holding the whole object.
  `src/lib/audit.ts` already exports a correctly guarded `parseAuditJson` that this screen
  does not use.
- `src/modules/admin/routes.tsx:601` the settings page's local `parse(raw: string)`, same
  shape, cosmetic by comparison.

### 11.3 `HAVING` cannot see an ungrouped column in MariaDB
`runCrmFollowups` filtered dormancy with
`HAVING COALESCE(MAX(lead_activities.occurred_at), leads.created_at) < ?` while
`leads.created_at` was in neither the select list nor the `GROUP BY`. MariaDB answers
`Unknown column 'leads.created_at' in 'HAVING'`, so `/internal/cron/crm-followups` would have
returned 500 every night it ran. Fixed by adding the column to both; it is functionally
dependent on `leads.id`, which is already grouped, so the grouping is unchanged. The cron now
runs end to end in the suite.

### 11.4 Both preconditions named in the task were already satisfied
The `quote_sent` visit gate asked for in `changeStage` was already there, and
`convertLeadToProject` was already a single `db.transaction()`. Neither needed an edit; both
are now executed and asserted rather than merely read. See 11.5.

### 11.5 What the suite proves, specifically
The three refusals are the point: `changeStage` to `quote_sent` and `createQuote` both refuse
with no completed site visit (so a lead cannot sit in `quote_sent` with no quote in
existence, and a rate cannot be quoted unseen); `approveQuote` refuses the person who raised
it; a second `convertLeadToProject` refuses. Also executed: the escalation branch against a
fixture `approval_limits` row (`limitBps` 250 against a 500 bps discount), the zero-discount
self-approve branch, `sendQuote` reporting `emailed:false` with an `email_log` row because
SMTP is unconfigured, `rejectQuote` → `reviseQuote` superseding revision 1, and the
conversion opening a client, 12 stages from template 1, 3 milestones summing to the
subtotal exactly (613,510,000 paise, GST excluded), and the site store.

Row-level scoping is asserted from both sides: the gated `expected_value_paise` and
`probability_pct` columns are **absent** from the row when `canViewValue` is false, not
merely nulled, and a lead outside the scope predicate is invisible to the scoped reader.

### 11.6 Test-side errors worth recording
Four of the eleven first-run failures were mine, not the module's, and two of them are
facts about the schema that the next module will meet again: `lead_activities.activity_type`
splits calls by direction (`call_out` / `call_in`, no bare `call`), and
`project_milestones` names its weightage column `percent_of_contract`. Also
`duplicatesByPhone` lives in `service.ts`, not `queries.ts`, and `leadStageHistory` reads
newest-first.

### 11.7 Fixtures, and why the numbers move between runs
The suite creates two obviously-fake users (`@example.invalid`, open question 8.1 is still
unanswered so no real name appears) and one fixture `approval_limits` row, and cleans up by
`id > MAX(id)` captured in `beforeAll` — Kysely 0.27 has no savepoints and every service
function opens its own transaction, so an outer rollback is not available. Verified after
the run: every tracked table is back to zero rows and all reference data is intact.

`document_numbering` is deliberately **not** reset, so quote and lead numbers advance across
runs. Assertions match the shape `NCC/QT/2026-27/nnn`, never a literal sequence number.

## 12. The JSON column sweep, 2026-09-04

§11.2 recorded the mechanism and fixed the two CRM readers. This section closes the class:
every JSON column in the schema, every reader of one, one reader for all of them, and two
tests that fail if a second appears.

Verification for this section: `npx tsc --noEmit -p tsconfig.json` → exit 0, no output.
`npm test` → 8 files, **204 passed**. `npm run test:integration` → 3 files, **49 passed**.

### 12.1 Twelve columns, three of them invisible to a grep
From `information_schema.check_constraints` where `check_clause like '%json_valid%'`, with no
limit this time (§11.2 reported five because the probe had `limit 5` on it):

`audit_log.after_json`, `audit_log.before_json`, `dashboard_daily_snapshot.detail_json`,
`email_log.response_json`, `project_documents.visible_to_roles`,
`quotes.payment_schedule_json`, `settings.value_json`, `site_page_revisions.content_json`,
`site_page_revisions.schema_types`, `site_pages.content_json`, `site_pages.schema_types`,
`site_services.body_json`.

Three are not named `*_json` — `project_documents.visible_to_roles` and both `schema_types`.
Any search that assumed the naming convention would have missed them, and two of the three
belong to a module nobody has written yet.

### 12.2 Six variants of one function, now one
Before the sweep, five files parsed a JSON column and each did it differently:

| Site | Was | Now |
| --- | --- | --- |
| `src/lib/audit.ts` | `parseAuditJson`, zero callers | deleted |
| `src/lib/settings.ts` | local `parse`, threw on every row | `parseJsonColumn` |
| `src/lib/numbering.ts` | `safeJsonString`, fell back to the default prefix every call | `parseJsonColumn` |
| `src/modules/crm/service.ts` | `parsePaymentSchedule` returned `[]` always | `parseJsonColumnArray` |
| `src/modules/crm/routes.tsx` | `readSchedule` returned `[]` always | `parseJsonColumnArray` |
| `src/modules/admin/routes.tsx` | local `parse` + `FieldDiff`'s own attempt | `parseJsonColumn` |
| `src/modules/admin/service.ts` | `JSON.stringify(next) === row.value_json` | `jsonColumnEquals` |

`src/lib/json.ts` holds all of it: `JSON_COLUMNS`, `parseJsonColumn`, `parseJsonColumnArray`,
`jsonColumnEquals`. Nothing in projects or inventory read a JSON column at all —
`project_documents.visible_to_roles` has no reader yet — so neither module changed.

`diffFields` in `src/lib/audit.ts` was left alone. It overlaps `FieldDiff` in spirit, but
merging them changes what the audit screen displays, and that is not this bug.

### 12.3 The one a `JSON.parse` grep could not have found
`src/modules/admin/service.ts` `saveSettings` compared `JSON.stringify(next) === row.value_json`
— JSON text on the left, a pre-parsed value on the right. Never equal. So every save of the
settings form rewrote every row on the form, wrote a `setting.update` audit entry for each,
and told the user it had saved 25 settings when it had been asked to change none. The audit
entry it wrote was itself wrong: `before` was the encoded column and `after` was the decoded
value, so the diff viewer compared a value against its own encoding.

There is no `JSON.parse` on that line. The grep in the work order would have walked past it.
It was found by reading every use of a JSON column rather than every use of the parser, which
is the reason the column list in 12.1 exists at all.

### 12.4 The reader parses less than its predecessors did
Every deleted variant parsed any string it was given. `parseJsonColumn` parses a string only
when it is unambiguously JSON structure — it starts with `[`, `{` or `"`, or it is exactly
`null`, `true` or `false`.

The reason is `company.phone_primary`. It arrives from the driver as the JS string
`+91 78292 92929`; a stored value of `9876543210` would arrive as the JS string `9876543210`,
and a reader that parses every string turns that into a number. Nothing complains until
something calls `.trim()` on it. The old settings `parse` did exactly this, and so would a
naive consolidation. Bare text and bare numbers now come back as the strings they are, and
the fallback still covers the case it exists for: a hand-written row or a server that reports
the column as text, where an array or an object always starts with a structure character.

Malformed JSON returns the string, not `null` and not a throw. An unreadable setting should
still render as whatever is in the column; an unreadable payment schedule should be refused by
the caller about to raise invoices against it. A parser cannot tell those two apart.

### 12.5 Two tests hold the line
`tests/json-columns.test.ts` (unit, no database, 16 tests) scans every `.ts`/`.tsx` under
`src/` with comments stripped and fails unless `JSON.parse` appears in exactly one file,
`src/lib/json.ts`, exactly once. Comment stripping drops whole lines that begin with `//` or
`*` rather than cutting at the first `//`, so a line of code keeps its trailing comment and no
call can hide behind one. The rest of the file pins the reader's behaviour, including the
`9876543210` case from 12.4 and the comparison from 12.3.

Checked that the guard fires: a throwaway `src/modules/hr/_guard_probe.ts` containing one
`JSON.parse` turned that test red, in a module that is still a stub. Probe deleted.

`tests/integration/json-columns.test.ts` (7 tests) reads the `json_valid` CHECK constraints
out of `information_schema` and requires them to equal `JSON_COLUMNS` exactly, extracting the
column name from the clause rather than trusting MariaDB to keep naming an inline CHECK after
its column. A migration that adds a JSON column now fails the build until the column is
registered. It also asserts the settings form round-trips: posting back what the page rendered
returns `changed === 0` and writes no `audit_log` row — 12.3 as a property, against a real
driver, which is the only place that bug is visible. The actor is user 0, which does not
exist, so a regression fails the `updated_by` foreign key as well as the count.

### 12.6 Eight of the twelve columns have no reader yet
Only four are read anywhere today: both `audit_log` columns, `quotes.payment_schedule_json` and
`settings.value_json` — which is to say, all four that had a reader had a broken one.

The other eight are `dashboard_daily_snapshot.detail_json`, `email_log.response_json`,
`project_documents.visible_to_roles`, `site_pages.content_json`, `site_pages.schema_types`,
`site_page_revisions.content_json`, `site_page_revisions.schema_types` and
`site_services.body_json`. Two are written already — `src/lib/mailer.ts:111` puts the SMTP
response into `email_log.response_json` with `JSON.stringify` — and the rest belong to the
dashboard snapshot job and the marketing / site-content module, which are stubs.

Every one of them is a place this bug gets reintroduced by the next person who needs the value
and reaches for `JSON.parse`. That is what 12.5 is for, and it is why the guard is a test rather
than a note in this file.

### 12.7 Three settings rows contradict their own `data_type` — flagged, not fixed
`migrations/003_reference.sql:217-219` insert `finance.gst_default_pct`,
`finance.tds_default_pct` and `finance.retention_default_pct` as unquoted `18.00`, `2.00` and
`5.00` — valid JSON, so `json_valid` accepts them, but JSON **numbers** — under
`data_type = 'string'`. The driver returns `18`, the `.00` already lost. The settings page
renders `String(18)`, and `coerceSetting('string', '18')` returns the string `"18"`, so the
first real save of that form rewrites all three rows as a different type than they were seeded
with and reports three changes the user did not make.

Nothing reads these three keys yet — finance is a stub — so nothing is broken today. The trap
is for whoever writes finance: `getSetting('finance.gst_default_pct', 18)` returns a number on
a fresh database and a string after any settings save. Fixing it needs a decision this session
cannot make, because `coerceSetting` has no decimal type: either `data_type` becomes `int` and
fractional percents stop being expressible, or the values become JSON strings and every reader
must `parseFloat`. Both need a migration, and neither is a JSON-parse bug, so the sweep stopped
at recording it. `tests/integration/json-columns.test.ts` asserts that these three and only
these three are contradictory, so the list cannot grow unnoticed and fixing the seed forces the
assertion to be updated.

## 13. A percentage is basis points, 2026-09-04

Fixes 12.7 forward, in `migrations/011_settings_rate_units.sql`. The question was how the
three finance rate settings should be represented, and the working assumption on the table was
a decimal string parsed with explicit decimal conversion, to keep floats away from a
money-adjacent rate. The spec answers it differently, and the spec wins.

### 13.1 What the spec says
Three places, none of them a float:

- **4.3**, restated verbatim in `migrations/002_rbac.sql:90-92`: `max_value BIGINT` is
  "paise, or basis points when document_type is quote_discount_pct".
- **6.7 rule 5**: "`quotes.discount_pct` is checked against `approval_limits` for
  `quote_discount_pct` in basis points."
- **6.8**: every rate in the finance schema is `DECIMAL(5,2)` — `gst_pct ... DEFAULT 18.00`,
  `tds_pct ... DEFAULT 0`, `contingency_pct ... DEFAULT 3.00`, plus `work_done_pct`,
  `threshold_pct` and `actual_pct`. Two decimal places, exactly.

So a percentage held in a general-purpose column is an integer in basis points, and 18.00
percent is 1800 of them. Basis points encode `DECIMAL(5,2)` losslessly and introduce no parse
step where a float could enter. A decimal string would have been a *second* representation of a
percentage in a codebase where `submitQuote` already compares one in basis points against
`approval_limits.max_value` and `admin/routes.tsx:572` already renders that column as
`max_value / 100` with a percent sign — and converting between two representations is where the
drift being avoided actually happens.

### 13.2 Why `data_type` is `int` and the unit lives in the label
6.2 fixes the enum at `('string','int','money','bool','json')`. There is no decimal member, so
this is a choice inside the enum, not an extension of it. `money` would render 1800 as 18 in the
editor but hint "in rupees" and call a tax rate money. `int` renders the stored integer, so the
unit moves into `label`, which is a data column: "Default GST rate, in basis points (1800 =
18.00%)". 6.2's promise that the editor "renders from `settings.data_type`, so adding a key
needs no new UI code" still holds — no UI changed for this.

`coerceSetting('int', '1800')` returns 1800 and `jsonColumnEquals(1800, 1800)` is true, so the
form round-trips exactly and the no-op save from 12.5 stays a no-op.

### 13.3 A forward migration, and why the conversion is arithmetic
003 cannot be edited: `scripts/migrate.mjs` checksums every applied file and treats a change as
a hard failure, which is the same reason 010 exists. 011 converts with
`ROUND(CAST(JSON_UNQUOTE(value_json) AS DECIMAL(9,4)) * 100)` rather than writing three
literals, so a value an owner had already edited is carried across at its own figure, from
either the seeded form (JSON number `18`) or the post-save form (JSON string `"18"`).

Verified: `npm run db:migrate` → `Applied 011_settings_rate_units.sql`; the three rows read back
`1800`, `500`, `200` as `int` with the new labels; 25 settings rows and 12 `json_valid` checks,
unchanged. Then a fresh database migrated 001 through 011 from empty (`--db ncc_fresh`) landed on
the identical three values and the same 12 checks, so the arithmetic does not depend on the dev
database's history. Scratch database dropped.

### 13.4 `MODIFY COLUMN ... LONGTEXT` silently unmarks a JSON column
Probed in a throwaway database before shipping 011's `ALTER TABLE settings MODIFY COLUMN
value_json JSON NOT NULL COMMENT ...`, because a comment is not worth changing a constraint set
by accident:

| Statement | `json_valid` checks on the column |
| --- | --- |
| `CREATE TABLE t (v JSON NOT NULL)` | 1 |
| `MODIFY COLUMN v JSON NOT NULL COMMENT 'x'` | 1 — preserved, not duplicated |
| `MODIFY COLUMN v LONGTEXT NOT NULL COMMENT 'x'` | **0 — dropped** |

MariaDB's `JSON` is an alias for `LONGTEXT` plus that CHECK, so spelling out the underlying type
in a later migration removes the marker. mysql2 reads the marker to decide whether to pre-parse,
so a migration that did this would stop the driver parsing the column and every reader would
start receiving raw text — the 12.x bug inverted, and the one thing the shared reader's string
branch is there to survive. `tests/integration/json-columns.test.ts` fails on it immediately: 11
constraints against 12 registered columns.

### 13.5 What still is not decided
Nothing reads these three keys yet. The finance module is the first consumer and it will need to
divide by 100 on the way into a `DECIMAL(5,2)` column; that conversion belongs in one place in
`src/modules/finance/`, not spread across call sites, and this section is the reason it exists.
`approval_limits` is still empty pending open question 8.2 — the representation of a limit is
settled, the numbers are not.

### 13.6 Deferred to phase 9: a range check on the rate settings
`data_type` stays `int` with the unit in the label. The gap that leaves is an editor showing
`1800` for a field labelled a GST rate: someone types `18`, saves, and GST is 0.18 percent. It
looks like a typo and behaves like a money bug, and nothing in the save path would refuse it
today.

Deferred deliberately, not overlooked. The fix belongs with the rest of the input hardening in
**spec phase 9**, and it is a validation rule rather than a schema change. It applies to exactly
three keys — `finance.gst_default_pct`, `finance.tds_default_pct`,
`finance.retention_default_pct` — in three bands, not as a floor:

| Value | Verdict | Why |
|---|---|---|
| `0` | accept | A zero rate is legitimate. §6.8 line 1999: `tds_pct DECIMAL(5,2) NOT NULL DEFAULT 0`. TDS under 194C does not apply to every payment, and the spec's own default is nil. |
| `1`–`99` | **reject** | Below one percent for GST, TDS or retention. Reads as a decimal entered into a basis-point field: `18` meaning 18 percent, stored as 0.18. |
| `>= 100` | accept | One percent or more, in basis points. |

The message has to name the unit and the zero case, because the value the user typed looks
correct to them: "This rate is in basis points — 1800 is 18 percent, 200 is 2 percent. You
entered 18, which is 0.18 percent. Enter 0 for a nil rate."

The first draft of this section set the floor at 100 and would have rejected the spec's own TDS
default. Corrected here rather than in phase 9, where a rule written from the wrong premise
would have been implemented as written.

A `pct` data_type with its own editor branch was considered and rejected for now: it changes
6.2's type-driven render for one module's three keys, mid-flight, before the module that reads
them exists.

The consequence of waiting is bounded. The three keys have no readers until finance is built,
and a wrong value is visible in the field it was typed into.

---

## 14. HR, first slice: the employee master, pay, documents and the exit, 2026-09-04

Covers `src/modules/hr/{queries.ts,schemas.ts,service.ts,routes.tsx}` against §6.6. Attendance,
leave, contractors, safety and recruiting are still the stub screens; what follows is only what
had to be decided to ship the first four.

### 14.1 The employee-to-login link is recorded twice and written once

Two columns describe the same relationship and the spec declares both: `employees.user_id`
(§6.6, `migrations/006_hr.sql`) and `users.employee_id` (§4, `001_core_auth.sql`, FK added in
006). Neither is named canonical. **Only one has a writer** — `createUser` in
`src/modules/admin/service.ts` sets `users.employee_id`; nothing in the codebase writes
`employees.user_id`.

That is not cosmetic. `runExit` read `employee.user_id` to find the login to close, so for any
account created through the 6.1 admin screen — which is all of them — the branch never fired:

- an employee row was marked `exited` while a live session still held their cookie;
- `exitBlockers` keys its assignment and raised-expense queries on the user id, so a departing
  employee with open project assignments produced an empty checklist and read as a clean
  clearance.

Both faults are invisible to a test that seeds `employees.user_id` directly, which is why
`tests/integration/hr-flow.test.ts` links the login the production way (`users.employee_id`) and
asserts `employees.user_id` is still null while the exit still revokes the session.

**Decision: read both directions, write neither.** `employeeLoginId(db, employeeId, userId)`
prefers `employees.user_id` when set and otherwise looks up `users.employee_id`; `runExit` and
`exitBlockers` both go through it, and `findEmployee`'s users join became
`ON users.id = employees.user_id OR users.employee_id = employees.id`. Two matching rows would
need two accounts each claiming the same employee, and `executeTakeFirst` returns one row either
way — so the widened predicate cannot break the profile page, where the narrow one showed "no
login" on every one of them.

Rejected: adding a writer for `employees.user_id` in `createUser`. Which column is canonical is a
schema question, and choosing makes the other stale for rows that already exist. Rejected also: a
migration dropping one of them — 006 is applied and checksummed (see 13.3).

**Reopens if:** §8 settles the direction, or a second writer appears. The change then is one
function.

### 14.2 Two of the five exit blockers match on a name, and are advisory

§6.6 rule 7 lists five things that must be clear before an exit completes. Three key on ids. Two
cannot, because the schema does not carry one:

- `material_issues.received_by_name` — free text signed at a store counter;
- `equipment_deployments.operator_name` — the same.

So those two are matched against `employees.full_name` exactly. **A store issue recorded as
"Ramesh" against an employee named "Ramesh Kumar" does not appear on the checklist.**

**Decision: match exactly, and treat the checklist as a prompt rather than a proof of
clearance.** Rule 7 already provides for the case — a blocked exit completes against a recorded
reason — and `override` is stored as that reason rather than as a boolean, so an exit forced
through with keys outstanding is legible six months later. The refusal is `UnprocessableError`,
not `Conflict`: the request is well formed and the state of the world is what is wrong with it.

Rejected: adding `received_by_employee_id` / `operator_employee_id`. The spec models these as
free text on purpose — a gate entry names whoever signed, including people with no employee row,
such as a contractor's driver — and inventing the FK changes two other modules' write paths from
inside HR. Rejected also: fuzzy matching (`LIKE '%name%'`, token overlap). A false positive
blocks a departure over someone else's issue slip, while a silent miss is at least in front of
the person running the exit, who can see the store register.

**Reopens if:** attendance lands a per-employee site record that these rows could join by id.

Recorded alongside: `advancesOutstanding` ships although rule 7's enumerated list does not name
it — rule 7's prose case ("three open advances") does. Both queries run: an expense the employee
*raised* (`created_by`, still `draft` or `pending_approval`) and one where they are the *payee*
(`employee_id` with `payee_type = 'employee'`, through `part_paid`). Both are money that follows
the person out of the door.

### 14.3 Rule 6 has two halves; the schema enforces one and nothing implements the other

Rule 6 (§6.6, spec line 1751): only `aadhaar_last4` is stored, plus the scanned document "in
`files` under an access-checked route ... `GET /api/files/:id` enforcing permission, so a leaked
filename does not leak a document."

The first half holds, four deep:

- `employees.aadhaar_last4 CHAR(4)`, and the column refuses more;
- `employeeSchema` accepts exactly four digits or nothing. A twelve-digit paste is **rejected,
  never truncated** — truncating admits the full number into the request body, and from there
  into whatever logs the request, which is the thing the Aadhaar Act restricts;
- `documentSchema` refuses a `document_no` that is not four digits when `doc_type = 'aadhaar'`.
  That column is `VARCHAR(60)`, so without the refine the number rule 6 keeps off the employee
  row is accepted on a document row for the same person. Rule 6 is about the number not being in
  the database, not about which table it is in;
- `auditableEmployee` keeps `aadhaar_last4`, `pan` and the three bank columns out of `audit_log`.
  `audit.view` is a wider grant than `hr.employee_view`, so copying them there routes around the
  permission that protects the profile. `document_no` is not audited either, for the same reason
  and with no per-type exception.

**No hashed or tokenised form of the number is specified anywhere in the spec** — line 1751 and
the two schema lines are every mention of Aadhaar in it. None was invented: flagged rather than
chosen. The consequence is 14.2 — with no stable identifier for a person beyond `employees.id`, a
free-text site record can only be matched by name.

The second half is not built:

- **`GET /api/files/:id` has no route handler.** The path appears in a comment at
  `src/lib/files.ts:16` and as a link at `src/modules/projects/routes.tsx:1011`; nothing serves
  it, so that link 404s today.
- `storeUpload` (`src/lib/files.ts:92`) has no callers anywhere in `src/` or `tests/`.
- `csrfProtect` skips the body parse for `multipart/form-data` (`src/middleware/csrf.ts:29`) and
  expects `x-csrf-token` instead, so a plain browser upload form is *rejected* as things stand.
  That is a hard precondition on the upload work, not a note: **see 15.1.**
- `files` carries `uploaded_by` and `visibility` but **no `entity_type`/`entity_id`**, so a
  serving route cannot derive from the row which permission protects the document. It would have
  to search every table holding a `file_id`.

Consequence for HR, stated precisely: `POST /api/hr/employees/:id/documents` takes a `file_id`
and verifies the row exists, so the document register is real — but the only way a `files` row
gets there today is a direct insert. **No Aadhaar scan can be uploaded or served yet, so nothing
is exposed.** This is a missing feature, not a leak. Named here because rule 6 reads as satisfied
and half of it is not, and because the fix belongs with `files` and CSRF rather than in HR.

**Blocks:** any HR screen offering a document upload.

### 14.4 Pay is separated by query shape, not by a flag

Rule 5 puts compensation in its own table behind `hr.payroll_view`. Implemented so that
`findEmployee` *cannot* return a pay figure: it does not select from `employee_compensation` at
all, and `compensationHistory` is called only from the fragment behind that permission. No
`canViewPay` boolean threaded through a join, no filtering of a result set after the fact. That is
what lets `ops_manager` see the team without seeing what the team is paid, and the integration
test asserts the absence on the returned object rather than on the rendered page. The same
reasoning keeps `aadhaar_last4` and the bank columns out of `listEmployees`: a list page is the
thing left open on a shared site laptop.

A revision closes the open period the day before the new one starts, so the history is a set of
adjacent non-overlapping periods and "what was he on in August" has one answer. An
`effective_from` on or before the open row's start is refused rather than silently reordered:
backdating over a period already paid is a payroll correction, and it needs a person to decide
what happens to the payment already made. Unlike the employee writes, the *figures* go into the
audit entry — `hr.payroll_view` is the narrower grant, and a pay revision with no record of what
changed is the one an owner asks about.

Found while checking who can reach it: **`accounts_manager` holds `hr.payroll_view` and
`hr.payroll_run` but not `hr.employee_view`** (`migrations/002_rbac.sql:274`). Every §6.6 route
that renders a pay figure hangs off `/app/hr/employees/:id`, which requires `hr.employee_view`. So
the role the spec gives payroll to has no screen on which to exercise it. Left as the seed has it:
the alternative is granting a role a permission the spec's own table did not list, and the figures
may be intended to reach that role through §6.8 finance instead. **Reopens with the payroll slice.**

### 14.5 The attendance grid's permission contradicts the seed

Spec line 1723 gives `GET /app/hr/attendance` to `hr.employee_view`; line 1724 gives
`POST /api/hr/attendance/bulk` to `hr.attendance_record`. The 002 seed grants those two
permissions to almost disjoint sets of roles: `project_manager` and `site_supervisor` can record
attendance and cannot open the grid (`002_rbac.sql:244`, `:260`); `admin` can open the grid and
cannot record (`:208`). Only `ops_manager` and `hr_manager` hold both.

A site supervisor is the person who enters the day's attendance. Read literally, the spec's table
denies them the screen it is entered on.

Not resolved, and not resolved silently either. The HR dashboard's "Attendance unapproved" card
shows its count to every holder of `hr.employee_view` but **links to the grid only for a holder of
`hr.attendance_record`**, so nobody is offered a link that 403s. The stub route keeps the spec's
permission unchanged. The choice between widening it to `hr.employee_view OR hr.attendance_record`
and adding `hr.employee_view` to the two site roles belongs with the attendance slice and with §8.

### 14.6 HR declares no `json_valid` column of its own

The working assumption going in was that this module would put a first reader on some of the eight
registered JSON columns that have none. It does not: `006_hr.sql` declares no JSON column at all.

What HR does instead is indirect and worth recording so the count is not double-claimed. The
module *writes* `audit_log.before_json` and `after_json` through `writeAudit` on all five of its
mutations, and `tests/integration/hr-flow.test.ts` reads them back through `parseJsonColumn` from
`src/lib/json.ts` — the first reader either of those two columns has had. No second parse path was
added; `tests/json-columns.test.ts` still fails the build on a bare `JSON.parse` anywhere in
`src/` outside that one file. An HR-owned JSON column would arrive with attendance, if at all.

### 14.7 What this slice deliberately did not touch

- **Contractor labour.** §6.6 keeps two populations apart, and nothing in `service.ts` writes
  `labour_contractors` from an employee form or the reverse; `/app/hr/contractors` is a count
  behind `hr.labour_contractor_manage`. The separation is currently preserved by the second half
  not being built, which is not the same as having designed it. The rate/attendance/bill chain is
  where it will actually be tested.
- Attendance, leave, safety, recruiting: stubs, unchanged.
- `approval_limits` is still empty pending §8.2. Contractor bill approval needs it (line 1728,
  "`hr.labour_contractor_manage` + limit"), so that slice cannot close on real numbers either.
- Reporting lines are walked, not checked one level deep: A reports to B reports to A is the same
  mistake as A reports to A, and it produces an org chart renderer that recurses until the stack
  ends. Both refusals are `UnprocessableError` and both roll back.

### 14.8 Deferred to phase 9: one canonical direction for the employee-login link

14.1 resolves the split by reading both directions. That is correct for now and it is not the end
state, because **nothing keeps the two columns consistent.** `users.employee_id` and
`employees.user_id` are two directions of one relationship, each nullable, with no constraint, no
trigger and no shared writer between them. Today only one is ever written, so they cannot disagree.
The moment a second writer appears — a "link an existing login" button, an import, a fix applied by
hand in the database — they can, and `employeeLoginId` prefers `employees.user_id` when it is set,
so a stale value there would win over a correct `users.employee_id`.

**Phase 9: pick one canonical direction, then drop or derive the other.** Either is defensible:

- keep `users.employee_id` — it is the column that has a writer, and it puts the FK on the side
  that is genuinely optional, since an employee need not have a login;
- keep `employees.user_id` — HR reads start from the employee, and it is one hop shorter on the
  pages that matter.

Whichever survives, the other should become a view or a generated column rather than a second
nullable FK, and `employeeLoginId` collapses to a single lookup. A migration reconciling existing
rows has to run before the drop; with no real staff rows yet (the fence in section 3), that
reconciliation is currently empty — this is the cheapest the change will ever be.

**Reading both ways is explicitly fine until then.** Recorded as hardening, not as a defect: the
behaviour is correct, the invariant is merely unenforced.

**Verified for this section, 2026-09-04, on the machine in §7:** `npm run typecheck` clean over 71
project files with all four HR files in `--listFilesOnly`; `npm test` 8 files / 204 tests passed;
`npm run test:integration` 4 files / 82 tests passed against the dev MariaDB on 3307 (hr-flow 32),
and a post-run count over `users, employees, employee_compensation, employee_documents, expenses,
files, audit_log, user_sessions, leads, projects` returned 0 for all ten, so the fixtures clean up
after themselves. The first integration run failed its `afterAll` on `fk_emp_reports` — one DELETE
over a range of employees can reach a manager before their report — fixed by nulling
`reporting_to_employee_id` and `users.employee_id` ahead of the table deletes, and the rows that
partial cleanup left behind were removed by hand and counted back to zero.

---

## 15. Preconditions on unbuilt work

Blocking conditions on code that does not exist yet, recorded here because the person who
writes it will not have been in the conversation where the condition was found. Each names
the file it applies to. **A precondition is not advice.** If one cannot be met, it is
escalated, not worked around.

### 15.1 No upload handler lands until multipart CSRF is covered

**Applies to:** `src/lib/files.ts` (`storeUpload`, currently uncalled), the unwritten
`GET /api/files/:id`, and any route that accepts a file.

**The condition:** `csrfProtect` does not read a CSRF token out of a `multipart/form-data`
body. `src/middleware/csrf.ts:29` lists that content type in `SKIP_CONTENT_TYPES`, and the
skip is on the **body parse**, for a real reason — buffering the body to find a hidden field
would hold 15 MB in memory before the guard runs, which defeats streaming the upload.

State it precisely, because the direction of the failure decides what has to be built:

- The guard still runs on a multipart POST, and it still calls `verifyToken`. Multipart is
  **not exempt from verification.**
- With no body to read, the token must arrive in the `x-csrf-token` header. If it does not,
  `verifyToken` throws `ForbiddenError` (`src/lib/csrf.ts:29-31`). So the failure is
  **closed** — a plain `<form enctype="multipart/form-data">` carrying the hidden `nc_csrf`
  field is *rejected*, not waved through.
- This is therefore an unbuilt path, not an open hole. Nothing is exposed today because
  `storeUpload` has no callers and no route serves a file.

**What satisfies the precondition.** Any one of:

1. Submit the upload through htmx or `fetch`. `AppShell.tsx:54` already sets
   `hx-headers={{'x-csrf-token': …}}` on `<body>`, so every htmx request inside the dashboard
   carries the header for free — an `hx-post` with `hx-encoding="multipart/form-data"` passes
   the guard as written, and this is the cheapest route.
2. Give `csrfProtect` a streaming-safe multipart branch that reads only far enough to find the
   token field and leaves the file parts unconsumed.
3. A dedicated guard on the upload route that verifies the header before the handler touches
   the body.

**What does not.** Adding `multipart/form-data` to a list that bypasses `verifyToken`;
mounting the upload route outside `csrfProtect`; or "temporarily" accepting an unverified
multipart POST. An upload endpoint is the one route where a forged cross-site POST writes a
file to disk under a real user's identity.

**Second half of the same slice:** `files` has `uploaded_by` and `visibility` but no
`entity_type`/`entity_id` (14.3), so `GET /api/files/:id` has nothing on the row from which
to decide *which* permission protects it. That question is settled in the same piece of work
or the route ships guarding an Aadhaar scan by `uploaded_by`, which is not a permission
check. See 14.3 for what §6.6 rule 6 promises here.

### 15.2 `leave_types.requires_document` stays unenforced until an upload route exists

**Applies to:** `requestLeave` in `src/modules/hr/service.ts`, and the leave form in
`src/modules/hr/routes.tsx`.

**The condition:** three of the seven seeded leave types carry `requires_document = 1` — SL,
MAT and PAT — and SL is the most frequently taken kind of leave there is. `leave_requests`
has `file_id` with an FK to `files`, and `requestLeave` checks that a supplied file exists.
Nothing can supply one: `storeUpload` has no callers and no route accepts a file (15.1).

So the flag is **surfaced and not enforced.** The form prints "needs a document" beside those
types, the audit entry for every request carries
`document_required_and_absent: <requires_document && file_id === null>`, and the request is
accepted. Enforcing it today would make three of seven types unrequestable, including sick
leave, which is the one type nobody can give notice for.

**What satisfies the precondition:** 15.1, and then one line in `requestLeave` turning the
audited flag into a refusal. Until then the audit field is the record of which approvals were
granted without the document the type asks for, which is what an inspection would ask about.

**Do not** enforce it by adding a "document reference" text column, or by refusing SL. The
first stores a promise instead of a document; the second removes the most common leave type
from the system.

## 16. HR, second slice: attendance and leave, 2026-09-04

Covers §6.6 rules 1 and 4 and the leave half of the route table, in the same four files as
section 14 (`src/modules/hr/{queries.ts,schemas.ts,service.ts,routes.tsx}`) plus `src/dashboard/nav.ts`.
Contractor labour, safety and recruiting are still stubs. What follows is what had to be
decided, what was found on the way, and what is deliberately not built.

### 16.1 The month lock is derived from `attendance.approved_at`, and it blocks inserts

Rule 4 requires a closed month to refuse changes. There is no table to record that a month is
closed: `migrations/` declares no `attendance_periods`, and `accounting_periods` belongs to
finance. Its permission `finance.period_close` is what rule 4 names as the **override** for a
closed attendance month, so using finance's table as the lock would make one permission both
the gate and the key.

**Decision: the lock is derived.** A month is closed when any of its `attendance` rows has a
non-null `approved_at` (`attendanceMonthState`, `locked: approved > 0`). Three consequences,
all of them chosen rather than inherited:

- **The close is whole-month and has no project scope.** A close covering one project would
  leave the month simultaneously locked and open, and a derived lock cannot express that
  without the table it does not have.
- **The lock refuses inserts, not only updates.** A month closed with twenty days entered and
  the twenty-first added afterwards changes the same payroll figure the lock exists to freeze.
- **One approved row closes the month.** There is no partial close, and `approveAttendanceMonth`
  refuses a second close (`ConflictError`) rather than restamping: `where approved_at is null`
  is the only record of when the month was first closed.

The derived state is read in three places — the month state the screen renders, the per-row
prior in `recordAttendanceBulk`, and the month check in `decideLeave`'s approve branch, because
approving leave writes attendance rows and would otherwise walk straight into a closed month.
All three go through `assertMonthOpen`, which is why they cannot drift apart.

**Reopens if:** an `attendance_periods` table lands. The change is `attendanceMonthState` and
nothing else.

### 16.2 An unreachable guard in `recordAttendanceBulk`, found and kept

`recordAttendanceBulk` carries a per-row check that a prior row is not already approved
(`service.ts:644`). **It cannot fire.** Under a derived lock, an approved row makes its month
locked, so `assertMonthOpen` throws before the loop when `canOverridePeriod` is false — and
the guard is skipped when it is true.

Reported rather than deleted, and kept: it is the guard a stored or project-scoped lock would
need on day one, and a row-level check in front of a row-level write is not misleading code.
`tests/integration/hr-attendance-flow.test.ts` asserts the observable truth — that the refusal
arrives with the month's message, not the row's — and says why in a comment, so the next reader
does not "fix" the test to match the unreachable branch.

### 16.3 A day counted is a day that is not Sunday; public holidays count

`workingDaysBetween` excludes Sundays and nothing else. Sunday is the weekly off on these
sites, and charging leave entitlement for one would overstate what the person took.

**Public holidays are not excluded, and this costs the employee.** There is no holiday calendar
table in the schema and no holiday list in the spec, so a range containing 2 October is charged
one day more than the person was absent for. Inventing the company's holiday list would be
inventing a business rule; the over-count is in the direction that is visible to the employee,
who will say so, rather than the direction that quietly pays for a day nobody worked.

The same rule is used twice — for `days` on the request and for the set of dates the approval
writes `attendance` rows across — and it has to be the same call, or the balance says one number
and the muster roll shows another.

**Reopens if:** §8 supplies a holiday calendar. `isWorkingDay` is then the only function to
change and both readers follow.

### 16.4 `min_notice_days` is enforced on a self-raise and waived on an approver's

Seeded notice: MAT 30, PAT 15, EL 3, CL/LWP/COMP 1, SL 0.

**Decision: enforce it against the person raising their own leave, waive it for a holder of
`hr.leave_approve` raising it for someone else, and audit the waiver.** A system that cannot
record a maternity notification given at twenty days is a system HR keeps its real leave
register outside of, and a register kept outside the system is the failure mode this module
exists to prevent. The audit entry for every request carries `notice_days_given`,
`notice_days_required` and `notice_waived`, so the waiver is a fact somebody can be asked
about rather than a silent bypass.

Rejected: enforcing for both. It makes the on-behalf path useless for the case it exists for —
recording something that already happened. Rejected also: dropping the check entirely, which
leaves the column with no reader and the notice period with no meaning.

### 16.5 The document a leave type asks for is surfaced, not enforced

See **15.2**. Three of seven seeded types require a document, no route can accept one, and
enforcing the flag would make sick leave unrequestable. The audit field
`document_required_and_absent` is the record until 15.1 is satisfied.

### 16.6 An approval writes attendance, and clears the project off a day already worked

`paid_leave`, `unpaid_leave` and `half_day` are `attendance.status` ENUM members with **no
writer anywhere in the codebase except `decideLeave`**. §6.8 rule 10 costs staff time by joining
`attendance` to `employee_compensation`, so approved paid leave that never reached `attendance`
is time the company paid for and charged to nothing. The approval therefore writes one row per
working day in the range, inserting where the day is unmarked and updating where it is not.

Four things the update branch decides:

- **`project_id` is cleared.** A day on leave was not worked on a site, and leaving the day
  charged puts leave cost inside a project's budget. The day may well have been marked
  `present` against a project before the leave was approved, which is the case the UPDATE
  exists for and the one that had never run.
- `in_time`, `out_time` and `overtime_hours` are cleared for the same reason.
- `remarks` becomes `Leave request <id>`, so the row says where it came from without a join.
- **A half day is written as `half_day`, not as a whole day of `paid_leave`.** `days` is 0.5 in
  a `DECIMAL(4,1)` column, and the muster roll counts a `paid_leave` row as a full day absent.

The interlock runs the other way too: `recordAttendanceBulk` refuses to mark an approved leave
day as worked and puts the request number in the message, because withdrawing the request is
the correct way to undo it. A *leave* status over an approved leave day is still allowed —
`unpaid_leave` over `paid_leave` is a correction a supervisor is entitled to make, and the
balance is not touched by it.

Balances are **tracked, not enforced.** Every seeded `annual_quota` is NULL pending §8.6, so
there is no quota to refuse against and a negative balance is a fact for HR to look at rather
than a validation failure. `leave_balances` is upserted on `uq_bal (employee_id, leave_type_id,
financial_year)` with the arithmetic done in JS: `balance = opening + accrued - availed - encashed`.

### 16.7 A leave range crossing 31 March lands wholly in the financial year it starts in

`financialYear(from_date)` picks the balance row for the whole request, so 30 March to 2 April
draws four days from the year that is ending and none from the year that is starting.

Splitting it would need a rule for which year a March-to-April absence draws down, and §8.6 has
not answered the simpler question of what the annual quota even is. **Guessed, and recorded as a
guess.** The alternative — refusing a range that crosses the boundary — pushes the employee into
raising two requests and produces the same total in two rows, with no rule to say it is right
either.

**Reopens with §8.6.** If the answer splits the range, `decideLeave`'s balance block is the only
code that changes.

### 16.8 "Own" is expressed as the absence of a permission, and the sidebar had to learn it

The §6.6 route table gives `GET /app/hr/leave` the permission mode "own". There is no `own`
permission key, and there is no route-level middleware that can express it: `/app/*` sits behind
`csrfProtect()` then `requireAuth()`, so **a route with no `requirePermission` is
authenticated-only**, which is what "own" means here. `/app/hr/leave`, `POST /app/hr/leave` and
`POST /api/hr/leave/:id/withdraw` all carry none.

Ownership is therefore enforced below the route, in two places that cannot be bypassed by
shaping the request differently:

- `listLeaveRequests({ employeeId })` filters inside the query. The route passes
  `canApprove ? undefined : (selfEmployeeId ?? -1)` — the `?? -1` is deliberate: a login with no
  employee record sees **nothing**, not everything.
- `withdrawLeave` refuses a request that is not the caller's own, and refuses one that is not
  pending. An approved request has already moved `attendance` and `leave_balances`, so undoing
  it is a reversal an approver makes.
- `decideLeave` refuses self-approval **by employee, not by login**. The request is filed against
  an employee record and carries no user id, so an HR officer whose account is linked to employee
  4 cannot approve employee 4's leave. The dashboard queue filters the same way.

This broke the sidebar's stated invariant — a route you can reach is a route you can find — in
its second direction: with every item requiring a permission, a user holding none saw an empty
sidebar and had no link to the one page they could open. `NavItem.anyUser` was added for exactly
this case, and `perms: []` without the flag stays hidden, so a half-edited entry hides rather
than leaks (`tests/nav.test.ts`).

### 16.9 The attendance grid's permission was widened, resolving 14.5 in one direction

14.5 recorded that the spec's route table denies a site supervisor the screen attendance is
entered on: line 1723 gives the grid to `hr.employee_view`, and the 002 seed grants that to
`admin`, `ops_manager` and `hr_manager` while giving `hr.attendance_record` to
`project_manager` and `site_supervisor`.

**Decision: widen the read, leave the writes exactly as specified.**
`GET /app/hr/attendance` requires `hr.employee_view` **OR** `hr.attendance_record` **OR**
`hr.attendance_approve`; `POST /api/hr/attendance/bulk` keeps `hr.attendance_record` and
`POST /api/hr/attendance/approve` keeps `hr.attendance_approve`, both alone. Inside the page,
`canRecord`, `canApprove` and `canOverride` (from `finance.period_close`) decide which controls
render, so a viewer who cannot record sees the month without the submit.

Widening a read grants nobody a write the spec did not give them. The alternative — adding
`hr.employee_view` to the two site roles — edits the grants in a migration that is applied and
checksummed (13.3), and it also hands those roles the employee master, including pay. **Still an
§8.1 question**; this is the reversible half of it.

### 16.10 Rule 1's Alpine keyboard matrix is not built, and nothing pretends it is

Spec line 1761: "`AttendanceGrid.tsx` is a month-by-employee matrix with keyboard entry (arrow
keys to move, single letter to set status) **built in Alpine**, because HR marks a whole month in
one sitting and a click-per-cell form is unusable."

**What ships instead:** a server-rendered grid for **one day** across the roster, prefilled from
`attendanceOn`, submitted as a single POST for the whole day, plus a month view that reads. The
month-by-employee matrix, the arrow-key movement and the single-letter status are **not built.**

The reason is not effort. Alpine is vendored, and there is **no `x-data`, `x-model` or `x-on:`
anywhere in `src/`** — every interactive surface in the application so far is a server-rendered
form plus htmx. Writing the first client-side stateful component in the codebase, inside the
attendance slice, on an inferred design, would set the pattern for §6.5's `ItemPicker` and
`LineItemGrid` (line 1355) by accident. Flagged rather than chosen, which is the standing rule
for a spec instruction that conflicts with a built convention.

What ships is enterable from the keyboard in the browser's own tab order across a day's rows.
That is not the same thing, and the month-in-one-sitting workflow the spec gives as the reason
for the matrix is not served by it. **This is the largest deliberate gap in the slice.**

### 16.11 Verification record, 2026-09-04 — attendance and leave

Run from `C:\Users\HP\Downloads\neelachandra-main\neelachandra-main`, against the persistent dev
MariaDB 11.4.4 on 127.0.0.1:3307 (`ncc_dev`):

| Gate | Command | Result |
| --- | --- | --- |
| Types | `npm run typecheck` | 0 errors, **71** source files listed by `--listFiles` |
| Pure | `npm test` | **245 passed**, 9 files |
| Database | `npm run test:integration` | **138 passed**, 5 files |

The integration total is 82 → 138 because `tests/integration/hr-attendance-flow.test.ts` adds
**56** tests. The pure total is 204 → 245, which is `tests/hr-schemas.test.ts` new at **27**, the
month and working-day block appended to `tests/dates.test.ts` at **12**, and **2** more generated
rows in `tests/nav.test.ts` — one per new sidebar entry, since that file asserts every href is a
path some module registers. Both HR integration files run against the same database in one fork (`fileParallelism: false`, `singleFork: true`) and clean up by id above a
high-water mark; `hr-flow.test.ts` asserts `unapprovedAttendance === 0`, which only passes if the
attendance file's cleanup is complete, so the two files check each other.

What the counts do **not** cover: the four `/app/hr/*` screens and three `/api/hr/*` posts in this
slice are exercised through their services, not through HTTP. No e2e run touches the grid, and
the "not built" of 16.10 is a statement about the markup, which no gate here asserts.

## 17. Seams written now so that later work is a data change

### 17.1 The leave quota check is written and dormant; a number in `annual_quota` activates it

`assertWithinQuota` in `src/modules/hr/service.ts` runs on every leave approval and refuses one
that would exceed the type's entitlement. It is **dormant**, because `leave_types.annual_quota` is
NULL for all seven seeded types (spec line 1617 defers them to §8.6) and NULL means "no policy, so
nothing to enforce". Negative balances therefore stay exactly as 16.6 describes them: tracked, not
refused. **Supplying quota values switches enforcement on with no code change and no deploy** —
that is the reason to write it before the numbers exist rather than after.

**What "available" means is a reading, and it is the part to argue with.** The spec gives
`annual_quota` on the type and `opening`/`accrued`/`availed`/`encashed` on the balance row, and
says nothing about how the two relate. Nothing writes `accrued`: there is no accrual job anywhere
in the codebase. So a gate that drew only on the balance columns would compute an entitlement of
zero and **refuse every request the moment a quota was set** — a trap wearing the costume of a
seam, and the failure mode would arrive on the day HR finally answered §8.6. The entitlement is
therefore `max(accrued, annual_quota)`: the quota stands in while the accrual column is zero, and
an accrual job that catches up takes over from it without another edit.

Two consequences, both deliberate:

- **Mid-year it is generous.** Twelve days are available in month one rather than one twelfth of
  them. That is the same direction as 16.3's treatment of public holidays — towards the employee —
  and it is the safer error while the policy is unwritten.
- **The stored `balance` column and the gate disagree, and both are right.** `balance` stays the
  spec's formula, `opening + accrued - availed - encashed`, with no quota term, so an approval that
  passed the gate can still leave `balance` negative. The entitlement lives on the type and the
  ledger lives on the balance row; only an accrual job reconciles them. The integration test says
  this out loud rather than asserting around it.

Ordering: the check runs **before** the attendance loop, so a refusal does not depend on the
transaction rolling back to be correct — though it is inside the transaction too, and the test
proves `availed` did not move and no `attendance` row survives the refusal.

The audit entry for `hr.leave_approve` now carries `annual_quota` and `quota_enforced` on **every**
approval, enforced or not, so the day the numbers land is legible in the log instead of inferred
from a behaviour change. The refusal message names the type, what is available, the quota and the
shortfall, because "quota exceeded" gives an approver nothing to tell the employee.

The `-11` balance assertion in `tests/integration/hr-attendance-flow.test.ts` carries a comment
pointing here. When §8.6 lands it is the first thing that will fail, and it will fail *because the
gate started working*. The fix then is to give the fixture employees an opening balance, **not** to
loosen the gate.

### 17.2 Rule 1's Alpine attendance matrix gets its own slice, immediately after HR slice 3

16.10 recorded that the keyboard-driven month-by-employee matrix of spec line 1761 is not built.
This is the disposition of that gap: **it is neither dropped nor deferred to phase 9.** It becomes
its own slice, scheduled immediately after HR slice 3 (contractor labour and bills), and it is
built as **the reference pattern for every later client-side component** — §6.5's `ItemPicker` and
`LineItemGrid` (line 1355) and §6.7's `ApplicantBoard` drag-free `hx-post` all land on top of
whatever this slice establishes.

Sequenced after slice 3 rather than before it for one reason: **Alpine is not introduced in the
middle of a slice.** The first client-side stateful component in a codebase that is otherwise
entirely server-rendered sets conventions — where the state lives, how it posts, how it degrades
without JavaScript, how it is tested — and those decisions deserve their own commit, their own
DECISIONS entry and their own gate, not a paragraph inside a bill-generation change.

**Rejected: drop the keyboard grid and keep the day-at-a-time form.** The spec gives a reason, not
a preference — "HR marks a whole month in one sitting and a click-per-cell form is unusable" — and
the shipped form is exactly the click-per-cell form named there. Ten employees over a 26-working-day
month is 260 cells across 26 separate posts. Dropping it would mean the module's most-used screen
stays the one the spec singled out as unusable.

**Rejected: defer it to phase 9 hardening.** §7.6 hardening is backup verification, rate-limit
tuning and the audit retention job — work that does not change what the application does. A missing
primary entry surface is not hardening, and deferring it there would also mean the first client
component gets designed under cutover pressure, which is the worst moment to set a pattern that
five later components inherit.

### 17.3 Two blocking data items, logged rather than invented

Both of these are inputs only the business can supply. Nothing in the codebase guesses at either,
and neither is worked around.

**The Karnataka public holiday list for the current year.** `isWorkingDay` treats Sunday as the
only non-working day, so every national and state holiday — 26 January, 15 August, 2 October,
Ugadi, Ganesh Chaturthi, Deepavali, Kannada Rajyotsava and the rest — is currently counted as a
working day. The consequences: `workingDaysBetween` **over-counts** the days deducted from a leave
range containing a holiday, the `holiday` member of the `attendance` status ENUM has no writer, and
the muster roll shows a holiday as an ordinary unmarked day. 16.3 records the direction of the
error; this records what would fix it. What is needed is the dated list for the financial year,
which is a `holidays` table plus one branch in `isWorkingDay`, not a redesign. **Not invented**: the
gazetted Karnataka list varies by year and by whether a holiday is a general or a restricted one,
and a wrong date silently mis-costs payroll.

**Per-type leave quotas, §8.6.** `annual_quota` and `carry_forward_max` for each of EL, CL, SL,
LWP, COMP, MAT and PAT. 17.1 is the seam waiting for them. Also unanswered in the same §8.6 block
and needed before this module can be called finished: whether the company is registered under EPF
and ESI (which decides whether `uan`, `pf_number` and `esi_number` are required or optional), and
whether leave accrual runs on the 1 April financial year — assumed yes, matching
`document_numbering` — or on the calendar year.

**Does attendance override approved leave? Same §8.6 conversation, and it belongs to the same
answer.** `hr-attendance-flow.test.ts:911` asserts that marking attendance on a day already covered
by an approved leave request is permitted, and nothing outside that test says so — no spec line, no
section here, and the code does not refuse it only because nobody wrote a refusal. The question is a
policy one: if a person on approved EL turns up and works, is that an attendance row plus a leave day
(paid twice), a cancellation of the leave day, or an error the clerk must resolve before either row
exists?

The reason this is on the blocking list rather than in 20.3's triage is the **failure mode, which is
silent**. A wrong answer produces no error and no missing row: the leave request stays approved, the
attendance row says present, and payroll — which reads both — sees a paid leave day and a worked day
for one calendar day. Nothing in the system disagrees with itself loudly enough to be noticed, and
the discrepancy surfaces as a salary figure nobody can reconstruct. That is why it cannot be repaired
as a test defect: a test cannot be written until it is known which of the three outcomes is wanted,
and the current test pins the one that is cheapest to leave in place, not one that was chosen.

Coupled to the quotas because the same answer decides both: whether an approved day is a *reservation
against a balance* (in which case attendance over it must release the balance) or merely a *record
that permission was given* (in which case both rows are legitimate and payroll needs the rule). No
enforcement should be written for either until this is answered — see 21.1 on the accrual precondition
for the same argument about writing enforcement ahead of the writer that feeds it.

**Also unanswered, and it gates the shape of HR slice 3 rather than a column in it:** §8.6 asks
"Do you use labour contractors, and roughly how many? The whole `labour_contractors` and
`contractor_bills` design in 6.6 assumes yes. If site labour is directly employed instead, that
part of the module changes shape substantially." Slice 3 is built to the spec's design, which
assumes yes. If the answer is no, that slice is dead weight rather than wrong.

## 18. HR, third slice: contractor labour and bills, 2026-09-05

Four files in the projects pattern — `queries.ts`, `schemas.ts`, `service.ts`, `routes.tsx` — plus
`tests/integration/hr-contractor-flow.test.ts` against the dev MariaDB. Spec §6.6 rules 2 and 3,
migration `006_hr.sql`. No finance posting: §6.8 rule 1 is not in this slice.

### 18.1 Contractor labour is a separate ledger, and the separation is asserted, not assumed

`labour_contractors`, `contractor_rates`, `contractor_attendance` and `contractor_bills` share no
identity table with `employees`. There is no `employee_id` anywhere in the four, no row is created
in `employees` for a contractor worker, and **individual workers are not stored at all** — the unit
is a headcount per skill per day, which is what §6.6 rule 2 prices and what a site gate can
actually report. A named-worker register would need Aadhaar or an equivalent identifier, and the
standing constraint is that full Aadhaar is deliberately not stored.

This is a property of the schema rather than of the code, so it is checked by a test that reads
`information_schema.COLUMNS` and fails if any column matching `%employee%` or `%aadhaar%` appears in
those four tables. It will fail the day somebody adds the convenient link, which is the point.

`contractor_attendance` is also a different table from `attendance`, and the two never join. One
consequence worth knowing: `hrDashboard`'s `unapprovedAttendance` counts `attendance` only, so
unapproved contractor days do not appear on the HR dashboard KPI.

### 18.2 Only a `per_day` rate can price a day, so four of the five UOMs cannot reach a bill

`contractor_rates.uom` has five members — `per_day`, `per_sqft`, `per_cum`, `per_kg`, `lumpsum` —
and `contractor_attendance` records a headcount, an overtime figure and nothing else. **There is no
quantity column**, so a piece-rate agreement has nothing to multiply and no path to a bill. This is
a gap in §6.6 rather than a decision: rule 2 says "attendance × rate" and the rate card the same
rule specifies can hold four rates that attendance cannot express.

What is built: the other four UOMs are accepted onto the rate card, because the column has them and
a rate that exists should be recordable, and the attendance entry screen **derives its skill rows
from the `per_day` rates in force on the date being entered**. A skill nobody has priced per day is
never offered, so the service never has to refuse a row the screen invited. Recording one anyway —
through a direct call or a hand-made post — is refused by name.

Not resolved here, and not silently designed around: billing piece-rate work needs either a
quantity column on `contractor_attendance` or a separate measurement table, and both are spec
changes. Flagged for the business rather than chosen.

**Closed on 2026-09-05 by migration 013 — see §19.2.** The quantity column was added, with `uom` and
`work_type` beside it, and all five UOMs now reach a bill. The paragraph above stands as the record of
what was found; the two sentences it ends on are superseded by 19.2, which also repairs the CHECK
constraint 013 got wrong (§19.3). The entry screen no longer derives its rows from `per_day` rates
alone: it renders a day grid from the per-day rates and a second grid from the measured lines in force,
and the two post as one indexed set.

**Overtime is recorded and unpriced.** `overtime_hours` is stored per row and contributes nothing to
`amount_paise`, because the spec gives no overtime multiplier. The entry screen says so. A ceiling of
`headcount × 12` hours is enforced in the schema so a typo cannot store a week in a day.

### 18.3 Three routes are additions to the §6.6 route table, and one of them is load-bearing

The §6.6 route table gives four routes; the page list gives five screens. A page cannot exist
without a route to reach it, so `GET /app/hr/contractor-attendance` and
`GET /app/hr/contractor-bills` (plus `GET /app/hr/contractor-bills/:billId`) are additions of the
mechanical kind.

`POST /api/hr/contractor-attendance/approve` is the one that matters. **Rule 2 bills only rows whose
`approved_at` is set, and nothing in the route table can set it.** Taken literally the module ships a
bill generator that can never find anything to bill. The addition carries
`hr.attendance_approve` — the permission rule 4 uses for the same act on employee attendance — rather
than a new permission key, so the §4.3 matrix is unchanged.

It approves a period rather than a row, because that is how the act happens: a supervisor signs off a
week, not a cell. Two consequences the integration test pins down: correcting an approved row
**clears** `approved_by` and `approved_at`, since the figure that was signed for is no longer the
figure on the row; and re-approving a period reports `{approved, alreadyApproved}` instead of
refusing, so the second click after a correction is not an error.

**Rejected: infer approval from the bill.** Treating "billed" as "approved" would make rule 2's
`approved_at` filter dead code and remove the only check between a gate clerk's headcount and money
leaving the company.

### 18.4 The compliance gate reads the day worked, not today, and a NULL date does not block

Rule 3's checks — labour licence, WC policy, blacklist — run against `attendance_date`, not against
`today()`. For a licence that expired last week both readings agree; they differ only when a day from
**before** the expiry is entered late, and refusing that would refuse to record labour that was on
site while the cover was live. Cost that happened is recorded.

A NULL `licence_valid_until` or `wc_policy_valid_until` does **not** block, because a column that was
never filled has not "passed". A missing licence number is a separate reason and is reported
separately.

**A failure is overridable, a blacklisting is not.** Someone holding
`hr.labour_contractor_manage` can force a day through an expired licence or lapsed WC cover; every
reason forced is written into the `hr.contractor_attendance_record` audit payload as a list, so the
override is a record rather than a bypass. A `blacklisted` contractor is refused outright with no
override, since the point of the status is that no further work is authorised.

### 18.5 The gross is summed, never typed, and an unapproved row stops the bill

Rule 2's gross comes from `SUM(amount_paise)` over the attendance rows in the period. Nothing on the
generate form can change it; everything typed there is a deduction applied afterwards. The rate is
**snapshotted** onto each attendance row as `rate_paise` when the day is recorded, so a later rate
change cannot restate a bill — the integration test records a raise effective 2026-08-06 and proves
the 5 August row is still priced at the old rate.

**An unapproved row inside the period refuses the bill instead of being skipped.** A bill that
quietly left four days out would leave `bill_id` NULL on them and no later period covers those
dates, so they would never surface again. The refusal names the count and the earliest date, and the
fix is one button away on the same screen.

**What stops a day reaching two bills is not a unique index.** `contractor_bills` has exactly one
unique key, `uq_cb_no (bill_no)`; there is no unique constraint on
`(contractor_id, project_id, period_from, period_to)` and overlapping periods are therefore
permitted by the schema. The actual guard is that generation stamps `bill_id` on the rows it billed
under `WHERE bill_id IS NULL` and refuses if the update count does not match the row count, having
taken `FOR UPDATE` on those rows first. Correcting a billed row is refused by name, quoting the bill
number. Anything asserting "one bill per period" has to assert it against that mechanism.

The financial year on the bill number comes from the **first day of the period**, not from today, so
a March period billed in April keeps its own year's series — the same rule as the leave year. A
refused bill burns no number: the deduction check runs before `nextNumber`, and the transaction would
roll it back regardless. The test proves consecutive serials across two bills with a refusal between
them.

### 18.6 Retention, TDS, advance and penalty: where each of the four numbers comes from

Retention and TDS default from `settings` (`finance.retention_default_pct` = 500 bp,
`finance.tds_default_pct` = 200 bp after migration 011) and can be overridden per bill on the form.
A blank field means "use the setting", not "zero". Both are stored as the resulting **paise**;
`contractor_bills` has no column for the percentage that produced them, so the rates and whether
each came from the settings or was entered go into the `hr.contractor_bill_generate` audit payload,
which is the only record of how the figure was reached.

`net_payable_paise = gross − advance_recovered − retention − tds − penalty`. A negative net is
**refused rather than stored**: the column is BIGINT and would hold it, but a bill saying the
contractor owes the company is a debit note and §6.8 has no reading for a negative expense. The
refusal says to recover the balance on the next bill.

**Advance recovered is typed in, because no advance table exists.** Nothing in the schema records a
loan or advance paid to a contractor, so there is nothing to look the figure up from and nothing to
decrement. It is a number the person raising the bill enters and the audit log preserves. A real
advance ledger is a finance concern and is not invented here.

All four are BIGINT paise with a `_paise` suffix, computed by `applyPct` on integers. The integration
test bills a day priced at ₹437.50 precisely so the arithmetic contains a half-paise tie, and asserts
it resolves upward.

### 18.7 §206AA's 20% is not applied; the missing PAN is surfaced instead

A contractor with no PAN attracts TDS at 20% under §206AA rather than the 2% default. **That rule is
not implemented.** `generateContractorBill` returns a `noPan` flag, the generate flash message and the
bill page both warn on it, and the rate used is whatever was entered or defaulted.

Rejected: raising the default to 20% when `pan IS NULL`. Section 206AA has conditions this codebase
has no way to evaluate — the higher of 20% or the specified rate, interaction with the 194C
threshold, and lower-deduction certificates under §197 — and a wrong deduction is money withheld from
a contractor that has to be refunded through a return. Warning a human who can read the certificate is
the honest behaviour until the rule is specified.

### 18.8 The identity finance will key on is `contractor_bills.id`

§6.8 rule 1 turns an approved contractor bill into an `expenses` row. That posting is **not built in
this slice**, and `contractor_bills.expense_id` stays NULL. What this slice guarantees is that the row
it leaves behind already carries the identity that posting will key on:

```
expenses.source_type  = 'contractor_bill'      -- ENUM member, 009_finance.sql
expenses.source_table = 'contractor_bills'
expenses.source_id    = contractor_bills.id
contractor_bills.expense_id -> expenses.id     -- fk_cb_expense, added in 009
```

`contractor_bills.id` is that identity: immutable, auto-increment, what the FK from `expenses` points
back at. `bill_no` (`VARCHAR(24)` UNIQUE, from `nextNumber`, e.g. `NCC/CB/2026-27/001`) is the
human-facing form of the same thing and is what messages quote, but it is not what finance should key
on. The four values above are written into the `hr.contractor_bill_approve` audit payload on every
approval, so the link is legible before the posting exists.

**Discrepancy, closed by 012 — see 19.1.** §6.8 rule 1's prose calls `(source_table, source_id)` a
**unique index**; the spec's own DDL block at `NCC_BUILD_SPEC.md:2013` writes `KEY idx_exp_source`, and
`009_finance.sql:140` reproduced that. When this section was written the conclusion was that changing
it belonged to whoever builds §6.8. That was wrong in one respect: the change is cheapest while
`expenses` is empty and no posting path has been written against the weaker guarantee. Migration
`012_expense_source_unique.sql` makes it `UNIQUE KEY uq_exp_source`. The reasoning, including why NULL
duplicates remain permitted, is in 19.1. The tripwire in the integration test is now inverted and
asserts `NON_UNIQUE = 0`.

### 18.9 A bill above the second-approval threshold is refused, not approved with one signature

Approval resolves an `approval_limits` row for document type **`expense`**. There is no
`contractor_bill` member in that ENUM, and inventing one by migration is a bigger change than reading
a contractor bill as the expense it is about to become.

**The figure checked is the gross, not the net payable.** The gross is the cost committed to the
project; the net is what leaves the bank, and that belongs to `payment_release`.

`approval_limits` is **seeded empty** pending §8.2, so today every approval is refused with a message
saying no limit is set for the role. That is deliberate — a missing row read as "unlimited" is the
failure this table exists to prevent — and the integration test asserts that state, then inserts a
fixture row with a made-up `role_key` to exercise the paths behind it. No real limits are seeded.

Above `requires_second_approval_above`, approval is **refused**. `contractor_bills` has one
`approved_by` column and no `second_approved_by`, unlike `purchase_orders` and `expenses`. Writing a
single signature as `approved` where the limit says two are required is exactly the failure the second
signature exists to prevent, so the code refuses and says why. Unreachable until §8.2 supplies
numbers. A second-approval column is the fix; the test is a tripwire pointing here.

Self-approval is refused before the limit is even resolved: whoever generated the bill cannot approve
it.

### 18.10 What this slice deliberately did not touch

- **§6.8 rule 1, the `expenses` posting.** 18.8 records the identity it will key on. `expense_id`
  stays NULL and the bill page says so in words rather than leaving the field blank.
- **Payment of a bill.** `payment_release` limits, part payments and the bank side are §6.8's.
- **Piece-rate billing** (18.2) and **§206AA** (18.7).
- **An advance ledger** (18.6).
- **The Alpine keyboard matrix.** 17.2 gives it its own slice, immediately after this one. Nothing
  client-side was introduced here: `src/` still contains no `x-data`.
- **No new multipart route.** The 15.1 fence holds; contractor documents are not uploadable and the
  compliance fields are typed dates and numbers.
- **No new `json_valid` reader was needed, contrary to expectation.** `006_hr.sql` declares no JSON
  column among `labour_contractors`, `contractor_rates`, `contractor_attendance` and
  `contractor_bills`, so the count of `JSON_COLUMNS` entries lacking a reader is unchanged at eight of
  twelve. The one JSON read this slice performs is `audit_log.after_json` in the integration test, and
  it goes through `parseJsonColumn`.

### 18.11 Verification record, 2026-09-05 — contractor labour and bills

| Gate | Result |
| --- | --- |
| `npm run typecheck` | clean, no diagnostics |
| `npx tsc -p tsconfig.json --noEmit --listFilesOnly \| grep -c '/src/'` | **71** files compiled |
| `npm test` | 9 files, **246** tests passed |
| `npm run test:integration` | 6 files, **175** tests passed — `hr-contractor-flow` contributes 32 |

Run against the persistent dev MariaDB on 127.0.0.1:3307. The integration suite was run twice in
succession and passed both times, which is also the evidence that the fixture cleanup works — a
leftover `FIXLC-ANNA` would fail the duplicate-code test on the second run.

`tests/integration/hr-contractor-flow.test.ts` covers, in order: the schema-level separation from the
employee master (18.1); rate resolution, including a project rate beating a company-wide one, an
`effective_to` closed by a later line, a refused same-day restatement and an unpriced skill (18.2); the
`uq_ca` insert-then-update branch on the second post of a day, a refused future date, the override
path with its audit payload, the permission refusal and the blacklist refusal (18.4); period approval,
the approval cleared by a correction and the re-approval count (18.3); the unapproved-row refusal,
`bill_id` stamping, the billed-day refusal quoting the bill number, consecutive serials across a
refusal, half-up rounding on a ₹437.50 day and the negative-net refusal (18.5, 18.6); and self-approval,
the empty-`approval_limits` refusal, the gross-versus-limit refusal, a successful approval with the
finance identity in the audit payload and `expense_id` still NULL, the double-approval refusal and the
second-signature refusal (18.8, 18.9).

One tripwire remains deliberate: the second-approval refusal (18.9). It fails when the schema gains
what it describes as missing, and it carries a comment naming this section. The other one, the
`NON_UNIQUE = 1` assertion on `idx_exp_source`, fired as designed within a day: 19.1 closed the
divergence and the assertion is now `NON_UNIQUE = 0` on `uq_exp_source`.

## 19. Corrections made before finance depends on them, 2026-09-05

Slice 3 surfaced schema facts that §6.8 would otherwise be written against, and each is cheaper to
change now than after five posting paths exist. §18 logged them as findings; this section closes them.
19.1 and 19.2 are corrections to the spec's schema; 19.3 is a correction to 19.2's own migration, found
by test within the hour.

### 19.1 `expenses (source_table, source_id)` is UNIQUE — migration 012

§18.8 called this a spec-versus-migration divergence. That was half right, and the correction matters
because it changes who was wrong: **the divergence is inside the spec.**

- `NCC_BUILD_SPEC.md:2013`, in the `expenses` DDL block:
  `KEY idx_exp_source (source_table, source_id)`
- `NCC_BUILD_SPEC.md:2137`, §6.8 rule 1: "A unique index on `(source_table, source_id)` **where both
  are non-null** makes double posting impossible at the database level rather than by convention."

`009_finance.sql:140` reproduced the first one faithfully. It is not a transcription error — the DDL
block is what a migration is written from, and it says `KEY`.

**The prose wins.** A `KEY` is an access path and promises nothing about content; rule 1 is a statement
about what the database refuses, and it is the only sentence in §6.8 that says how double counting is
prevented at all. A schema sketch that contradicts a behavioural guarantee loses to it. Flagged here
rather than settled by editing either line of the spec.

**Why now rather than with §6.8.** Nothing posts into `expenses` yet. Five paths eventually will — GRN,
contractor bill, equipment deployment, campaign spend, payroll — and each will be written assuming a
second attempt is refused underneath it. Adding the constraint afterwards means auditing five call sites
plus whatever they have already written. Adding it against an empty table is one `ALTER`.

**Preconditions, checked rather than assumed** (dev MariaDB, before the migration was written):
`expenses` held **0 rows**, of which **0** had both columns non-NULL, in **0** duplicate
`(source_table, source_id)` groups. Nothing blocked the change.

**NULL stays permissive, and that is rule 1's own wording being met.** Rule 1 says "where both are
non-null". MariaDB has no partial index for that clause and does not need one: a UNIQUE index treats any
row with a NULL in an indexed column as distinct from every other row. So unlimited rows may hold
`(NULL, NULL)` while `('contractor_bills', 7)` may appear once. The manual class rule 1 closes on —
statutory fees, professional fees, site overheads, travel — carries no source document and is
untouched. This is the property to want, not a hole to close later; a strict constraint over NULLs would
permit exactly one direct-entry expense in the company's history.

**Renamed to `uq_exp_source`.** Every other unique key in this schema is `uq_` (`uq_expense_no`,
`uq_period`, `uq_budget`, `uq_cb_no`, `uq_ca`), and an index called `idx_` that silently refuses an
insert is the sort of name that costs somebody an afternoon. One `ALTER` does the `DROP` and the `ADD`,
so the pair is never unindexed. Both columns also gained a `COMMENT` naming the constraint and this
section.

**Three tests, in `tests/integration/hr-contractor-flow.test.ts`.** The old tripwire is inverted: the
only index over those columns is `uq_exp_source` with `NON_UNIQUE = 0`, which also fails if a future
migration leaves both indexes in place. Five rows with no `source_id` insert without complaint, three
fully manual and two with `source_table` set and `source_id` NULL — half a pair is exempt by the same
rule, and the migration comment claims it, so it is asserted. The refusal test calls no service at all:
the same insert runs twice with `source_id = contractor_bills.id`, and the second comes back
`ER_DUP_ENTRY`, `errno 1062`, message naming `uq_exp_source`. Asserting the errno is the point — it is
what distinguishes the database refusing from a service check refusing, and rule 1 asks for the former.

### 19.2 `contractor_attendance` can price measured work — migration 013

**§6.6 omitted the quantity.** The spec gives `contractor_rates` a five-member UOM enum:

```
uom ENUM('per_day','per_sqft','per_cum','per_kg','lumpsum')
```

and then gives `contractor_attendance` — the only table §6.6 rule 2 bills — a `headcount`, an
`overtime_hours`, a snapshot `rate_paise` and an `amount_paise`. There is no column holding a measure.
So a per-sqft rate could be entered on the rate card and multiplied by nothing: `applicableRate` carried
a hardcoded `where uom = 'per_day'` for exactly that reason. **Four of the five members of a declared
enum could not reach a bill.** §18.2 recorded it as a structural gap; this closes it.

**Not a trim of the rate card.** The alternative was to drop the four unreachable members and bill days
only. That was rejected: interiors work is quoted per square foot for false ceiling and per running foot
for wardrobes as a matter of course, `neelachandrainteriors.com` is in scope (§8.10), and the enum is
therefore describing the business correctly. The attendance table was the side that was short.

**Now reachable, and how each is priced.** `per_day` multiplies `rate_paise` by `headcount`, exactly as
before — no existing row or code path changed meaning. `per_sqft`, `per_cum` and `per_kg` multiply
`rate_paise` by `quantity` and round to paise. `lumpsum` is reachable by the same arithmetic with
`quantity` read as the number of times the sum is due, which is a reading rather than a spec statement
and is flagged below. So: **five of five reachable, one of them on an assumed interpretation.**

**Three columns, because pricing a measured line needs three facts** — `quantity DECIMAL(14,3)` (the
type §6.8 already uses for `budget_lines.qty`, so the eventual posting is a copy rather than a
conversion), `uom` (snapshot beside `rate_paise` for the same reason `rate_paise` is snapshot at all: the
row must stay readable after the rate card moves under it), and `work_type`. The third is the
non-obvious one: a day rate is resolved by skill level, but a per-sqft rate is *for plastering* or *for
tiling* and one contractor may hold both open at once, so skill level cannot choose between them.
Without it `applicableRate` would fall back to "latest `effective_from` wins" — an arbitrary choice
between two very different amounts. `contractor_rates` supersession is keyed on
`(contractor_id, work_type, uom, skill_level, project_id)`, so both lines legitimately stay open.

**Deviation from the instruction, flagged not taken silently.** The instruction said *additive and
nullable*. `quantity` and `work_type` are nullable; **`uom` is `NOT NULL DEFAULT 'per_day'`**. Nullable
is what protects rows already written, and a column whose default is the only value those rows could
have had protects them identically — while leaving every reader free of a `uom ?? 'per_day'` coalesce
that would otherwise be permanent. Additive it is: no column changed type, no index changed, no row was
rewritten.

**`uq_ca` is untouched, and that has a consequence.** The key stays
`(contractor_id, project_id, attendance_date, skill_level)`, so a day holds exactly one row per skill
level whatever the unit. Therefore **300 sqft of plastering and 40 sqft of tiling, by the same masons on
the same day at the same site, cannot both be recorded.** Widening the key is a change to an existing
UNIQUE index and is not additive, so it is not in 013. Recorded here rather than designed around: the
entry screen carries a hint saying a day holds one row per skill level whatever the unit, and the schema
refuses the collision with that sentence rather than letting MariaDB throw 1062 at a gate clerk. If the
owner answer below says one crew routinely does two measured work types in a day, the key has to widen
to include `work_type` and that is a migration with a real backfill decision in it.

**Unconfirmed, pending an owner answer: the real UOM mix.** Nothing in the spec or in any answered
question says which units Neelachandra actually bills contractors in, in what proportion, or whether
`lumpsum` means a fixed sum per occurrence (the reading implemented) or a fixed sum for a whole scope
that attendance should not touch at all. Every UOM is reachable, and which ones matter is a guess. Two
things follow if the answer arrives differently: the `lumpsum` arithmetic may be wrong, and the `uq_ca`
consequence above may be a daily obstruction rather than a rare one. **Do not read the five reachable
units as evidence that five are used.**

**A headcount is still required on a measured row**, and that is a choice. The quantity is what prices
such a row, so the headcount is not arithmetically needed — but `headcount SMALLINT UNSIGNED NOT NULL`
has no default, the table is called attendance, and whoever knows 300 sqft was plastered knows how many
masons did it. What is *not* permitted is a quantity with the headcount cell left blank: the entry
grid's blank-means-skip rule would drop the row and the measure with it, so that combination refuses
instead of vanishing. That is the one refusal in this change that exists because of a UI rule rather than
a schema one, and it is the one worth keeping if the grid is ever rewritten.

**Three gates on one fact, deliberately.** `recordContractorAttendance` refuses at entry with a message
naming the unit ("A per sqft rate is priced by the measure, so enter a quantity above zero");
`chk_ca_quantity` makes the row unwritable; `generateContractorBill` refuses to sum a measured row with
no quantity into a gross. The last is not redundant — it is the layer that can name which row and which
period, it is what stands between the row and a payable amount, and 19.3 is the reason it earned its
place on the first day.

**Tests.** Ten unit cases in `tests/hr-schemas.test.ts` (27 → 37) pin the form contract, including the
one that matters most: the two grids post into **one** indexed set of six repeated field names, so a
blank line in the day grid must not shift the measured grid's quantities up a row. Six integration cases
in `tests/integration/hr-contractor-flow.test.ts` (34 → 40) bill a non-day UOM end to end against
MariaDB — the rate chosen by work type rather than skill level, two per-sqft lines open at once with
`ambiguous: true` when the work type is omitted, `4550 × 240.5 = 1,094,275` paise off a `DECIMAL(14,3)`
that arrives as a string, `675075 × 3.5` rounding half up to `2,362,763`, and a bill whose gross mixes a
measured amount with a day-rate one and whose audit row records `measured_rows: 2` of 3.

### 19.3 A CHECK constraint admits UNKNOWN — migration 014

013 shipped this constraint and a header claiming it makes a measured row with no measure unwritable:

```sql
CHECK ((uom = 'per_day' AND quantity IS NULL) OR (uom <> 'per_day' AND quantity > 0))
```

**It does not.** A CHECK refuses a row only when its expression evaluates to FALSE; UNKNOWN passes. For
`uom = 'per_sqft'` with `quantity = NULL`:

| disjunct | evaluates to |
| --- | --- |
| `'per_sqft' = 'per_day' AND NULL IS NULL` | `FALSE AND TRUE` → **FALSE** |
| `'per_sqft' <> 'per_day' AND NULL > 0` | `TRUE AND NULL` → **NULL** |
| the whole clause | `FALSE OR NULL` → **NULL** → **admitted** |

So the one row the constraint existed to refuse was the one row it let through. The three other shapes
were refused correctly, because each compares a quantity that is present: a day row carrying a quantity
and a measured row carrying `0` or a negative both give `FALSE OR FALSE`.

**Found by test, not by reading.** The integration case asserting the refusal in both directions saw the
INSERT succeed, and then a later count in the same file came back 4 instead of 3 because the admitted row
had been approved. Worth stating plainly: the constraint had been eyeballed, the migration header argued
for it at length, and it was wrong. The reason the suite caught it is that the test inserts through
`db` with no service in the way and asserts `errno`, so there was nothing to mask it.

**This is the second time in one slice that a constraint's stated meaning and MariaDB's NULL semantics
disagreed — and in opposite directions.** 19.1 wants the permissiveness over NULLs and documents it as
the requirement being met. 19.2 wanted strictness and silently got permissiveness. The generalisation
worth carrying forward: **three-valued logic is not a footnote in either direction, and a constraint over
a nullable column is not verified until a row with a NULL in it has been refused by the server.**

**The fix** tests for presence before comparing, so the disjunct is FALSE rather than UNKNOWN when the
quantity is missing (`FALSE AND NULL` is FALSE, so the ordering carries it):

```sql
CHECK ((uom = 'per_day' AND quantity IS NULL)
    OR (uom <> 'per_day' AND quantity IS NOT NULL AND quantity > 0))
```

Forward migration, `DROP CONSTRAINT` then `ADD CONSTRAINT`, no column and no row touched. **Preconditions
checked rather than assumed:** `contractor_attendance` held 0 rows, of which 0 were measured-with-NULL,
0 were day-with-a-quantity and 0 were measured-with-non-positive. Nothing blocked the `ALTER`, which
validates the table as it stands and would have failed loudly if a row had used the hole.

**Verified by probing the server directly**, not by re-reading the clause: `('per_sqft', NULL)`,
`('per_sqft', 0)` and `('per_day', 5)` each come back `errno 4025` naming `chk_ca_quantity`, while
`('per_sqft', 240.5)` and `('per_day', NULL)` get past the CHECK and are stopped only by a foreign key —
which is the proof they passed it. The integration test now asserts the clause text contains
`quantity` IS NOT NULL as a tripwire, because "the constraint exists" is exactly the assertion that was
true while the constraint was broken.

## 20. Constraints made real, 2026-09-05

19.3 fixed one CHECK constraint. This section is what followed from asking whether the mistake it
recorded was an incident or a class, and then closing the two places where the schema states a rule it
does not enforce. Same day, same tables, before finance is built on either.

### 20.1 The CHECK sweep found one bug, already fixed, so the deliverable is a rule

**Fourteen migrations were written before three-valued logic was understood**, so every CHECK in the
schema was swept. The inventory, from `information_schema.CHECK_CONSTRAINTS` against the migrated dev
database rather than from reading the migrations:

| Constraint | Table | Columns it references | Nullable? | Vacuous for some row shape? |
| --- | --- | --- | --- | --- |
| `chk_ca_quantity` | `contractor_attendance` | `uom`, `quantity` | `quantity` yes | No, since 014. Yes as 013 wrote it |
| `value_json` | `settings` | `value_json` | No | No — NULL cannot arise |
| `content_json` | `site_pages` | `content_json` | No | No — NULL cannot arise |
| `schema_types` | `site_pages` | `schema_types` | No | No — NULL cannot arise |
| `content_json` | `site_page_revisions` | `content_json` | No | No — NULL cannot arise |
| `after_json` | `audit_log` | `after_json` | Yes | Permissive over NULL, by design |
| `before_json` | `audit_log` | `before_json` | Yes | Permissive over NULL, by design |
| `detail_json` | `dashboard_daily_snapshot` | `detail_json` | Yes | Permissive over NULL, by design |
| `response_json` | `email_log` | `response_json` | Yes | Permissive over NULL, by design |
| `visible_to_roles` | `project_documents` | `visible_to_roles` | Yes | Permissive over NULL, by design |
| `payment_schedule_json` | `quotes` | `payment_schedule_json` | Yes | Permissive over NULL, by design |
| `schema_types` | `site_page_revisions` | `schema_types` | Yes | Permissive over NULL, by design |
| `body_json` | `site_services` | `body_json` | Yes | Permissive over NULL, by design |

**Twelve of the thirteen are not in any migration.** MariaDB implements a `JSON` column as `LONGTEXT`
plus an automatic `CHECK (json_valid(col))` named after the column, so a grep for the word CHECK across
all fourteen files finds two non-comment lines, both `chk_ca_quantity` — 013 creating it and 014
replacing it. Anyone auditing the schema by reading the migrations sees one constraint and there are
thirteen.

**The eight nullable `json_valid` constraints are permissive over NULL and are left alone.**
`json_valid(NULL)` is NULL, so the CHECK admits the row — the same rule that made 013 vacuous, wanted
here, because a nullable JSON column means the document may be absent. The constraint still bites on
every other shape: `json_valid('')` is 0, and the empty string is the one that matters, because a form
field submits `''` rather than NULL and `src/lib/json.ts` is what turns that into a NULL. So: correct as
they stand, and **the repair list from the sweep is empty**. No sweep migration was written.

**What was added instead is the rule, as a test.** `tests/integration/schema-constraints.test.ts`
enumerates the constraints, separates the auto-generated ones from the explicit ones by shape, requires
the explicit set to equal a list the file classifies, and fails when any explicit constraint compares a
nullable column without an `IS NOT NULL` guard in its clause — unless the constraint is recorded in that
file as deliberately permissive with a reason. A new CHECK in a migration cannot land without the NULL
question being answered, which is the part of 19.3 that generalises. The file also runs the 19.3 truth
table as SQL and proves on `dashboard_daily_snapshot.detail_json` that a nullable JSON column takes a
NULL and refuses malformed text with `errno 4025`.

**The rule was verified by regression, not by reading.** 013's clause was put back on the table by hand:
the test fails naming `chk_ca_quantity` and `quantity`. 014's clause: it passes. A tripwire nobody has
seen fail is a tripwire nobody knows is connected.

**The same mechanism now covers the twelve, because that is the set that grows.** An explicit CHECK is
written by hand and reviewed; an automatic one arrives with a `JSON` column and is invisible in the
migration. So `AUTO_JSON_CHECKS` in the same test file records each of the twelve as `table.column` ->
the nullability decided for it plus the migration line that declared it, and three assertions hold it:
the enumerated set must equal the recorded set, the recorded nullability must still match the schema
column by column, and every nullable entry must cite something. Adding a JSON column therefore fails the
suite until someone states whether its nullability is intentional — which is the decision that was never
made for the twelve that already exist. **Verified the same way:** a throwaway `zz_throwaway_json JSON
NULL` on `dashboard_daily_snapshot` produced 4 failures across 2 files, each naming the column, and the
column was dropped again.

**Side finding, reported and left.** `site_pages.schema_types` is `JSON NOT NULL` (007:27) while
`site_page_revisions.schema_types` is `JSON NULL` (007:51), uncommented, and spec :1387 says "every
publish snapshots the previous state". A snapshot column that can be NULL where the column it snapshots
cannot be is not a faithful snapshot. §7 marketing is unbuilt and nothing writes either table, changing
nullability is not a CHECK repair, and it is a second instance of the prose-and-DDL disagreement recorded
in 21.3 — so it is logged here rather than fixed.

### 20.2 A UNIQUE index cannot say "both or neither" — the expenses source pair

**What was open.** 012 made `expenses (source_table, source_id)` UNIQUE and both columns nullable, and
19.1 records why the nullability is deliberate: a UNIQUE index treats a row with a NULL in an indexed
column as distinct from every other such row, so the manual expenses — both NULL, and the majority of
the table — do not collide with each other. That reasoning stands. What it also admits is

```
source_table = 'contractor_bills', source_id = NULL
```

a row that claims to be the posting of an upstream document and points at no row.

**The index structurally cannot refuse it, and no version of it can.** A UNIQUE index constrains rows
*against each other*; this row is wrong *on its own*. It is not a duplicate of anything — two of them do
not even collide, because for indexing purposes one NULL is not equal to another. Making the columns
`NOT NULL` would close it and break direct entry, which is the larger half of the table. So the choice is
not between index designs. **A CHECK is the only mechanism that closes it**, and `chk_exp_source_pair` in
migration 015 is that CHECK:

```sql
CHECK ((source_table IS NULL AND source_id IS NULL)
   OR (source_table IS NOT NULL AND source_table <> ''
       AND source_id IS NOT NULL AND source_id > 0))
```

**Written so the 014 mistake cannot recur, by construction rather than by a guard bolted on.** `IS NULL`
and `IS NOT NULL` are the two predicates in SQL that never return UNKNOWN, so a clause built only from
them has no third outcome to leak through. The two comparisons that are not null predicates — `<> ''`
and `> 0` — sit behind the `IS NOT NULL` test in the same conjunct, so neither can be reached with a NULL
operand.

**Why it matters more than an edge case.** 6.8 rule 1 is "actuals are never typed where another module
already produced them", and the pair is the evidence of which document produced the money.
`source_table IS NOT NULL` is the natural way to ask "is this a posted actual or a manual entry", and a
half-populated row answers *posted* while being unreconcilable to anything. The mirror shape, an id with
no table, is an orphan no join can resolve.

**The sentinel values are in the same constraint deliberately**, and this is wider than the instruction
that prompted it, which said both-or-neither. `source_table = ''` with an id, or a real table with
`source_id = 0`, satisfies both-or-neither and still refers to nothing: `''` is not a table name and 0 is
not an `AUTO_INCREMENT` id. Same defect, same constraint, no second migration later. Flagged in the
report rather than done quietly.

**`source_type` is deliberately not tied in.** Requiring `source_type = 'manual'` to imply a NULL pair,
and each other member to imply its own table name, means writing the map from ENUM member to table into
the constraint: six branches to edit whenever a posting path lands, and two members (`campaign_spend`,
`payroll`) have no posting path yet. The pair constraint holds whatever `source_type` says, which is what
makes it the one that closes the hole. Considered and rejected, not overlooked.

**Preconditions counted before applying:** `expenses` held 0 rows — 0 half-populated by table, 0 by id,
0 carrying a sentinel. The `ALTER` validates the table as it stands, so it would have failed loudly on a
row that used the hole. Nothing under `src/` inserts into `expenses` yet (0 hits for
`insertInto('expenses')`); `hr/service.ts:2316` records in an audit payload what the finance posting
*will* write, which is where the shape came from.

**Asserted against the server:** both NULL inserts and is read back; `('contractor_bills', NULL)` and
`(NULL, 4242)` come back `errno 4025` naming `chk_exp_source_pair`; so do `('', 4242)` and
`('contractor_bills', 0)`; two different documents in the same table both insert; and the same document
twice is refused `errno 1062` naming `uq_exp_source` — the two mechanisms separable in one test, which is
this section's argument stated as an assertion.

**Still open: `source_type` is not tied to the pair, and should not stay advisory forever.** Today the
constraint says the pair is whole or empty and says nothing about which ENUM member claims it, so
`source_type = 'manual'` with a full pair, or `'grn'` with an empty one, are both writable. The reason is
that the map from ENUM member to table name does not exist anywhere yet. **When finance lands it will
exist in code** — each posting path names its own table, the way `hr/service.ts:2316` already names
`'contractor_bills'` — and at that point the map is a fact about the system rather than a guess, and this
constraint should be extended to match it: `'manual'` implies an empty pair, every other member implies
its own table name. Recorded as a precondition on §6.8 rather than a preference, because the longer it
stays advisory the more postings exist to migrate.

### 20.3 Triage of six comment-justified assertions, none fixed

Found by grepping the suites after 20.2, under the CLAUDE.md rule it produced. Recorded rather than
repaired: four of the six need an answer or a different session's attention, and repairing a test whose
basis is unknown is how a wrong assertion gets a confident new comment.

**Two are genuine defects.**

`tests/integration/hr-contractor-flow.test.ts:989` — the docstring quotes 6.8 rule 1 and cites 19.1
correctly, and is right about identical pairs. The child test asserted something about *half* pairs, which
rule 1 does not mention, and took the parent's credibility for it. A real citation stretched one step. This
is the failure that actually let the source-pair hole survive, and it is why CLAUDE.md now carries a second
clause: **a citation covers the shape it names and no adjacent shape.** The first clause would not have
caught it, because there was a citation.

`tests/inventory-schemas.test.ts:216` — "The system quantity is deliberately absent from the form and the
POST: `postAdjustment` reads it inside the transaction from the row it locks." The stated basis is the
behaviour of the code under test, so the assertion **cannot ever disagree with the implementation**:
change `postAdjustment` and the justification changes with it. Circular in the original way, and the claim
it is making — that a physical count must not be able to submit a system quantity — is a real control
worth a real citation.

**Two are undocumented domain assumptions. They need an owner's answer, not a repair.**

`tests/hr-schemas.test.ts:156` — "accepts one time without the other, because a half day may have only
one." Plausible and unstated: whether a half day records one punch or two is a payroll question.

`tests/integration/hr-attendance-flow.test.ts:445` — "`attendanceOn` takes no project on purpose: an
overhead day showing as unmarked would invite a supervisor to enter it again against a project." A UX
argument for a query's shape, written with the test. It may well be right.

**One is sound and gets tightened opportunistically.** `hr-contractor-flow.test.ts:395` cites "Rule 2" by
number rather than by line. Substantively correct; the line number goes in the next time that file is open
for another reason.

**The sixth is a policy claim, not a test problem, and is now on the §8.6 blocking list in 17.**
`hr-attendance-flow.test.ts:911` asserts that a write is permitted over a day covered by approved leave.
That is a statement about attendance overriding leave, which nobody has ratified, and the reason it is on
the blocking list rather than in this triage is that **if it is wrong the error is silent**: the leave stays
approved, the attendance row says the person was present, and payroll sees both. Same conversation as the
quotas, and the same answer decides both.
