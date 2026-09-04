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
| 8.1 | Actual org chart and roles | phase 2 | roles are provisional (2.5); no real staff rows exist |
| 8.2 | Approval limits | phase 7 | finance approval thresholds unseeded |
| 8.3 | Stage templates and payment milestones | phase 3 | `stage_templates` seeded from the spec's example only |
| 8.4 | Material consumption norms | phase 4 rule 4 | consumption variance cannot be computed |
| 8.7 | Offline capability | phase 3 | assumed yes (2.4) |
| 8.11 | Hosting plan specifics | phase 0 | MariaDB assumed; collation depends on it (2.1) |
| 8.12 | Freeze scope, and the sign-off owner | phase 1, 9 | no named owner to sign off a gate failure (4.4) |

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


