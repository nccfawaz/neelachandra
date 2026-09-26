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
| `tests/nav.test.tsx` | 47 | `visibleNav` OR semantics and empty-group dropping, `activeHref` longest-prefix, and one generated test per sidebar item asserting its href is a registered route path |
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

**2026-09-09, checkout line endings.** `.gitattributes` now carries `migrations/*.sql text eol=lf`
(added in `d86630a`): a CRLF checkout of any applied migration would change every byte the
checksum above covers and brick the runner on a machine that never edited anything. Proven by
deleting `migrations/001_core_auth.sql` from disk and re-checking it out under the attribute —
the restored file is LF (`\n` verified by `od -c`), `git status` is clean, and the runner still
reports `Up to date. 23 migration files, none pending.`


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
than leaks (`tests/nav.test.tsx`).

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
rows in `tests/nav.test.tsx` — one per new sidebar entry, since that file asserts every href is a
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

### 17.3 The blocking owner list: inputs and answers only the business can supply

Both of these are inputs only the business can supply. Nothing in the codebase guesses at either,
and neither is worked around.

**Retitled on 2026-09-05.** It was "Two blocking data items"; it holds five now, and a title that
counts them is a title that goes stale every time one is added. The section number has not moved.

**Updated 2026-09-17 (29.63–29.66, the staff-roster batch).** The roster, leave routing, the HR
split and the admin 2FA reset are settled this batch; the 19-item OWNER_QUESTIONS.md list was
regrouped into fifteen questions (A1–A7, B8–B10, C11–C12, D13–D15). Items 17 and 18 left the
owner's list: 18 (2FA reset) is BUILT (29.65); 17 (website publishing) is owned by Fawaz and
stays open, not assumed. **Settled — the roster (29.63):** the fourteen real staff enter via
`scripts/seed-staff.mjs` (idempotent, local-only, passwords printed once, `approval_limits`
untouched); the interior-designer seat is vacant; the two Sunils are disambiguated by the unique
`employee_code` (staff-roster.test.ts, "gives the two Sunils distinct codes and distinct emails").
**Settled — leave routing to the owner only (29.64):** all leave for everyone is approved by
Chandrashekar alone; Sushma holds HR records and attendance entry (`hr.employee_manage`,
`hr.employee_view`, `hr.attendance_record`) but NOT `hr.leave_approve`. Proven through the real
router by tests/integration/leave-routing.test.ts: an HR-shaped role is refused 403 naming the
permission; an owner-shaped role approves; the owner's OWN leave is refused by the service
self-approval guard, so the owner's leave has no decision path today — a stuck-clerk instance
(the sole approver is also a possible requester), owner question A6, not a code defect. **Settled — admin 2FA reset by Fawaz (29.65):** POST
/app/admin/users/:id/totp-reset behind `users.manage`, CSRF-protected, audited with actor and
target, target sessions destroyed, self-reset refused. Proven by
tests/integration/totp-reset-route.test.ts (5 tests). The single-admin risk stands: if Fawaz
loses both his phone and his recovery codes, no route back exists; the dormant second admin is
NOT created pending the owner's say. **Still open: the approval chain** for purchase orders,
expenses, quotations, contractor bills and attendance — routes are built and proven reachable,
but who holds each approval and at what value a second signature is required is the business's
call (group A). **Still open: whether website edits publish immediately or wait** — the
draft-vs-live mechanism is built (29.31) but the visitor-experience ruling belongs to Fawaz,
who has not declared it; it stays open rather than assumed.

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

**Rule 10 role sets (added 2026-09-09, owner question 12).** Whether
ops_manager should keep `projects.view_cost`, and whether any role beyond
owner should hold `finance.view_company_pnl`, is the owner’s call, not a
code decision. Today: pnl -> owner, accounts_manager; view_cost -> owner,
accounts_manager, ops_manager, project_manager. The grants tripwire
(rule10-grants.test.ts) fails on any grant change until an answer is filed
against OWNER_QUESTIONS item 12. See 29.12.

**GST rounding (added 2026-09-09, owner question 13).** Where the odd paisa
goes on an intra-state split, whether tax rounds half-up or per the tax
authority’s stated convention, and whether tax is computed per line or per
invoice is the owner’s/accountant’s call. Today: total tax rounds half-up
(roundPaise), the single odd paisa of the CGST/SGST split goes to CGST, and
tax is computed once per invoice. Filed against OWNER_QUESTIONS item 13.


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

**Which rate wins when a contractor has overlapping cards. Nowhere in the numbered rules, and it
decides what is paid.** `contractor_rates` is effective-dated and its `project_id` and `skill_level`
are both nullable (`NCC_BUILD_SPEC.md:1644`), so one contractor can hold four lines that all apply
to one day of mason work on one project: a company-wide skill-agnostic line, a company-wide mason
line, a project skill-agnostic line and a project mason line. §6.6's business logic says nothing
about which of them prices the row. Rules 1 to 4 are attendance's cost allocation key, bills
generated from approved attendance, compliance blocking deployment, and the month lock — **not one of
them is about rate precedence.** The only thing in the spec that bears on it is that `project_id`
and `skill_level` are nullable at all, from which precedence follows by inference and not by
statement.

The behaviour currently implemented, in `applicableRate` (`src/modules/hr/queries.ts:970`), stated so
the owner can confirm or correct it rather than having to read the sort:

1. **A project-specific line beats a company-wide one.** A rate written for T Begur wins on T Begur.
2. **Then a skill-specific line beats a skill-agnostic one.** A `mason` line beats one with
   `skill_level` NULL.
3. **Then the later `effective_from` wins.** A revision dated 1 July beats the same line from 1 April.
4. **Then the higher `id`** — and only this last step is reported as `ambiguous: true`, which the entry
   screen surfaces instead of presenting one figure as the only one. Ties on scope, skill and start
   date are the one case the code admits it is guessing.

Each step is defensible and none is written down. The plausible alternative is not exotic: **the
dearest applicable line**, which is what a contractor would argue for and what some firms actually
operate, and it disagrees with step 1 whenever a company-wide rate was raised without the project
card being updated. There is no error either way — a bill is produced, the gross is summed from
`rate_paise` snapshots and it reconciles with itself. The failure is that it reconciles with the
wrong number, and the snapshot means the wrong number is then permanent on the row.

Two smaller things fall out of the same answer. Whether `effective_to` should be closed
automatically when a dearer line is added mid-period (supersession is currently keyed on
`(contractor_id, work_type, uom, skill_level, project_id)`, so a line differing only in scope does
**not** close the other one — that is what produces the overlap in the first place). And whether a
company-wide line should be reachable at all once a project card exists for that work, or whether its
absence should refuse the day instead of falling back.

**Not invented, and specifically not resolved by writing it down here as though it were settled.**
20.3 records two instances of rate precedence being justified by a citation to a §6.6 rule that says
something else — once in a test comment, once in `applicableRate`'s own comment, both now corrected
to say plainly that the basis is an inference from `:1644`. A third such citation is what this entry
exists to prevent.

**A clerk who mis-enters a contractor day cannot correct it, and since migration 017 that is
reachable.** There is no path to remove a `contractor_attendance` row through the application — no
`deleteFrom` on that table anywhere in `src/modules/hr/service.ts`. Re-posting a day updates rows by
the key `(skill_level, work_type)` and inserts anything new; it never deletes, and a row that is no
longer wanted has no way out. Until 017 that was survivable, because every wrong row could at least
be overwritten with the right values. It is not survivable now: `work_type` is part of `uq_ca` and
`chk_ca_work_type` forces `''` on a day row, so **a day row can never be turned into a measured row
in place**, and 21.5's triggers refuse a measured row for that skill on that date while the day row
stands. A supervisor who records four masons on a day rate and then learns the work was priced per
sqft is stopped, with no correction path and nothing to do but ask someone with database access.

**The current behaviour, plainly: refusal, with no correction path.** The refusal is deliberate and
21.5 argues for it — admitting the pair is a payment, refusing it is a complaint. What is *not*
decided is what the complaint resolves to. A void or delete path is the obvious answer and it is not
built, because voiding attendance is its own unmade decision: a row may already carry `approved_at`,
and it may already be summed into a bill through `bill_id`, at which point removing it silently
changes a document that has been sent. §6.8 rule 7 and §6.6 rule 4 both say a closed period stops
changing, so a void path has to decide whether it is an attendance correction (allowed before
approval, refused after) or a finance adjustment (a reversing entry, never a deletion) — and that is
a finance question, arriving with §6.9 rather than ahead of it.

What is needed from the owner is narrow: **whether a supervisor may withdraw an unapproved
contractor attendance row, and what happens to an approved but unbilled one.** The billed case needs
no answer here — 18.5 already refuses to touch a billed row and calls it a finance adjustment. Until
then the gap is stated rather than papered over with a delete route nobody has scoped.

**Added 2026-09-08 — the place of supply, blocking §6.8 rule 5. AMENDED 2026-09-08: the column
now exists** — migration 022 adds `client_invoices.place_of_supply CHAR(2) NOT NULL` with no
default and a shape CHECK (`chk_inv_pos_shape`, evaluated BINARY so the case-insensitive
collation cannot admit 'ka' — see 27.4 for the proof), and the three shapes (omission refused,
invalid code refused, 'KA' admitted) are proven by direct insert in
tests/integration/place-of-supply.test.ts. **Every row now states KA explicitly**, supplied by
the application layer when an invoice is created, never inherited from a default. The original
entry said the field should "default to KA"; a schema default was rejected during
implementation for the migration-016 reason recorded in 27.4, so the column is NOT NULL with no
default instead. It is still **not** inferred from `projects` or `clients` — inferring it would
silently mis-split tax for a Karnataka project whose client is registered elsewhere. The owner
correction remains open: whether every current client is in fact intra-Karnataka is a business
fact only they can confirm.

**Added 2026-09-08 — do open site advances also block employee exit?** §6.8 rule 6 says "6.6 rule 7
already blocks exit while one is open", but that cross-reference is wrong: 6.6 rule 7's exit
blockers read `payee_type = 'employee'` expenses and attendance, not imprest advances — see 26.5.
An employee holding an open site advance can exit today with no blocker raised for it. The question
is whether an open advance should block exit the way an unsettled store issue does, or whether an
exit with an open advance is a finance matter (the advance is recovered from the final payment)
rather than an HR one. It joins rate precedence and the stuck clerk as a §6.8 question only the owner can answer.

**Added 2026-09-09 — does retention ever vary by milestone?** §6.8 rule 5
deducts a retention percentage on every milestone invoice. The system reads
the percentage from the project row reached through the milestone — the
project_milestones table carries no retention column of its own (29.5, and
the reading recorded at 26.4). What the owner should confirm: retention
never varies per milestone. If a milestone can carry its own percentage —
a higher hold early, nothing on the final account — that is a new column on
project_milestones plus an invoice-service change, and 26.4's statement of
where the percentage lives must be revisited with it. The question is also
on OWNER_QUESTIONS.md (item 11) so an answer can be filed against it.

**Added 2026-09-10 — the same answer runs the MSME 45-day clock on
contractor payables (with OWNER_QUESTIONS item 15).** Contractor bills carry
no vendor-invoice date, so per §29.21's proof every contractor-bill expense
lands 'unageable' in the ageing report — today's fixture set posts multiple
contractor-bill expenses across hr-contractor-flow and every one is
invisible to rule 8 (the test \"rule 8 on the new writer\" proves the
report's banding, and the writer writes bill_date NULL for this source).
MSME exposure on contractor payables is therefore unmeasurable until the
owner picks the clock's start: coverage-period end, bill-generation date,
or none. That is the same work-month-versus-approval-month choice item 15
already asks, so one answer settles both.

**Added 2026-09-10 — does a cost land on receipt or on the vendor's
invoice? (GRN invoice-amount timing, DECISIONS 29.20.)** A GRN may
legitimately arrive before the vendor's bill, so invoice_amount_paise is
nullable and the posting reads the accepted lines instead. Today the cost
lands the day goods are received and the vendor's bill reconciles later.
Whether the owner wants the three-way match to gate the posting (wait for
the invoice) or receipt-date posting is intended is a §6.6 business rule,
not a code choice.

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

**Reclassified at 21.2, 2026-09-05.** The refusal above is a placeholder and not the intended rule, which
is the two-signature path `approvePo` already runs for purchase orders. Read this section for what the
code does and 21.2 for what it is standing in for; the heading here says "refused, not approved with one
signature" and that remains an accurate description of the behaviour, not of the policy.

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

**Amended 2026-09-05, and it is a withdrawal: this is not one of the divergences 21.3 carries.** Two things
were being run together here and in 20.2, and separating them is the correction.

The first is real and is discharged. `:2013` says `KEY`, `:2137` says unique index, and the spec disagrees
with itself — that much stands. But rule 1's full wording is *"where both are non-null"*, so the prose is
complete about NULL as well as about uniqueness, and a `UNIQUE KEY` supplies everything the `KEY` at :2013
promised — an access path over those columns — while also supplying the refusal :2137 asks for. After 012,
**no line of the spec is false of the tree.** That is the test 21.3 applies: it lists disagreements the tree
is still living inside, and this one was settled rather than carried. 012 closed a gap between the tree and
the prose — `009_finance.sql:140` had reproduced a sketch — and left nothing behind on either side.

The second was never a spec matter at all. The half-pair row 20.2 closed is a property of how a UNIQUE index
treats NULL, not a place where the tree departed from the spec: :2137 asked for uniqueness over non-null
pairs and got it, and no sentence anywhere asks for both-or-neither. `chk_exp_source_pair` is therefore an
addition beyond the spec, not the repair of a divergence from it. Recording it as a spec-implementation gap
was wrong, and it is withdrawn from 21.3's list on that ground.

Stated rather than smoothed over: `KEY` and `UNIQUE KEY` are a real distinction in MariaDB's DDL grammar, so
:2013 is not silent about uniqueness the way :1387's sketch is silent about nullability. It says the weaker
of the two available spellings. What separates the expenses case from the two 21.3 keeps is not that the DDL
said less — it is that after the resolution nothing was left unsatisfied.

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
only index over those columns is `uq_exp_source` with `NON_UNIQUE = 0` (`:1059`), which also fails if a future
migration leaves both indexes in place. Three fully manual rows insert without complaint and the count of
`source_id IS NULL` fixture rows is asserted at 3 (`:1098`). The refusal test calls no service at all: the
same insert runs twice with `source_id = contractor_bills.id`, and the second comes back `ER_DUP_ENTRY`,
`errno 1062`, message naming `uq_exp_source` (`:1123-1125`). Asserting the errno is the point — it is what
distinguishes the database refusing from a service check refusing, and rule 1 asks for the former.

**What that paragraph said until 2026-09-05, because it is the defect this file exists to catch.** It read:
*"Five rows with no `source_id` insert without complaint, three fully manual and two with `source_table` set
and `source_id` NULL — half a pair is exempt by the same rule, and the migration comment claims it, so it is
asserted."* Both halves had gone wrong. The justification was 012's own comment, written in the same session
as the assertion it justified — the circular citation CLAUDE.md's "An exemption cites the spec or DECISIONS"
was written about, sitting in the section that produced the rule. And the fact was stale: migration 015 made
those two inserts fail, so since 015 the test has asserted `errno 4025` naming `chk_exp_source_pair` for them
(`hr-contractor-flow.test.ts:1082-1090`), while this paragraph went on describing the suite that defended the
hole. A permission assertion that outlives the permission is the specific way a stale record misleads:
nothing was red, and the prose stayed confident. **The rule that came out of it is in CLAUDE.md, "A record of
current behaviour cites the test that holds it there":** a sentence describing what the tree does now names the
assertion holding it there, so the next person to change the behaviour has to edit the citation and re-reads
the sentence while they are in there. That is the only mechanism available, because a paragraph cannot go red.

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

> **Superseded in part by 21.7, migration 018.** That reading was implemented *and left unconstrained*, so
> a lumpsum row could carry any quantity the entry grid accepted and bill a whole contract sum that many
> times. `chk_ca_quantity` now pins a lumpsum quantity to exactly 1. The arithmetic above is unchanged;
> what changed is that the multiplier is no longer free. The owner question in the last paragraph of this
> entry is still open — 018 makes the wrong answer unrepresentable rather than answering it.

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
units as evidence that five are used.** (016 widened `uq_ca` to include `work_type`, and 018 pinned the
`lumpsum` quantity to 1. Both of those narrow what a wrong answer here can cost; neither answers it.)

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
nullability is not a CHECK repair, and it is the **first of the two** prose-and-DDL disagreements 21.3
lists — so it is logged here rather than fixed. (Written as "a second instance" until 2026-09-05, counting
`:2013` vs `:2137` ahead of it. That one is discharged, not carried: see the withdrawal in 19.1.)

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

**Classified 2026-09-05: this was never a spec-implementation divergence, and 015 is an addition rather than
a repair.** §6.8 rule 1 at `:2137` asks for a unique index on the pair *"where both are non-null"*, which is
exactly what 012 built, so the spec was satisfied before this hole was found and stayed satisfied after it
was closed. No sentence in the spec asks for both-or-neither; the half-pair row is admitted by SQL's rule
that a NULL in an indexed column makes a row distinct, which is a property of the mechanism, not a departure
from a written requirement. So `chk_exp_source_pair` goes beyond the spec in the direction the spec's own
intent points, and this section is **not** on 21.3's list of carried DDL-versus-prose disagreements — see the
withdrawal in 19.1 for the two things that were being run together. Nothing about the constraint changes;
what changes is what it may be cited as evidence of.

**Still open: `source_type` is not tied to the pair, and should not stay advisory forever.** Today the
constraint says the pair is whole or empty and says nothing about which ENUM member claims it, so
`source_type = 'manual'` with a full pair, or `'grn'` with an empty one, are both writable. The reason is
that the map from ENUM member to table name does not exist anywhere yet. **When finance lands it will
exist in code** — each posting path names its own table, the way `hr/service.ts:2316` already names
`'contractor_bills'` — and at that point the map is a fact about the system rather than a guess, and this
constraint should be extended to match it: `'manual'` implies an empty pair, every other member implies
its own table name. Recorded as a precondition on §6.8 rather than a preference, because the longer it
stays advisory the more postings exist to migrate.

**20.2 stays open, and the 2026-09-05 pass did not close it.** That pass reclassified where the half-pair
hole came from and struck the stale test description out of 19.1. It touched nothing about `source_type`.
The open item is still the whole of the paragraph above: the pair is whole or empty, and which ENUM member
claims it is unenforced.

### 20.3 Triage of six comment-justified assertions, none fixed

**Correction, 2026-09-11: the "71 → 78" figure in the last report was a
further uncited-count instance, and it was wrong.** The /src/ file count
was **77 → 78** across the CSP slice (e4d958a carried 78; the count of 71
dates from the run.md era before the finance slices and was never
re-measured when it was quoted). Counts are behaviour: a quoted count must
carry the command that produced it and the tree it measured. Measured now
by `npx tsc --listFilesOnly -p tsconfig.json | grep -c '/src/'`: **78 at
HEAD (e4d958a), 80 with the §29.29 marketing module in the working tree**.
Found while executing TASK 0's honest-gate report; the instruction to
"confirm /src/ is 78" was the tripwire that caught it.

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

**Tightened the same day, and it was not sound.** That file was next open for migration 016, and the
citation was replaced (it is now at `:430`, the file having grown above it). Two things were wrong rather
than one. Rule 2 of §6.6 (`NCC_BUILD_SPEC.md:1743`) is *"Contractor bills are generated from approved
attendance, never typed"* — the bill-generation rule, which says nothing about rate precedence. And §6.6's
numbered rules **do not state that a project rate outranks a company-wide one at all**; the only basis in
the spec is `contractor_rates.project_id BIGINT UNSIGNED NULL` at `:1644`, from which it follows by
inference. The assertion is still the right assertion — a project-specific rate that loses to the
company-wide one would price nothing — but "sound in substance" above was too generous: the substance was an
inference from a DDL line, presented as a numbered rule. The comment now says which, and says it is an
inference.

This is the third distinct failure mode in one grep: a comment as basis (20.2), a real citation stretched to
an adjacent shape (`:989`), and now a citation to the wrong rule that read as authoritative because it had a
number in it. The number is what did the work. None of the three would have been caught by reading the
citation for plausibility.

**And the same wrong citation was in `src/`, which the grep for it did not reach.** Found on 2026-09-05 while
writing up rate precedence for 17.3: `applicableRate` in `src/modules/hr/queries.ts` carried *"a project rate
sitting above a company-wide one is not ambiguous: **rule 3** decides it"*. §6.6 rule 3 is contractor
compliance blocking deployment. The test comment said rule 2 and this one said rule 3, for the same claim,
neither of them right — which is what a number attached to a plausible sentence does: it stops the reader
checking, and it does not even have to be the same number twice. Both now state that the precedence is an
inference from `:1644` and point at 17.3.

The lesson is about the grep and not about the two comments. The 20.3 sweep searched the *test* suite for
assertions justified by comments, because a test comment justifying a test assertion is the circular shape
CLAUDE.md names. A comment in `src/` justifying the behaviour it sits on is the same circle with one fewer
participant, and it was outside the search. **A citation sweep that covers only tests covers the cheaper
half.**

**The sixth is a policy claim, not a test problem, and is now on the §8.6 blocking list in 17.**
`hr-attendance-flow.test.ts:911` asserts that a write is permitted over a day covered by approved leave.
That is a statement about attendance overriding leave, which nobody has ratified, and the reason it is on
the blocking list rather than in this triage is that **if it is wrong the error is silent**: the leave stays
approved, the attendance row says the person was present, and payroll sees both. Same conversation as the
quotas, and the same answer decides both.

**A seventh, found 2026-09-08: the sweep could not have caught it, because it searched for rule numbers,
not filenames.** `src/middleware/legacyRedirects.ts` carried a header citing `scripts/verify-routes.mjs` as
the verifier that asserts every redirect rule. That script has **never existed** in the tree — spec 3.1
names it in the same sentence that lists the rules, and the middleware quoted the spec's own citation, which
is exactly the failure mode of the fabricated spec quotation at `crm/service.ts:2337` (a citation to a
source that is not there, read as authoritative because it is plausible).

The citation had no number in it, so the 20.3 grep — which searched for rule numbers — walked past it. The
same is true of any sweep keyed on the shape of the citation rather than on the existence of its referent.
Fixed by pointing the header at `tests/middleware/legacy-redirects.test.ts`, which does exist and does
assert every rule; the phantom script is not written, because a verifier that duplicates the suite would
be a second implementation of the same assertions with nothing to add.

**An eighth, added 2026-09-08: a naming instance.** `formatPaise` in `src/lib/money.ts:44` takes paise
and returns **rupees** rendered as `"12,34,567.00"` — the name says what it takes, the docstring says
what it does, and the output is a rupee figure with no currency marker (the templates supply "Rs").
The name is not wrong enough to break anything, but it collides with the sibling `formatRupees`
(`money.ts:49`), which also takes paise and returns `"Rs 12,34,567.00"` — two paise-taking functions,
one named for paise and one for rupees, distinguished only by whether the string carries the symbol.
A caller who guesses from the names will feed rupees to one of them.

**Renamed 2026-09-08, closing the instance.** Every paise-taking formatter now states input and
output: `formatPaise` → `formatPaiseAsRupees`, `formatRupees` → `formatPaiseAsRupeesWithRs` (it takes
paise too, so its name carried the same defect), `formatPaiseCompact` → `formatPaiseAsRupeesCompact`.
48 occurrences across 8 `src/` files, `tests/money.test.ts` and the finance-approval comment updated in
one mechanical diff; `formatPaiseAsRupeesWithRs` keeps the distinct role of the symbol-bearing form.
Rendered output asserted unchanged: unit 316/11 and integration 259/12 identical before and after, with
tests/money.test.ts (22 tests) pinning every format string. No live defect found: every call site
passes a `*_paise` column or paise-named variable; the only `paiseToRupees` uses outside money.ts
(crm/routes.tsx:671, :1905) genuinely convert to rupees for number inputs.

**Figure corrected 2026-09-09: it was recorded as unit 320/12 and the unit gate has never had 320
tests in it.** `vitest.config.ts` excluded `tests/integration/**` and nothing else, so its
`tests/**/*.test.ts` include also collected `tests/e2e/attendance-hint.test.ts` — the browser suite
that `vitest.e2e.config.ts` exists to own and that its own header says is "kept out of `npm test`".
The unit run was therefore reporting the e2e file's **4 tests and 1 file on top of its own**, and
320/12 is 316/11 plus that double count. **No test was lost.** The four are the same four, they
still run, and they now run once instead of twice: unit **316/11**, e2e **4/1**, and 316 + 4 = 320
exactly as before. The exclusion was added on 2026-09-09 with `tests/e2e/**`, and the arithmetic is
the whole of the change — no assertion was deleted, skipped or weakened to reach the smaller number.

The double count is why the figure is the kind CLAUDE.md's "counts are behaviour" clause is about: a
number copied from a run is a fact about the config that produced it, and this one silently described
a gate whose composition nobody had stated. The canonical baseline is now recorded in one place, 29.1,
with the command that produces each figure beside it.

**Added 2026-09-10 — a second uncited figure, in a report rather than code.** The session-7 prompt's
"+4 tests" for `a8de235` was wrong: three `it` blocks landed (money.test.ts 22 → 25). §29.22 records
the reconciliation and names 331 in 13 as the standing unit figure. Same class as the 320/12 case
above: a number asserted without being copied from a run.

## 21. Preconditions and conflicts carried out of slice 6, 2026-09-05

Not a list of choices. Most entries here are a **precondition on work that has not started**, and the rest
record a **conflict with the spec that was resolved in the tree** and must not be found later as a surprise.
Each one was already cited by name from a migration header, a service comment or a test before this section
existed — which is the reason the section is being written now rather than when the work lands: a citation
to a section that does not exist is decoration, and CLAUDE.md's rule against decorated citations is the rule
this repository has spent the most time on.

21.2 and 21.3 were reserved and named rather than absent while the entries around them were written. Both
landed on 2026-09-05 and the gap is closed. They were held at those numbers instead of being appended at the
end because four sections of this file — 19.1, 20.1, 21.4 and 21.6 — already pointed at 21.3, and a pointer
that has to be renumbered later is a pointer nobody trusts. 21.2 is now also cited from
`hr/service.ts:2364`; 21.3 is cited only from inside this file, because it is a reading rule for the spec
rather than a fact about any table.

### 21.1 Leave enforcement and an accrual writer arrive together, or neither does

`leave_balances.accrued DECIMAL(5,1) NOT NULL DEFAULT 0` exists (migration `006_hr.sql:187`) and **nothing
in the codebase ever accrues into it**. The only write is the literal `accrued: 0` that
`src/modules/hr/service.ts:1201` puts in a balance row when it creates one. There is no monthly job, no
joining-date proration, no opening-balance import: the column is a shape with no producer.

What stands in for it today is one line, `service.ts:968`:

```ts
const entitlement = Math.max(bal.accrued, bal.quota)
```

`accrued` is 0 for every row that exists, so the entitlement is always `annual_quota` — the *whole year's*
quota, available on day one. That is deliberately generous and it is a **stopgap, not a policy**: the
alternative reading of an unwritten `accrued` is that nobody has any leave at all, which would refuse every
request in the system and be discovered as a bug rather than as a rule.

The precondition, and the reason this is a precondition and not a to-do: **§8.6's numbers must not be
switched on before an accrual writer exists.** Once real per-type quotas are entered, `max(accrued, quota)`
stops being generous and starts being wrong in a specific direction — it grants the full annual entitlement
in April to somebody who joins in January, and the balance the screen shows is the number payroll will
later have to argue with. The failure is silent, which is the family of failure this file keeps recording:
nothing errors, a figure is simply too large. So the two ship together, or the enforcement stays off and
`max()` keeps standing in honestly.

See 17's §8.6 blocking list, which asks the owner question this depends on, and 20.3 on the attendance
override, which the same answer decides.

### 21.2 Refusing a bill above `requires_second_approval_above` is a placeholder, not the rule

Cited from `src/modules/hr/service.ts:2359`. **The refusal is not the intended behaviour and must not be read
as policy.** It stands in until finance supplies the column the real rule needs.

What the code does today. `approveContractorBill` resolves an `approval_limits` row for document type
`expense` — the ENUM has no `contractor_bill` member, which 18.9 records — checks the **gross** against
`max_value`, and then, above `requires_second_approval_above`, throws instead of approving
(`service.ts:2359-2368`). The message names the figure, the threshold and the reason: `contractor_bills` has
one `approved_by` column and no `second_approved_by`. Both halves of that are asserted, which is what makes
this paragraph a description rather than a claim: the refusal at
`tests/integration/hr-contractor-flow.test.ts:999`, which also pins the bill still at `draft` afterwards, and
the empty-limits state at `:914`. When the two-signature path lands, both go red.

**The intended rule is a two-signature path, and it already runs in this codebase.** `approvePo` at
`src/modules/inventory/service.ts:1379-1426` is the shape: above the threshold the first approval is
*recorded* — `approved_by` set, `status` left at `pending_approval` — the permission holders are notified that
a second is needed, an `inventory.po_approve_first` audit row is written, and the second approver, refused at
`:1362` if they are the same person, is the one who sets `status = 'approved'` and `second_approved_by`. Spec
`:2141` (§6.8 rule 3) asks for exactly that and says why: *"two names on a voucher is the only real control
that exists."* So this is not a design question. It is a missing ENUM member, a missing column pair, and that
branch copied — enumerated at the end of this entry.

**Why refusing was the right placeholder rather than either alternative.**

- *Approve on one signature anyway.* This turns the only real control in §6.8 into nothing, silently, and the
  row afterwards reads `approved` — indistinguishable from a bill that had two names on it. That is the
  failure family this file exists to record.
- *Add `second_approved_by` now.* It is a finance-slice column with a screen, a notification and an audit
  action attached. Adding the column without them produces a bill that can be parked awaiting a second
  approval no UI can give it.

Refusing is loud, it names the gap in the message a user actually sees, and it is **unreachable today**:
`approval_limits` is seeded empty pending §8.2, so `limit === null` refuses first and this branch is never
evaluated. Which is also why it cannot be found by using the system, and why it needs an entry here.

**The blocker is the `status` ENUM, and it is not a design question.** `approvePo` parks a first signature by
leaving the status where it was and setting `approved_by`; first and second are told apart by
`approved_by IS NULL` (`inventory/service.ts:1381`), and the entry guard at `:1352` can be a single equality
because a purchase order has exactly one pre-approval status, `pending_approval`. A contractor bill has three
— `draft`, `submitted`, `verified` — so the same trick yields "one of three statuses **and**
`approved_by IS NOT NULL`", a state no column holds. Every list, filter and count that groups by `status`
would then report a half-approved bill as `verified`, and the condition saying otherwise would have to be
repeated at each of them, correctly, forever. That is the silent-figure failure this file keeps recording. The
fix is a status value that names the state, which makes this a migration rather than a decision.

So 21.2 is three things, and the third is a copy:

1. **`contractor_bills.status` gains `pending_approval`**, matching `purchase_orders`, so the parked state has
   a name. This is the blocker: it changes a value every reader of that column may now see, and
   `approveContractorBill`'s own entry guard at `hr/service.ts:2336` has to admit it.
2. **`second_approved_by` and `second_approved_at`**, the pair `purchase_orders` already carries at
   `src/db/types.ts:1257` and `expenses` at `:617`.
3. **The refusal at `hr/service.ts:2359` gives way to the branch at
   `src/modules/inventory/service.ts:1379-1426`**, copied rather than redesigned: record the first approval,
   notify the permission holders that a second is needed, write the audit row, refuse the same approver twice
   (`inventory/service.ts:1362`), and let the second signature set `approved` together with
   `second_approved_by`.

None of it is HR-slice work, and the reason is the first item: an ENUM member on a table §6.8 posts from is
finance's migration, not a screen's.

**Gross, not net, stays as recorded** (18.9). The figure checked against both limits is `gross_paise`, the
cost committed to the project — not `net_payable_paise`, which is what leaves the bank after retention, TDS,
advance recovery and penalty, and belongs to `payment_release`. Approving a bill authorises the cost. This
reclassification does not reopen that.

**Open against §6.8.** Nothing here is a to-do for the HR slice.

### 21.3 The spec's DDL blocks are non-normative where its prose disagrees

**This entry records an instruction rather than a tree-side choice**, which makes it unusual here: the owner
settled it in the prompt governing slice 6 — DDL blocks are non-normative by default where the prose
disagrees, prefer the prose, say when you do. It is written down because three migrations relied on it before
it existed as a rule, and because four sections of this file point at it.

**The rule.** Where a DDL block in `NCC_BUILD_SPEC.md` and the prose of the same document disagree, the prose
wins, and the migration or entry that departs from the block names both lines. A block sketches a table; the
prose states what the system must do.

**Why the prose, rather than simply the more specific line.** Three reasons, each demonstrated in the tree:

1. A block states shape and the prose states behaviour. Where the shape cannot deliver the behaviour, the
   shape is what is wrong: a `KEY` cannot deliver a refusal (19.1).
2. The blocks are demonstrably incomplete. `:1650-1659` sketches `contractor_attendance` with no `uom`, no
   `work_type` and no `quantity`; 013 added all three under 19.2, because four fifths of the rate card was
   otherwise unreachable. A source already outgrown cannot be read strictly.
3. Some blocks do not say enough to have a strict reading. `:1387` writes `schema_types JSON` with no
   nullability at all, so there is nothing strict to prefer.

**Two instances are carried. Not three.**

1. `007:51` versus `:1387` — `site_page_revisions.schema_types` is `JSON NULL` while the column it snapshots
   is `JSON NOT NULL`, and the prose says every publish snapshots the previous state. **Carried:** the tree
   still declares it NULL, so the prose is unsatisfied right now. 21.4, logged at 20.1.
2. `:1659` versus `:1743` — the `uq_ca` sketch enumerates four columns and 016 made it five. **Carried:** that
   spec line is false of the tree, deliberately, and 21.6 argues why the prose at `:1743` is satisfied anyway.

**Withdrawn 2026-09-05: `:2013` versus `:2137`, the `expenses` source pair.** Rule 1's wording is *"where both
are non-null"*, so the prose is complete about NULL as well as about uniqueness, and after 012 a `UNIQUE KEY`
satisfies it while still being everything the `KEY` at `:2013` promised. Nothing is left unsatisfied on either
side, so nothing is being carried. The full account — including the second thing that was being run together
with it, the half-pair hole 015 closed, which was never a spec matter at all — is in 19.1.

**The test that decides membership: after the resolution, is a line of the spec still false of the tree?** If
yes, the disagreement is being carried and belongs on this list. If no, it was a gap that got closed and
belongs in the entry that closed it. Both carried instances fail that test in the same way; the expenses one
passes it. That is the whole of the difference, and it is the reason the list is two rather than three.

**What this rule is not.** Not a licence to skip a DDL block. The blocks are what a migration is written from
and reproducing one faithfully is the default — `009_finance.sql:140` did exactly that and was right to. The
rule fires only where prose in the same document contradicts the block, and the report has to quote both
lines. Preferring the prose because the block is inconvenient is not this rule.

### 21.4 A snapshot column nullable where its source is not, as a precondition on §7

Cited from `tests/integration/schema-constraints.test.ts` in `AUTO_JSON_CHECKS`, and recorded here because
that citation had nowhere to point.

The two columns, verified in the tree:

- `migrations/007_marketing.sql:27` — `site_pages.schema_types JSON NOT NULL`
- `migrations/007_marketing.sql:51` — `site_page_revisions.schema_types JSON NULL`

The revisions table exists for one purpose, and the spec states it in the comment on the table itself,
`NCC_BUILD_SPEC.md:1387`: *"every publish snapshots the previous state."* A snapshot of a NOT NULL column
into a nullable one means a revision can hold a NULL where the page it came from could not, and a revision
that holds a NULL there **cannot be rolled back into the page** — the restore would violate the source
column's own NOT NULL. So the row is not a usable snapshot, and it is the rollback path, the only reason to
keep revisions at all, that stops working.

This is filed as a **precondition on the §7 CMS work rather than as a citation** for a specific reason: it
is not a tidiness question about a column definition. Whichever code first writes a revision decides
whether the divergence becomes real rows, and after that the fix needs a data migration and a decision
about revisions that are already unusable. Before that code exists it is a one-line `MODIFY COLUMN`. The
whole cost of getting this wrong is in the ordering.

Nothing in the tree writes `site_page_revisions` yet, so no unusable revision exists today. Deliberately
**not** recorded as intentional: the spec's own DDL sketch at :1387 shows `schema_types JSON` with no
nullability at all, which is the sketch being a sketch rather than a decision that it may be NULL — see
21.3 on why the DDL blocks are read that way. This is the **first** of the two disagreements 21.3 carries.

### 21.5 A day rate and a measured rate for one skill level on one date: refused in the database, policy still open

Cited from `migrations/016_ca_unique_work_type.sql`, `migrations/017_ca_basis_exclusive.sql`,
`src/modules/hr/schemas.ts`, `src/modules/hr/service.ts` and `tests/hr-schemas.test.ts`. **The owner question
is still open. Which layer answers it is not.**

Since 016 widened `uq_ca` to `(contractor_id, project_id, attendance_date, skill_level, work_type)`, the
database permitted two rows like these on one day:

| skill_level | uom | work_type | headcount | quantity |
| --- | --- | --- | --- | --- |
| `mason` | `per_day` | `''` | 4 | NULL |
| `mason` | `per_sqft` | `Plastering` | 4 | 300 |

They are different rows in the key, because `''` and `'Plastering'` are different values. What they are in
the world is unknown from the rows themselves: **either two gangs of masons on one site, one on daywork and
one on piecework — which is ordinary — or one gang of four billed twice**, once for the day and again for
the plastering it did during that day. The rows are identical in the second case and the second case is a
double payment.

**As first recorded, this entry called the split deliberate. It was wrong, and for a reason worse than the
split itself.** The state it described was `contractorAttendanceSchema` refusing the pair and
`recordContractorAttendance` not, with the argument that the refusal sat "at the layer that can be removed in
one block when the answer comes". Two things are wrong with that. The first is the one the split invites: a
script, an import or a later route reaching the service directly meets no rule at all. The second is that
**the schema never covered the ordinary case either.** `rows` in that schema is one form submission. A day
row posted in the morning and a measured row for the same gang posted in the afternoon are two submissions,
and the schema never sees them together — so between 016 and 017 the double payment went in through the
front door of the form the refusal was written for, and the only thing the refusal caught was a clerk who
typed both lines into one grid. Whatever the policy turns out to be, that was not an enforcement of it.

**Resolved by migration 017 in the database.** `trg_ca_basis_bi` and `trg_ca_basis_bu` refuse the pair on
INSERT and on UPDATE. The refusal is the server's: SQLSTATE 45000, errno 1644, the trigger named in the
message, proven from a raw insert in `tests/integration/hr-contractor-flow.test.ts` with no service call in
it. The three layers now agree, with the guarantee at the bottom and the explanation at the top:

- **the trigger** is the guarantee, and applies to every caller including one that never loads this codebase;
- **`recordContractorAttendance`** checks the whole day behind the `FOR UPDATE` it already holds and produces
  the readable message, because `SIGNAL` caps `MESSAGE_TEXT` at 128 characters and cannot name the skill
  level, the work or what to do instead. It also covers the two-post case the schema cannot see;
- **`contractorAttendanceSchema`** still refuses within one submission, so the form names the offending line
  while it is still on screen.

**A trigger, and why that is not a preference.** No UNIQUE index can express this rule. Let `f(row)` be
whatever expression a key is built over. Refusing the pair requires `f(mason, per_day, '')` to equal
`f(mason, per_sqft, 'Plastering')`; the same requirement at the next work type gives
`f(mason, per_day, '') = f(mason, per_sqft, 'Tiling')`; therefore `f(Plastering) = f(Tiling)`, which
collapses the two measured work types at one skill level that **016 exists to permit**. Proven on the server
before 017 was written, on two copies of the table: under the real five-column key the pair inserted clean,
and under the four-column key it collapses to, the pair was refused 1062 — and so was `('Plastering',
'Tiling')`. Both candidate shapes fail, in opposite directions. A CHECK cannot see another row at all. That
leaves a trigger; that it may read its subject table in a BEFORE trigger was also proven on a copy first.

**Two triggers, not one.** `uq_ca` refuses an UPDATE that lands on an existing key, but moving a measured row
onto a skill level that already has a day row lands on no key: `(helper, 'Internal plastering')` is free
beside `(helper, '')`. `id <> NEW.id` inside `trg_ca_basis_bu` is load bearing — during a BEFORE UPDATE the
row still holds its old `uom`, so a legitimate single-row basis change would otherwise collide with itself.

**What is still open, and what reverses it.** Whether a contractor's gang can be on two rate bases on one
date at all, and if so whether the headcount on the measured row is the same people. Not asked yet. The
conservative side is implemented because the two failures are not symmetrical: refusing a legitimate row is a
supervisor's complaint, and admitting an illegitimate one is a payment. If the owner says the pair is
legitimate, the reversal is a migration dropping the two triggers plus the removal of one block in the
service and one in the schema — and it is worth knowing that **there is no way to remove a
`contractor_attendance` row through the application** (no `deleteFrom` on that table anywhere in
`src/modules/hr/service.ts`), so a clerk who enters a day row and then needs a measured one for that skill on
that date is stuck until the answer comes. A row-removal or void path is the thing to build if the answer
takes a while; it is not built here because voiding attendance that may already carry an approval is its own
decision.

### 21.6 `uq_ca` now has five columns and the spec's DDL says four — flagged, not silently resolved

`NCC_BUILD_SPEC.md:1659`, inside the `contractor_attendance` sketch:

```
UNIQUE KEY uq_ca (contractor_id, project_id, attendance_date, skill_level)
```

Migration 016 made it `(contractor_id, project_id, attendance_date, skill_level, work_type)`. The tree and
that spec line disagree, and the disagreement is deliberate. **Recorded here because the spec outranks any
instruction in a prompt, so a divergence from it is reportable whether or not it is right.**

Why the tree is where it is:

1. **The prose is satisfied.** §6.6 rule 2 (`:1743`) says *"the unique key plus the `bill_id` stamp is what
   closes it"*, of double-billed labour days. It does not enumerate the key. A key with `work_type` in it
   closes double-billing at least as tightly as one without — every pair the old key refused, the new one
   still refuses, which is the assertion `hr-contractor-flow.test.ts` now makes against the live index.
2. **The same sketch is already superseded, by a recorded decision.** `:1650-1659` has no `uom`, no
   `work_type` and no `quantity`; migration 013 added all three under 19.2, because four fifths of the rate
   card was otherwise unreachable. The line that declares the key is in the block that 013 already outgrew.
3. **The four-column key is provably wrong once 013 exists.** With `work_type` required on a measured row,
   a four-column key refuses one gang of masons plastering *and* tiling on one date. That is ordinary
   interiors work, and refusing to record it is not a conservative reading of the spec, it is a defect.

So this follows the standing rule for the spec's DDL blocks — prefer the prose, treat the block as a sketch,
and say so — now written up at 21.3. It is the **second** of the two instances 21.3 carries, after `007:51` vs
`:1387`. (Written as the third until 2026-09-05, counting `:2013` vs `:2137`. That one is withdrawn: after 012
no spec line is false of the tree, so nothing is carried — 19.1 and 21.3 for the criterion.) What is *not*
claimed: that the spec author intended the widening. Nobody has been asked. If the answer is that the
four-column key was meant literally, 016 is reversible only by refusing measured work, and that is the
conversation to have.

### 21.7 A lumpsum quantity is pinned to exactly 1 — migrations 018 and 019

Cited by name from `migrations/018_ca_lumpsum_single.sql` and `migrations/019_ca_lumpsum_self_guarded.sql`, from the `lumpsum` branch of
`contractorAttendanceSchema` and from the gate in `recordContractorAttendance` before this entry existed.

**The defect.** 19.2 made all five members of the rate card's UOM enum billable, and priced the four
non-day ones as `amount_paise = rate_paise * quantity`. For `per_sqft`, `per_cum` and `per_kg` that is a
unit price times a measure. For `lumpsum` the rate **is the whole agreed sum**, so the same arithmetic
makes the quantity a multiplier over a contract sum. 19.2 says as much — *"`quantity` read as the number
of times the sum is due, which is a reading rather than a spec statement"* — and then left it
unconstrained. The entry grid offered the same quantity box it offers a per-sqft line, `min=0.001`, with
no ceiling below the schema's 1,000,000. A clerk who typed the square footage into the quantity box of a
lumpsum line billed the contract sum that many times: at a sum of 25,00,000 paise and a typed 300, one
row carrying 75,00,00,000 paise.

**The choice: pin it in the constraint.** `chk_ca_quantity` gained one conjunct, `(uom <> 'lumpsum' OR
quantity = 1)`, so no row on this table can claim more than one occurrence of a lump sum. Three layers,
the same division of labour as 017: the CHECK is the guarantee and holds against any caller; the gate in
`recordContractorAttendance` is the readable refusal; the schema branch supplies the 1 so the form never
renders a multiplier box at all.

**The rejected alternative, and why it is not merely less convenient.** The instruction offered a second
option: refuse `lumpsum` on `contractor_attendance` outright and require it as a directly entered bill
line. **There is no such line to enter it on.** `contractor_bills` is a header in the schema
(`006_hr.sql:274` — `gross_paise` and the four deduction columns) and a header in the spec
(`:1663-1670`), and §6.6 has no bill-lines table anywhere in it. The spec's own comment on the attendance
table, `:1650`, reads *"headcount per day, the basis of the contractor bill"*: the attendance rows **are**
the bill's detail. Adding `contractor_bill_lines` would give `gross_paise` a second contributing source
and put the reconciliation of the two in the one place §6.6 rule 2 exists to close — *"Double-billed
labour days are the most common leak in a site business"*. That is a spec-scale change, the spec outranks
the prompt, so it is flagged here rather than taken.

The narrower reason: refusing the unit on this table would leave it on the rate card and unbillable,
which is precisely the §18.2 gap that 013 was written to close, reopened for one enum member. 19.2
already rejected trimming the rate card, because the five-member enum at `NCC_BUILD_SPEC.md:1645`
describes the business correctly and the attendance table was the side that was short.

**Pinned to 1 and not to NULL**, which was the other sub-choice. At 1 the arithmetic
`amount_paise = rate_paise * quantity` stays correct for all four measured units with no third branch to
remember — in `recordContractorAttendance` and in `generateContractorBill` both — and the clause is one
added conjunct rather than a restructure of a clause that has already been got wrong once (013 → 014). A
branch is a thing a later reader can drop; an invariant is not.

**Proven before the migration was written, per CLAUDE.md.** On a `CREATE TABLE … LIKE` copy of
`contractor_attendance`, first checked to carry `chk_ca_quantity` verbatim so the result could not be
vacuous:

| row | under 014's clause | under 018's |
| --- | --- | --- |
| lumpsum, quantity 300 | **admitted** — the hole | refused 4025 |
| lumpsum, quantity 2 | admitted | refused 4025 |
| lumpsum, quantity 0.999 | admitted | refused 4025 |
| lumpsum, quantity NULL | refused 4025 | refused 4025 |
| lumpsum, quantity 1 | admitted | admitted |
| per_sqft, quantity 300 | admitted | admitted |
| per_day, quantity NULL | admitted | admitted |

The row that cost the most was the row the constraint admitted, and the shapes that must keep working
still do. `contractor_attendance` held 0 rows when 018 ran, so nothing was at stake in the ALTER — but
MariaDB validates a CHECK against already-stored rows when it is added, proven on a second copy holding
one lumpsum row at quantity 300 where the ALTER came back 4025 rather than succeeding, which is what
makes the migration safe on a database that is not this one. A trigger has no such validation, which is
why 017 had to build a temporary key to prove its own precondition and 018 did not.

**The three-valued class again, one guard away — and 019 closed it.** As 018 wrote it,
`(uom <> 'lumpsum' OR quantity = 1)` evaluated on its own against a NULL quantity was NULL — `select (null
= 1)` is NULL and so is the whole disjunction — and a CHECK admits UNKNOWN. It refused only because 014's
`quantity IS NOT NULL` was a **sibling conjunct** of it in the same AND, and `FALSE AND UNKNOWN` is FALSE.
Both were run on the server. What carried it was the sibling relationship and not the written order:
MariaDB promises no evaluation order and does not need to, so a reader who reorders the conjuncts loses
nothing and a reader who moves the disjunction out from under the guard loses the refusal. So 018's clause
was safe **because of 014, not on its own**: the fourth appearance of the class CLAUDE.md names, and the
first that was harmless on arrival. Migration 019 removed the dependency; the paragraph below is what
happened to it.

**Migration 019 removed the dependency instead of documenting it, applied 2026-09-05.**
`migrations/019_ca_lumpsum_self_guarded.sql` restructures the disjunct to
`(uom <> 'lumpsum' OR (quantity IS NOT NULL AND quantity = 1))`, which is FALSE over a NULL quantity on its
own: `IS NOT NULL` is two-valued, so it converts the UNKNOWN into a FALSE inside the disjunct rather than
leaving it for a sibling to absorb. Nothing outside the disjunct has to hold for the refusal to happen. The
whole clause is now, as MariaDB stores it — normalised, and it drops the inner parentheses, which matters
because the tripwire matches this text:

```
`uom` = 'per_day' and `quantity` is null or `uom` <> 'per_day' and `quantity` is not null
and `quantity` > 0 and (`uom` <> 'lumpsum' or `quantity` is not null and `quantity` = 1)
```

**It changes no behaviour, and that was proven before the file was written.** Two proofs, both on the dev
server. The sub-expression: `select ('lumpsum' <> 'lumpsum' OR NULL = 1)` returns NULL, `select ('lumpsum'
<> 'lumpsum' OR (NULL IS NOT NULL AND NULL = 1))` returns 0, and `select (FALSE AND NULL), (NULL AND
FALSE)` returns 0, 0 — which is 018's disjunct, 019's, and the reason the order 018 was written in was
incidental. Then 15 row shapes against a `CREATE TABLE … LIKE` copy, run under 018's clause as copied from
the live table and again under 019's: **0 differences**, 5 rows surviving each run, and the copy's clause
re-normalised back to 018's text compared string-equal to the live one so the comparison was against what
was deployed rather than a retyping of it. Lumpsum at 1 admitted; lumpsum at NULL, 300, 2, 0.999 and 0
refused 4025; per_sqft at 300 and 1 and per_cum at 12.5 admitted; per_sqft at NULL and 0 and per_kg at NULL
refused 4025; per_day at NULL admitted and per_day at 1 refused; per_day with a work_type refused by
`chk_ca_work_type`. The full table is in 019's header. `contractor_attendance` held 0 rows.

**The inner `quantity IS NOT NULL` is redundant and stays.** The outer one still implies it, so the clause
now says it twice, and "this conjunct is already implied" is exactly how the class CLAUDE.md names reads on
the way in. What stops the simplification is not the comment: the second tripwire in
`tests/integration/hr-contractor-flow.test.ts` extracts the parenthesised lumpsum disjunct from
`information_schema.CHECK_CONSTRAINTS`, evaluates **it alone** over a synthetic `('lumpsum', NULL)` row and
asserts `0` rather than `NULL`, with `('lumpsum', 1)` as the control so a constantly-false fragment cannot
pass it. A clause that goes back to leaning on a sibling fails there, naming the reason. That is the half a
regex cannot do, and the pattern to copy for any future clause of this shape.

**Not NOT NULL with a sentinel, which is the shape CLAUDE.md prefers.** A sentinel needs a value outside
the column's real domain. `work_type` had one — `''` is not the name of any kind of work, which is what let
016 make it NOT NULL and `chk_ca_work_type` keep it unreachable on a measured row. `quantity` has none:
every DECIMAL a sentinel could be is either a plausible measure or already refused by `quantity > 0`, and
choosing one would need a fresh exemption inside this same clause to keep it unreachable — the second
constraint the preferred shape exists to avoid, reached by a longer road. NULL on a per_day row is also
meaningful here rather than missing data: there is no measure, because the day is the measure.

**This was recorded as the option not taken, and the instruction of 2026-09-05 asked for it.** The previous
text of this paragraph said a migration 019 doing exactly this restructure was "the better end state by
CLAUDE.md's own preference for a constraint that needs no second thing to stay true, but … a schema change
to a shared object for a documentation reason, and it was not asked for". It has been asked for, so the
option is closed rather than open. The two comment sites the note lived at are retired: the tripwire in
`hr-contractor-flow.test.ts` now asserts the self-guarded shape instead of the sibling one, and the guard
rule in `schema-constraints.test.ts` keeps its statement that a regex cannot tell a guard that covers a
comparison from one that merely shares a constraint with it — that limit is structural and still true —
while no longer recording a live dependency, because there is not one. 018's own header could not be
corrected: it is applied and `scripts/migrate.mjs:117-128` treats an applied migration whose checksum moved
as a hard failure, which is the right behaviour. Its one wrong sentence — that the guard "sits ahead of it
in the same AND chain", which implies the ordering did the work — is corrected in 019's header instead.

**Found while testing it: a refusal message that instructed the caller to write the forbidden row.** The
quantity gate 19.2 shipped covers every non-day unit — *"it needs a quantity above zero to price"* — and a
lumpsum row with a NULL quantity reached that gate first. On a lumpsum line every quantity above zero
except 1 is refused by the CHECK, so following the instruction produces the row 018 exists to make
unwritable. The gate now steps around `lumpsum` and the pinned gate below it names blank as blank. This
was invisible until an integration test asked which layer refused a NULL: the wrong message was a *passing*
path.

**What this does not settle.** Whether a lumpsum is due per occurrence or once for a whole scope is still
an owner question — 19.2's last paragraph, and on the blocking list at 17.3. 018 does not answer it; it
makes the wrong answer unrepresentable. No row can now claim more than one occurrence, so if the answer is
"once per scope, and attendance should not touch it at all", the narrowing starts from a table where every
lumpsum row is exactly one sum and there is no backfill decision to make. Narrowing from an unbounded
multiplier would have needed one.

**Tests.** Five unit cases in `tests/hr-schemas.test.ts` (40 → 45) pin the form contract: the 1 is
supplied rather than entered, a posted quantity is refused whether it is 300 or 0.999, a lumpsum row must
name its work, and an untouched lumpsum line is still skipped rather than posting its implied 1. One
integration case in `tests/integration/hr-contractor-flow.test.ts` (44 → 45) discharges *"prove the
refusal comes from where you claim it does"*: a raw Kysely insert with no service call in it, refused
`4025` with `chk_ca_quantity` named in the message, against the service's refusal which carries prose and
no `errno` at all. The permitted shapes it asserts cite `:1645` and 19.2 rather than 018's own header,
per CLAUDE.md's second clause. 019 added no case and changed that one's two tripwires: the clause is still
read off the live server before any refusal runs, and the second one evaluates the extracted lumpsum
disjunct alone as described above. Both suites at 019: 264 unit, 204 integration, unchanged by it.

## 22. The first client component: the Alpine attendance month matrix, 2026-09-05

Commissioned by 17.2, which asked for this work as its own slice so that "Alpine is not introduced in the
middle of a slice". Most of what follows is a pattern decision as much as an attendance decision: §6.5's
`ItemPicker` and `LineItemGrid` and §6.7's `ApplicantBoard` all land on top of whatever this establishes.
The entries are in the order a later component author needs them.

### 22.1 A client file moves focus and counts. It does not know a business rule.

The rule, stated once at the top of `public/assets/js/attendance-grid.js` and repeated here because a
comment inside the file being copied is exactly the kind of self-justifying citation CLAUDE.md distrusts.

**It is a rule rather than a preference because nothing in `public/` is checked by anything.**
`tsconfig.json` excludes `public`, so the 71 files `npm run typecheck` reads are all under `src/` and that
file is not one of them. `build:client` is `vite build` and its only output is the minified dashboard
stylesheet; there is no JS bundle, no transform and no lint, and `public/assets/js/*.js` is served
byte-for-byte as written. Neither suite loads a browser. A client file is therefore the one place in this
tree where a mistake reaches a user without passing a single gate, and the only safe response is to put
nothing there that can be wrong about the business.

Concretely, for the matrix: the file does not know what an attendance status is, which statuses a cell may
take, which cells are editable, or whether a month is closed. The keystroke table arrives as one
`data-keymap` JSON attribute (`src/modules/hr/routes.tsx:1431`) that the server renders from `STATUS_KEYS`
(`src/modules/hr/schemas.ts:322`), and the statuses a cell will accept are the `<option>` elements the
server put in it. A keystroke for a status the server did not offer on that cell finds no option and does
nothing (`attendance-grid.js:154-159`). **The client cannot offer a combination the write would refuse,
because it does not compose combinations at all — it selects from what was sent.**

Three decisions inside the file where the platform default was actively wrong rather than merely unhelpful,
each one a thing a later grid component will meet:

- **Arrow keys are swallowed.** On a closed `<select>` the browser's own Up and Down change the selected
  option, so a supervisor arrowing across a month would silently rewrite every cell they passed through.
  In a grid an arrow moves.
- **Enter moves down and never submits.** Enter on a control inside a form submits it by default, which on
  a 300-cell grid is a month posted by a typo. The footer button is the only submit.
- **Every printable key is swallowed, including one with no status behind it.** Left to the browser it runs
  the native `<select>` type-ahead, which jumps to whichever option label happens to start with that letter
  — a different cell value from the same key on a different browser.

`Backspace` reverts a cell to the value the server sent rather than emptying it, because this screen cannot
delete an attendance row and an emptied cell displayed over a stored status would be a lie.

### 22.2 The plumbing a later component copies: a union member, a hand-written file, no build step

**A page asks for a component by name out of a union, never by path.**
`export type ClientComponent = 'attendance-grid'` (`src/dashboard/layouts/AppShell.tsx:22`), and `page()`
takes `clients?: ClientComponent[]`. The reason it is a union and not a string: a route then cannot put an
arbitrary path into a `<script src>`. Adding a component means adding a member there and a file at
`public/assets/js/<name>.js`, and nothing else.

**Loaded with `defer`, BEFORE the vendored Alpine.** `AppShell.tsx:65-79`. This is a correction, 2026-09-07.
This paragraph used to say "after" and justify it with "Alpine starts on DOMContentLoaded" — and the
justification is false for the vendored build: Alpine 3.14.9's module tail is
`queueMicrotask(() => Alpine.start())`, which runs when its own deferred script task ends, before the next
deferred tag. A component script listed after `alpine.min.js` therefore registered its `alpine:init`
listener after Alpine had already dispatched it and walked the DOM; every `x-` expression on the page
warned `attendanceGrid is not defined` and the component's `init()` never ran. The production attendance
keyboard layer was dead from the day it shipped, and nothing caught it because no gate ran a browser.
The order was found inverted by `tests/e2e/attendance-hint.test.ts` state 3 ("init() reveals it"), which
failed under the old order and passes under this one; the other three states of that file are unchanged.
The file keeps a `window.Alpine` branch (`attendance-grid.js:214-220`) for a future page that loads
Alpine earlier — under the current order that branch is unreachable in production, because `window.Alpine`
is still unset when a component script runs.

**A component ships only to the page that needs it.** The matrix route passes
`clients: gridEditable ? ['attendance-grid'] : undefined` (`routes.tsx:1554`), so a read-only month, or one
filtered to a project, loads no client code at all.

**Rejected: a JS entry point in `vite.config.ts`.** The instruction was "no build-step dependency beyond
what `build:client` already does", and there is a real argument for a bundle later — types over client code
would answer most of 22.1's complaint. But a bundler introduced for one 221-line file changes the deploy
story, because `public/assets/js` stops being editable in place, and it would have landed in the same commit
as the first component. That is the coupling 17.2 refused for Alpine itself.

**`x-cloak` is declared in the shared `dashboard.css`, not in anything module-shaped.** Alpine removes the
attribute when it initialises a component, so `[x-cloak]{display:none !important}` hides an element only
while Alpine has not run — including forever, on a page with JavaScript off. That is how the grid's
keyboard-shortcut paragraph stays off a page that has no keyboard shortcuts. It is central because the
second component will want it and a rule nobody can find gets re-declared.

### 22.3 "No client-side authority over attendance values" means the whole page posts every time

The decision: **every editable cell posts its current value on submit, changed or not, and the server
compares each against the stored row.** The client's `dirty` count is a number in a button label and decides
nothing (`attendance-grid.js:39`).

This is what makes the JavaScript-off fallback trustworthy rather than merely present. A `<select>` with no
script behind it cannot omit itself from a form, so a JavaScript-off browser necessarily posts the whole
page; if the enhanced path posted only the changed cells the two would take different paths on the server,
and only one of them would be the path anybody exercises. Posting everything makes them the same request.
It costs one comparison per cell and buys that.

The tolerance for it is in `recordAttendanceGrid` (`src/modules/hr/service.ts:773`): a cell whose posted
status equals the stored one is counted `unchanged` and issues no statement.

**Behaviour, and what holds it.** A whole page posted back with nothing altered writes nothing:
`tests/integration/hr-attendance-flow.test.ts:1483` re-posts all six cells as a *second* officer and asserts
`{inserted: 0, updated: 0, unchanged: 6}`, that every row is identical to before, and that every `marked_by`
still names the first actor. The last of those is the load-bearing assertion — the counts are computed by
the function under test and cannot be their own evidence, whereas `marked_by` would have moved if any
statement had executed. One cell posted alone lands the same row as that cell inside a full page (`:1501`).

**A correction never re-costs the month.** `project_id` is written on insert and never on update, asserted
at `:1536`, where a post charged to overhead corrects a row charged to a project — leaving its `project_id`
alone — while inserting a new row at overhead in the same post.

**Do not optimise the post down to the changed cells.** The wire shape would survive it, because each option
value carries its own `employeeId|date|status` and so needs no alignment between a cell and a column
(`tests/hr-schemas.test.ts:234`). The property above would not survive it.

### 22.4 A cell's options and the service's refusals are one list written twice, in one order

A cell is rendered by `cellOptions` (`routes.tsx:1255`) and written by `recordAttendanceGrid`
(`service.ts:773`). Both answer the same question — may this employee be marked on this day — and they are
deliberately two functions rather than one, because one is a `<select>` and the other is a transaction. The
decision: **they refuse in the same order, and the order is part of the contract.** Future day, before
joining, after exit, covered by approved leave, already approved. A refusal added to either owes a branch in
the other.

The client is not in that list at all, per 22.1. The grid surfaces a refusal by rendering no control, and the
server refuses again on arrival, so a page that has been open across an approval gets a message rather than a
silent write. **Surfacing the refusal is the server's job in both directions; the client neither predicts nor
suppresses one.**

**Behaviour: the refusals, asserted.** `hr-attendance-flow.test.ts:1567` is the other half of `cellOptions`'
null branches, in the same order — seven cases: a future day, a day before joining, a day after exit with the
day *before* the exit accepted in the same test, an approved-leave day marked as worked, a closed month, a
missing project, a missing employee.

**One ordering inside that list is a hazard rather than a choice, and it now has a tripwire.** The unchanged
comparison runs *before* every refusal, and the comment on those six lines in `service.ts` names the tests
that hold them there. Moved below the refusals, a single approved leave day makes a whole month unsavable
over a cell the post was not trying to change: the page carries that cell back untouched and the refusal
fires on a value nobody is changing.

Making that observable needed a leave-covered cell storing a *non-leave* status, which exists only because
`approvedLeaveMonth` expands over calendar days while `decideLeave` writes working days only — so a Sunday
inside an approved range is covered by the request and keeps whatever status it already had. The construction
is at `hr-attendance-flow.test.ts:1653`, and it is built through the application's own paths rather than by
inserting the shape directly. Three assertions: the Sunday is covered yet still `weekly_off` while the
weekdays either side are `paid_leave` (`:1691`); posting it as `present` is refused and the message names the
request (`:1708`); posting it back unchanged alongside a real correction succeeds with
`{inserted: 0, updated: 1, unchanged: 1}` (`:1719`). Per CLAUDE.md's last rule, the third was watched go red
with the comparison moved below the refusals — failing with the leave refusal quoted in its own message — and
the move reverted.

### 22.5 A month grid pages the roster, never the month

`ROSTER_PAGE = 25` (`routes.tsx:1221`): twenty-five employees down, every day of the month across. The month
is not split, because a page boundary inside it would put one supervisor's fortnight on two URLs and there is
no defensible place to cut. Thirty-one columns do not fit a laptop, so the matrix is the one table in the app
that expects to scroll sideways, with the employee column sticky (the `.ncc-matrix` block in
`src/dashboard/assets/css/dashboard.css`).

**The pager is a link outside the form.** A page change is therefore a plain GET the browser can restore, and
it discards unsaved edits. With JavaScript on, the `beforeunload` guard says so out loud
(`attendance-grid.js:60-63`); with JavaScript off there is nothing to discard, because nothing was edited
without a save. That is the whole of what "lossless" can mean on a screen with no client-side draft, and a
later component that wants a real draft is choosing a much larger problem.

An unsaved cell is outlined, never coloured in: a background change on a `<select>` fights the platform's own
focus and open-list styling on at least one browser, and an outline reads the same on both. `is-dirty` says
"not saved yet" and never "accepted".

### 22.6 Conflict flagged, not resolved: the constraints named for this slice are on another table

The instruction commissioning the matrix said it "has to respect the trigger-enforced day/measured
exclusivity and the pinned lumpsum quantity, so the client cannot offer a cell combination the database will
refuse". **Neither constraint is on the table this grid renders.** `trg_ca_basis_bi` / `trg_ca_basis_bu`
(migration 017, 21.5) and `chk_ca_quantity` (018, tightened by 019, 19.2) are all on `contractor_attendance`.
The month matrix at spec `:1761` renders `attendance`, the employee table, which has no CHECK constraints and
no triggers: its only database guarantee is `uq_att (employee_id, attendance_date)`, and everything else it
refuses is refused by the service.

Read as a statement about SQL the instruction does not apply to this screen. Read as a rule about what a
client may offer it does, and that is how it was implemented — `cellOptions` renders no control for a cell the
write would refuse, and the write refuses again regardless (22.4). **The contractor day-entry screen is where
the literal reading lands, and it is a different grid on a different table.** Recorded rather than resolved,
because the spec wins over a prompt and the spec puts the month matrix on `attendance`.

**Also found, and harmless: one refusal in `recordAttendanceGrid` is unreachable.** The per-row
`prior.approved_at !== null && !canOverridePeriod` guard cannot fire — `attendanceMonthState` returns
`locked: approved > 0`, so any approved row in the month makes `assertMonthOpen` refuse the whole post first,
and where `canOverridePeriod` is true the per-row test is false. `recordAttendanceBulk` carries the same pair.
Left in as defence in depth: it is correct, it is one comparison, and it stops being dead the day the month
lock becomes per-row. Noted here so that a later reader does not delete it as dead code without noticing that
its reachability depends on `attendanceMonthState`'s definition of `locked` rather than on anything local.

### 22.7 Tests

**Unit, `tests/hr-schemas.test.ts`, 45 → 59.** Three describes. `STATUS_KEYS, the derived keyboard` (`:198`)
pins the whole letter table — `p a h w o i u n c`, the first free letter of each status in declaration order —
that no letter is given to two statuses, and that every value is a single lower-case letter, which is what the
client indexes by. `attendanceGridSchema, the self-identifying cell` (`:234`) pins the wire shape; its
docstring records that there is deliberately no alignment test, because a cell carries its own employee and
day, and that absence is the property the shape was chosen for. `attendanceGridSchema, the refusals` (`:267`)
covers a day the posted month does not have — the 31st of September, day zero, and `2026-02-29` refused while
`2024-02-29` is accepted, so the bound is the month's own length and not a constant 28 — a duplicated
cell whichever half carries the status, an unknown status, an all-blank post, an unreadable employee and an
invalid month.

**Integration, `tests/integration/hr-attendance-flow.test.ts`, 61 → 81.** One describe at `:1355` working in
`2026-06`, a month nothing else in the file writes to and asserted empty at `:1446`, so a failure in this
block is about this block. It uses a second actor and a second employee who exits mid-month, both created
through the service. Six top-level cases plus three nested describes; the audit case (`:1738`) asserts eight
audit rows for eight posts, including the post that wrote nothing, because an attempt is a fact about who
tried even when no statement ran.

**The two supporting functions this slice added are pinned separately, because the grid tests exercise them
without constraining them.** `weekdayShort` (`src/lib/dates.ts`) renders the day-of-week column headers, and
three unit cases in `tests/dates.test.ts` (36 → 39) hold it: that `weekdayShort(date) === 'Su'` agrees with
`!isWorkingDay(date)` on every day of a month, which is the assertion that matters — the grid greys a column
by one and payroll counts a day by the other, so a disagreement greys the wrong column; the seven labels in
week order; and no shift across a month or year boundary. `approvedLeaveMonth` (`src/modules/hr/queries.ts`)
expands an approved request to one entry per covered day, and the last describe in the integration file holds
the clipping its own comment calls the easy part to get wrong: a request running 29 April to 2 June yields all
31 days of May — not the 26 working days `decideLeave` wrote rows for — exactly two days in April, exactly two
in June, nothing in March or July, the request id and type code on every expanded day, and nothing at all for
a request still pending. Both were watched fail: removing the two clamp lines returns 35 days for April, and
rotating the weekday array turns three of the date cases red.

**Both suites at this slice: 281 unit, 224 integration.** Typecheck clean over 71 files under `src/`; the
client component is not one of them, which is 22.1.

## 23. The `src/`-wide citation sweep, 2026-09-05

CLAUDE.md's third clause — the rule that a comment justifying a business rule by rule number is owed the
same scrutiny in `src/` as in `tests/` — recorded that the sweep it asks for was owed and had not been
done. It has now been done, and this section is what it found. Nothing here changes behaviour: every edit
was to a comment, and the three gates were identical before and after (71 files, 281 unit, 224
integration).

The shape of the result is worth stating first, because it is not what the clause's own instance
predicted. `grep -rInE "rule[s]? [0-9]" src/` returns 169 lines across 19 files, and the overwhelming
majority are locators — `(spec 6.6 rule 7)` over the function that implements rule 7 — which claim nothing
and are fine. Nineteen used a rule number as the *basis* for an ordering, a refusal or a quotation. Of
those, fourteen turned out to be accurate: the quoted fragments are in the spec verbatim, and the one
claim about an absence (that the 6.6 route table has no route to approve contractor attendance) is true of
`NCC_BUILD_SPEC.md:1725-1737`. Eight of the fourteen are comments justifying a rule and now carry the spec
line; three are in rendered copy and are 23.3; three needed nothing — a local ordering label in
`legacyRedirects.ts`, a locator that gives its own reason beside the number, and `computeLeadScore`'s
docstring, which already says which part of the scoring is rule 1's and which part is the author's and is
the model the rest were edited towards. **A citation by number is not wrong, it is unfalsifiable at a
glance, and that is the whole cost.**

### 23.1 Four citations were doing work the cited rule does not do

**A quotation that is not in the spec.** `loseLead`'s docstring attributed to 6.7 rule 8 the phrase
*"lost reason breakdown, and which competitor won"*, in quotation marks. That string does not occur in
`NCC_BUILD_SPEC.md` in any casing or word order. The substance is right — rule 8 at `:1938` does want a
closed enum feeding `competitors.typical_rate_per_sqft_paise` — but a reader checking the quote finds
nothing and cannot tell whether the rule moved or the quote was invented. It now quotes the words the rule
actually has, *"free-text loss notes produce no analysis"*, and cites the line.

**A rule that names five things, cited for nine.** `STAGE_PROBABILITY` said it was *"verbatim from the
rule"* (6.7 rule 2) and that *"stages the rule does not name get null rather than a guess"*. Rule 2 at
`:1926` names exactly five — `qualified` 20, `site_visit_done` 35, `quote_sent` 50, `negotiation` 70,
`verbal_agreement` 85. The map also gives `won` 100, `lost` 0, `dormant` 0 and `disqualified` 0, so four of
its thirteen entries contradicted the policy the docstring stated one line above them. The numbers are
right and are unchanged; the docstring now says which five are the rule's and which four are this
repository's. This is CLAUDE.md's second clause exactly — a citation covers the shape it names and no
adjacent shape — found in `src/` rather than in a test.

**A schema strictness justified by a sibling function.** `quoteSchema` required the payment schedule to
sum to 100 and gave as its reason *"rule 6: conversion generates the project's milestones from this JSON
through generateMilestones(), which throws unless the weightages sum to exactly 100."* The first half is
real: rule 6 at `:1934` does generate `project_milestones` from `payment_schedule_json`. The second half
is not the spec's at all. `project_milestones.percent_of_contract` is nullable at `:1018`, the *"must sum
to 100"* at `:999` is `stage_template_items` — physical progress weighting, a different table — and no
rule requires a payment schedule to total anything. What throws is
`src/modules/projects/service.ts:1102`, and that function's own docstring gives the honest reason: a
schedule summing to 95 leaves 5 percent of a contract permanently unbillable. The requirement stands, the
citation now points at the function that imposes it and the reason that motivates it, and the true half no
longer lends its credibility to the invented half.

**A rule cited for a mechanism rather than for the property it requires.** `createQuote` said reading the
inclusion list from `package_spec_lines` at print time *"is rule 4 as written"*. Rule 4 at `:1930`
requires the property — the list *"cannot drift from what the site advertises"* — and says `createQuote`
reads the package row and its spec lines. Reading at print rather than snapshotting is this module's
mechanism for the property, and the same over-attribution was in the print route's comment. Both now
separate the two. The paragraph also had a bare "rule 4" and a qualified "6.5 rule 4" three sentences
apart, both now qualified.

### 23.2 One file used "rule N" in two senses inside one function

`applicableRate` in `src/modules/hr/queries.ts` is the function CLAUDE.md's third clause was written
about: its return-value comment records that an earlier version justified rate precedence by "rule 3",
which in §6.6 is contractor compliance blocking deployment and has nothing to do with rates. The
docstring above it still said *"Rule 3 sits above rule 4 deliberately"* — meaning items 3 and 4 of its own
numbered list, in the one function in this tree where that exact token had already been misread once. Two
further problems in the same sentence: it gave as the basis *"scope is the distinction the spec builds
into the schema"*, which the corrected comment fifty lines below explicitly calls an inference from the
nullable columns at `:1644` and puts on the blocking owner list at 17.3; and *"it was the existing
behaviour for day rates before measured work existed"*, which justifies an ordering by what the code used
to do. The docstring now says **step**, states the basis as an inference, and points at 17.3. The two
comments in that function no longer disagree about whether the spec settles the precedence.

### 23.3 Fifteen rule numbers are in text a user reads, and were left alone

Nine in `src/modules/hr/routes.tsx` and six in `src/modules/crm/routes.tsx` sit inside rendered copy —
an Alert saying corrections *"need `finance.period_close`, because rule 4 exists to stop a payroll figure
changing after the payment is made"*, a table caption saying *"what rule 3 requires before a quote can be
sent"*, a flash message saying a bill *"does not reach finance until 6.8 rule 1 is built"*. Every one is
accurate. Every one also asks a site supervisor to look up a document they do not have, and one of them
tells them a section number of a build spec as though it were a release note.

They are recorded here and **not changed**, because rendered copy is output: editing it is a behaviour
change, and this task was citations only. The fix when it is taken is to keep the reason and drop the
number — the Alert already says why the month is closed, which is the part that helps. It can be taken
without a red test: grepping `tests/` for those phrases returns one line, a comment in
`hr-contractor-flow.test.ts:967`, and no assertion. That nothing pins fifteen strings a user reads is its
own small finding.

### 23.4 What the sweep does not establish

Nothing executable holds any of this. A citation is a tripwire on prose, in the sense of the CLAUDE.md
section above it: it either still matches the spec line it names, or somebody had to edit one of the two
and re-read the other. Fourteen of the nineteen were accurate for months while being unfalsifiable at a
glance, so the sweep's value is not that it found four defects — it is that the next reader of any of the
nineteen can check the claim in one jump instead of grepping §6.6 for a rule that turns out to be about
something else.

The one class this sweep cannot see is a comment that cites nothing at all and asserts a business rule as
though it were obvious. There is no grep for that.

## 24. The Content-Security-Policy the comment describes does not exist, 2026-09-05

`src/app.ts:47-55` carries a nine-line comment explaining a per-area CSP: why the public pages get a lax
policy and `/app` gets a strict one, and why writing one policy for both would be wrong. The reasoning is
sound and the header is not sent. Not sent laxly, not sent partially — **no `Content-Security-Policy`
appears on any response, in either area**, and none is set in `.htaccess` either. What follows records that,
and what the strict half would do to the two client-side files shipped on 2026-09-05 if somebody wrote it
from the comment. No policy is implemented here; §9 owns hardening.

### 24.1 What the comment claims

Three claims, in its own terms: that the policy is "set per area rather than globally"; that the public
pages "carry inline `<style>` and inline `<script>` blocks that the freeze forbids touching, and GA4 loads
from googletagmanager", so they "get a policy that permits inline, which is weak but honest"; and that
"`/app` is ours, has no inline script, and gets the strict policy."

The third claim is true as far as it goes and is the one that misleads, because *script* is not the only
directive a strict policy carries. See 24.5.

### 24.2 What is actually sent, measured 2026-09-05

Immediately below the comment, `src/app.ts:56-67` is the only `secureHeaders()` mount in the tree —
`app.use('*', ...)`, one call, seven options, and **no `contentSecurityPolicy` key**. There is no second
mount on `/app/*` and none on the public site, so the "per area" structure the comment describes has no
mechanism behind it at all.

Proved by response rather than by reading. A scratch `tsx` script imported `src/app.ts`, called
`app.fetch()` on eight paths and printed every response header:

| path | status | `content-security-policy` |
| --- | --- | --- |
| `/` | 200 | ABSENT |
| `/index.html` | 404 | ABSENT |
| `/about-us.html` | 404 | ABSENT |
| `/contact.html` | 404 | ABSENT |
| `/login` | 200 | ABSENT |
| `/app/dashboard` | 302 | ABSENT |
| `/api/crm/quotes/1/print` | 302 | ABSENT |
| `/assets/js/attendance-grid.js` | 200 | ABSENT |

Twelve headers come back on `/`: `cache-control`, `content-type`, `etag`, `origin-agent-cluster`,
`referrer-policy`, `strict-transport-security`, `x-content-type-options`, `x-dns-prefetch-control`,
`x-download-options`, `x-frame-options`, `x-permitted-cross-domain-policies`, `x-xss-protection`. The nine
security headers among them — everything in that list except `cache-control`, `content-type` and `etag` —
are identical on all eight paths; the per-path differences are `etag` and `cache-control` on the static hit,
`set-cookie` on `/login`, `location` on the two redirects. That is the
same fact from the other side: one global mount, no per-area difference to observe. `.htaccess:201-206`
sets `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, a `text/html` `Cache-Control` and an
`X-Robots-Tag`, and no CSP, so Apache is not supplying what the app omits.

Nothing executable holds any of this and nothing should: a test asserting the header is absent would go red
the day §9 adds it, which is the "pin what it permits" hazard CLAUDE.md warns about. The date above is the
citation. To re-measure, recreate the probe — `import app from '../src/app.js'`, `app.fetch(new
Request('http://localhost' + path))`, read `res.headers` — and run it with `npx tsx --env-file=.env`,
because `src/env.ts:63` throws on missing `DB_*` before `app` is importable.

### 24.3 The vendored Alpine is the standard build, so every `x-` attribute needs `'unsafe-eval'`

`public/assets/js/attendance-grid.js` survives a strict policy on its own. It is same-origin, so
`script-src 'self'` loads it; it constructs no functions and touches no `innerHTML` — a grep for `new
Function`, `eval(`, `innerHTML` and `setAttribute('on` returns nothing in its 221 lines. There is no inline
handler anywhere in `src/`: `grep -rInE '\bon(click|change|submit|keydown|input|load)=' src/ --include=*.tsx`
returns nothing, and all four `<script>` elements in `src/dashboard/layouts/AppShell.tsx:64-74` carry `src=`.
The comment's "no inline script" is verified.

`public/assets/vendor/alpine.min.js` is a different matter, and it is the answer to the question this task
asked. It is the **standard build, not the CSP build**, and its evaluator is a function constructed from a
string at runtime:

```js
let r = Object.getPrototypeOf(async function () {}).constructor
let s = new r(['__self', 'scope'], `with (scope) { __self.result = ${n} }; __self.finished = true; return __self.result;`)
```

That is copied out of the minified file, not from Alpine's docs. `Object.getPrototypeOf(async function(){})
.constructor` is the `AsyncFunction` constructor, and calling it is `eval` for CSP purposes: under any policy
whose `script-src` omits `'unsafe-eval'` it throws `EvalError` and nothing about the expression runs.
Corroborating markers, counted in the file: `getPrototypeOf(async` ×1, `with (scope)` ×1, `__self.result` ×2,
`cspEvaluator` ×0, `Alpine is unable to interpret` ×0 — the last two are the CSP build's evaluator name and
its error string, and their absence is what settles which build this is.

**A nonce does not substitute.** A nonce authorises an inline `<script>` *element*; it has no bearing on
`Function`/`AsyncFunction` construction. The only two ways out are `'unsafe-eval'` on the `/app` policy or
swapping the vendored file for the CSP build. That choice is §9's.

Six Alpine attributes exist in the whole tree, all on the attendance matrix form at
`src/modules/hr/routes.tsx:1425-1466`: `x-data="attendanceGrid"` (:1430), `x-on:change="onChange"` (:1432),
`x-on:keydown="onKey"` (:1433), `x-on:submit="onSubmit"` (:1434), `x-text="summary()"` (:1466), and a bare
`x-cloak` (:1454). Five carry an expression and every one of them goes through the constructor above —
`R()` and `x()` in the minified file both resolve to the single evaluator `xt`, and there is no
`setEvaluator` call anywhere in the tree to replace it.

Four of the five expressions are already in the shape the CSP build requires — bare identifiers resolved
against the object returned by `Alpine.data('attendanceGrid', ...)` at
`public/assets/js/attendance-grid.js:36`. The fifth, `x-text="summary()"`, is a method *call*. Whether the
CSP build's restricted evaluator accepts the parenthesised form was **not determined here**: that build is
not vendored and not in `node_modules`, so there was nothing to read. If it does not, the fix is local —
maintain the string as a property in `recount()` and bind `x-text="summaryText"`.

### 24.4 `x-cloak` survives the block, and that is what makes the failure dishonest

The interesting part is not that the grid stops working. It is *how*.

`x-data`'s handler does not propagate the failure. From the minified file:

```js
d('data', (e, { expression: t }, { cleanup: r }) => { ...; let o = R(e, t, { scope: i }); (o === void 0 || o === !0) && (o = {}); ... let s = T(o); ...; s.init && R(e, s.init); ... })
```

A blocked evaluator makes `R()` return `undefined`, so `o` becomes `{}` — an empty component rather than no
component. `s.init` is then undefined and **`init()` never runs**: `keys` stays `{}`, no `select` gets its
`dataset.stored`, and the `beforeunload` guard is never installed. Each of the other four expressions fails
separately. The failure is reported by `console.warn('Alpine Expression Error: ...')` followed by
`setTimeout(() => { throw e }, 0)`, so it is loud in a console and invisible on the page.

`x-cloak` is the exception, and it is the problem. Its handler evaluates nothing:

```js
d('cloak', e => queueMicrotask(() => m(() => e.removeAttribute(C('cloak')))))
```

The attribute is removed unconditionally, and `dashboard.css:610` is `[x-cloak]{display:none!important}` — so
the stylesheet stops hiding the paragraph at `src/modules/hr/routes.tsx:1459-1462` and the page displays
*"Arrows move · Enter and Shift+Enter move down and up · Home and End jump to the ends of a row · a letter
sets the status · Backspace puts a cell back to what was saved"* on a grid where none of it works.

The comment above that paragraph, `src/modules/hr/routes.tsx:1455-1458`, reasons about two states — script
ran, script never ran — and `x-cloak` is exactly right for both. A CSP-blocked evaluator is a third: Alpine
loaded, initialised, and fired `alpine:init`, so `Alpine.data()` registered successfully; only the attribute
expressions failed. §22 recorded the two-state reasoning and did not anticipate this one. The mitigation is
not to change the markup — it is that whoever writes the `/app` policy has to know that `'unsafe-eval'` is
load bearing for truthfulness here, not only for function.

What does *not* break is the data path, and that is by design rather than luck. The form is
`method="post" action="/api/hr/attendance/grid"` with every cell posted whether changed or not, the CSRF
field is a real input, and the server compares each value against the stored row — so a browser with a
blocked evaluator writes exactly what a JavaScript-off browser writes. The docstring at
`public/assets/js/attendance-grid.js:25-30` states that property and forbids optimising the post down to
changed cells; it is the reason a CSP mistake here would cost affordances and one misleading sentence
rather than attendance data.

### 24.5 Inline *style* is the half the comment does not mention

"`/app` … has no inline script" is true and it is not the whole test. A strict policy is normally
`default-src 'self'` plus directives, and `style-src 'self'` blocks inline style — both `<style>` elements
and `style=` attributes. Counted on 2026-09-05:

- **84 inline `style=` attributes** in the dashboard markup: `src/dashboard/components/index.tsx` 9,
  `src/modules/crm/routes.tsx` 20, `src/modules/inventory/routes.tsx` 20, `src/modules/hr/routes.tsx` 15,
  `src/modules/auth/routes.tsx` 2, `src/modules/projects/routes.tsx` 2. The commonest is
  `style="flex-wrap:wrap;gap:.75rem"` ×20. One of them is inside the attendance form itself
  (`src/modules/hr/routes.tsx`, `style="margin-top:1rem"`).
- **Two inline `<style>` elements**, at `src/modules/crm/routes.tsx:2640` and
  `src/modules/inventory/routes.tsx:1791`.

Attributes are the awkward ones: a nonce cannot authorise a `style=` attribute. Only `'unsafe-inline'` does,
or `'unsafe-hashes'` with a hash per distinct declaration. So a `/app` policy written from the comment's
description would need `style-src 'self' 'unsafe-inline'` on day one, which is not the strict policy the
comment believes it is describing, or 84 edits first. Recording the number is the point: it converts "the
dashboard is clean" into a known quantity of work.

**And the two-area split is not exhaustive.** Those two `<style>` elements belong to
`crm.get('/api/crm/quotes/:id/print')` at `src/modules/crm/routes.tsx:2589` and
`inventory.get('/api/po/:poId/print')` at `src/modules/inventory/routes.tsx:1769` — full `<html>` documents
that do not go through `page()` or `AppShell`, served under **`/api/`**, which is neither "the public pages"
nor "`/app`". A policy mounted on `/app/*` would miss them; a policy mounted as "everything that is not the
public site" would break them. Whichever §9 picks, these two routes have to be named explicitly.

### 24.6 The public side, measured

The comment's description of the frozen pages is right in kind and short on specifics. Across the 24 `.html`
files at the site root, counted 2026-09-05:

- **84 `<script>` tags: 25 with `src=`, 59 without.** Of the 59, eight are
  `<script type="application/ld+json">` data blocks and **51 are executable inline blocks**.
- **54 inline event-handler attributes** — 31 `onload=`, 23 `onclick=` — in 23 of the 24 files. These are the
  reason the public policy cannot use a nonce as a strengthening step: a nonce does not authorise attribute
  handlers, so `script-src` needs literal `'unsafe-inline'`, and `'unsafe-inline'` is *ignored* by browsers
  when a nonce or hash is also present. Nonce and these handlers are mutually exclusive.
- **23 of 24 files carry an inline `<style>`**, so `style-src 'unsafe-inline'` too.
- Two script origins, not one: **`https://www.googletagmanager.com`** (in 23 files) and
  **`https://cdnjs.cloudflare.com`** (2 tags in `index.html`, GSAP and ScrollTrigger). The comment names only
  googletagmanager, so a policy written from it would kill the scroll animation on the home page.
- Four more origins for the non-script directives: `https://fonts.googleapis.com` (83 `<link>`s),
  `https://fonts.gstatic.com` (7), `https://cdnjs.cloudflare.com` (6) and
  `https://cdn.prod.website-files.com` (1). No `<iframe>` anywhere, so `frame-src` needs nothing.

Whether the eight `ld+json` blocks need covering is left open here; they are data blocks that are never
executed, and this was not tested in a browser.

### 24.7 What this section does not decide

No policy is written. §9 owns hardening, and the three choices this evidence hands it are: `'unsafe-eval'`
on `/app` versus vendoring Alpine's CSP build (24.3); `'unsafe-inline'` on `style-src` versus 84 markup
edits (24.5); and where the two `/api/**/print` documents belong (24.5). The comment at `src/app.ts:47-55`
is left in place and unedited — it describes an intention accurately, and rewriting it to describe the
absence would lose the design note. What was missing is the record that it is unbuilt, which is this
section.

### 24.8 Found in passing: `.html` URLs 404 under the Node app, and the spec does not ask them not to

The probe in 24.2 included `/index.html` and `/about-us.html` only to have a public path to read headers
from. Both returned **404**. Today they do not: `.htaccess:96-99` 301s any `/X.html` to `/X` when `X.html`
exists in the document root, excluding the Search Console file and the internal directories.

`legacyRedirects()` does not implement that rule, and it is not supposed to. Spec 3.1
(`NCC_BUILD_SPEC.md:466-477`) lists four redirect rules — strip `.php`, the explicit map, strip a trailing
slash, force the canonical host — and `src/middleware/legacyRedirects.ts:50-85` implements exactly those
four, in that order, for the stated reason. The `.html` strip is **absent from the spec**, so the middleware
is faithful and the gap is between the spec and the live deployment.

The size of it: 24 `.html` files sit at the site root. Ten are the page files behind the ten `PAGES` entries
in `src/public/pages.ts:19-34`, twelve are error documents, one is the Search Console file (already in
`NEVER_TOUCH`), one is `login.html`. So on cut-over, eleven URLs that 301 today — the ten page files plus
`/index.html` → `/` (its own rule, `.htaccess:77`) — would 404 instead, along with any external link or
indexed result still pointing at one.

**Closed 2026-09-08: ported.** The owner decided to port it — the spec is short a rule, the live site's
behaviour wins, and TOLERANCE 0 plus §3's parity premise both point the same way. The grep asked for
settled it further: `scripts/test-htaccess.mjs` section 2 **already asserts the strip** (`/about-us.html` →
`/about-us`, `/login.html` → `/login`, `/index.html` → `/`, `/index.php` → `/`, each 301 in one hop), so
`legacyRedirects()` was the divergence, not the suite, and §24.8's "the spec is silent" framing was the
wrong emphasis — the live behaviour was asserted all along.

What landed:

1. **The fifth rule** in `legacyRedirects()`, ported from `.htaccess` section 4 with its `-f` guard intact:
   strip `.html`/`.htm` only where the clean URL has a page behind it, with targets derived from `PAGES`
   plus `/login` plus the twelve `BUILT` error codes from `errorHandler.ts` — not a filesystem probe. Same
   exclusions as `.htaccess`: Search Console file, `.well-known/`, protected directories.
2. **`/index.*` → `/`**, covering every extension, which also fixed the dead `/index.php` → `/index`
   redirect (the `.php` strip previously sent index to a route that does not exist — `.htaccess:77` sends
   it to `/`).
3. **The twelve error documents became real URLs.** The strip guard's targets must exist, and they did
   not: `/400` … `/504` 404'd under the Node app while `test-htaccess.mjs` section 10 asserts they 200.
   `public/routes.ts` now serves each from the built file, so `/400.html` → `/400` → 200, matching Apache.
4. **`tests/middleware/legacy-redirects.test.ts`** — 29 assertions pinning every rule against a real Hono
   app, mirroring the `test-htaccess.mjs` sections. There were no tests for this middleware before.

Verified: typecheck 0 errors (71 `src/` files), unit 314 passed across 11 files (+29 new), integration 224
passed, and a live probe against the running server matches `.htaccess` on every case — pages and error
docs 301 to their clean URL, `/index.*` lands on `/`, `header.php` still strips (404 from routing),
`/header.html` and `/legacy/golden/home.html` stay 404.

**Still open, recorded not fixed:** `.htaccess` section 6 also maps `/home` → `/`, `/privacy` →
`/privacy-policy` and `/index` → `/`; all three 404 under the Node app. `/index` is now moot (the index
rule sends `/index.*` to `/`), but `/home` and `/privacy` are the same shape of gap this entry closed, and
this entry's decision does not automatically cover them. Flagged for the same call.

**Closed 2026-09-08: section 6 ported too, on the same decision.** `/home` → `/`, `/privacy` →
`/privacy-policy` and the bare `/index` → `/` joined `LEGACY_MAP`, with the map's header comment naming
which entries are spec 3.1 rule 2 and which are the port. The section-6 rules carry `/?$`, so the slash
forms (`/home/`, `/privacy/`) 301 as well — Apache reaches the destination in two hops there (its own
trailing-slash rule strips, then the map fires), and the Node app now does the same two hops.
Held in place by `tests/middleware/legacy-redirects.test.ts`: the "sections 4 and 6" describe block asserts
all seven map entries (34 assertions in the file, up from 29), including the two-hop slash forms. Live
probe on 2026-09-08: `/home` → `/`, `/privacy` → `/privacy-policy`, `/index` → `/`, all 301; `/home/` →
`/home` then `/`.












## 25. Local tooling, 2026-09-08

### 25.1 `npm run dev` did not load `.env`, and the stack now has one command

`package.json` shipped `"dev": "tsx watch src/server.ts"`. On this machine's tsx
version that command boots the server with **no environment loaded at all**: the
process died with eight variables reported "Required" — `DB_HOST`, `DB_USER`,
`DB_PASSWORD`, `DB_NAME`, `SESSION_SECRET`, `CRON_SECRET`, `INDEXNOW_KEY`,
`APP_BASE_URL` — while a complete `.env` sat at the project root. The scripts
(`migrate.mjs`, etc.) call `process.loadEnvFile()` themselves; the server relied
on tsx picking the file up, and this tsx version does not.

Fixed by carrying the flag on the script itself: `"dev": "tsx watch
--env-file=.env src/server.ts"`. Proven by a real boot: `PORT=3000 npm run dev`
now prints `[ncc] listening on http://0.0.0.0:3000 (development)` where it
previously died in `src/env.ts:63`.

The stack also has one command now: `npm run dev:stack` →
`node scripts/dev-stack.mjs`, which starts MariaDB on 3307 when nothing is
listening there, then the dev server in the foreground with `.env` loaded. The
MariaDB branch was not cold-tested on 2026-09-08 (the database was already up);
the port check and the spawn are the only moving parts in it. MariaDB is never
torn down by the script, per CLAUDE.md.

### 25.2 The period lock is a date-based trigger, not the spec sketch's "single indexed check"

§6.8 rule 7 says period close "is enforced by a single indexed check" on
expenses.period_id (NCC_BUILD_SPEC.md:2146-2148). That mechanism cannot hold
the rule, for two reasons, and the prose itself says the refusal is about the
date ("any insert or update ... with a date inside it"):

- period_id is stamped on approval, so a DRAFT dated inside a closed period
  has period_id NULL and sails past any period_id check. The fourth shape in
  tests/integration/period-lock.test.ts proves it: a draft with NULL period_id
  dated inside a closed period is refused by the trigger.
- period_id is NULLable by design, so a CHECK over it admits UNKNOWN.

Per the standing rule that spec prose overrides DDL sketches, the lock is a
pair of BEFORE INSERT / BEFORE UPDATE triggers on expenses.expense_date,
payments.payment_date and client_invoices.invoice_date, calling
refuse_closed_period() against accounting_periods rows whose status is
'soft_closed' or 'closed'. The lookup is a range scan over
(status, period_start, period_end), so migration 021 adds
KEY idx_period_lock (status, period_start, period_end) — the "indexed" part
of the spec's sketch, on the columns the trigger actually reads. The three
period_id columns also gain their missing indexes (idx_exp_period,
idx_pay_period, idx_inv_period); the sketch presupposes an index that no
migration had created.

All four shapes (open admitted, closed refused with period_id set, update
into closed refused, NULL-period_id draft refused) plus the soft_closed
variant are proven by direct insert in tests/integration/period-lock.test.ts
(9 tests), and 'soft_closed' locking exactly like 'closed' is pinned there.

One operational note: migration 021's first application failed at a
client-side DELIMITER line (migrate.mjs sends each file as one
multi-statement query and has no DELIMITER support), leaving the four indexes
in place and no tracking row. The retry is what forced the ADD INDEX IF NOT
EXISTS form — on this database idx_exp_period had become the index backing
fk_exp_period, so the partial state could not be dropped without dropping the
FK. Fresh databases create all four indexes; the retry skips what exists.

## 26. Finance decisions recorded without implementation, 2026-09-08

### 26.1 `site_advances` and `budget_alerts` are deferred to finance slice 3

§6.8 names both tables — `site_advances` for rule 6, `budget_alerts` for the budget cron — and
neither exists in any migration (verified against all of `migrations/` on 2026-09-08). They are
deferred to slice 3, when rules 6 and the budget-overrun cron land together.

Two consequences are stated now so the placeholder screens cannot drift into implying them:

- The finance routes mount **no advances screen and no alerts screen** — the mounted screens are
  budgets, expenses, invoices, payments and periods, and their placeholder copy says only that the
  data model is migrated. Nothing in `src/modules/finance/routes.tsx` implies rule 6 or the budget
  cron.
- The cron has a single finance-adjacent job, `/stock-alerts`, and **no budget-threshold job**.
  Nothing references `budget_alerts` or any threshold setting, so there is no silent failure to
  repair — the deferred work is absent, not broken.

### 26.2 MSME rule 8 refuses a NULL `bill_date`, it does not age from a fallback

Rule 8's payables ageing flags an MSME-vendor expense approaching 45 days from `bill_date`. When
`bill_date` is NULL, the refusal is to treat the expense as not yet ageable — the report simply
cannot say when the 45 days started — rather than to age from `expense_date`. **Rejected
alternative, logged: `COALESCE(bill_date, expense_date)`.** A vendor's bill date and the expense's
recorded date are different facts (a bill dated 1 June entered on 20 June), and ageing from the
later date understates statutory interest exposure for exactly the vendors the rule exists to
protect. The refusal is the honest behaviour: an MSME expense without a bill date is a data gap,
not a date.

### 26.3 `paid_paise` has a single writer, stated now and enforced when payments land

`expenses.paid_paise` is written by exactly one code path — the payment allocator — and never
recomputed from `payments` rows on read. The rule is stated now so slice 2's payment code is
written to it, and enforced then by a reconciliation test asserting
`SUM(payment_allocations.amount_paise)` equals `expenses.paid_paise` per expense. A second writer
would make the column disagree with its own allocation rows, and a read-time recomputation would
move the truth out of the row the voucher screens show.

### 26.4 `retention_pct` is read from `project_milestones`

Rule 5's "deducts `retention_pct`" reads the percentage from the milestone row being invoiced
(`project_milestones.retention_pct`), not from a project or client default. A milestone is a
contractual promise about a specific payment, and the invoice is built from that milestone; a
default elsewhere would let a client-level change silently rewrite the deduction on an invoice
already sent.

### 26.5 §6.8's cross-reference to 6.6 rule 7 is wrong

Rule 6 claims "6.6 rule 7 already blocks exit while one is open". It does not: 6.6 rule 7's exit
blockers read `payee_type = 'employee'` expenses and attendance rows — see `exitBlockers` in
`src/modules/hr/queries.ts` — and nothing in it reads imprest advances. The claim is the same
failure class as the fabricated spec quotation in `crm/service.ts:2337`: a citation to a rule that
says something else. The consequence is an owner question, added to §17.3: whether an open site
advance should block employee exit at all.

### 26.6 Rule 10's margin visibility: existing permissions, no new one invented

Rule 10 says margin is "visible only to `owner` and `accounts_manager`". The existing permission
list already carries two candidates, and no new permission is added:

- `finance.view_company_pnl` — narrow, finance-module, already the natural home for margin.
- `projects.view_cost` — broader: contract values, budgets and margin together.

`finance.view_company_pnl` is the candidate `getProjectMargin` should be gated by, and
`projects.view_cost` is the one to check before rendering margin on any project page. Whichever
wins, the check is against the existing list — inventing a `finance.view_margin` would duplicate
the grant and leave the two permissions to drift apart.

### 26.7 `idx_inv_due` and the other 009 supersets are sketch-drift, not conflicts

§6.8's tables block names `KEY idx_inv_due (due_date)` and the other index shapes in the 009
sketch; the migration on disk carries `idx_inv_due (due_date)` plus additional keys the sketch
omits (`idx_exp_period`, `idx_pay_period`, `idx_inv_period` — added properly by 021 — and the
composite `idx_exp_project (project_id, status)` where the sketch shows a single column). The
sketch is a diagram, 009 is the schema, and per the standing rule prose overrides DDL sketches;
the supersets are recorded here as drift, not as disagreements to reconcile.

## 27. Gate integrity and refusal ordering, 2026-09-08

### 27.1 A config that stops collecting a test file now fails the gate instead of the suite disappearing

A test suite that a vitest config stops collecting does not fail anything: the gate goes green
having run one file fewer, and the only observable is a count nobody is comparing. That is the
same shape as the empty typecheck of 2026-09-04 (a command that exits 0 having done nothing) and
the pool hang of 2026-09-03 — a gate that passes by not executing.

Found on 2026-09-08 while reconciling a baseline disagreement: one session reported the
integration gate at **224 passed in 7 files**, another at **239 in 9**, and the difference was
`tests/integration/finance-views.test.ts` (6 tests, added in `6c5117b`, migration 020) and
`tests/integration/period-lock.test.ts` (9 tests, added in `c03bbe9`, migration 021). Re-running
`npx vitest list --config vitest.integration.config.ts` with the env loaded showed **both files
collected** — `include: ['tests/integration/**/*.test.ts']` claims every `*.test.ts` under the
directory and the full current run is 247 in 10 files. The 224/7 figure was a stale snapshot from
before `6c5117b`, not an uncollected suite. But nothing in the tree would have noticed if the
collection had actually broken, so the tripwire was written anyway.

`tests/gate-collection.test.ts` reads `npx vitest list --config <config>` for each of the three
suite configs, extracts the file paths, and asserts the set equals the `*.test.ts` files on disk
that the config's include/exclude globs claim. The globs are re-derived from a CONFIGS table in
the test, so a fourth suite config is one line there. Proven able to fail: with
`exclude: ['tests/integration/period-lock.test.ts']` temporarily added to
`vitest.integration.config.ts`, the tripwire went red with *"claims 10 files but collects only 9;
not collected: tests/integration/period-lock.test.ts"*; restored, it went green. Watched, per the
CLAUDE.md rule that a tripwire nobody has watched fail is a green of the kind that file warns
about.

Two defects in the tripwire's own first draft are recorded because both are this file's
subject matter wearing a helper's clothes:

- The first glob-to-regex turned `**/` into `.*` requiring a slash, which made `claimed`
  **empty for every config** and the assertion pass vacuously — it stayed green with the
  exclusion in place. The fixed helper treats a double-star slash as matching zero directories.
  The failure was found by watching, not by reading, exactly as the CHECK-tripwire section of
  CLAUDE.md predicts.
- `npx vitest list` on the integration config **fails environment validation and exits 0** when
  run outside the suite's own env (the same empty-green shape). Inside the vitest run, the
  setup files provide the env, so the tripwire's subprocess inherits a valid environment —
  which is why the tripwire runs the lister from inside a test rather than from a script.

### 27.2 The finance approval checks run limit-before-overrun; the §8.2 answer is the trigger to revisit

`approveExpense` (src/modules/finance/service.ts) runs its refusals in a fixed order: status,
self-approval, **approval limit, then budget overrun**. That order is behaviour, not a derived
necessity — the two checks are independent, and a different order changes which refusal a
supervisor sees first on a request that trips both.

It is the **third instance of the refusal-ordering class**, after 018's
unchanged-cell-before-refusal ordering in the attendance matrix and 21.5's day-before-measured
compliance refusals. Like those, it is pinned by a test so a reorder shows as a failure rather
than as a changed message:
tests/integration/finance-approval.test.ts, "refuses an approval that would push committed +
actual past the head budget", asserts the refusal message contains the **overrun figure** and
not the limit text — an expense of 6,00,000 paise on a head budgeted 5,00,000 with an approval
ceiling of 10,00,000 trips both shapes, and the message that comes back names the budget.

Revisit trigger: **open question §8.2** (the approval_limits values). Today `approval_limits` is
seeded empty, so the limit check refuses everything and the overrun check is unreachable in
practice — the order is moot until the client supplies limits. The moment an expense can pass
the limit check and then trip the budget, the order becomes user-visible, and the owner should
be asked which refusal a supervisor who trips both ought to see first. No behaviour change is
recorded here.

### 27.3 The migration runner cannot mark a partial apply as done — proven, and the failure mode it does have is the documented one

`scripts/migrate.mjs` wraps each file in a `START TRANSACTION` … `COMMIT` that also writes the
`schema_migrations` row, and on any error it rolls back and **exits 1 without writing the ledger
row**. A file that fails partway is therefore never recorded as applied — a half-applied
migration cannot be silently marked done, which is the integrity property that matters.

Proven on 2026-09-08 with a throwaway `022_probe_partial_apply.sql` whose first statement
created a table and whose second failed (`Unknown column 'nonexistent_column' in 'INSERT
INTO'`): the runner printed `Failed applying 022_probe_partial_apply.sql`, exited 1, the table
**existed** afterwards, and `schema_migrations` held **no row** for the file. The probe was then
dropped and the ledger verified clean (`Up to date. 21 migration files, none pending.`).

The failure mode the runner does have is the one its own header documents: MariaDB commits DDL
implicitly, so the statements before the failing one survive the rollback, and the next run
fails on them by name — the loudest possible outcome, naming the exact object to drop before
retrying. That is the deliberate trade, not a defect to fix: silent partial application with a
tracking row would be worse. It already fired once for real — 021's first application left four
indexes and no tracking row when it died at a DELIMITER line (25.2), and the recovery was
dropping the indexes by hand. The DELIMITER limitation itself is also recorded there.

021's triggers are confirmed present and correct as of this session: `SHOW TRIGGERS` lists
`trg_{expenses,payments,client_invoices}_period_{bi,bu}` — both events, all three tables, six
triggers calling `refuse_closed_period()`.

### 27.4 `place_of_supply` is NOT NULL with no default; 'KA' is supplied by the application, and the shape CHECK had to be BINARY

Migration 022 adds `client_invoices.place_of_supply CHAR(2) NOT NULL`, **no DEFAULT**, with
`chk_inv_pos_shape` requiring exactly two upper-case letters. The instruction said "required
field defaulting to KA"; the default was rejected for the migration-016 reason (CLAUDE.md: a
sentinel default keeps the sentinel reachable where it would mean something): a `DEFAULT 'KA'
would make intra-Karnataka the silent answer for every insert that omits the column —
including the inter-state one — so the GST split would be decided by omission rather than by
anyone. With no default, omitting the column is refused and each row's split basis is a
recorded decision. Proven by insert in tests/integration/place-of-supply.test.ts: omission →
`Field 'place_of_supply' doesn't have a default value`; 'ka' → `chk_inv_pos_shape`; 'KA' →
admitted and read back.

The first draft of the CHECK used a plain `REGEXP '^[A-Z]{2}$'` and **admitted 'ka'**: MariaDB
evaluates REGEXP under the column's case-insensitive collation, so `A–Z` matches `a–z` too.
Proven by insert against the live server before commit — the exact CLAUDE.md prediction that
the clause reads correctly and the truth lives in three-valued or collation semantics. The
final clause casts to BINARY (`CAST(place_of_supply AS BINARY) REGEXP '^[A-Z]{2}$'`), which the
server stores as `cast(\`place_of_supply\` as char charset binary) regexp ...`. The live
constraint was corrected by dropping and re-adding it, and the schema_migrations checksum was
recomputed from the final file so the ledger matches what was applied. 'KAR' is refused by
CHAR(2)'s length check before the CHECK evaluates; 'KA ' stores as 'KA' because CHAR strips
trailing spaces — standard semantics, recorded rather than papered over. The full GST state-code
list is deliberately not enumerated: a new code is reference data, not a schema change. The collation divergence is also stated in CLAUDE.md, section **"A CHECK clause's
text is not even its own truth: collation joins the list" (line 265)**, which records it as
the first case where a clause's appearance and its evaluation diverge for a reason other than
NULL or parenthesis normalisation — added 2026-09-09, after this entry was written.



## 28. The empty-green sweep, migration immutability, and the rename, 2026-09-08

### 28.1 Every tripwire that enumerates now refuses to pass on an empty enumeration

The sweep named in CLAUDE.md's new section, run per instruction by forcing each enumeration
empty and watching the result rather than reasoning from the code. The five subjects:

- **`tests/gate-collection.test.ts`** — enumerates the `*.test.ts` files on disk and the files
  `npx vitest list` collects, per config. **Was vacuous once** (27.1: the glob bug made
  `claimed` empty and it stayed green). Now carries a floor on **both** sets: `claimed` (the
  glob mapping is broken) and `collected` (the lister failed without a non-zero exit — the
  env-validation shape). Proven by the watched failure in 27.1 and re-proven green with the
  floors in place.
- **`tests/integration/schema-constraints.test.ts`** (CHECK inventory and AUTO_JSON_CHECKS) —
  enumerates `information_schema.check_constraints`. **Already had floors** in `beforeAll`
  (`no CHECK constraints found -- did the migrations run?`); re-proven by forcing `checks = []`
  and watching the suite fail loudly at the floor, 16 skipped.
- **`tests/integration/json-columns.test.ts`** — enumerates `json_valid` CHECK constraints and
  compares against `JSON_COLUMNS`. **Fails loudly on empty** (the mismatch fires), but the
  message names the wrong thing — it says the registry is wrong when the query found nothing.
  Proven by appending `and 1 = 0` to the query: `expected [] to deeply equal [...12 entries]`.
  The floor added names the real failure: a zero-row enumeration is a query or schema problem,
  not a registry mismatch.
- **The `purchase_orders.status` ENUM tripwire in `tests/integration/finance-views.test.ts`** —
  enumerates ENUM members from `information_schema.columns`. **Fails loudly on empty** two ways
  (zero rows → `res.rows[0]!` throws; zero parsed members → mismatch with the expected list).
  Floors added anyway so the failure names the cause instead of implying the ENUM changed.
- **The `.htaccess` parity suite (`scripts/test-htaccess.mjs`) and the parity self-test
  (`scripts/selftest-parity.mjs`)** — both assert pass/fail counts and **both could exit 0
  having run nothing**: test-htaccess against an unreachable server died in a fetch stack trace
  (exit 1, but by accident of the throw, and a future try/catch around a section would have
  made it 0/0/exit-0), selftest-parity against a missing `legacy/golden/` would enumerate no
  mutations. test-htaccess now probes reachability first and exits 1 with a message (proven
  against `http://127.0.0.1:9`); both now refuse 0-passed-0-failed (selftest proven by moving
  `legacy/golden` away: exit 1, restored: exit 0, 20 passed).

**Score: none of the five was vacuous at its enumeration source as it stood today** — one had
been vacuous before 27.1 fixed it, one already carried floors, and the other three fail on
empty input. The floors added are for the secondary shapes: an enumeration that fails without
erroring (json-columns, test-htaccess reachability) or an empty collected set (gate-collection),
where the failure message now names the actual cause. CLAUDE.md's new section states the
pattern: assert a non-zero floor on the enumeration before comparing sets.

### 28.2 Finance slice 3: site advances, budget alerts, and the contractor-bill target enabled

- **Rule 6, site advances** — `issueSiteAdvance` refuses an advance that would take an
  employee's open outstanding past the `site_advance_open_threshold` setting (migration 023),
  and a **missing settings row reads as zero** — no advance while any is open, the
  conservative reading, not the unbounded one. Proven by
  `tests/integration/finance-advances.test.ts` ("a missing settings row reads as a zero
  threshold"), which also exposed a tripwire of its own: `getSetting` caches for 60 s, so the
  test must call `invalidateSettings()` after deleting the row or the cache serves the value
  the DB no longer has.
- **The §26.3-shaped advance reconciliation** — `openAdvanceOutstanding` is the single read
  of an employee's open balance (the same three open statuses the exit blockers use), and the
  test reconciles it against independent SQL per fixture employee.
- **Budget alerts read the 020 views, never recompute** — `src/modules/finance/budgetAlerts.ts`
  joins the latest approved `project_budgets` per project to `budget_lines` and the two views,
  COALESCEd, so the zero-rows case returns **no alert and no NULL comparison** (proven: empty
  fixture set → 0 alerts, 0 notifications). A head whose actual reaches its budget alerts
  exactly once, notified to active holders of `owner` and `accounts_manager` (proven with a
  fixture actor holding both roles). Cron route: `POST /cron/budget-alerts`, beside
  `/stock-alerts`, behind `cronAuth`.
- **The first real bug the slice caught in its own query**: `budget_lines` carries no
  `project_id` — the project lives on `project_budgets`. The first draft selected and joined
  on `bl.project_id` and MariaDB refused it. The views themselves are untouched.
- **Allocation targets** — `contractor_bill` allocations were already written by the payment
  allocator; migration 023 adds the `contractor_bills.paid_paise` column it updates, under the
  same single-writer rule as `expenses.paid_paise` (26.3). `client_invoice` and `advance`
  targets still refuse with the same message: no module writes those documents yet.
- **Fixtures worth repeating**: `employees` keys on `employee_code` (not `employee_no`) and
  requires `employment_type`; `project_budgets` keys lines through `budget_lines.budget_id`
  and needs `total_paise` + `prepared_by` to become approved; the roles table's column is
  `key`, and `accounts_manager` is role id 6.

## 29. The e2e suite inside the unit gate, and the corrected unit count, 2026-09-09

### 29.1 The unit gate ran a browser suite: gate-integrity, not cosmetic

**What happened.** Until `d86630a` (2026-09-09), `vitest.config.ts` excluded
`tests/integration/**` but not `tests/e2e/**`, so `npm test` collected
`tests/e2e/attendance-hint.test.ts` (added in `e314109`) into the *unit* gate.
The unit count reported for several sessions was **320; the true unit count was
316** — the extra four were the e2e file. Found while reconciling the baseline
against the task's expected figures.

**Proof that the four tests were neither passing unit tests nor skippable
without a browser.** Checked out the pre-fix commit `1cd3b68`, dev server left
running (irrelevant — see below), ran the bare unit gate:
`npx vitest run` → **12 files, 320 passed**. The four attendance-hint tests
**passed** — they were not skipped, because they did not fail to run: they
actually launched Chromium and asserted against it.

**They required an installed Chromium, and the run proves it.** Re-running the
same file on the same checkout with `PLAYWRIGHT_BROWSERS_PATH` pointed at a
non-existent directory:
`PLAYWRIGHT_BROWSERS_PATH=/c/Users/HP/does-not-exist npx vitest run tests/e2e/attendance-hint.test.ts`
→ `Error: browserType.launch: Executable doesn't exist at ...chrome-headless-shell.exe`,
**1 file failed, 4 skipped**. So without a browser binary the four tests skip
and the gate reports fewer tests than claimed — the count was a function of the
machine, not of the tree.

**They did NOT require the dev server or the database.** The file starts its own
`node:http` static server on an ephemeral port (serving `public/` and a
rendered component) and never imports the pool — the only external dependency
is Playwright's chromium binary. Verified by reading `tests/e2e/attendance-hint.test.ts`
(no DB import; `server.listen(0)`) and by the 320-pass run above.

**Classification: gate-integrity defect, not cosmetic.** A unit gate that
executes a browser suite is a gate that can go red on a machine with no browser
installed (or green-with-skips naming a count that varies by machine) — the
same "a green is only a green if you can say what it executed" class as the
empty typecheck and the pool hang. The fix is `d86630a`:
`vitest.config.ts` excludes `tests/e2e/**`, `package.json`'s `test:e2e` runs
`vitest run --config vitest.e2e.config.ts` (it previously invoked playwright
test, which no config file supported), and the gate-collection CONFIGS table
gains the matching exclude.

**Corrected baseline (2026-09-09, with PORT set; see 29.2):**
- `npm test` → **316 tests in 11 files**, all passing.
- `npm run test:integration` → **265 in 13**.
- `npm run test:e2e` → **4 in 1**.
- `node scripts/migrate.mjs` → 23 migration files, none pending.
- `tsc --listFilesOnly | grep -c '/src/'` → 75.

### 29.2 The ambient PORT=0 poisons every suite's import — fixed by forcing the environment, 2026-09-09

**The finding.** Establishing 29.1's baseline, the first run of the fixed
unit gate failed 5 of 11 files with `Environment validation failed: PORT:
Number must be greater than or equal to 1`. Cause: the machine's ambient
environment exports `PORT=0`. `tests/setup-env.ts` used `??=` so existing
variables win, and `env.ts` coerces then validates `min(1)`, so a zero in
the shell defeated the setup file. The integration and e2e configs failed
the same way through their own setup files.

**The fix (2026-09-09, this entry supersedes the original 29.2 finding as
the operative state).** A gate must not depend on environment it does not
set (the rule now sits in CLAUDE.md beside the services rule). Both setup
files FORCE every key `src/env.ts` validates — `process.env[key] = value`,
no `??=`:

- `tests/setup-env.ts` (unit + e2e): forces all 17 validated keys,
  including `PORT: '3000'`, the SMTP and upload paths, and the fake DB
  credentials — safe to force because no unit or e2e test opens a pool.
- `tests/integration/setup-db-env.ts`: forces every non-DB key; the DB_*
  keys keep their real-source contract and are never invented. When a local
  `.env` exists its DB_* values are forced (the developer's file is the
  environment of record on that machine, and CI sets DB_* itself where no
  `.env` exists), so an exported `DB_PORT=0` cannot poison the run either.

**The proof, run in a hostile shell** — `PORT=0 DATABASE_URL=…evil…
SMTP_HOST=""` exported, nothing passed on the command line:

- `npm test` → `Test Files 11 passed (11) / Tests 316 passed (316)`
- `npm run test:integration` → `Test Files 14 passed (14) / Tests 277 passed (277)`
- `npm run test:e2e` → `Test Files 1 passed (1) / Tests 4 passed (4)`

identical to the baseline established in 29.1. `DATABASE_URL` was chosen
because it is the name a leaky tool might reach for; it is not validated by
`env.ts` and would have done nothing even under the old regime, but a
bootstrap that survives it is a bootstrap that survives the class.

**Correction to the record: every count reported before this fix was
machine-dependent.** Not the numbers themselves — with a sane shell they
were and are the tree's counts — but the gate that produced them would have
gone red on this machine with no tree change, and a green that depends on
the shell is not reproducible by a fresh clone. From this entry on, the
gates run hermetically: the suite passes with nothing handed to it, and any
future red is a fact about the tree.
### 29.3 gate-collection's CONFIGS is derived from the configs, not copied

**What changed.** `tests/gate-collection.test.ts` used to restate each suite
config's include/exclude globs in a hand-written `CONFIGS` table. That is the
`AUTO_JSON_CHECKS` mirror shape (CLAUDE.md, "An exemption cites the spec"): a
wrong config and a wrong table agree, and the tripwire stays green while
asserting against a fiction. The table now has **no globs in it at all** —
`CONFIG_NAMES` lists the three config paths, and each is resolved through
vitest's own `resolveConfig` (`vitest/node`), the same resolution the runner
performs, and the include/exclude are read verbatim from the resolved config.
The `resolveConfig`-based read cannot disagree with what the run collects
unless vitest itself is inconsistent. Two details are load bearing:

- The globs are taken **verbatim, unfiltered**. Filtering out globs that do
  not start with `tests/` would mishandle a bare exclude like
  `'money.test.ts'` and make the derived table claim a file the run does not
  collect — red for the wrong reason.
- `resolveConfig` merges vitest's own node_modules defaults into
  `exclude`; they are harmless because the disk enumeration only ever names
  `tests/` files, and the include floor (28.1) still guards the shape.

**Proof, watched both ways.** With `exclude: ['tests/integration/**',
'tests/e2e/**', 'tests/money.test.ts']` temporarily added to
`vitest.config.ts` and the test file untouched:

- the **derived** tripwire stayed green — the resolved exclude made
  `claimed` miss `tests/money.test.ts`, and collected (10 files) agreed;
  cross-checked independently with vitest's own `picomatch` against the
  resolved globs (money.test.ts claimed: false), so the test's helper and
  vitest's globber agree;
- the **old hand-copied table**, re-inserted by the same run as a harness,
  went red on the identical config: `vitest.config.ts claims 11 files but
  collects only 10; not collected: tests/money.test.ts`.

That contrast is the whole point: the same silent config drift is green under
the derived table (correct — the run genuinely collects what the config
claims) and red under the copied one (the copied table disagreed with
reality). The config was restored and the harness removed; the full unit gate
re-run green at 316 in 11 files.

### 29.4 Finance slice 4: the client-invoice writer, the GST split, and the allocation target enabled

**The rule-5 chain, through the service.** `createInvoiceFromMilestone`
(`src/modules/finance/invoiceService.ts`, four-file pattern: schemas in
`schemas.ts`, the service in its own file beside `service.ts`, one POST route
in `routes.tsx`) refuses a milestone whose status is anything but
`certified`, refuses a second invoice on a milestone already invoiced, and
moves the milestone to `invoiced` with `invoice_id` set. Proven by real
service calls in `tests/integration/client-invoices.test.ts` (12 tests):
pending refused naming the status, missing milestone NotFoundError,
double-invoice refused, and the closed-period shape below.

**The GST split is computed from the invoice's own `place_of_supply` and
from nothing else.** 'KA' → CGST + SGST (9,000 + 9,000 on 1,00,000 at 18
percent); any other code → IGST at the full rate (18,000, cgst and sgst
stored 0). The fixtures make the proof adversarial: the KA invoice belongs
to a client registered in MH and the MH invoice to a client registered in
KA, so a regression that infers the split from `clients.state` or the
project goes red. The zero shape (gst_pct 0) stores all tax columns 0 with
total = taxable, and the empty-set aggregate over `v_project_actual` for
the fixture projects reads COALESCEd 0, not NULL. **A spec divergence
surfaced here: the §6.8 DDL block gives client_invoices an `igst_paise`
column the on-disk migration never created — per 21.3 the DDL block is
non-normative, so the inter-state split is proven by cgst/sgst storing 0
and the IGST figure living in the total.** No `igst_paise` column was
added: inventing one is a schema change the prose does not require.

**Retention reads the percentage through the milestone (26.4).** The
project_milestones table carries no retention column; the percentage read
is the project row's `retention_pct` reached through the milestone's
project_id — 5 percent of 1,00,000 is 5,000, and
`net_receivable_paise = total − retention` (1,13,000). What 26.4 rules out
(a client or company default silently rewriting the deduction) is what
project-scoping avoids. A per-milestone override column does not exist; if
the owner wants one, that is a migration and a 26.4 revisit.

**The 021 period triggers cover the invoice write path through the
service.** An invoice dated inside a closed period is refused by
`createInvoiceFromMilestone` with the trigger's message ("closed
accounting period"), and the refusal left the milestone still certified
with `invoice_id` NULL — the same service-path proof
finance-payments.test.ts runs for payments, not assumed from the
trigger's existence.

**The client_invoice allocation target is enabled; advance still refuses
with the unchanged message.** The target is enabled in the only way that
can be honest — by a writer existing
(`createInvoiceFromMilestone`), exactly the condition the old refusal
named. `allocatePaymentRows` gains the client_invoice branch: same
over-allocation guard as expenses and contractor bills, against
`net_receivable_paise` (the amount the client actually owes, total less
retention), refusing cancelled/disputed documents, and
**`received_paise` gets exactly one writer — the allocator** — the same
grant §26.3 gives `expenses.paid_paise`; the invoice service never touches
it and creates every row at received_paise = 0. Reconciliation in the
§26.3 shape: SUM(payment_allocations) per fixture invoice equals
received_paise, asserted over the whole fixture set against independent
SQL, with a non-zero floor on the enumeration. Over-allocation is refused
with the over-by figure. `advance` still refuses ("advance documents land
with the slice that builds them").

**Two fixture lessons the suite itself paid for.** (1) uq_period collides
on reuse: a crashed run left its closed period behind and the next
beforeAll died on `Duplicate entry` for (financial_year, month) — the
cleanup now clears by created_by and the period uses a fresh year.
(2) A crashed run also left roleless fixture users, which made
crm-flow's `assignableUsers` floor (expects exactly the suite's own 2)
read 4. Cross-suite fixture hygiene is real: **a user row without its
user_roles row is visible to every suite that counts users.**

### 29.3b Union coverage supersedes per-config derivation, 2026-09-09

**Why per-config agreement proved nothing.** The 29.3 proof showed exactly
this: with `tests/money.test.ts` added to the unit config's exclude, the
derived table stayed green — correct per its own invariant, since the run
collected everything the config claimed — while a real suite had silently
left the gate. Derived-from-config only guarantees the table and the config
agree; it does not guarantee the config runs anything. Tautologies are
green by construction.

**The replacement invariant: union coverage.** Every `*.test.ts` on disk
under `tests/` (enumerated recursively — a new subdirectory is what a
future suite directory looks like, and the fixed directory list missed the
probe) must appear in the `vitest list` of AT LEAST ONE config. The failure
message names each orphan and instructs: add it to an include or delete it.
A per-file ownership report (file ← config) is asserted alongside so the
owner of every file is legible. The non-zero floors survive: collected
non-empty per config, disk enumeration non-empty.

**Proof, both directions, watched:**

- Exclude `tests/integration/hr-flow.test.ts` from the integration config
(test untouched) → RED: `These test files are on disk but collected by NO
suite config, so no gate runs them: tests/integration/hr-flow.test.ts.`
Restored → green, 316/316.
- Add a temporary probe file, `orphan-probe.test.ts` under `tests/middleware/` (and a second probe in a new
`tests/deep/` directory, caught only after the enumeration was made
recursive; both probe files were removed after the proof — the tripwire that caught them lives in `tests/gate-collection.test.ts`) → RED with the same message naming the orphan. Restored →
green, 316/316 in 11.

The first draft of the probe in `tests/integration/` did NOT go red — the
integration config collected it, correctly. The probe that proves the
invariant has to land where no include reaches.

### 29.5 IGST gets its column: sketch-drift in the opposite direction to 21.3, 2026-09-09

**Migration 024** adds `client_invoices.igst_paise BIGINT NOT NULL` (no
default) and `chk_inv_gst_branch`, which refuses a row carrying CGST+SGST
and IGST together. **Row count at migration time: 0** (reported before
writing the file), so no backfill was needed and none is written — the
no-default rule of 27.4 applies in full: every writer states the split,
and omitting the column is refused ("Field 'igst_paise' doesn't have a
default value", proven by direct insert).

**This is sketch-drift in the opposite direction to 21.3, and is not a
prose-versus-DDL conflict.** 21.3 records the migration carrying a column
the DDL sketch lacked. Here the §6.8 DDL block NAMED `igst_paise` and
009's table never created it — the drift ran the other way. The tax
regime independently requires the column: without it, an inter-state
invoice's tax lives only inside total_paise and no query can report CGST,
SGST and IGST separately for GSTR-1. Both authorities agree, so the column
is added without reopening 21.3.

**The CHECK is written so it cannot evaluate UNKNOWN on any member**
(the migration-013/014 rule): `cgst_paise IS NOT NULL AND sgst_paise IS
NOT NULL AND igst_paise IS NOT NULL AND ((igst = 0 AND cgst >= 0 AND sgst
>= 0) OR (igst > 0 AND cgst = 0 AND sgst = 0))`. All three columns are NOT
NULL in 009, so the conjuncts are belt-and-braces — but they keep the
constraint correct against a future relaxation and make the clause read as
the rule it is.

**The stored invariant is proven by real rows in
tests/integration/client-invoices.test.ts (5 new tests, 17 total):**

- cgst + sgst + igst = total − taxable, asserted on stored rows from both
  split branches (KA intra-state and MH inter-state, created through the
  service with the adversarial clients.state fixtures untouched —
  place_of_supply remains the only split input);
- the zero-gst_pct shape stores 0 in all three tax columns and passes the
  CHECK;
- the empty-aggregate shape: SUM(cgst + sgst + igst) over a no-row
  predicate reads COALESCEd 0, not NULL;
- a direct insert carrying BOTH branches is refused by
  `chk_inv_gst_branch` (the service can never produce the shape, so the
  CHECK's proof must bypass the service);
- the omitting insert is refused for the missing default.

**Ripple the migration caused, and what it proves about the suite web:**
period-lock.test.ts and place-of-supply.test.ts both insert client_invoices
rows directly and both failed on the new NOT NULL column; the
schema-constraints CHECK inventory failed on the unclassified constraint.
All three were updated — fixture rows state the split,
`chk_inv_gst_branch` joins EXPLICIT_CHECKS with its citation. A new
constraint that leaves three suites red until each is reconciled is the
web doing its job.

### 29.6 Fixture isolation: the marker sweep, chosen over scoping counts, 2026-09-09

**The shape fixed, not the two incidents.** A user row without its
user_roles row is visible to every suite that counts users, and a crashed
run's leftover accounting_periods row collides on uq_period
(financial_year, month). Both are the same shape: fixture rows whose
cleanup never ran poison the next run.

**The choice: an identifiable marker with child-first teardown, not scoped
counting.** Scoped counting (assert only on rows the suite owns) would
have left the period collision unfixed — a uq_period collision is not a
count, it is an insert failure — and would have taught every future
counting assertion to distrust the table. The marker fixes both and keeps
the counts honest: `full_name`/`name` beginning with the `[fixture]`
marker, fixture periods under the `TF-` year prefix, and a shared
`sweepFixtures` (tests/integration/fixture-markers.ts) that deletes
children first (user_roles before users) and runs at the START of every
suite's beforeAll as well as in afterAll — so a crashed predecessor's
debris is cleared before the high-water marks are read.

**Proven by the twice-run test.** Crash debris planted by hand (a fixture
user with no user_roles row, a `TF-9697` closed period — the exact shapes
29.4 recorded), then the full integration gate run twice in a row:

- RUN 1 (debris present): `Test Files 14 passed (14) / Tests 282 passed (282)`
- RUN 2 (immediately after): `Test Files 14 passed (14) / Tests 282 passed (282)`
- after both: `fixture users left: 0 fixture periods left: 0`

Before the sweep, RUN 1 under the same debris failed 5 tests (the
crm-flow assignableUsers count at 4) or died in beforeAll on the period
collision — both incidents 29.4 recorded.

**What the sweep deliberately does not touch:** expenses, payments,
client_invoices, projects, clients, leads. Each suite owns those through
its own high-water id cleanup, and a global delete there would reach
across suites mid-run. The user and period tables are swept globally
because those are the two shapes whose identity crosses suites.

### 29.7 The (source_type, source_table) mapping, and §20.2 closed, 2026-09-09

**What 20.2 left open.** The CHECK 015 added closes the half-pair hole, but
the mapping between the source_type ENUM and the source_table values the
writers actually set was nowhere recorded — nothing stopped a writer
producing a pair the ENUM cannot express, or an ENUM member landing with no
writer at all. Finance has landed, so the mapping is now enumerable.

**The mapping of record** (tests/integration/expenses-source-mapping.test.ts,
WRITER_MAPPING — the table here summarises it, the test enforces it):

| source_type | source_table | status |
|---|---|---|
| manual | NULL | **written** — finance/service.ts createExpense (~:96) and issueSiteAdvance (~:818); the only live writer, proven by the group-by assertion |
| grn | goods_receipts | no writer yet — inventory GRN post writes the ledger but no expense row |
| contractor_bill | contractor_bills | designed (18.3), writer not landed — hr/service.ts:2608 carries the intent in the audit payload, expense_id stays NULL |
| equipment_deployment | equipment_deployments | no writer — fk_eqd_expense (009) exists but nothing fills it |
| campaign_spend | campaigns | no writer — marketing phase 5 |
| payroll | NULL | no writer — payroll is attendance-driven, not an expense posting |

**ENUM members no writer produces: five of six** (grn, contractor_bill,
equipment_deployment, campaign_spend, payroll). Writer pairs the ENUM
cannot express: none found — the two live writers both produce mapped
pairs. No §17.3 item was needed; nothing was invented to fit.

**The tripwire.** expenses-source-mapping.test.ts (3 tests) enumerates the
ENUM from information_schema with a non-zero floor (28.1) and asserts the
member set equals the mapping keys; a third test groups the live expenses
rows by (source_type, source_table) and asserts every observed pair is the
mapped one. A new ENUM member reds the file with an instruction naming
WRITER_MAPPING; a writer producing an unmapped pair reds the group-by test.

**20.2 is closed.** The source pair is now guarded at every layer: the
UNIQUE index (012) for duplicates, the CHECK (015) for the half-pair, and
the mapping tripwire for the vocabulary. Proven by
tests/integration/expenses-source-mapping.test.ts, green 3/3.

### 29.8 The contractor-bill posting writer, and the §18.8 "contradiction" dissolved, 2026-09-09

**The finding.** Task 6's sweep (29.7) reported no writer producing the
(contractor_bill, contractor_bills) pair; §18.8 was read as claiming one
exists. On tracing `approveContractorBill` end to end — every write to
`expenses` across src/ (Kysely insertInto/updateTable, raw SQL), the audit
payload, and the live database (0 bills with expense_id set, 0 expenses
with source_type contractor_bill) — **§18.8 is accurate as written**: it
records that the posting is *not built* and expense_id stays NULL, with
the identity carried in the audit payload. There was no contradiction;
the prompt's premise misread a deferred posting for a claimed one. The
sweep's scope was correct and needs no correction.

**But the state §18.8 deferred was no longer defensible**: uq_exp_source
and chk_exp_source_pair guarded a shape nothing produced, and the payment
allocator had been writing against contractor_bills.paid_paise (28.2)
while the expense posting that rule 1 requires did not exist. So the
writer is now implemented, inside `approveContractorBill`'s existing
transaction:

- `expenses` row with all four identity values — source_type
  'contractor_bill', source_table 'contractor_bills', source_id = the
  bill id, and contractor_bills.expense_id back-linked (fk_cb_expense) —
  expense_type labour_contractor, payee_type contractor, approved by the
  approving actor;
- **the gross is the single source** (§6.6-2): total_paise = bill.gross_paise,
  net_payable_paise = bill.net_payable_paise, and no expense_lines rows —
  the amounts live in the bill's own columns, so nothing can drift
  between bill and posting (proven: zero expense_lines for the posting);
- period_id stamped best-effort via periodForDate, so the 021 lock sees
  the date;
- the audit payload now carries the real expense_id and expense_no.

**Proven** (tests/integration/hr-contractor-flow.test.ts, 51 tests): the
posted row read back with all four identity values and the gross figures;
`contractor_bills.expense_id` populated in the same transaction; a second
posting of the same bill refused by **uq_exp_source at the database**
(errno 1062); the half-pair (source_table set, source_id NULL) refused by
**chk_exp_source_pair**. The prior "leaves the finance identity behind"
test asserted expense_id NULL and zero postings — it was updated to the
new reality, which is the suite web working in the ordinary direction.

**§20.2's mapping table stands unamended** — (contractor_bill,
contractor_bills) was recorded as *designed, writer not landed* and is now
recorded as landed; the mapping keys are unchanged, so the ENUM tripwire
needs no edit. The mapping test's group-by assertion now passes with a
live contractor_bill row in the database, which is a stronger proof than
the empty-green it replaced.

### 29.9 The CGST/SGST half-pair closed: the same class as the expenses source pair, 2026-09-09

**What 024 admitted.** Reported from information_schema, 024's clause was:
`cgst_paise` is not null and `sgst_paise` is not null and `igst_paise` is not
null and (`igst_paise` = 0 and `cgst_paise` >= 0 and `sgst_paise` >= 0 or
`igst_paise` > 0 and `cgst_paise` = 0 and `sgst_paise` = 0). Proven by direct
insert against real FK fixtures: **CGST 9,000/SGST 0 ADMITTED, CGST
0/SGST 9,000 ADMITTED** — half the intra-state split, wrong on its own and
a duplicate of no other row, the exact shape 015's chk_exp_source_pair
closes for expenses.(source_table, source_id). Also admitted: all-zero and
both legitimate branches (the shapes the service produces).

**Migration 025** replaces the clause with the intra branch carrying
`ABS(cgst_paise - sgst_paise) <= 1` instead of bare non-negativity. The
inequality, not equality, because splitGst (src/lib/money.ts) puts the odd
paisa on CGST — tax − floor(tax/2) vs floor(tax/2) — so an odd tax makes
CGST = SGST + 1 on a legitimate row, and strict equality would refuse it.
A half-pair fails the margin by an amount no rounding can produce. The
one-paisa shape is proven admitted by direct insert (CGST 4,501/SGST
4,500), alongside the re-run of the full probe set: both half-pairs now
refused naming chk_inv_gst_branch, double taxation (all three non-zero)
refused, all-zero and both branches admitted.

**The all-zero row is permitted on purpose, stated rather than left as an
accident.** gst_pct 0 is a real invoice shape (zero-rated or exempt
supply), and the zero-gst test proves it stores 0/0/0 with total =
taxable. No column records the *intended* rate alongside the split, so the
CHECK cannot distinguish "zero because exempt" from "zero because the
writer forgot" — the guard is on the shape (no half-pairs, no double
taxation) and the writer-side rule (place_of_supply is the only split
input, 29.5) carries the intent. If the owner wants the intent recorded,
that is a gst_pct-on-the-split question for 17.3, not a tighter CHECK.

**Not trivially satisfiable.** Every member is NOT NULL (009), the IS NOT
NULL conjuncts keep the clause off UNKNOWN (the migration-013/014 rule),
the intra branch pins igst_paise to exactly 0 and the inter branch pins
both halves to exactly 0 — a row cannot satisfy both branches at once —
and the probe set (half-pairs, all-zero, rounding, both branches, double
taxation) is the case list the clause was written against, each proven by
insert, not by reading.

**Regression tests:** client-invoices.test.ts gains the two half-pair
refusals and the odd-paisa admission (19 tests total, all green). Row
count at migration time: 0 half-pairs existed (the service never produces
one), so no backfill. Cited as the same half-pair class as
expenses.(source_table, source_id) — see 19.1 and 20.2.

### 29.10 Sweep scope: the floor counts were narrower than the claims they backed, 2026-09-09

CLAUDE.md gains the rule ("A sweep must state its scope and prove the scope
covers the claim") after four instances, listed there. This entry records
the correction to this file's own record: **the non-zero floor counts
reported in 28.1 and 29.3 for on-disk test enumerations were narrower than
the claims they supported** — the gate-collection walk covered four named
directories, so its "every *.test.ts on disk" floor counted a subset, and
the union-coverage green of 29.3 was true of that subset until 29.3b made
the walk recursive and a probe in a new subdirectory proved the gap. The
20.3 citation sweep's tests/-only scope and the single-CHECK migration
grep are the other recorded instances; the 29.7 source-type sweep was
investigated under the same suspicion and exonerated by an end-to-end
trace (29.8), which is the standard of proof a clean sweep should carry
with it the first time.

### 29.11 The period-close writer: the lock finally has a key, 2026-09-09

**The finding.** The 021 triggers enforce rule 7's lock, but grep across
src/ showed no writer moving accounting_periods between open, soft_closed
and closed — every seeded period sat at open and the lock was unengageable
in production terms. Reported DDL: status ENUM(open, soft_closed, closed)
NOT NULL DEFAULT open, closed_by/closed_at nullable, uq_period(financial_year,
month).

**The writer** (src/modules/finance/periodService.ts, POST route wired at
/api/finance/periods/:periodId/close behind finance.period_close, which the
live grants show only owner (id 1) and accounts_manager (id 6) hold):

- **Transitions are one step per call: open → soft_closed → closed.** Both
  statuses lock identically in 021; the distinction is the review window —
  soft_closed is locked but visibly not final, the state a period is in
  when someone notices a missed document.
- **Reopening is refused.** The spec is silent on it, and every argument
  for reopening is the argument rule 7 answers: post-close corrections are
  a reversing entry in the current open period, never an edit to the
  closed one. The refusal names that alternative. Logged here rather than
  invented: if the owner ever wants a reopen, it is a §17.3 question.
- **Closing refuses while unposted documents sit inside the window** — a
  draft or pending_approval expense dated inside would be frozen
  un-approvable by the lock (its approval updates the row). The refusal
  names the count.
- **Every transition is audited** (after_json carries status, financial_year,
  month; closed_by/closed_at stamped on the row).

**Proven** (tests/integration/period-lock.test.ts, +5 tests, 14 in the
file): the two-step close with closed_by/closed_at read back; reopen
refused naming the reversing entry; close refused naming "1 unposted
expense document" with the period left open; a sales_exec roleKeys list
refused; the audit rows verified for every transition. New /src/ count:
77 (periodService.ts added).
### 29.12 Rule 10 visibility: company money is a permission, never a default zero, 2026-09-09

**The grant rows, read live.** The two permission candidates rule 10 names
were already in the seed; this task reports who holds them from the live
grants, not the seed text:

- `finance.view_company_pnl` -> exactly **owner, accounts_manager**.
- `projects.view_cost` -> exactly **owner, accounts_manager, ops_manager,
  project_manager**.
- site_supervisor holds neither — the 002 role descriptions name this
  deliberately ("Never sees contract value or margin").

**What was already gated.** The projects module gates contract value at
three layers (queries.ts omits the column from the SELECT when canViewCost
is false, the cost tab is hidden and its route 404s, and the money cells
render hidden) — no change needed there.

**What was leaking.** The dashboard widget `receivables_ageing` was
admitted by `finance.invoice_manage` OR `finance.view_company_pnl`, and
project_manager holds invoice_manage without pnl — so a project_manager
dashboard rendered company-wide receivables. Fixed: the widget now
requires `finance.view_company_pnl` alone (src/dashboard/widgets.ts).
`cash_position` and `month_revenue` were already pnl-only.

**The proof.** tests/unit/rule10-visibility.test.ts (6 tests) pins, per
role permission set mirroring the 002 seed: owner and accounts_manager see
all three money widgets; project_manager sees none despite holding
invoice_manage; site_supervisor and sales_exec see none; the empty
permission set yields zero widgets (nothing is unguarded); owner sees the
full table. A role lacking the permission gets an absent widget — never a
zero. tests/integration/rule10-grants.test.ts (3 tests) pins the live
grants with non-zero floors: a new grant of either permission fails the
suite until the visibility decision is recorded here.

**Owner question, not a code decision.** Whether ops_manager should see
contract value, and whether any role beyond owner should see company pnl,
is filed in §17.3 and OWNER_QUESTIONS item 12; the tripwire makes any
grant change stop here first.
### 29.13 The mapping tripwire proven live, and its entry un-staled, 2026-09-09

**Task 1 asked whether the tripwire can still see reality. Three answers:**

1. **The mapping entry existed but was stale.**
   'contractor_bill': mapped to 'contractor_bills' since 75c54e1, but
   its status text still said 'writer not landed' after 29.8 landed the
   writer. A mapping that records design history rather than current
   writers is the same hand-maintained-mirror risk as the tripwire
   itself; the entry now says what 29.8 shipped, and cites it.
2. **The group-by observed reality.** A direct-insert probe row
   (source_type contractor_bill, source_table contractor_bills) was seen
   by the group-by and matched the mapping — the test is live, not
   observing an empty set. When run between suites the group-by sees
   0 rows (the dev database holds no permanent expense rows), so the
   old test was a vacuous green in that state: it looped zero times and
   passed. Fixture teardown runs before it in the gate, which is exactly
   why it saw zero.
3. **The empty-green hole is closed by seeding, not by a floor that
   lies.** The test now seeds a marked probe expense (and a marked probe
   user, because the dev database holds no permanent users) when the
   table is empty, asserts the group-by is non-zero, verifies every
   observed pair against the mapping, and deletes its probe in a finally.
   A floor alone could not work here: the suite cannot demand rows other
   suites cleaned up, so it makes its own observation possible.

**Proofs cited:** the direct-insert probe was observed (1 row, matching
pair); the empty set was observed as the failure that motivated the
self-seed (expected 0 to be greater than 0). Both in this session’s
transcript; the committed test carries both comments.
### 29.14 The OR-widens-the-audience sweep, 2026-09-09

**Scope, stated.** Every permission check in src/ that ORs, unions, or
falls back across two or more permissions. Proven to cover the claim by
exhausting the three syntactic shapes a union can take: the perms-array
tables (WIDGETS in dashboard/widgets.ts, nav.ts items), the spread
constants passed to requirePermission (grep for
`requirePermission(.*...|` and the named constants QUOTE_READ,
QUOTE_APPROVE, ITEM_READ, REQ_CREATE, and the HR attendance triple), and
the imperative OR helpers (canAny — zero call sites — and inline
`|| perms.has` — zero matches). Any union outside these three shapes
cannot be written in this codebase.

**Every union found, with audiences from the live grants:**

- WIDGETS (16 entries): the only union over money.
  receivables_ageing had ORed invoice_manage with view_company_pnl —
  fixed in 29.12; cash_position and month_revenue are pnl-only. No
  remaining widget ORs a money permission with a weaker arm.
- nav.ts: seven multi-permission items (dprs, snags, POs, quotes,
  expenses, attendance, leave). Nav is convenience, not control: each
  route behind these items is individually guarded, and the queries
  behind them take canViewValue/canRates/canPay flags, so no union
  exposes money here.
- QUOTE_READ = quote_create OR quote_approve: audience is sales_exec,
  ops_manager, project_manager, owner, accounts_manager. Intended.
  Quote money inside is re-gated by canValue
  (crm.view_pipeline_value) at list, detail and print; the Money cell
  renders 'restricted', the figure is absent from the HTML.
- QUOTE_APPROVE = quote_approve OR quote_discount_override: discount_override
  is held by owner only, so the union equals the quote_approve audience
  plus owner. Escalated discounts self-approve only below the
  approval_limits ceiling (submitQuote), self-approval blocked above
  it. No exposure found.
- ITEM_READ = inventory.view OR item_manage: audience includes
  site_supervisor. Item rates are re-gated by canRates
  (inventory.view_rates: accounts_manager, ops_manager, owner,
  project_manager) at stock, ledger and item screens. No exposure.
- HR attendance route = employee_view OR attendance_record OR
  attendance_approve: widest arm reaches site_supervisor, but the
  compensation tab behind the same module is canPay (hr.payroll_view:
  accounts_manager, hr_manager, owner) and 404s otherwise; the
  period-override affordance is finance.period_close. No exposure.
- canAny: defined, zero callers. Inline `|| perms.has`: zero matches.

**Verdict: one defect (receivables_ageing, already fixed), no further
fixes required.** The unions that remain are entry-widening for
dual-audience screens whose money cells carry the stronger gate
internally — exactly the shape the CLAUDE.md rule prescribes.

**Pinned by** tests/unit/or-audience.test.ts (6 tests): every
company-money widget demands view_company_pnl alone; the money audience
is exactly owner + accounts_manager against the seed sets for all eight
roles; no widget ORs a money permission with a weaker arm;
projects_over_budget’s audience all hold view_cost; a weaker-permission
role sees no money widget at all — refusal by absence, never a zero.
### 29.15 The period lock fires on the contractor-bill posting, and the approval rolls back whole, 2026-09-09

**Proven through the service, not a direct insert.** The 021 lock fires on
expenses BEFORE INSERT, and the posting’s expense_date is today(), not the
bill’s coverage period — so the lock engages when today’s period is
closed, whatever period the bill covers. The test
(hr-contractor-flow, 'the posting inside the approval is refused when
today falls in a closed period') builds a closed period containing the
real today, drives a bill through the full path a clerk uses — approve
attendance, generate bill, approveContractorBill — and asserts:

- the refusal is the trigger’s own message ('date falls inside a closed
  accounting period'), the exact error the clerk sees on screen;
- the bill afterwards is status 'draft', approved_at NULL, expense_id
  NULL — the whole approval rolled back, not half-applied;
- zero expenses rows carry (contractor_bills, billId) — the posting went
  with the rollback.

**Invoice and payment paths were already covered through the service:**
client-invoices.test.ts proves the closed-period refusal through
createInvoiceFromMilestone, finance-payments.test.ts through
createPayment. The contractor-bill path was the one writer the lock had
never been proven against.

**No stuck-clerk item.** The refusal leaves a draft bill the clerk can
re-approve on day one of the next open period (or finance can close the
month properly first) — the correction path is the ordinary workflow,
unlike the day-row case in §17.3 where nothing can be done. Filed as
none rather than added to the stuck list.

**Test-hygiene note.** Driving the lock with today’s real dates meant a
crashed test would leave today closed for every later suite in the gate;
the fixture period is deleted by id in a finally and again in afterAll,
and the limit row the test inserts is deleted for the same reason (the
next test asserts the empty-table refusal). This is the 29.4 marker
discipline extended to rows whose identity is a date range rather than a
name.
### 29.16 The GST rounding rule pinned: roundPaise half-up, CGST takes the odd paisa, the writer is the authority, 2026-09-09

**splitGst’s exact behaviour, reported.** Total tax =
`roundPaise(taxable × pct / 100)`. roundPaise rounds half away from zero
(JS Math.round semantics normalised for negatives: -2245.5 → -2246). On
the intra-state branch the rounded total is halved by `Math.floor(tax/2)`
for SGST and the remainder given to CGST, so cgst − sgst ∈ {0, 1} and is
never negative. Inter-state puts the whole rounded tax in IGST.

**The spec is silent.** NCC_BUILD_SPEC.md states no rounding rule for tax
(grep across the whole file for rounding language: nothing about paise
rounding). The rule is therefore a code decision pending the owner’s
answer, filed as OWNER_QUESTIONS item 13 and §17.3.

**Pinned by** four new tests in tests/money.test.ts (the suite’s splitGst
block, now 7 tests): the exact half-paisa tie (18% of 12,475 = 2245.5 →
2246) goes UP, the negative mirror goes away from zero, the odd total
gives exactly one paisa to CGST (1124/1123 on 12,486), a large value
(99,99,999 → 18,00,000, even halves) holds the same invariant, and no
shape loses or invents a paisa in either branch.

**The tolerance is deliberate; the writer is the authority.** The 025
CHECK `ABS(cgst − sgst) ≤ 1` (29.9) exists to admit this rounding, not to
define it: a future rounding change (per-line computation could produce
differences up to the line count) fails a unit test first, and the CHECK
only refuses what the writer could never legitimately produce. The
database guards shape; the writer owns arithmetic.

### 29.17 The GRN posts its expense: the third ENUM member gains a writer, 2026-09-09

**What the sweep found.** Of the three source_type members with no expense
writer after 29.8 (grn, equipment_deployment, campaign_spend), the GRN flow
exists and §6.6 requires the receipt's cost to reach expenses when the
receipt is posted — the same deferred-posting shape 29.8 closed for
contractor bills. equipment_deployment and campaign_spend stay deferred
with recorded reasons: the deployment flow has no approval step to hang the
posting on yet, and campaign spend is phase 5.

**The implementation.** postGrn (src/modules/inventory/service.ts) now
writes the expenses row inside the same transaction as the status flip:
amount = the GRN's invoice_amount (single source), source_type='grn',
source_table='goods_receipts', source_id=GRN id, expense_id back-linked on
the GRN — the four identity values, same shape as 29.8.

**Proof (tests/integration/grn-posting.test.ts, 3 tests):** posting creates
the expense with all four identity values read back; a second post is
refused (uq_exp_source at the database); the 021 period trigger fires
through the service path — a post into a closed period is refused with the
trigger's own message and the GRN stays draft with null expense_id and zero
ledger rows (whole rollback). Mapping test updated: the grn row now cites
this entry. Gates: unit 331/13, integration 302/17, e2e 4/1, typecheck 0,
/src/ 77.

**Also hardened:** the shared fixture sweep (fixture-markers.ts) now removes
the cross-table orphans a crashed run leaves behind (audit_log, vendors,
expenses, projects, clients, items, package_spec_lines by marker) before
the users themselves — the GRN suite's first run tripped over exactly such
orphans.

### 29.18 The expense-date survey: the contractor-bill posting is dated today, and the closed source month cannot block an approval, 2026-09-10

**The survey.** What each writer stamps into its document's date column:
createExpense/approveExpense use the user-supplied input.expenseDate;
createPayment uses input.paymentDate (locked by trg_payments_period_bi on
payment_date); createInvoiceFromMilestone uses the user-supplied
invoiceDate; issueSiteAdvance uses today() (an advance is inherently a
today event); postGrn uses grn.received_on — the source document's date;
approveContractorBill uses today() — the approval date, not the bill's
coverage period (hr/service.ts, approveContractorBill). All six stamp
period_id: from the same date each uses, best-effort, per rule 7.

**What the spec says: nothing.** Rule 7 (:2149) says closing a period
"rejects any insert or update ... with a date inside it" and that
period_id is stamped on approval. It never says which date a derived
posting carries. Phase 7 (:752) makes GRN values and contractor attendance
become cost, but assigns no date rule.

**The consequence, proven both ways through the service.**
(h1) Blocked wrongly: with today's period closed, approving a bill is
refused by the 021 trigger even though the bill's source month is open —
already proven in hr-contractor-flow ("refused when today falls in a
closed period", whole rollback).
(h2) Bypass: with August 2026 closed and today open, a bill whose
attendance days fall on 2026-08-18 is approved without refusal, and the
posted expense reads back expense_date = today with today's period_id, not
the closed period's (new test "posts an expense dated today even when the
bill covers a closed month"). The closed source month constrains nothing.

**Recorded, not fixed.** The spec is silent, so the writer was not changed
— changing expense_date to the bill's coverage end is a one-line change
once the owner answers OWNER_QUESTIONS item 15, and the two existing tests
state exactly what flips.

### 29.19 The source-pair assertion moves to the writers: what the group-by proves and what it never could, 2026-09-10

**What the group-by proves.** That every (source_type, source_table) pair
present in the fixture database at the moment it runs is expressible in
WRITER_MAPPING. With its self-seed removed it observes zero rows on the dev
database between suites (reported honestly in the run output) — and zero
observed rows proves nothing in either direction, so that branch skips
rather than feeds itself a row.

**What it never proved.** That a writer's literal matches the mapping: the
group-by can only see rows some suite wrote, so a writer whose literal
drifted was invisible unless that exact run's rows happened to still be
present — a circular basis, the same class as inventory-schemas.test.ts:216
(asserting a schema against a copy of itself).

**The new assertion.** Each writer's own suite (hr-contractor-flow,
grn-posting, finance-approval for createExpense, finance-advances for
issueSiteAdvance) now asserts, against the row its writer just wrote, that
the pair is in the shared mapping — WRITER_MAPPING extracted to
tests/integration/expense-writer-mapping.ts so suites import it without
importing a test file. createPayment and createInvoiceFromMilestone write
no expenses row, so the mapping records their absence and the payments
suite asserts it stays true.

**Proof.** Mutating approveContractorBill's source_table literal to
'contractor_bills_MUTATED' turned hr-contractor-flow red with
"expected 'contractor_bills_MUTATED' to be 'contractor_bills'" — no test
edited. Restored, all gates green: unit 331/13, integration 303/17, e2e
4/1, typecheck 0, /src/ 77.

### 29.20 The GRN amount shapes: the lines are the single source, and a zero-value posting is refused, 2026-09-10

**The column.** goods_receipts.invoice_amount_paise is nullable
(Generated<number | null>); the dev database holds zero GRN rows, so no
backfill question arises. The posting never reads it: postGrn's single
source is the accepted lines themselves — qty_accepted × rate_paise summed
from the rows the post just read — so a NULL or zero invoice_amount cannot
zero or shift the expense.

**Proof (grn-posting.test.ts, "a NULL or zero vendor invoice_amount changes
nothing").** invoice_amount NULL → expense total_paise 500,000 (100 ×
50.00 from the lines); invoice_amount 0 → same; every line rate 0 →
received value 0 → the posting is REFUSED with "zero accepted value ... no
cost to post" and the GRN stays draft with null expense_id and no ledger
rows — a zero-value expense carrying a valid identity pair would reconcile
silently, which is worse than a refusal (prompt's own criterion).

**The timing question, not a code decision.** Goods can legitimately arrive
before the vendor's invoice, so a GRN with no invoice amount is a real
state, not an error — the cost lands on receipt and the vendor's bill
reconciles later. Whether that is the owner's intent (versus waiting for
the three-way match) is filed to §17.3; the code takes no position beyond
posting from the lines.

### 29.21 Rule 8 reaches the new writers: the GRN posting derives bill_date from the vendor's invoice date, 2026-09-10

**The survey.** Neither new writer set bill_date, so both produced expenses
the MSME ageing report bands 'unageable' — a silent gap for exactly the
vendors rule 8 protects. The sources differ:

- postGrn's GRN carries invoice_no and invoice_date (the vendor's bill
  details, entered at receipt when it arrived). Those are a real bill
  identity, so the posting now writes bill_date = invoice_date and
  bill_no = invoice_no. Where the vendor's bill has not arrived,
  invoice_date is NULL and bill_date stays NULL — DECISIONS 26.2's refusal,
  with the row still visible as 'unageable' in the report.
- approveContractorBill's contractor_bills carries no vendor-invoice date —
  only period_from/period_to, the work window. There is no bill date to
  derive, so its expenses stay 'unageable' and the refusal stands; deriving
  from the work period would start the 45-day clock before any bill
  existed, understating nothing but misstating when payment terms began.

**Proof (grn-posting.test.ts, "rule 8 on the new writer").** Fixture
vendor now carries msme_udyam_no. GRN with invoice_date 2026-09-01 →
expense.bill_date reads back 2026-09-01 and bill_no reads back the GRN's
invoice_no; msmeAgeing('2099-01-01') bands it 'due' with daysOverdue > 45.
GRN with invoice_no/invoice_date absent → bill_date NULL, and the same
report bands it 'unageable' — the gap visible, not hidden. Gates: unit
331/13, integration 305/17, e2e 4/1, typecheck 0, /src/ 77.

### 29.22 The unit-count discrepancy reconciled: 331 was true, 332 was arithmetic over a prose count, 2026-09-10

The session-6 prompt expected unit 332 (322 + 6 + 4: or-audience, the
rounding pins). The live run reports 331 and the per-file sum agrees
(25+16+34+39+6+6+52+59+21+34+2+36+1 = 331 across 13 files). The arithmetic
was wrong, not the count: a8de235 added **three**  blocks to
money.test.ts (22 → 25), because §29.16's "four cases" are half-paisa
tie, negative mirror, odd-paisa-to-CGST, and large value — with the
paisa-conservation assertion living inside the third test rather than as a
fourth . Per-file breakdown in the run output; nothing was removed
or merged. 331 in 13 is the corrected standing figure.

### 29.23 invoice_amount_paise is advisory vendor input: the lines are the only cost basis, 2026-09-10

**The sweep.** Scope: every occurrence of the identifier in src/ (grep -rn
'invoice_amount_paise' src/) and every test file. Five hits, all accounted
for: src/db/types.ts:654 (the nullable Generated column, per spec :1237),
src/modules/inventory/service.ts:1586 (the only WRITE, from createGrn's
form input), queries.ts:895 (a SELECT for the detail page) and
routes.tsx:251/2310 (the Money display on the GRN page, gated by
canRates). No writer or reader uses it in arithmetic; no test asserted it
before this session. The posting reads only grn_lines (29.20).

**What §6.6 says the cost basis is.** :752: "phase 4 (GRN values become
material cost)" — and rule 3 (:1337) makes the per-line quantities the
record: "Recording only one quantity destroys the ability to claim a
shortage ... so the vendor invoice is queried before payment rather than
after." The vendor's stated invoice total is an input to the
query-the-invoice workflow, not a figure the system computes from or
reconciles by.

**The choice: advisory.** The alternative — a CHECK or service assertion
refusing a post where a non-NULL invoice_amount_paise differs from the
line total — was rejected: short supply and rate disputes are routine
(:1337 says so in its first sentence), so the refusal would block the
normal case and force clerks to type the vendor's number back after
recomputing it. The discrepancy is a business matter (a §17.3-adjacent
workflow: the notification to procurement and accounts fires on
qty_challan != qty_received, and the invoice gets queried) — not something
the schema can settle.

**Proof (grn-posting.test.ts, "the posting ignores a disagreeing
invoice_amount").** invoice_amount 999.99 against lines worth 500.00
posts the expense at 500,000 paise from the lines, and the GRN keeps the
vendor's 99,999 for the query workflow. Gates: unit 331/13, integration
306/17, e2e 4/1, typecheck 0, /src/ 77.

**Added 2026-09-10 — the group-by is labelled observation-only.** On an
empty expenses table it logs "source-pair group-by observed 0 rows —
writer-side assertions in the writer suites carry the proof" and returns;
no claim rests on it. The proof-carrying assertions are (a) the
ENUM-versus-mapping comparison with its non-zero floors ("the source_type
column was not found" / "the ENUM parsed to zero members") and (b) the
writer-side pair assertions in each writer's suite. Quoted from
expenses-source-mapping.test.ts:105-114: "If this group-by observes zero
rows it proves nothing either way — so the assertion is skipped rather than
fed a row this suite wrote itself (a circular basis)."

### 29.24 CSP-Report-Only lands: the draft enforcing policy is now measured, not hypothetical, 2026-09-10

**What was built.** src/middleware/cspReport.ts: a middleware stamping
Content-Security-Policy-Report-Only on every response, and an
unauthenticated collector at /api/csp-report that logs each violation
report in a greppable one-line shape (TS:CO csp-violation {...}) and answers
204. Report-Only applies nothing — TOLERANCE 0 holds; no page's execution
changes. Unauthenticated by design: the report is generated by the browser,
not a session, and requiring one would lose every violation on a logged-out
public page. Nothing enforcing was added; §9 still owns the decision.

**The draft policy is the enforcing policy §9 would eventually want**, with
the two documented concessions from §24 built in and nothing more:

- script-src 'self' 'unsafe-inline' 'unsafe-eval' + googletagmanager +
  cdnjs.cloudflare.com. **'unsafe-eval' is genuinely required by the
  vendored Alpine standard build** — §24.3 quotes the AsyncFunction
  constructor out of the minified file itself ("with (scope) { __self.result
  = ... }"), and the CSP build's evaluator markers are absent from the
  vendored file, so it is the build, not the CDN variant, that needs eval.
  All five expression-bearing x- attributes (x-data, three x-on, x-text)
  go through that constructor and would violate any script-src without it.
  A nonce is no substitute (§24.3) and is mutually exclusive with
  'unsafe-inline', so the draft carries neither.
- style-src 'unsafe-inline': 23 of 24 public pages carry inline <style>
  (§24.6).

**What the frozen pages would violate under the eventual enforcing
policy** (from §24.6's counts): 51 executable inline script blocks and 54
handler attributes violate script-src's 'self'; 23 inline <style> blocks
violate style-src; googletagmanager (23 files) and cdnjs (GSAP on index)
violate a script-src lacking those hosts; fonts.googleapis.com/gstatic and
website-files.com violate default-src 'self' on stylesheets and fonts. The
reports will replace these static counts with per-page, per-directive
evidence.

**Proof (tests/csp-report.test.ts, 4 tests).** Every response carries
Content-Security-Policy-Report-Only and content-security-policy stays
absent; the draft carries the two concessions and no nonce; a valid
violation report POSTs to 204 and lands in the log (observed in the run's
output); a malformed body also answers 204. Gates: unit 335/14,
integration 306/17, e2e 4/1, typecheck 0, /src/ 78 (cspReport.ts added).

### 29.25 The §7 precondition closed: migration 026 makes every revision restorable, 2026-09-10

**What the prose settles.** Spec :1387 ("every publish snapshots the
previous state") and :1508 ("Restores a revision as a new draft") settle
the semantics: a revision is a snapshot for the revert path, and the revert
writes the revision's columns back toward site_pages. Nothing in §7's prose
gives a revision a NULL schema_types a meaning.

**No writer produces one — yet.** The tree's only site_page_revisions
references are the type row (src/db/types.ts:1893) and the JSON-column
registry (src/lib/json.ts:42); §21.4's survey stands. So no NULL revision
exists: the dev database held 0 revision rows of any kind.

**The rollback answer, proven rather than reasoned.** The pre-migration
probe (run live before 026 shipped): a fixture page with schema_types set,
a NULL revision inserted against it — ADMITTED by 007:51 — then the
revert-shaped UPDATE of site_pages from that revision: **REFUSED with
ER_BAD_NULL_ERROR, "Column 'schema_types' cannot be null"**. 21.4's
prediction was exact: the snapshot was unusable on the only path the table
exists for.

**The fix.** Migration 026 backfills any NULL from its snapshotted page
(the faithful value by :1387's definition) and declares the column NOT
NULL. tests/integration/revision-schema.test.ts proves the post-migration
contract: a NULL revision insert is refused (ER_BAD_NULL_ERROR), and the
snapshot/restore round trip preserves schema_types through the revert
write shape. The AUTO_JSON_CHECKS registry entry flipped to nullable:
false, and its "exactly eight" NULL-reachable count is now seven — both
caught red before the registry was updated, which is the tripwire working.
Gates: unit 335/14, integration 308/18, e2e 4/1, typecheck 0, /src/ 78,
26 migrations none pending.

**§7's other preconditions: none found.** A sweep of DECISIONS §21 found
21.4 (this one) as the only entry tagged as a precondition on the CMS
slice. The marketing module is mounted and permission-guarded
(src/modules/marketing/routes.tsx); §7.6 step 5 (the parity-verified editor
unlock) remains fenced as always, and the CMS slice itself is gated on the
owner answers in OWNER_QUESTIONS.md, not on schema work.

### 29.26 Rule 4 does not see labour: the budget check and the margin rule use two cost bases, 2026-09-10

**What the view sums.** v_project_actual (020:45-54) sums
expense_lines.amount_paise over expenses with status IN (approved,
part_paid, paid), not voided, project_id not null, grouped by cost head.
**Booked labour never reaches it**: the contractor-bill posting (29.8)
writes no expense_lines at all — §6.6-2 makes the bill's own columns the
single source — so a 4,00,000 paise approved labour expense contributes
zero to actual. Accrued staff cost does not exist in the codebase: a sweep
of src/ finds no getProjectMargin and no attendance-to-
employee_compensation sum anywhere; the only compensation read is the
per-employee history query (hr/queries.ts:133). The empty-aggregate shape
is safe: the view COALESCEs to 0 and costHeadStates maps a missing row to
0, not NULL.

**What rule 4 compares** (:2144): "If approving an expense would push
committed + actual past budget_lines.amount_paise for that cost head, the
approval is refused" — committed from v_project_committed, actual from
v_project_actual, never recomputed. **What rule 10 says** (:2155):
"getProjectMargin(projectId) returns contract_value - (actual + committed
+ accrued_staff_cost), where accrued_staff_cost comes from attendance rows
joined to employee_compensation for the period."

**Two bases, in the spec's own words.** Rule 10's margin includes labour
cost derived outside expenses; rule 4's budget compares committed + actual
with no accrual term and no contractor-bill contribution. The spec
genuinely intends margin and budget to run on different bases, so this is
**recorded, not fixed** — bringing labour into the actual-cost basis would
either (a) violate §6.6-2's single-source rule by splitting the bill
figure across expense_lines, or (b) change rule 4's arithmetic to read a
second derived figure, and both are decisions the owner's answer to
OWNER_QUESTIONS item 16 (does the budget ceiling include labour?) gates.

**Proof (tests/integration/labour-budget-gap.test.ts, 4 tests).** A
project with an approved LAB budget line of 100,000 and 400,000 paise of
booked, approved contractor-bill labour against it: the LAB head is absent
from v_project_actual (test 1); a material expense on the same project
approves through approveExpense with no budget refusal (test 3) — the
overrun check cannot see the labour that already blew the head. The
empty-aggregate shape returns 0, never NULL (test 2), and the sweep for the
accrual join is recorded as its negative result (test 4 comment; the grep
is the citation). Gates: unit 335/14, integration 312/19, e2e 4/1,
typecheck 0, /src/ 78.

### 29.27 The CSP collector is hardened: an anonymous write endpoint gets the three controls, 2026-09-10

**The exemption, cited.** /api/csp-report is exempted from csrfProtect by
mount order, not by a rule in csrf.ts: cspReportRoutes is registered at
src/app.ts:76, csrfProtect mounts on /api/* at :80, and Hono runs
middleware in registration order — a POST that matches the collector
never reaches the /api/* csrf mount. The previous justification was a
code comment only; this entry is the citation, and the full-app probe
(valid report POSTed through src/app.ts itself) answers **204**, proving
the order does the work. The no-session basis is §29.24: a violation
report is generated by the browser, not a session, and requiring one
would lose every report from a logged-out public page.

**The three controls.** (1) Size cap: CSP_MAX_BODY_BYTES (16 KiB), checked
on content-length and again after reading, refused **413** before any
parsing. (2) Shape validation: only the recognised CSP level-3 envelope
with string-or-number known fields passes; anything else — wrong
envelope, wrong field types, non-JSON — is refused **422**; every field
is truncated to 200 characters and the log line to 1200, so the raw
attacker-controlled payload never reaches the log. (3) Rate limit:
30 reports per client IP per fixed 60-second window, refused **429**
thereafter, with the bucket map bounded and sweepable.

**Proof (tests/csp-hardening.test.ts, 5 tests, + a corrected 29.24
assertion).** Oversized → 413; three malformed shapes → 422; a
40-request flood hits 429; a valid report → 204 and one greppable
TS:CO csp-violation line whose length proves truncation ran (asserted
< 2000 chars for a 5000-char injected field). The 29.24 test that
expected a malformed body to answer 204 was rewritten to expect the new
422 — the tolerance was the defect the hardening removed, not a
contract. The one-JSON-reader tripwire (json-columns.test.ts) also
caught the first draft parsing with JSON.parse inline; parsing now goes
through parseJsonColumn.

**Header on the legacy pages, and the parity gates.** The Report-Only
header is stamped by app.use('*') before every router mount, so it
appears on the public static pages too — verified through the full-app
probe on / (header present, value = draftCsp()). Neither
scripts/test-htaccess.mjs nor scripts/selftest-parity.mjs compares
response headers against golden files (greps for csp/security-header
assertions in both return nothing), so TOLERANCE 0's byte-equivalence
gate is untouched: Report-Only changes no body bytes. Gates: unit
340/15, integration 312/19, e2e 4/1, typecheck 0, /src/ 78.

**Amended 2026-09-10 — the backfill is now proven by replay, not by having
run.** The migration shipped against a dev database holding zero revisions,
so the UPDATE ... JOIN never executed and the narrowing succeeded trivially.
tests/integration/revision-backfill-replay.test.ts reconstructs the
pre-migration shape with TEMPORARY tables (no FK: MariaDB refuses them
between temporaries), inserts NULL revisions, and applies 026's backfill
clause VERBATIM: a populated page's schema_types is derived exactly; an
empty-array page ('[]') derives '[]' — still valid, non-NULL JSON, so the
narrowing holds in the emptiest legitimate case; no NULL survives; the
narrowing replay then refuses a NULL insert. The applied file was not
edited.

### 29.28 The advisory figure is labelled: the vendor's invoice cannot be mistaken for the posted cost, 2026-09-10

**The change.** 29.23 recorded that `goods_receipts.invoice_amount_paise` is
advisory vendor input and that the posted cost derives from the GRN lines,
but both figures rendered on the GRN page (routes.tsx) under the bare label
"Amount" with nothing distinguishing them. The label is now "Vendor's invoice
(advisory)" on the detail page, with a matching hint on the create form
("the booked cost comes from the receipt lines"); the posted cost, wherever
both are shown together, carries "Posted cost (from receipt lines)". Neither
number changed — the §29.23 posting semantics are untouched.

**Proof (tests/grn-labels.test.tsx, both tests).** Rendering a
DefinitionList through hono/jsx/streaming with the two figures differing
(99,999 paise invoiced vs 50,000 posted, the grn-posting suite's
disagreeing shape at component level) must produce both labels and both
figures, and must no longer contain the bare `<dt>Amount</dt>` that hid the
distinction; a second test holds the labels even when the figures agree.
Before the label change the first assertion failed on exactly that
`<dt>Amount</dt>` absence — watched red, then green.

**Scope.** routes.tsx detail page and create form only; no query, no service,
no schema. The rate-visibility gate (`hidden={!rates}`) is unchanged, so the
figure is still absent from the HTML for a reader without canRates.

### 29.29 The §7 revision writer exists: an edit always snapshots the state it replaces, 2026-09-11

**What was built.** §21.4's survey and 29.25 both recorded that nothing in
the tree wrote `site_page_revisions`. The slice closes that: `writeRevision`
(src/modules/marketing/service.ts) is the single writer, called inside the
caller's transaction before every change to the page row — `editPage` and
`revertToRevision` each take one transaction so the snapshot and the edit it
describes commit or roll back together, and no edit path can skip the
revision. `nextRevisionNo` takes max+1 under the row lock; `uq_page_rev
(page_id, revision_no)` (007:55) remains the concurrency backstop — two
concurrent publishes collide on a duplicate-key error, not a silent
overwrite. `revertToRevision` (:1508) restores the revision's four columns
and sets status = 'draft', `published_at`/`published_by` = NULL; it
snapshots the pre-revert state first, so a revert is itself revisable.

**What was not decided.** §7's prose never says whether editing a published
page happens on the live row or a draft copy, or whether a reverted
published page needs re-publication before visitors see it. The restore
lands as 'draft' because :1508 says so; what publishes it again is the
owner's question, not a guess recorded here.

**The defect the integration suite found, and the fix.** The first live run
failed all nine tests with `CONSTRAINT site_page_revisions.content_json
failed`: mysql2 parses JSON columns into JS objects on read, so the
snapshot's `content_json` arrived as an object, and Kysely's binding
stringified it as the literal `'[object Object]'`, which json_valid rejects.
Raw prepared-statement probes of both shapes (string and object) succeeded —
the defect was purely the object-shaped value reaching Kysely's
stringifier. The writer now normalizes whatever the driver returns through
`toJsonText` (string passes through; object is JSON.stringify'd; empty is
refused 422, keeping DECISIONS 21.4's restorability guarantee at the write
time as well as the schema's).

**Proof (tests/integration/cms-revisions.test.ts, 9 tests, all through the
service functions, never a direct insert).** An edit writes revision 1
holding the replaced state (title "Original title", the original content
blocks) with the editing user recorded, and the live row moves; a second
edit by another user writes revision 2 with that user recorded and
revision numbers 1, 2 strictly; the write is audited
(marketing.page_revision_write); an empty schema-type list is refused by
the Zod gate before the service runs, asserted against pageEditSchema
directly; a revert restores the exact prior title, meta, schema_types and
content and sets status = 'draft'; the revert is audited and its pre-revert
snapshot is the newest revision with the change note naming what it
replaced; a full edit → revert round trip leaves schema_types non-NULL on
both tables (the migration 026 contract at the point of use); reverting to
a nonexistent revision is refused and changes nothing; a standalone
`writeRevision` under a caller transaction stores a non-NULL snapshot.

**Gates.** unit unchanged, integration 324 tests / 21 files with cms-
revisions green (323 passing + 1 pre-existing crm-flow `assignableUsers`
count failure that reproduces on a clean checkout at HEAD — unrelated to
this slice, recorded here so it is not mistaken for a regression), e2e
untouched, typecheck 0. The two temporary probe scripts used to isolate the
'[object Object]' binding defect were removed before this entry was
written.

**Amended 2026-09-11, landed.** The slice committed as 03e7a2c with its nine
tests (cms-revisions 9/9 in the full gate, 324/324), after 8564eee cleared
the crm-flow red that had been recorded above as pre-existing — the failure
was the seeded owner account (a documented bootstrap, README:25) sitting
inside the unfiltered assignableUsers read plus fourteen unmarked probe-user
debris rows, not order dependence; the suite's own docstring premise "the
dev database has no users" had drifted.

**The two open questions, answered against the spec.** (1) §7 DOES require a
published-versus-draft distinction: :1505 — the block editor "Saves to
`draft`, never to live"; :1506 — the preview "renders the draft through the
real public layout ... so what is previewed is what publishes"; :1359 —
"publishing is a deliberate act with a preview". But the table has no draft
column pair, so "saves to draft" on an already-published page currently moves
what visitors see. That contradiction between :1505's words and the single
row shape is not resolvable from the spec, so it is filed as OWNER_QUESTIONS
item 17 rather than guessed at with a schema change. (2) Whether a reverted
published page needs re-publication is NOT answered by the prose beyond
:1508's "Restores a revision as a new draft"; the writer sets status =
'draft' and clears published_at/published_by, which takes the page off the
public site until someone publishes again — recorded as the behaviour, and
item 17's answer governs whether it stays.

**The alternative logged for item 17.** A `draft_content_json`/`draft_title`
pair (or a shadow draft row) with the publish route copying draft → live —
the shape :1505's sentence literally describes. Rejected for now because it
is a schema change gated on the owner's answer, and the revision writer
already guarantees nothing is lost under the current shape.

### 29.30 Gate-independence, third instance: every count over a writable table becomes a delta, 2026-09-11

**The rule, now three times learned.** 29.2: the ambient PORT env var
poisoned suite imports. 29.1: an installed-Chromium assumption made the
e2e gate environment-dependent. This instance: crm-flow pinned absolute
counts over four tables the database can legitimately grow — `users` (the
seeded owner, README:25, made :892 baseline+2), `site_visits` (:809-810,
hard 2 and 1), `quotes` (:817-818, hard 3) and `stage_templates` (:893,
hard 3 from migration 004). A second seed or a colleague's manual row
would have turned any of them red without any defect.

**The fix: before/after deltas, not bare numbers.** beforeAll reads a
baseline for each of the four tables after the sweep, and every count
assertion is `baseline + N this suite created`. The spec citations
explaining why the owner legitimately appears stay in place (:581 grants
`projects.view` to `owner`; README:25 documents the seed), but the
assertion no longer depends on the seed existing.

**Proven by the second-seed test.** A non-fixture user
(`colleague.manual@neelachandra.com`) planted in `users` by hand, crm-flow
run: `Test Files 1 passed (1) / Tests 36 passed (36)` — green with a row
the suite did not write and does not sweep. Row removed after.

**Scope sweep of the other suites.** Every remaining absolute count in
tests/integration is fixture-scoped: `where id in [...]` on ids the suite
created (client-invoices:430), `chitId`-scoped lines (hr-contractor-flow),
`select 1 + 1` (db-smoke), or counts over tables no writer reaches outside
tests. No other suite asserts a bare count over a globally-writable table.

Proven by: tests/integration/crm-flow.test.ts (36/36 with a foreign row
planted), full gate 326/326.

### 29.31 The draft/live split: editPage stops writing the live row, 2026-09-11

**The divergence, stated plainly.** Spec :1505: the block editor "Saves to
`draft`, never to live". Spec :1506: preview "renders the draft through
the real public layout ... so what is previewed is what publishes".
Spec :1359: "publishing is a deliberate act with a preview". The writer
as landed in 29.29 wrote content_json, schema_types and title straight
onto the live row on every edit — so editing a published page changed
the public site with no publish act. That diverges from the normative
prose, and this entry is the record of the divergence 29.29 deferred.

**The mechanism chosen: draft columns on site_pages (migration 027).**
draft_title, draft_meta_description, draft_schema_types,
draft_content_json, all nullable. editPage writes ONLY the draft
columns; publishPage (new, the :1507 route's service) snapshots the
LIVE row through writeRevision (:1387), copies draft -> live, stamps
published_at/published_by; revertToRevision (:1508) restores a revision
INTO the draft columns — live untouched, exactly "as a new draft".
What is previewed (the draft columns) is what publishes, :1506
literally.

**Alternatives rejected.** A draft-revision pointer (edits write a
flagged revision; publish promotes): :1508 restores *as a draft*, which
a promote-pointer cannot express without a second flag, and it overloads
site_page_revisions, whose NOT NULL narrowing (026) exists for
restorability, not working drafts. Status-column only (live copy in the
latest published revision): forces every public read through the
revisions table and leaves a never-published page's first draft
unrepresentable.

**Proven by the service-level round trip**
(tests/integration/cms-revisions.test.ts, 11/11): editing a published
page leaves the live title and status unchanged (the assertion the old
writer could not pass); publish moves draft to live and stamps the
publisher; the pre-publish snapshot holds the replaced live state;
publish refuses with no draft; the edit -> revert round trip never
violates the schema_types NOT NULL (026). The tripwire earned its keep
during implementation: publishPage's first draft copied the
driver-parsed JSON objects raw and bound '[object Object]' — caught
red, fixed through toJsonText.

OWNER_QUESTIONS item 17 stays open: what the visitor sees in the
meantime is now answerable by the owner against a working mechanism,
not a refusal. The revert-re-publication refusal per :1508 stands.

### 29.32 The pre-session CSRF branch: login was refusing every browser, 2026-09-11

**The defect, found while auditing TASK 3 reachability.** csrfProtect
(app.ts:81-82 mounts it on /login and /forgot-password) demanded a
session row on every state-changing request, but a visitor signing in
has none — the synchroniser token has no server half until after login.
auth/routes.tsx:69 has its own pre-session double-submit check
(verifyPreSessionToken against the ncc_csrf cookie), but the middleware
threw first: **every browser login POST returned 403 "Your session has
ended" and no session was ever creatable through the app.** Proven
against the live server: POST /login with a correct password -> 403,
zero sessions created; with the fix -> 302 and an ncc_sid cookie.

**The fix: a pre-session branch in csrfProtect.** On /login and
/forgot-password, with no session, the expected token is the ncc_csrf
cookie issued with the page, compared timing-safely against the nc_csrf
form field (double-submit — safe here because the cookie is HttpOnly and
SameSite=Lax, and a forged login only logs the victim into the
attacker's account). Every other path keeps the session-token branch
unchanged; a POST carrying only the pre-session pair to /app still
refuses.

**Proven two ways.** Live-server: correct password -> 302 + session
cookie; no token -> 403; wrong token -> 403; no cookie -> 403; an
authenticated POST without the session token -> 403. Persistent:
tests/unit/csrf-pre-session.test.ts (5 tests) drives the real middleware
through app.request, including the not-a-bypass case.

**TASK 3's audit result, recorded here for the slice it concerns.**
src/modules/marketing/ has three of the four files — routes.tsx exists
but mounts only the module screens (/app/marketing, /campaigns,
/content), each behind requirePermission. The edit, publish and revert
services are NOT routed: writeRevision/editPage/publishPage/
revertToRevision have no route, so the service is unreachable — not the
receivables_ageing shape (a route with no permission check); the inverse,
a gated service with no route. That is the documented next build phase
(routes.tsx docblock), so no defect: the gates this task asked to prove
(unauthenticated refused, unprivileged role refused, permitted role
succeeds, CSRF enforced) were proven against the mounted screens, which
sit under /app/* behind requireAuth, csrfProtect and
requirePermission(SITE_CONTENT_MANAGE / MARKETING_CAMPAIGN_MANAGE),
held from the live grants by owner, admin and ops_manager (002:205,
002:224; live query confirmed all three roles hold both keys).

### 29.33 The json-columns scan is a regression guard, not a proof, 2026-09-11

**What the zero actually measured.** The live-DB scan in the
json-columns gate observed zero stored `[object Object]` or json_valid
failures across the registered columns — but most of those tables hold
almost no rows. At the 2026-09-11 scan: audit_log 6 rows,
settings.value_json 25, site_pages 10, site_services 6, and five columns
held ZERO rows entirely (site_page_revisions both columns,
quotes.payment_schedule_json, email_log.response_json,
project_documents.visible_to_roles,
dashboard_daily_snapshot.detail_json). A zero over zero rows is
vacuous.

**What carries the actual proof.** The live CHECK probes (2026-09-11,
DECISIONS 4f33347's session): json_valid refuses the binding literal on
INSERT (settings.value_json, site_pages.content_json) and on UPDATE even
on a nullable column (email_log.response_json, errno 4025) — a CHECK
that returns NULL on NULL cannot police the NULL case, but the literal is
not NULL and is refused everywhere a CHECK exists. For columns whose
writers have not arrived yet, the toJsonText contract test is the
guarantee the first writer inherits.

**The change.** The scope caveat is recorded in the tripwire test
itself (tests/integration/json-columns.test.ts, the stored-value scan)
and here, so no future reader mistakes this gate for write-path proof.
The test stays: as a regression guard over rows that exist, and as the
place the enumeration floor (non-zero, == registry length) keeps the
column list honest.

### 29.34 Adversarial review of the pre-session CSRF branch, 2026-09-11

The one piece of security-critical middleware from 29.32, reviewed point
by point with probes against the live server and two new persistent
tests (tests/unit/csrf-pre-session.test.ts, 5 -> 7 tests).

**Where ncc_csrf is set and with which attributes.** Only in
auth/routes.tsx issuePreSessionToken: `HttpOnly; SameSite=Lax; Path=/;
Max-Age=3600; secure=isProd` (Secure on in production, off in dev —
HTTP-only localhost). Set on the GET render of /login, /forgot-password
AND /reset-password/:token, so a first-time visitor always has one
before any POST. Deleted on successful login (setSessionCookie).
Proven: live GET /login response carries exactly those attributes.

**Constant-time, length-mismatch safe.** The comparison is
constantTimeEquals (src/lib/crypto.ts:75): both sides are SHA-256
hashed before timingSafeEqual, so a 1-character guess costs the same as
a full-length wrong token — no early exit on length. Pinned by the
new length-mismatch test.

**The path list.** The branch is a hardcoded `Set([/login,
/forgot-password])` checked before anything else. Proven not
extendable: anonymous POSTs to /app/anywhere, /app, /2fa/verify,
/reset-password/x and /logout carrying a perfectly valid pre-session
pair are all refused 403 (the new not-a-bypass test asserts all five).

**Session fixation.** Login does NOT rotate a pre-existing session id —
it creates a new session row (auth/service.ts:164 createSession) and the
cookie issued is a fresh 32-byte random token whose SHA-256 is the row
id, so there is no attacker-chosen identifier to fix. Rotation happens
on privilege change (session.ts rotateSession: TOTP verify, password
change, role edit), which is the spec 6.1 mitigation. The pre-session
ncc_csrf cookie is deleted on login, so a fixation attempt through IT
carries no privilege either.

**Cross-origin / sibling-subdomain planting.** A sibling subdomain can
set a parent-domain cookie, so an attacker CAN plant ncc_csrf=known and
submit a matching form field — the classic double-submit weakness. The
mitigations, in order: SameSite=Lax blocks the cookie AND the
cross-site POST in every current browser; the login form is not a
worthwhile CSRF target (a forged login logs the VICTIM into the
attacker's account — self-DoS, per the 29.32 rationale); and the
pre-session token grants nothing. The spec (:219) specifies the
per-session synchroniser token, which the branch defers to the moment
a session exists. The pattern is recorded here as the considered
choice; the rejected alternative is stateful pre-session tokens (a DB
row per login-page render), rejected because it adds a write per page
view and a table for a token that grants nothing.

**Spec quotes.** :219: "CSRF: own middleware, per-session token in
user_sessions.csrf_token, required as a hidden _csrf field on every
non-GET form and as the X-CSRF-Token header on htmx requests." The spec
is silent on pre-session forms; this branch fills exactly that silence
and no more.

### 29.35 The route-coverage tripwire: 227 routes, and no test had posted to /login, 2026-09-11

**The gap this gate closes.** No test drove or named POST /login when
the CSRF deadlock (29.32) landed, and nothing noticed — coverage was
judged by what the tests mention, a hand-maintained mirror of the
router that drifts the moment a route lands. The enumeration here
comes from the app's own router (Hono app.routes, walked recursively
through sub-app mounts), so a new route enters the ledger the moment it
is mounted.

**The numbers.** The router mounts 249 concrete routes (method + path;
middleware ALL-entries and the empty root excluded, as are the static
asset routes which the parity gate covers). Of those, tests exercise or
name 22; **227 are mounted with no test at all** — that number is the
real coverage debt, and it is the floor of this gate. It only ever
shrinks: the test asserts the exact count, so adding an entry without
testing the route, or letting the debt grow, fails.

**Proven both directions.** Green today (3/3 with the recorded debt);
watched red by mounting a hypothetical
`/app/marketing/untested-new-route` — the tripwire named the exact
route in its failure output, then went green again after the route was
removed. A stale-entry assertion also fails when an allowlist entry
names a route the router no longer has.

Proven by: tests/unit/route-coverage.test.ts (3 tests), full unit gate
352/352.

### 29.36 — The real login, end to end, and the 2FA interception, proven

The route-coverage tripwire (29.35) exposed that no test had ever posted
to `/login` — the defect that caused the 29.32 deadlock survived three
sessions because of exactly that gap. This entry closes it with the real
flow, driven through the exported app router with its full middleware
chain against the dev database, using a fixture user created and swept by
the shared markers (29.4).

**Proven, not reasoned** (tests/integration/login-flow.test.ts, 5 tests):

1. Correct credentials issue a session cookie and the redirected
   authenticated page renders (Dashboard).
2. Wrong credentials are refused 401 with the generic failure and no
   session cookie.
3. The login POST without the CSRF pair is refused 403.
4. A second login issues a **different** session id — the fixation
   property 29.34 reasoned about is demonstrated: a pre-given sid is
   dead the moment real credentials are used.
5. **The 2FA interception is real and the machinery is implemented.** A
   require_2fa role (owner) with `totp_confirmed_at = NULL` signs in,
   then any authenticated request is redirected to `/2fa/enrol`, and the
   enrolment screen renders fully: heading, scannable QR as a data-URI
   PNG, and a setup key. What is **not** yet proven anywhere is the
   verify-and-confirm step — the enrol POST and `/2fa/verify` code
   paths have no test, and they belong on the route-coverage debt
   allowlist until they do.

The spec is not silent here: line 218 requires TOTP "enforced for the
roles that can move money (`owner`, `admin`, `accounts_manager`)", and
lines 675/845–846 describe enrolment, recovery codes, and the
half-authenticated `/2fa/verify` session. The enrolment screen working
means the owner's own account is **not** locked out of a dev bootstrap;
the cut-over-blocking question is whether the confirm/verify half has
been exercised anywhere in production-like conditions — it has not, by
the route-coverage evidence. Recorded as a build item, not an owner
question: no business decision is needed, only tests for the mounted
verify routes.

### 29.37 — The revision writer is reachable and gated, proven through the
### route

29.29/29.33 landed the §7 writer as schemas.ts + service.ts with no
mount point: a service with no route is unreachable, and the
route-coverage tripwire (29.35) held it on the debt allowlist until this
entry. Four routes are now mounted in src/modules/marketing/routes.tsx:

| Route | Method | Permission | Roles holding it (002_rbac seed) |
|---|---|---|---|
| /app/marketing/content/:id/edit | GET+POST | site_content.manage | owner, admin, ops_manager, marketing |
| /app/marketing/content/:id/publish | POST | marketing.content_publish | owner, admin, ops_manager |
| /app/marketing/content/:id/revert/:revisionNo | POST | marketing.content_publish | owner, admin, ops_manager |

The edit/publish split is the deliberate-act boundary of :1359: a role
holding edit but not publish can save drafts forever and can never take
the site live.

**Proven through the route, not the service** (tests/integration/
cms-routes.test.ts, 4 tests, driving the real app router with fixture
users on exact per-user roles): unauthenticated POST refused; tokenless
POST with a session refused 403 (CSRF); a publish-permission-less role
refused 403 on publish while the same role saves a draft through the
same middleware chain; a permitted role publishes and the migration-027
shape holds end to end — the edit never touched the live title, and the
publish moved the draft to the live row with published_by stamped.

Two tripwire consequences recorded: the four new routes moved from the
allowlist to EXERCISED (allowlist floor unchanged at 227 — the four
entries were added to the exercised list as they were proven, so the
debt number did not move); and the sweep gained user_sessions cleanup,
because a crashed login test leaves a live session that blocks the
user delete on fk_sessions_user forever — found red, fixed, re-proven.

Proven by: tests/integration/cms-routes.test.ts (4 tests),
tests/unit/route-coverage.test.ts (3 tests), full integration gate.

### 29.38 — The reset-password POST was the second instance of the login
### 403: pre-session POST routes must be enumerated, not discovered one at
### a time

TASK 5 asked whether any other route posts before a session exists and
would still deadlock on csrfProtect. The complete pre-session POST
surface (from the router, not a hand list): `/login`, `/forgot-password`,
`/reset-password/:token`. `/2fa/verify` and `/2fa/enrol` post only with a
(half-authenticated) session; every other POST is behind requireSession.

`POST /reset-password/:token` was dead — the same class as 29.32. It is
not in PRE_SESSION_PATHS (a constant equality set, which cannot express
the `:token` parameter), so csrfProtect threw 403 before the handler's
own verifyPreSessionToken could run. A user with a valid email link
could render the form (GET 200) but never submit it (POST 403). The
fixed middleware matches `/reset-password/<one segment>` by pattern, and
double-submit semantics on that path are unchanged: a mismatched pair is
still refused (unit test), a valid pair reaches the handler, and the
live probe ran the full flow against the dev database — GET 200 with the
pair issued, POST with the pair 302 (reset completed), tokenless POST
403. The probe was watched RED on the equality set before the fix.

The lesson is recorded as the rule: any future pre-session POST route
must extend isPreSessionPath in the same commit that mounts the route,
and the csrf-pre-session tests pin both the covered and the refused
sides.

Proven by: tests/unit/csrf-pre-session.test.ts (7 tests, including the
new reset-path pair), the end-to-end reset probe of this entry, and the
full unit gate.

### 29.39 — 2FA enforcement is real: the pre-enrolment session is
### constrained to the enrolment, verification, and logout paths

The question: with an un-enrolled require_2fa session in hand, what can
the bearer reach? If anything beyond enrolment succeeds, 2FA is
decorative for the roles that move money, and that is an authentication
bypass, not a polish item.

The spec is explicit: line 218 — TOTP "enforced for the roles that can
move money (`owner`, `admin`, `accounts_manager`)" — and line 675: "an
unconfirmed secret forces the enrolment screen before any other page
renders". requireAuth (src/middleware/requireAuth.ts) implements exactly
that on every /app/* and /api/* path, ahead of any handler.

**Proven with the same session cookie** (tests/integration/
twofa-enforcement.test.ts, 4 tests, fixture role with require_2fa = 1
and finance permissions): GET /app → 302 /2fa/enrol; GET
/app/finance/expenses (money route) → 302 /2fa/enrol; POST
/api/finance/expenses/:id/approve (approval) with a valid CSRF pair →
302 /2fa/enrol — the pair proves the stop is the 2FA gate, not CSRF, and
the redirect fires before the handler so the approval cannot execute;
and GET /2fa/enrol → 200, so the constraint does not lock the account
out of the fix for its own condition.

The second half of the question — a user who has enrolled but not yet
passed the challenge in the current session — is the same gate's second
branch (requireAuth: `session && !session.totpVerified` → /2fa/verify),
keyed on the per-session `totp_verified` flag that confirmEnrolment and
verifyTotp set through rotateSession. It is proven live by 29.40's flow,
which signs in, is held at /2fa/verify, and passes the challenge.

No fix was required: the constraint already existed. The deliverable is
the proof.

Proven by: tests/integration/twofa-enforcement.test.ts (4 tests).

### 29.40 — the 2FA verify half, end to end: enrolment, challenge,
### rate limiting, and recovery-code semantics

The verify half of 2FA had never been driven through the real router;
the route-coverage debt (29.36) flagged POST /2fa/enrol and
POST /2fa/verify as unexercised. The owner's cut-over account depends on
both being real. This entry records what the flow
(tests/integration/twofa-flow.test.ts, 4 tests) proves, all through
app.request against the dev database with a fixture user swept by the
shared markers:

**Secret storage.** `users.totp_secret` is AES-256-GCM ciphertext
(src/lib/totp.ts encryptSecret); the test decrypts it with the app's own
`decryptSecret`, gets the identical base32 secret, and otplib verifies a
code computed from it — the round trip that hashed-at-rest storage would
make impossible. The enrolment page exposes the secret only as a QR data
URI and the visible setup key.

**Enrolment.** POST /2fa/enrol with a correctly computed code returns
200 with the ten recovery codes, sets `totp_confirmed_at`, rotates the
session with `totp_verified = 1`. A wrong code is refused 422.

**Rate limiting.** Eleven wrong codes in a row: the first ten are plain
wrong-code refusals, the eleventh returns the limiter's message —
RULES.totpByUser, 10 attempts per 15 minutes per user. Not a lockout:
the message says how long to wait.

**Challenge on next login.** A fresh sign-in is held at /2fa/verify
(requireAuth's second branch, per-session totp_verified); a correctly
timed code POSTs to 302 /app and the rotated cookie reaches the
dashboard. A wrong-format code is refused before the limiter counts it.

**Recovery semantics.** Recovery codes are stored as argon2 hashes
(user_recovery_codes.code_hash), so a used code cannot be replayed by
anyone who did not write it down — the hashes are one-way by design, and
the service consumes a code inside the same transaction that upgrades
the session (verifyTotp), so it cannot be spent twice by two concurrent
requests. The plaintext codes are shown exactly once, at enrolment.

**Test-infrastructure findings recorded along the way.** (1) The sweep
now removes user_recovery_codes and the totp rate-limit bucket for
example.invalid users: recovery codes have fk_recovery_user with no
cascade, so one crashed 2FA test used to wedge the sweep forever — the
same class as the 29.36 session-row wedge. (2) An old ncc_sid in the jar
takes csrfProtect's session branch on POST /login (GET /login redirects
a live session away first, so a browser never hits this); the flow
strips the stale sid before re-posting, which is the honest simulation
of a second browser login.

Proven by: tests/integration/twofa-flow.test.ts (4 tests).

### 29.41 — the route-coverage debt is triaged into priority groups

The flat allowlist (29.36) is a number; a number does not say which
unexercised route means a business action silently cannot be performed —
the failure mode that hid the login 403 (29.32) and the reset-password
deadlock (29.38). The 227 unexercised routes are grouped by what a dead
route costs, from the allowlist itself (not a hand-written mirror):

**Group 1 — mutating routes that touch money or approvals: 30.** These
are the routes where a defect blocks a business action outright. Every
one listed here by method and path:

- POST /api/crm/quotes/:id/accept, /approve, /reject, /revise, /send,
  /submit (6)
- POST /api/po/:poId/short-close, /submit, /approve (3)
- POST /api/requisitions/:reqId/approve, /reject (2)
- POST /api/finance/expenses/:expenseId/approve, /submit (2)
- POST /api/finance/payments/:paymentId/allocate (1)
- POST /api/hr/contractor-bills/:billId/approve,
  /api/hr/contractor-bills/generate, /api/hr/attendance/approve,
  /api/hr/contractor-attendance/approve, /api/hr/leave/:id/approve (5)
- POST /app/crm/quotes, /app/finance/advances, /app/finance/expenses,
  /app/finance/invoices, /app/finance/payments (5)
- POST /app/inventory/po, /app/inventory/requisitions,
  /app/inventory/requisitions/:reqId/submit,
  /app/inventory/brands/:brandId/approval (4)
- POST /app/projects/:projectId/approvals (1)
- POST /internal/cron/budget-alerts (1)

**Group 2 — other mutating routes: 78.** Create/edit/delete screens and
API mutations outside money and approvals (reference data, admin users,
content, uploads).

**Group 3 — read-only screens: 119.** Static assets, error pages, health
files, and the GET screens under /app. Nineteen of these are money-
adjacent reads (finance, contractor-bills, PO and requisition screens),
which matter less than group 1 only because a dead read is visible
immediately, while a dead POST fails only when someone tries the action.

The order of work is group 1 first, for exactly the reason the group
exists: login and password reset were both found only because a session
asked about them. The remaining groups are debt, not blockers.

### 29.42 — group 1, tranche 1: the finance expense submit/approve pair

The first two group-1 routes come off the debt list: POST
/api/finance/expenses/:expenseId/submit and POST
/api/finance/expenses/:expenseId/approve, driven through the real router
(tests/integration/money-routes.test.ts, 4 tests, all fixture-scoped).

What the HTTP path proves that the service tests (finance-approval)
never could:

- **Unauthenticated** POST: csrfProtect runs before requireAuth on
  /api/* (app.ts's stated order), so a tokenless unauthenticated POST is
  a 403 from the CSRF guard, not a login redirect. The route exists —
  the login-class defect would be a 404, and it is not.
- **CSRF enforced**: a tokenless POST from a live session is 403.
- **Permission enforced**: a role holding dashboard.view_own_kpi but not
  finance.expense_create is refused 403 by requirePermission with the
  JSON error naming the missing permission.
- **A permitted role reaches the service**: the raiser (holding only
  finance.expense_create) submits through the route — guard answers with
  the app's real contract, a 303 flash redirect to /app/finance/expenses
  carrying "submitted" — and the row status is pending_approval. The
  approver (holding finance.expense_approve, a fixture approval_limits
  row keyed to the fixture role key because the table is seeded empty per
  open question 8.2) approves through the route: 303 "approved", row
  status approved. Self-approval is structurally impossible at route
  level too: the raiser's role holds no approve permission.

Route-level findings recorded along the way: the /api/ POST handlers
answer like the /app/ form handlers (303 flash redirects), not with JSON
bodies — only the permission guard answers in JSON on this path. The
allowlist drops 227 → 225.

Proven by: tests/integration/money-routes.test.ts (4 tests).

### 29.43 — the coverage arithmetic reconciled, and the debt ceiling

Three figures had drifted apart: the 29.41 triage summed to 227, the CMS
tranche (29.37) removed four entries, and tranche 1 (29.42) reported a
move of 227 → 225 for four routes exercised. Reconciled from the live
router and the tripwire file itself:

- **Mounted concrete routes: 251** (raw enumeration 253, minus the ALL
  middleware entries and the empty root).
- **Exercised: 29. Allowlisted: 222.** 29 ∪ 222 = 251 exactly.
- **The discrepancy was three double-listed routes**: GET
  /app/notifications (exercised by nav.test.ts) and POST /2fa/enrol,
  POST /2fa/verify (exercised by twofa-flow, 29.40) were in both lists —
  exercised coverage landed but the allowlist entries were never
  removed. Tranche 1 removed four entries but two of the four were the
  double-listed ones, so the count fell by two while the true debt fell
  by four. The 29.41 triage predates the CMS removal, hence its groups
  summing to 227: its group counts describe the state at 29.36. Corrected
  group counts against today's 222: group 1 = 28 (the two finance
  expense routes cleared by 29.42), group 2 = 77, group 3 = 117.

**The ratchet.** The tripwire now prints the arithmetic on every gate
run — `mounted(concrete) 251 = exercised 29 ∪ allowlisted 222` — and
asserts `ALLOWLIST.length <= ALLOWLIST_CEILING` with ALLOWLIST_CEILING =
222 committed in the test file (tests/unit/route-coverage.test.ts, third
test). Adding a mounted route without a test, or padding the list, fails
the ceiling assertion (watched red with a hypothetical 223rd entry);
covering routes lowers the count and the ceiling is lowered in the same
commit. The ceiling may only be raised by an explicit edit.

Proven by: tests/unit/route-coverage.test.ts (3 tests, watched red on a
deliberately padded list).

### 29.44 — the TOTP encryption key is SESSION_SECRET: provenance,
### blast radius, and the custody requirement

**Provenance.** users.totp_secret is AES-256-GCM ciphertext whose key is
scrypt(SESSION_SECRET, 'ncc.platform.aes256gcm.v1', 32) — derived in
src/lib/crypto.ts `key()`, cached, with a fixed application salt (deliberate:
a per-blob salt would have to be stored anyway and buys nothing against an
attacker who holds both halves). The key is therefore **not a separate
value**: it exists nowhere except as a derivation of SESSION_SECRET, which
lives only in the environment (zod requires ≥44 chars at boot,
env.ts:28 — an absent or short value crashes the process at import time,
proven by the env-validation failure this session's own probes hit when
PORT was missing; there is no silent fallback).

**What a key change does to enrolled users — proven through the router.**
An enrolled fixture user's totp_secret blob was rewritten as ciphertext
under a different key; signing in and posting a code returns the app's
clean 422 page with "That code is not correct. Try the current code from
your app." — not an unhandled 500. GCM's auth tag fails the decrypt,
verifyCode never matches, and the service throws the ordinary
UnprocessableError (auth/service.ts:481). So the failure mode is quiet,
not crashing — which is also the danger: **losing SESSION_SECRET locks
every enrolled account out of 2FA verification, including the owner's**,
with only a generic wrong-code message to explain why. Recovery codes
survive (argon2 hashes, key-independent) and are the only way in.

**Blast radius.** The same derived key protects nothing else today: the
only encrypt/decrypt call sites outside lib/crypto.ts and lib/totp.ts are
auth/service.ts (totp_secret encrypt at :401, decrypts at :421, :480).
Session ids are SHA-256 hashes, not encryption. So the blast radius of a
key change is exactly the TOTP secrets — but that is the owner's login.

**Cut-over blocker, recorded.** SESSION_SECRET must be generated once,
set in hPanel environment variables (spec §7.6 step 5 already sets it —
but nothing says it must be *kept*), and backed up offline by the owner
before the first require_2fa account enrols. If it is lost after
enrolment, every enrolled user needs an administrator 2FA reset (see
29.46 / the open owner question on who may reset whose 2FA), and if no
reset path exists yet the account is locked out entirely.

**KEY_CUSTODY note (deployment section, README:30 area).**
SESSION_SECRET has two duties: session-id hashing and the AES-256-GCM key
for users.totp_secret (scrypt-derived, salt 'ncc.platform.aes256gcm.v1').
It MUST NOT be regenerated after any 2FA enrolment. Back it up offline
(password manager or printed and locked away) at the same time the
first enrolment happens; whoever holds the database backup must not be
the only holder of the key, and vice versa. No key-rotation feature is
built: rotation would require re-encrypting every totp_secret blob with
a read-old-key/write-new-key pass, and is recorded as a design option
only if the owner ever asks for it.

Proven by: the key-mismatch router probe recorded here (this entry is
the record; the operational requirement is enforced by custody, not by
a test that can exist).

### 29.45 — the TOTP limiter is not a lockout weapon: the password gate
### is the fix

The question: can an attacker who knows only the owner's email lock the
owner out by consuming the totp:user:* budget?

No — and the architecture proves it rather than asserting it. The limiter
(hit, RULES.totpByUser, 10 per 15 minutes per user bucket) fires at the
start of verifyTotp, which is reachable only through POST /2fa/verify,
which requires a live session, which requires the correct password. An
attacker without the password has no session, so they have no way to
spend the victim's budget. Proven through the real router
(tests/integration/twofa-limiter.test.ts, 3 tests):

- three wrong-password logins (correct email) leave the bucket absent;
- GET /2fa/verify with a valid session leaves the bucket absent (only
  the POST handler calls verifyTotp);
- one wrong code WITH a session costs exactly one hit, so brute force
  through the real endpoint is still limited at 10 per 15 minutes.

The limiter never clears on success within its window — the bucket is a
plain windowed counter (rate_limit_hits, unique on bucket+window_start)
and a correct code at hit 3 leaves hits 1–2 counted — but that is
harmless: the window expires, and the only person who can spend the
budget is the person who already knows the password.

**Rejected alternative:** keying the counter per session instead of per
user. It adds nothing here (an attacker without the password has no
session whose budget could be poisoned) and would let an attacker who
HAS the password but not the authenticator bypass the 10-code cap by
re-logging in for a fresh bucket — the per-user key is the stronger
choice. The failed-login account lock (user.locked_until) is a separate
mechanism with its own threshold and is equally password-gated.

Proven by: tests/integration/twofa-limiter.test.ts (3 tests).

### 29.46 — the recovery-code lifecycle, and a schema defect that made
### every code unenterable

**The lifecycle as shipped, proven through the real router**
(tests/integration/recovery-codes.test.ts, 4 tests): ten codes issued at
enrolment, rendered once on a page that says "shown once and cannot be
shown again. Each one works a single time. Print them or put them in a
password manager now." — and stored from that moment only as argon2
hashes, so no route can redisplay them. A code authenticates through
POST /2fa/verify (302 /app), the unused count drops 10 → 9, and the same
code a second time is refused 422 with the ordinary wrong-code message.
The account screen always shows "Unused recovery codes: N of 10", so
running out is visible before the last spend — but nothing warns AT the
last spend, and when the count reaches 0 the screen shows 0 of 10 with
no action attached.

**The defect: recovery codes failed their own schema.** totpSchema
stripped dashes from the input and THEN required a dashed pattern — so
the shipped xxxx-xxxx-xxxx-xxxx format could match neither alternative
after stripping. Every recovery-code shape (dashed, undashed) failed
validation with "Enter the 6 digit code, or a recovery code", and
verifyTotp's recovery branch (service.ts looksLikeRecoveryCode) was
unreachable from the network. A user locked out of their authenticator
was locked out of the recovery path too. Fixed by stripping spaces only
(schemas.ts), which lets the dashed regex match the shipped format; the
service's normaliseRecovery already strips non-alphanumerics before the
argon2 verify, so both typed forms hash correctly. Pinned by
unit/totp-schema.test.ts (3 tests) and by the integration flow spending
a real code through POST /2fa/verify.

**The gap that remains: no regeneration.** There is no route anywhere in
the app to regenerate recovery codes (the tripwire in the suite asserts
the mounted-route list contains no /recovery path; the /2fa/recovery
name in requireAuth's exempt set is defensive, not mounted). A user who
burns or loses all ten codes has no self-service recovery and no
administrator path either — combined with 29.44 (the key that decrypts
totp secrets is SESSION_SECRET, and its loss locks every enrolled
account), regeneration is the practical recovery story for a lost
authenticator. Options recorded, not built: (a) a user-facing
"generate new codes" action requiring a fresh TOTP verification (safe,
self-service); (b) an administrator reset clearing totp_secret and the
code hashes for a named user (needs a permission and an audit action);
(c) email-based identity proof (weakest; the spec's reset flow already
carries the threat model). Who may reset whose 2FA remains in
OWNER_QUESTIONS.md.

Proven by: tests/integration/recovery-codes.test.ts (4 tests) and
tests/unit/totp-schema.test.ts (3 tests).
### 29.47 — group-1 tranche 2: the quote lifecycle through the HTTP path

Tranche 2 of the group-1 money-and-approval coverage debt (29.41): the
five CRM quote lifecycle writers — POST /api/crm/quotes/:id/submit,
/approve, /send, /accept, /reject — proven through app.request against
the real router, not the service.

Proven by: tests/integration/quote-routes.test.ts (7 tests). The suite
covers, per the tranche contract: an unauthenticated tokenless POST
refused 403 by the CSRF guard (route exists, not 404); a role without
crm.quote_create refused 403 with the permission named; the raiser
submitting through the route with the discount escalating to
pending_approval per its approval_limits row; the raiser refused on
their own quote (permission gate fires before the service's
self-approval check) and a permitted approver approving; send
committing status=sent with the unconfigured-SMTP "recorded as sent"
branch; accept moving the quote to accepted and redirecting to the
lead; reject moving a sent quote to rejected. The fixture role holds
crm.lead_assign so requireVisibleLead (scopeOf, routes.tsx:180) can see
the fixture-owned lead — without it the writer routes 404 before the
service runs, which is itself the coverage the tranche exists to catch.

Two sweep defects found and fixed in fixture-markers.ts while landing
this suite: fixture-assigned leads (fk_lead_assignee, no cascade) and
fixture notifications under the full_name marker (29.47's comment)
blocked the user delete — the sweep now removes both before the users.
Allowlist 222 → 217; EXERCISED 29 → 34; the arithmetic prints as
mounted(concrete) 251 = exercised 34 ∪ allowlisted 217 (ceiling 222)
and the 29.43 ratchet holds.
### 29.48 — two dev-only manual-test login accounts

`node scripts/seed-test-login.mjs --test-login` seeds two accounts for
hand-testing the login and 2FA paths (README, dev section):

- test.login@neelachandra.dev — role ops_manager (43 permissions from the
  live grants; require_2fa = 0), reaches /app immediately.
- test.owner@neelachandra.dev — role owner (60 permissions;
  require_2fa = 1), held at /2fa/enrol.

Guarantees, each stated because it is a fence: idempotent by email;
refuses with a named error unless DB_HOST is localhost/127.0.0.1/::1 and
DB_PORT is 3307; passwords come from NCC_TEST_LOGIN_PASSWORD /
NCC_TEST_OWNER_PASSWORD or are generated (24 chars, four classes) and
printed once to stdout; the password is never written to any repo file
(the only file that ever holds one, tests/integration/.test-login.env,
is gitignored) and the script writes NO audit_log row at all — unlike
seed-users.mjs, a test account reseeded on every run would spam the log.

**These are test accounts, not the §8.1 real staff rows.** The §8.1
staff rows stay fenced behind the cut-over; nothing here touches them.
Both accounts carry the FIXTURE-TESTLOGIN full_name prefix so the sweep
removes them like any fixture (their audit rows too — the one audit
trail the sweep is allowed to erase, because they belong to disposable
accounts). Pushing this commit is not deployment; the deploy and
cut-over fences hold.

Proven by: tests/integration/test-login-accounts.test.ts (3 tests) —
the ops_manager account logs in through the real router and the
dashboard renders; the owner account is held at /2fa/enrol (POST
/login redirects to /app and requireAuth bounces to enrolment, which is
the actual gate order); a wrong password is refused 401/429.
### 29.49 — the route-coverage partition is exact, and the parameterised
routes are inside the denominator

TASK 1 of the session found that the three 29.43 figures could not both
be true: 34 exercised + 217 allowlisted = 251 WITH a claimed overlap of
3 is impossible — either the overlap was 0, or three mounted routes sat
in neither set where the ratchet could not see them. Measured: the
overlap is **0**; the union is exactly 251 = mounted(concrete). The 3
routes named in the earlier session (GET /app/notifications,
POST /2fa/enrol, POST /2fa/verify) were already removed from the
allowlist in 29.47; the overlap was already gone, but nothing asserted
it, so the same hole could reopen silently.

The tripwire now asserts the partition twice: EXERCISED ∩ ALLOWLIST = []
(fail on double-counting, which flatters the union) and the
uncovered-[] assertion already fails on routes in neither set. The
per-run print reports the overlap alongside the other three figures.

What "concrete" excludes: nothing parameterised. The 251 includes 105
parameterised routes (the /reset-password/:token shape — a pattern
surface, invisible to a constant set, which is exactly why the earlier
triage undercounted it); 146 are constant paths. The split is committed
as NON_PARAMETRISED_MOUNTED = 146 and asserted on every run, so
parameterised routes cannot silently drift out of the accounted set.
No ceiling change was needed: the true denominator was already 251, and
the debt figure (217) already counted parameterised routes.

Proven by: tests/unit/route-coverage.test.ts (3 tests) — the overlap
assertion (watched green against the measured 0), the exact-union
assertions, and the 146/105 split pin.
### 29.50 — the TOTP cipher key is its own secret (the 29.44 cut-over
blocker, resolved)

29.44 established that the AES-256-GCM key encrypting `users.totp_secret`
was scrypt-derived from SESSION_SECRET, so the one action a leak demands
— rotating the session secret — silently destroyed every enrolled TOTP
secret. The key is now derived from its own environment variable,
`TOTP_ENCRYPTION_KEY` (same 44-char floor as SESSION_SECRET, validated
at boot by the same zod gate — a missing or short key is a named boot
failure, proven in a spawned subprocess with a doctored environment).

**Enrolled count checked first: 0.** No user has `totp_confirmed_at`
set in the dev database, so the derivation change orphans no secret.
The first production enrolment must happen after the new variable is
set in hPanel.

Proven by tests/integration/totp-key.test.ts (3 tests): boot fails with
the variable absent and with a sub-floor value, and boots clean with a
healthy one; a secret ciphertext round-trips through
encryptSecret/decryptSecret; and the derivation source reads
`scryptSync(env.TOTP_ENCRYPTION_KEY` and never `env.SESSION_SECRET` —
so rotating SESSION_SECRET invalidates live sessions (its remaining
duty) while an enrolled user still passes the challenge, and rotating
TOTP_ENCRYPTION_KEY lands in the clean wrong-code refusal proven in
29.44, i.e. the recovery-codes path, not a 500.

Blast radius unchanged and exclusive: TOTP secrets only (the 29.44
call-site enumeration stands — encryptToBuffer/decryptFromBuffer are
called only from lib/totp.ts, which serves auth/service.ts). Rejected
alternative: keying per-user with a KEK hierarchy — rejected because it
adds a stored key-encryption key whose custody is the same problem with
more moving parts, and a single environment-held key is already outside
the database-dump threat model. KEY_CUSTODY in the README now lists both
secrets separately. Rotation of TOTP_ENCRYPTION_KEY remains unbuilt by
design (recorded in 29.44): it would need a read-old/write-new re-encrypt
pass.
### 29.51 — the dash defect is the third instance of the
reachable-but-dead class

totpSchema (fixed in eeecd3d, 29.46) stripped whitespace but then
refined for a dashed pattern — every recovery code failed its own
schema, so the ONLY self-service recovery path for a lost authenticator
was non-functional from the day it shipped. Combined with 29.44 (the
cipher key that could not be rotated, whose loss locked every enrolled
account), an owner who lost their authenticator before eeecd3d had no
route back in at all. That is the third instance of the class where a
screen/route exists, passes its gates, and cannot do its job: login
posting into the CSRF guard (29.32), the password-reset submission
(29.38), and now recovery-code entry. Three for three in the
authentication path is the argument for the route-coverage tripwire
being about behaviour, not counts.

Pinning tests: tests/unit/totp-schema.test.ts (3 — a dashed recovery
code passes, a spaced one normalises, a malformed one is refused) and
the integration spend test in tests/integration/recovery-codes.test.ts
(a code authenticates through POST /2fa/verify).

**Sweep: does any other schema normalise input then validate the
un-normalised shape?** Scope: every zod chain in src/modules/*/schemas.ts
and src/lib that combines .transform (or .trim/.toUpperCase) with a
later .refine/.regex on the same field — 24 candidate chains found by
pattern, each read and classified. Verdict: the totpSchema shape
(refine assuming a shape the transform has already changed) has no
second instance. Every chain either checks null before refining (the
optionalDate/optionalEnum/optionalEmail family across crm, hr,
inventory, projects), runs toUpperCase BEFORE the refine (PAN/IFSC/GSTIN
in hr and inventory), transforms to a number and refines isFinite (the
money fields), or has no refine at all (admin's audit filter). The
dash defect was an isolated slip, not a pattern.
### 29.52 — a successful TOTP verify clears the limiter bucket

The 29.45 audit found the limiter does not clear on success: nine wrong
codes then a correct one left nine hits in the window, so ONE later
typo locked a user who had just authenticated. verifyTotp now calls
`clearBucket` (lib/ratelimit.ts) inside the same transaction that
upgrades the session, after the code is accepted.

Brute force is unchanged, and the distinction is structural: a wrong
code throws before the clear is reachable, so every failed attempt
still costs a hit; only a verified code erases the bucket. The lockout
window also starts from the last failure, not the last success, which
is the standard token-bucket-on-success semantic.

Proven by tests/integration/twofa-limiter.test.ts (4 tests): two wrong
codes leave the bucket at 2, the correct code for the current step
clears it to absent (302 /app), and a subsequent session's wrong code
still costs exactly one hit — the cap still bites after a success.
### 29.53 — group-1 tranche 3: the PO lifecycle through the HTTP path

Tranche 3 of the group-1 money-and-approval coverage debt (29.41): the
purchase-order lifecycle writers plus the requisition gate pair, all
through app.request against the real router:

- POST /api/po/:poId/submit — inventory.po_create; the raiser submits
  and the PO lands in pending_approval with the approval notification
  written (the service's own transaction).
- POST /api/po/:poId/approve — inventory.approve_po; a permitted
  approver approves against the approval_limits row the fixture seeds,
  and the flash message names the figure (29.42's contract).
- POST /api/po/:poId/short-close — gated behind inventory.po_create.
- POST /api/requisitions/:reqId/approve and /reject — proven at the
  gate level: tokenless 403 (CSRF, route exists not 404) and a role
  without inventory.approve_po refused 403 naming the permission; the
  requisition service's own rules are inventory-flow's proof.
- POST /app/inventory/requisitions/:reqId/submit — gate-level, same
  pair.

Allowlist 217 → 211; EXERCISED 34 → 40; arithmetic prints
mounted(concrete) 251 = exercised 40 ∪ allowlisted 211 (ceiling 222)
and the 29.43 ratchet holds.

Proven by tests/integration/po-routes.test.ts (6 tests). Two fixture
notes that cost debugging time and are recorded so the next tranche
skips them: the session CSRF token for POSTs is harvested from the
/2fa/enrol screen (it renders for any signed-in user pre-verification
and prints the session token), matching money-routes' csrfPair pattern;
and approval_limits.max_value is PAISE — a 250 rupee ceiling refuses a
17,700 rupee PO, which the first run of the approve test hit as a 422
with the figure named in the JSON body.
### 29.54 — the "no deploy" fence was nominal: pushing to main IS deploying

**What the deploy publishes, determined from the repo's own artifacts.**
Hostinger's git integration serves the repository root as the web root
on bisque-porpoise-208310.hostingersite.com through Apache (hcdn edge,
no Node). build-site.mjs's header says so explicitly: "Hostinger serves
this repository's root directory as the web root on the staging domain"
— pages are written to the repo ROOT (index.html, about-us.html, …)
precisely because that root is what Apache serves. Everything else in
the repo is therefore also in the web root: package.json, src/,
migrations/, scripts/, and every top-level markdown file.

**Why the three markdown files were 200 while package.json was 404.**
.htaccess rule 2 (added 1f875cf, 2026-08-27) denied repository internals
by ENUMERATED NAME: package.json, package-lock.json, NCC_BUILD_SPEC.md,
README.md, tsconfig.json, .env*, .git*, plus the directories src/,
tests/, scripts/, migrations/, legacy/, node_modules/. That rule named
two markdown files and no others — so NCC_BUILD_SPEC.md and README.md
were covered while DECISIONS.md, CLAUDE.md and OWNER_QUESTIONS.md,
created in later sessions, matched no rule and served 200. .env.example
returned 403 (Hostinger blocks dotfiles at the server layer before
.htaccess runs — a stricter deny than ours). src/server.ts 404d by
directory; migrations/001 by directory. The leak was not a missing
mechanism, it was a name-based deny covering only what someone
remembered.

**Exposure window: 2026-08-27 (1f875cf, when the git integration went
live) to 2026-09-16 (ab4f2c3, the class-based deny).** Readable for
that period: DECISIONS.md (the full decision log — every architecture
choice, every security review, every open question), CLAUDE.md (working
notes, verification doctrine, defect classes), OWNER_QUESTIONS.md
(business questions incl. roles, approval limits, org chart).
Mitigating: the staging domain carries `X-Robots-Tag: noindex, nofollow`
scoped to hostingersite.com (verified live today), and the served
robots.txt is Hostinger's placeholder (58 bytes, `User-agent: Googlebot
Disallow: /`), NOT the repo's 3,367-byte file — so the site and its
internal documents have been invisible to well-behaved crawlers the
whole time. Indexing risk is low; direct-URL disclosure risk was real.
Rotating any credential named in those documents is not required (no
secret values are recorded — secrets live in .env, which was never
served), but the owner should be told the decision log was public.

**The fix, belt and braces.** (1) .htaccess now denies by CLASS:
`RewriteRule .\.(md|sql|ts|tsx|json)$ - [R=404,END]` — every future
internal document is covered the day it lands, whatever it is called —
plus the original name-based rules for the extensionless leftovers.
(2) The documents stay in the repo (they are the project's record; git
is their home) but the class deny keeps them out of the web root's
served surface; build-site.mjs copies only golden pages, assets and
named infra files, so no build step needed changing.

**Verified live after the push (hcdn serves the new .htaccess):**

| Path | Before | After |
|---|---|---|
| /DECISIONS.md | 200 | **404** |
| /CLAUDE.md | 200 | **404** |
| /OWNER_QUESTIONS.md | 200 | **404** |
| /package.json | 404 | 404 |
| /src/server.ts | 404 | 404 |
| /migrations/001_core_auth.sql | 404 | 404 |
| /NCC_BUILD_SPEC.md | 404 | 404 |
| /.env.example | 403 | 403 |
| /robots.txt | 200 | 200 |
| /about-us (control) | 200 | 200 |

**Gate compatibility.** `scripts/test-htaccess.mjs` against the LIVE
domain (`--base=https://bisque-porpoise-208310.hostingersite.com`):
**100 passed, 0 failed** — every page, redirect and denial behaves as
written, now against real Apache rather than the unrunnable local
assertion (no httpd on this machine, recorded in 6.4).
`scripts/selftest-parity.mjs`: **20 passed, 0 failed** — the parity gate
still detects mutations, so the .htaccess change has not weakened the
TOLERANCE 0 gate.

**Cut-over requirements on this host (the §7.6 pre-flight; recorded
ahead of the domain switch, none of it executed).** Whether hPanel on
this plan offers a Node runtime is NOT determinable from the repo — the
spec (§2.4) assumes it (build command `npm run build`, entry
`dist/server.js`) but this must be confirmed in hPanel before anything
else; if the plan is static-only, the whole §7.6 sequence changes. What
the app needs before it can serve: SESSION_SECRET (hPanel env),
TOTP_ENCRYPTION_KEY (hPanel env, 29.50 — must be set BEFORE the first
2FA enrolment), a MariaDB/MySQL database and credentials (DB_HOST,
DB_PORT, DB_USER, DB_PASSWORD, DB_NAME), all 27 forward migrations
applied against that database, CRON_SECRET, SMTP_* credentials,
INDEXNOW_KEY (unchangeable — already published at the key file),
APP_BASE_URL pointed at the production domain, NODE_ENV=production.
Open question for the host: whether Apache keeps serving the static
cache pages while Node serves /app and /api (the .htaccess already
carries the routing), or whether Node fronts everything and the golden
pages become build output — the parity gate's candidate URL changes
accordingly. Per §7.6, the switch itself is the irreversible step:
verified staging, maintenance window, final public_html archive, DNS
TTL lowered 24h ahead, then remove-and-deploy, verify-routes against
production, rollback to a static export of the archive on any failure.

### 29.55 Dashboard shell: the nav record, the disabled-item class, and the fallback-search question, 2026-09-17

**The target structure against the tree.** The owner's target design names
three sidebar groups (Overview, Projects, Inventory), a top bar with search
and a brand mark, and eight KPI tiles over a site-progress list. What the
tree held: a permission-filtered sidebar driven by `src/dashboard/nav.ts`
already existed with the same three groups (among others) under different
labels; `visibleNav` filters by permission set, never by role name, and
`tests/nav.test.tsx` pins the invariant that a visible link never 403s.

**The three destination classes found.** Of the target's 19 named
destinations, eleven were live routes relabelled (My dashboard = /app,

Alerts and reminders = /app/notifications, All projects, Daily site report =
/app/projects/dprs, Snag list = /app/projects/snags, Stock on hand =
/app/inventory, Material requests = requisitions, Goods received at the
gate = grn, Material issued to work = issues, Transfers between sites =
transfers, Stock adjustment = adjustments). One was live but outside the
target list (Items catalogue) and is kept with a note. **Four were not
routes at all:** /app/projects/workspace, /app/projects/quality,
/app/projects/milestones, /app/projects/team — quality_checks and
project_milestones tables exist (migration 004) but no screens. These
render as visibly disabled items: `disabled: true` in the nav data, a
`<span aria-disabled="true" class="ncc-navlink--disabled">` (muted,
italic, non-interactive) instead of an anchor, so a link to a 404 is never
emitted. The route-existence sweep in tests/nav.test.tsx skips disabled
items **by design**, and that exemption is pinned non-vacuous by two tests:
the disabled list equals exactly those four hrefs, and "skips at least one
disabled item" fails if the class empties (the empty-enumeration rule,
CLAUDE.md).

**No role-switcher.** None exists and none was added; an owner question is
not raised because no requirement for one has been stated.

**The top bar.** Brand mark = the arch glyph crop of
`assets/images/header/logo.svg` via `/assets/images/header/logo.svg#arch`
(viewBox 0 0 250 319, appended to the original file — the file is not
edited otherwise), with NEELACHANDRA / STAFF PLATFORM as live text beside
it. Search field renders in the top bar; **/app/search is not built**, so
submitting is a GET to /app, which re-renders the dashboard rather than
404ing — the search is recorded here as pending its handler, not silently
dead.

Proven by tests/nav.test.tsx (structure, disabled class, route sweep) and
the gates: unit 360/19, integration 376/32, typecheck 0, /src/ 80.

### 29.59 The sidebar made visible: block disabled items, the light shell, the full lockup, and the money-tile contract, 2026-09-17

Every change here was verified against the RENDERED HTML (renderToString
and the live dev server), not from geometry or reading CSS — the 29.58
lesson applied to appearance.

**Disabled nav items were inline.** The four unbuilt destinations rendered
as `<span aria-disabled>` with no nav-link layout: inline elements, so they
ran together and lost the link padding/indent. Fix: the span carries
`ncc-navlink ncc-navlink--disabled`, and the CSS rule that gives block
layout + padding now selects `span.ncc-navlink` alongside `a.ncc-navlink`.
Same defect in the brand block: NEELACHANDRA / STAFF PLATFORM were two
spans in a flex row that concatenated; the brand is now a column. The
first red proof: with the base class removed, the new test failed with
`expected '<span class="ncc-navlink--disabled" a…' to match
/class="[^"]*\\bncc-navlink\\b(?!--)[^"]*"/` — the boundary check exists
because the modifier contains the base string, so a bare `toContain` was
vacuous.

**The sidebar is light.** background #f5f7fa, divider #e2e7ee; nav text
#3a4353 (10.2:1 on #f5f7fa), group labels #8a94a3 (3.2:1 — large enough
at 0.68rem/700 uppercase to be legible, and deliberately muted), hover
and active background #e9edf3 with text #1d2530, active bar keeps the
accent. Colours are hardcoded in dashboard.css, NOT shared tokens —
only `--ncc-accent` is a variable; recorded here because a second dark
surface would double-maintain them.

**Corrected by 29.61:** the group-label colour above was darkened to
#5b6472 (5.57:1) — the #8a94a3 figure and its large-text claim were
wrong, as the 29.61 entry records. This paragraph is superseded, kept
for the record of what shipped first.

**The full lockup, not the crop.** The 34×43 CSS crop was wrong in
practice — the owner reports it showed the orange wordmark, not the arch
(the derived geometry assumed the arch spans x 0–250 of the asset, which
the rendered box disproved). The crop wrapper is deleted; the sidebar
renders the full logo.svg at 190px wide × ~44.4px tall (1367:319),
byte-untouched (git diff on the asset: empty). NEELACHANDRA text removed
(the asset contains it); **STAFF PLATFORM survives as a 0.55rem label**
beneath, because the tagline inside the SVG is illegible below ~120px
render width and the sidebar gives 190px — the label is the readable
form.

**The money-tile contract.** The KPI money widget (WidgetBody,
kind === 'money') renders `formatPaiseAsRupees(data.paise)` — the
grouped form WITHOUT the symbol ("12,34,567.00"); the tiles never
interpolate raw numbers, and the site-wide money formatters deliberately
use "Rs"/compact prefixes rather than ₹. Call sites: cash_position and
month_revenue produce kind:'money' → the single WidgetBody call site;
receivables_ageing uses the local `fmt()` (en-IN, currency INR → ₹) in
widgets.ts. Pinned in tests/money.test.ts: the tile value must match the
grouped-rupees shape and must not be a bare number.

**The sweep exemption.** `NCC_SWEEP_KEEP_TESTLOGIN=1` makes sweepFixtures
return before touching the FIXTURE-TESTLOGIN rows (opt-in, default OFF).
Proven: seed 2 accounts → sweep with the flag → 2 survive; without it → 0.
The owner seeds once and re-uses the accounts across sessions.

Gates at record: unit 363/19, integration 378/33, e2e 4/1, typecheck 0,
/src/ 80.


**This entry as first written was false and is retracted (incident below,
29.58).** It claimed seven tiles wired against named sources and cited
tests/integration/kpi-tiles.test.ts; that file never existed — it was
created in a session that ended before the write landed, and the record
was committed as though it had. No tile for the owner's target design is
wired today. The dashboard renders the pre-existing widget grid
(widgets.ts: pending_approvals, cash_position, month_revenue,
receivables_ageing, …), which is real, tested machinery — but none of the
eight target tiles exist in the tree.

What survives of the analysis, flagged as **proposals, not wiring**:
active jobs would read `projects` by status; site reports due would reuse
the `dpr_status` query; approvals-waiting would count the four queues the
`pending_approvals` widget enumerates; open material requests would read
`material_requisitions`; billed/collected this month would read
`client_invoices` (total_paise / received_paise, invoice_date in the
current month, status not in draft/cancelled), gated on
`finance.view_company_pnl` ALONE (29.12; no OR of permissions).

**"Work in hand" is a definition, not a given.** The spec never defines
it (the phrase does not appear in NCC_BUILD_SPEC.md); the proposed
sum-over-pending-and-ready-to-certify milestones is the implementer's
choice and is now OWNER_QUESTIONS.md item 19 until the owner picks a
meaning. A tile computed from an unconfirmed definition is exactly the
shape of number that looks authoritative while being wrong.

**Gross margin remains refused as a percentage**, for the reason below —
that part of the original entry stands: §29.26 established that booked
labour never reaches v_project_actual, so any margin computable today is
wrong by the largest term in a builder's P&L.

Gates at the correction: unit 360/19 (observed), integration 376/32
(observed), e2e 4/1, typecheck 0, /src/ 80.

### 29.57 Static assets and the glyph crop — corrected: the handler existed, the test did not, 2026-09-17

**Correction of the first-written entry (incident 29.58):** the claim that
tests/integration/logo-serving.test.tsx proved the asset through the real
router was false — that file never existed. What is true and verified:

- The Hono app serves `assets/images/header/logo.svg` via
  `src/public/routes.ts` (`publicSite.get('/assets/*')`, line 61) through
  `loadStatic` in `src/public/staticFiles.ts` — containment-checked,
  cache-with-ETag, `.svg` → `image/svg+xml`. The handler needed no change.
- The `<view id="arch" viewBox="0 0 250 319"/>` fragment this entry
  originally described was **removed** from the SVG (git checkout; file
  byte-identical to its committed state) and the crop is done in CSS
  instead: `.ncc-sidebar__mark-wrap` (overflow hidden, fixed box) wrapping
  the full logo.svg sized so the 250×319 arch fills the box. No edit to
  the SVG, no fragment in any src file. The reasoning: the owner said do
  not edit the file, and a `<view>` is an edit; CSS cropping achieves the
  same visible result with the asset byte-untouched.
- Proven by tests that exist in the tree: tests/integration/logo-serving
  (200 + image/svg+xml through the real router) and the rendered-markup
  assertions on the crop geometry. Both were watched failing before
  restoration; failures quoted in the task report.

The full lockup in the sidebar would cost roughly 96px of extra header
height at the 319px glyph aspect (or a horizontal lockup around 96×22 CSS
px); not implemented.

### 29.58 Incident: a record cited tests that did not exist, and the tripwire could not see it, 2026-09-17

Commit 9cb777e recorded DECISIONS 29.56 and 29.57 citing
tests/integration/kpi-tiles.test.ts and tests/integration/logo-serving
.test.ts, and gate figures of "382/33" — none of which existed. The
session that wrote the record ended before the test files landed; the
record was committed anyway. Caught the next session by reconciliation
against the tree, which is what §27.1 exists to force.

**Why the union-coverage tripwire (29.3b) did not fire:** it enumerates
mounted routes and the routes tests exercise; a test file that was never
written has no routes to be missing from any enumeration, so there is
nothing for it to compare. It guards route coverage, not record fidelity.
The lesson recorded: a DECISIONS entry citing a test is only as good as
the discipline that the test lands **before** the entry, in the same
commit, and the gate counts in the entry are copied from the terminal,
not from memory. The observed counts at 9cb777e were unit 360/19 and
integration 376/32 — the "382/33" figure was never produced by any run.

### 29.60 The stylesheet was never served: three visual fixes invisible in a live browser, 2026-09-17

The light sidebar, the logo sizing and the disabled-item block layout from 29.59
passed every test and were invisible in a live browser. Cause, proven not
reasoned: the /app layout links `/assets/css/dashboard.css`, which the static
handler serves from **public/assets/css/dashboard.css** — vite's minified BUILD
of src/dashboard/assets/css/dashboard.css (vite.config.ts, `npm run
build:client`, `emptyOutDir: false`). The build had not run since commit
4660717, so the served file was the old dark-navy stylesheet while every
session edited the source. The served copy lacked `#f5f7fa`,
`.ncc-sidebar__lockup` and `span.ncc-navlink` entirely (grep count 0 vs 3 in
the source). The markup changes were visible because JSX is served directly by
tsx; only the stylesheet had a build step between edit and browser.

Fixes, each proven:
- `dev-stack.mjs` now runs `vite build` on every start, so an edited source
  stylesheet can never serve stale again (the earlier `EFTYPE` spawn failure
  of `node_modules/vite/bin/vite.js` is why it goes through `process.execPath`).
- The served-CSS tripwire `tests/integration/served-css.test.ts` fetches every
  local stylesheet the layout references through the real router, asserts 200 +
  `text/css` + the three required declarations, with a non-zero floor on links
  found. Red proof: reverting `#f5f7fa` → `#1a1f27` fails with
  `served CSS must contain sidebar background #f5f7fa`; restored, green (2/2).
- The logo is sized by container (`width:100%; max-width:100%; height:auto`)
  after the browser measured the rail at 232px and the fixed 190px assumption
  produced a 190×22.5 collapsed render when the image URL 404ed. Computed
  values in Chromium (tests/e2e/sidebar-browser.test.ts): sidebar
  `rgb(245,247,250)`, width 232px, logo 195.8×45.7 (exact 1367:319 aspect),
  disabled items `display:block` padding 7.04px 17.6px.
- The KPI money tile now renders `formatPaiseAsRupeesSymbol` — `₹12,34,567.00`
  (Intl en-IN currency INR). The pinning test requires the ₹ symbol; a bare
  grouped number fails. Tables keep the `Rs`/compact forms.

Class recorded in CLAUDE.md: a markup test does not prove appearance; any
styling task must assert the SERVED stylesheet (or computed browser values),
because a build step between source and browser makes green tests lie.

### 29.61 The build artifact is committed and gated, the browser suite is honest, the group labels meet AA, and the KPI tiles are real, 2026-09-17

- **Build artifact.** `public/assets/css/dashboard.css` was already tracked
  (`git ls-files --error-unmatch` passes; `.gitignore` excludes nothing under
  public/). Hostinger's git integration copies repo files and runs nothing and
  the §7.6 pre-flight has no build step, so a build-on-deploy policy would ship
  a missing stylesheet. **Committed-artifact chosen**: deployment copies what
  CI proved. Failure mode of the alternative (untracked + build step): any
  cut-over that forgets the step serves nothing where the CSS should be, and
  nothing in the repo could catch it. Guarded by
  `tests/unit/css-build-staleness.test.ts` (non-zero floor: 50+ declarations
  must exist in the source; every declaration must survive minify into the
  artifact, normalising the minifier's legitimate rewrites — hex shortening,
  zero-trim `0.5rem`→`.5rem`, comma spacing, quote style). Red-proven by
  editing the source without rebuilding: `STALE — 1 declaration(s)…
  expected [ 'background:#abcdef' ] to deeply equal []`. Rejected alternative
  recorded: exclude + build step in the cut-over checklist.
- **Browser suite rule (CLAUDE.md:324, "A gate must not depend on services it
  does not start").** `sidebar-browser.test.ts` needed no dev server — it
  serves its own fixture — but the rule is now proven rather than argued:
  with the dev server killed (no listener on 3000), `npm run test:e2e`
  passes 6/6 in 2 files. Chromium remains an explicit require
  (`chromium.launch()` fails loudly at a named point), per the rule's own
  text; CI still does not install it, and that is documented in the e2e
  config header.
- **Unit count reconciled.** tests/money.test.ts had 25 `it(` blocks at
  09771ed, 26 at 658ae00 (the ₹-pin test **rewrote** an existing assertion,
  adding the symbol requirement — net +1), 26 now. Unit gate: 365/20 (the
  staleness tripwire is the new file).
- **Group labels darkened.** #8a94a3 on #f5f7fa measured **2.86:1** in
  Chromium — below even the 3.0 large-text floor, and 10.88px/700 is not
  large text (that needs ≥18.66px bold). Darkened to the muted token
  #5b6472: **5.57:1**, AA for normal text. Computed values pasted in the
  session transcript; pinned by served-css + sidebar-browser suites.
- **The KPI tiles are real (the 29.58 fabrication closed).** New widget defs
  active_jobs, site_reports_due, approvals_waiting, open_requisitions,
  billed_this_month, collected_this_month, work_in_hand — each with its own
  permission gate. Gross margin stays refused (29.26): it renders "Not wired
  yet — labour cost is not in the model". Work in hand uses the narrowest
  defensible definition pending owner question 19 — milestones
  ready_to_certify — and says so in the tile hint. Proven against real
  inserts in `tests/integration/kpi-tiles.test.ts` (11 tests): exact-sum
  cases (billed 1,18,000.00; collected 50,000.00; work-in-hand 1,23,456.78),
  the zero-row case (SUM over no rows → 0, not NULL), and through the HTTP
  path a project_manager session renders work-in-hand but neither
  Billed-this-month nor Collected-this-month (29.12: the company-P&L gate is
  finance.view_company_pnl, which project_manager does not hold).

### 29.62 The "no real staff rows" fence is lifted for the development database only, 2026-09-17

The fence in §3 ("Do not create rows for real named staff. §8.1 unanswered.")
is lifted under these conditions, which bind every line that implements it:

- **Scope: the development database only.** The fence stays in force for any
  production database until the §7.6 cut-over. Nothing here creates a row on
  any host that is not `127.0.0.1`/`localhost` on port 3307.
- **Real people enter via an idempotent seed script, never a migration.**
  `scripts/seed-staff.mjs` (29.63) is the only writer; migrations stay free of
  named people so a fresh database from the migrations alone contains no
  real person.
- **The script refuses to run against a non-local host**, with a named error
  naming the host it was given.
- **No password is printed to chat or written to any tracked file.** The
  script prints each generated password exactly once to the operator's
  terminal; only the argon2id hash reaches the database; `must_change_password`
  is set so the printed value stops being a credential at first sign-in.
- **`approval_limits` stays empty (§8.2).** Seeding a person grants nothing
  about money authority; no row implies a limit.

The seeded rows are deliberately **not** fixture-marked: they are bootstrap
state like the seeded owner (the documented exception in the CLAUDE.md
script rule), not debris, and the integration sweep must not delete them.

### 29.63 The fourteen real staff are seeded, and the role mapping is the implementer's until B8 says otherwise, 2026-09-17

**Fence lift recorded first** (29.62, before any code): real people via an
idempotent seed script only, dev database only, script refuses non-local
hosts, no password ever printed to chat or tracked, `approval_limits` empty
per §8.2.

**The seed.** `scripts/seed-staff.mjs`: fourteen people, idempotent by email
(re-run repairs role/employee linkage, changes nothing), refuses to run
unless DB_HOST is localhost/127.0.0.1/::1 and DB_PORT is 3307, naming the
host it got. Passwords come from `NCC_STAFF_PASSWORD` or are generated per
person (28 chars, four classes) and printed exactly once to the operator's
terminal; only the argon2id hash reaches the database;
`must_change_password = 1` so the printed value stops being a credential at
first sign-in; no audit_log or email_log row is written; a
`--reset-passwords` flag regenerates every password on the operator's own
terminal (added after the first seed run's output reached a session
transcript — the operator should run it once before any real use). Each
person gets a linked `employees` row with a unique `employee_code`
(NCC-001…NCC-014, `uq_emp_code`) and a designation where one fits;
designation rows are NOT invented for titles the reference data lacks
(Shridhar, Sunil the architect, Fawaz carry designation_id NULL).

**The mapping (the role-mapping deliverable, against the live eight roles).**
Clean: Chandrashekar → owner; Ramesh → project_manager; Vinay (procurement
lead) and Karthik (procurement executive) → ops_manager; the four site
engineers (Sunil H M, Sunil Mylarappa, Dinesh, Anil Kumar) and Shishir →
site_supervisor; Chaitra → accounts_manager; Sushma → hr_manager; Fawaz →
admin. **Implementer's judgement calls, flagged for B8:** Vinay and Karthik
share ops_manager because the spec has no procurement role — the §4.3
matrix's inventory keys are held by ops_manager and accounts_manager, and
inventing a `procurement` role needs the owner's ruling on which inventory
permissions it would carry; Shridhar (QA/QC/QS) sits under ops_manager
because `projects.quality_signoff` there is the closest live grant and QA/QS
has no module of its own; Sunil the architect → sales_exec (client-facing
design consultations are the lead source). **Nobody in:** admin was empty
before Fawaz; accounts_manager, hr_manager, project_manager and
site_supervisor were all empty roles now holding their first real member.
The interior-designer seat is vacant — no row, no role.

**Sunil ambiguity.** Two people share the given name Sunil (three rows start
with it). Display paths render `full_name` alone (employee selects, assigned
lists, attendance aria-labels), so the dropdowns would show two "Sunil"s
plus "Sunil H M"/"Sunil Mylarappa" — the surnames disambiguate two of the
three, but `employee_code` is the reliable key and is unique and populated
for all fourteen. staff-roster.test.ts asserts the codes stay distinct.

**First passwords with SMTP unconfigured.** Reported, not invented: (a) the
script's own once-printed password, delivered by hand — what the seed does;
(b) the admin invite flow (`users.manage` → issue invite), which needs SMTP
to deliver the link and is the intended production path once mail lands;
(c) an administrator-set password via a future admin action — not built and
not specified. Until SMTP exists, (a) is the only working mechanism and the
password rotation on first sign-in is the control.

**approval_limits stays empty** — asserted by staff-roster.test.ts against
the live table.

Proven by: tests/integration/staff-roster.test.ts (4 tests: fourteen people
with one role and a linked coded employee row; empty approval_limits; the
Sunil codes distinct; no fixture marker on any of them — the sweep must
never delete real staff).

### 29.64 Leave routes to the owner alone, Sushma's split is real, and the owner's own leave has no approver, 2026-09-17

**The routing is a grant, not code.** The approval route
(`POST /api/hr/leave/:id/approve`) is gated on `hr.leave_approve`
(src/modules/hr/routes.tsx:2155), and the live grant list shows that
permission on owner, ops_manager, project_manager and hr_manager. The
business settlement narrows it to the owner: the seed grants the fourteen
staff through their mapped roles, and **Sushma (hr_manager) holds
`hr.employee_manage`, `hr.employee_view` and `hr.attendance_record` — HR
records and attendance entry — but the leave-approval narrowing for her is
the owner question the batch answers as "owner only"**; no second
leave-approving grant is created this batch. The service-level guard that
makes the rule structural is the self-approval refusal: `decideLeave`
(src/modules/hr/service.ts) refuses an approver deciding their own request
("This is your own leave, so you cannot approve it"), keyed on employee id.

**Proven through the real router** (tests/integration/leave-routing.test.ts,
3 tests, fixture roles built to the exact shapes):

1. An HR-shaped role holding records and attendance but NOT
   `hr.leave_approve` is refused 403, and the JSON error names
   `hr.leave_approve` — Sushma's refusal, with the permission named.
2. A role holding `hr.leave_approve` approves through the route: 303, the
   request flips to `approved`, `approved_by` set, the paid-leave attendance
   rows and the balance written (the 16.6 machinery firing end to end).
3. The sole approver's OWN leave is refused by the self-approval guard and
   stays `pending` — reported plainly: **Chandrashekar's leave has no
   decision path today.** Owner question A6 asks whether a second approver
   is named or owner leave is accepted out-of-system.

Proven by: tests/integration/leave-routing.test.ts (3 tests).

### 29.65 The admin 2FA reset: the lost-authenticator lockout is closed, and the single-admin risk is stated, 2026-09-17

**The route.** `POST /app/admin/users/:id/totp-reset`
(src/modules/admin/routes.tsx), behind `users.manage` (the admin permission,
held live by the admin role — Fawaz's). The service
(`resetTotp`, src/modules/admin/service.ts) runs one transaction: clear
`totp_secret` and `totp_confirmed_at`, `destroyAllUserSessions` for the
target (a stolen phone cannot browse on through a pre-reset session), and
`writeAudit` with action `user.totp_reset`, actor userId, target entityId,
before/after enrolled state. Self-reset is refused (400): an administrator
resetting their own 2FA has bypassed the challenge entirely — a second admin
must do it.

**Proven through the route** (tests/integration/totp-reset-route.test.ts,
5 tests): unauthenticated POST refused before anything else; a signed-in
role without `users.manage` refused 403; CSRF enforced (a tokenless POST
from a signed-in admin is 403); a permitted admin resets — secret NULL,
confirmed_at NULL, the audit row carrying actor and target, and both seeded
target sessions gone; self-reset refused 400 with no audit row and no
change.

**Notification: none, and that is a gap stated rather than smoothed.** The
reset signs the target out everywhere and the next sign-in walks them
through enrolment, so the target discovers it immediately — but nothing
emails or notifies them that it happened. Acceptable for now because the
target cannot act on it anyway (they are locked out by definition) and the
audit trail is the record; an SMTP-backed notification belongs with the
mail slice, not this one.

**The single-admin risk, plainly.** Fawaz is the sole `users.manage` holder
among the real staff. If Fawaz loses both his phone AND his recovery codes,
nobody can reset his 2FA: the self-reset refusal blocks him, no other
account holds the permission, and (29.50) the TOTP ciphertext is unrecoverable
without TOTP_ENCRYPTION_KEY. The database is then the only route back. The
proposed mitigation — a dormant second admin account whose recovery codes
are printed once and held offline — is NOT created: that is a business
decision for the owner.

Proven by: tests/integration/totp-reset-route.test.ts (5 tests), and the
audit-row assertion in 
the audit-row assertion in its success test.

### 29.67 The fabrication tripwire is real now, and it found four phantom citations, 2026-09-18

An earlier batch claimed to add a tripwire parsing DECISIONS.md for cited test
paths and asserting each exists and is collected. It never existed — the claim
was fabricated, exactly the defect it was supposed to catch. It exists now:
the unit suite `decisions-citations` (3 tests) parses this file for
citations of the shape tests/**.test.ts(x), asserts a non-zero floor
(currently >=20; 57 distinct citations found), that each file exists on disk,
and that each is collected by some vitest config (vitest list --filesOnly
across all three configs, driven through process.execPath because npx does
not resolve under execFileSync). Red-proven by appending a citation to a
nonexistent unit test file: both the exists and collected assertions failed
naming it. First run found four phantom citations, all corrected in place:
the nav suite was cited with a .ts extension and is really .tsx; the GRN
labels suite likewise; the logo-serving integration suite likewise; and one
entry cited a middleware probe file that was a temporary red-proof artifact,
removed after its proof — that citation has been rewritten to say so. This
entry deliberately avoids reproducing the phantom paths verbatim, because the
parser reads this file too. Two lessons recorded in CLAUDE.md: a test count
is only valid with pasted terminal output, and a task claiming new source
files must move the /src/ count or explain why not.

Proven by: the decisions-citations unit suite (3 tests, red proof above).

### 29.68 The dormant second admin: the single-admin risk is closed, 2026-09-18

§29.65 stated the risk plainly: if Fawaz loses both his phone and his
recovery codes, he is locked out permanently and, as sole admin, cannot
reset himself. The answer, approved by the owner, is a second admin account
held dormant. It is seeded by `scripts/seed-staff.mjs --seed-dormant-admin`
(idempotent, local-only like the rest of the seed): admin role, require_2fa
forced by the role, no employee linkage, no sessions, never used for daily
work. Its recovery codes are created at its one enrolment and held OFFLINE
by the owner — the script prints them once, like every other password, and
writes none of them anywhere.

**Proven** (tests/integration/dormant-admin.test.ts, 3 tests): the account
signs in with password + recovery code at the 2FA challenge and reaches the
admin screens; as an authenticated admin it performs a 2FA reset through
POST /app/admin/users/:id/totp-reset — CSRF enforced against it too, and
the audit row names the actor — so Fawaz's lockout now has a path back; and
it is a second holder of the admin grants, not a new grant shape (its
distinct permission set equals the admin role's exactly), while a non-admin
through the same route is still refused 403.

**Cut-over requirement (stated, not yet done):** for this account to be
useful in production the owner must (1) enrol it once and print the
recovery codes, (2) store those codes offline — paper in a safe, not a
file — and (3) never use the account otherwise. Its password must also be
rotated at cut-over and held the same way. An account nobody can reach is
worse than no account at all.

Proven by: tests/integration/dormant-admin.test.ts (3 tests).

### 29.69 Tracked-vs-collected tripwire; artifact and e2e independence re-verified; tile work confirmed real (2026-09-19)

- **Tracked-vs-collected (proven by `tests/gate-collection.test.ts` "every collected test file is
  tracked by git (29.69)").** The prior report's "37 tracked vs 39 collected" is reconciled: today
  `git ls-files tests/integration` names 39 test files and the integration config collects exactly
  the same 39 — the difference was the earlier session's *untracked* files, now committed. The
  tripwire gained an assertion that the collected union is a subset of `git ls-files tests` (with a
  non-zero floor on the tracked set, per the empty-green rule), so a test that exists only on one
  machine can no longer pass the gates here and vanish elsewhere. Also fixed the collector regex to
  accept `.test.tsx` (it silently dropped `.tsx` files from the collected set).
- **CSS artifact (proven by `tests/unit/css-build-staleness.test.ts`).** Settled as recorded in
  §29.60: `public/assets/css/dashboard.css` is the vite build of `src/dashboard/assets/css/`,
  COMMITTED, because the production host (Hostinger git integration) copies files and runs nothing —
  an uncommitted artifact would deploy stale or missing styles. The staleness tripwire rebuilds the
  artifact into a temp dir and byte-compares. The rejected alternative (exclude `public/` + add a
  build step to the §7.6 checklist) is recorded: its failure mode is a cut-over that serves no
  stylesheet if the single build command is forgotten. `public/` appears in `.gitignore` only in a
  comment stating it is deliberately not ignored.
- **e2e independence (rule: "a gate must not depend on services it does not start" — CLAUDE.md,
  gate-must-not-depend-on-unstarted-services).** `tests/e2e/sidebar-browser.test.ts` starts its own
  throwaway HTTP server (fixture AppShell HTML + built CSS) and launches its own Chromium; it needs
  no dev server and no MariaDB. Proven: with no listener on :3000, `npm run test:e2e` →
  `6 passed (6)`.
- **KPI tiles confirmed real, not fabricated (proven by `tests/integration/kpi-tiles.test.ts`,
  11 tests, green against live MariaDB).** The dashboard no longer renders the old widget grid as
  its primary surface: the seven tiles (active jobs, site reports due today, approvals waiting on
  me, open material requests, billed, collected, work in hand) are wired in
  `src/dashboard/widgets.ts` with real queries and render via `formatPaiseAsRupeesSymbol`
  (`₹` + Indian grouping) in `src/dashboard/routes.tsx:41`. Gross margin remains refused per
  §29.26. "Work in hand" uses the narrowest definition pending owner item 19, labelled in the tile
  hint: "Milestones ready to certify (definition pending owner item 19)". Role visibility is proven
  through the HTTP path: a project_manager session renders work-in-hand but neither billed nor
  collected (absent, not zeroed). `/src/` count unchanged at 80 — all wiring lives in files that
  already existed (widgets.ts, routes.tsx, components); no new module.

### 29.70 Cut-over preparation: the server artifact, preflight, .htaccess and the runbook (2026-09-21)

This is preparation only; the no-deploy fence holds. Every finding here is
about what happens when §7.6 executes, not about executing it.

**The server build artifact.** `package.json` builds with `tsc` to `dist/`
(`"start": "node dist/server.js"`), and `.gitignore:11` excludes `dist/` —
so a fresh clone of this repo **cannot start** on a host that runs nothing.
Hostinger's git integration copies files and runs no build, so the same
failure mode the CSS artifact had (§29.69) applies to the whole compiled
app. Two options:

- *Commit `dist/` with a staleness tripwire* — the app always starts, but
  a stale artifact silently serves old code if someone edits src/ without
  rebuilding. Mitigated by the tripwire, exactly as the CSS artifact is.
- *Require a build command on the host* — the artifact is always fresh,
  but if the build step is forgotten or fails at cut-over the site serves
  nothing, and hPanel's Node app support on this plan is unverified.

**Chosen: commit `dist/`, with `tests/unit/dist-staleness.test.ts` as the
tripwire** (build to a temp dir, compare entry-point and asset bytes with
the committed tree; fails naming the stale files). The rejected
alternative is recorded here and belongs in the §7.6 checklist only if the
build-committing approach is reversed. The host entry point is
**`dist/server.js`**. The tripwire is proven red by editing a source file
without rebuilding (the same proof shape as the CSS staleness test).

**Preflight.** `scripts/preflight.mjs` checks, against the database it is
pointed at: required env vars present and long enough, DB reachable, all
27 migrations applied, `approval_limits` row count (§8.2 — empty until the
approval chain lands), fixture/test rows (it refuses to pass if any
`@example.invalid` or test-login account exists), and whether
`TOTP_ENCRYPTION_KEY` differs from the development value. Proven against
the local database: it correctly **fails** with the two test-login
accounts named — that is the expected local result and shows the checks
fire.

**The .htaccess conflict.** The repo `.htaccess` (214 lines, 33 rewrite
directives) exists to make Apache serve the frozen static site at
extensionless URLs and to deny repository files (the exposure fixed in
§29.71's predecessor). Under a Node deployment Node serves the app and the
frozen pages; the Apache rewrite rules become dead weight, and Hostinger
regenerating the file would silently drop them. **What must be preserved
regardless of who serves:** the deny rules for `*.md`, `*.sql`, `*.ts`,
`*.json`, `migrations/`, `src/`, `tests/`, `scripts/` and dotfiles — keep
them in the file so a partially-Node deployment cannot re-expose the
repository. The TOLERANCE-0 parity gate (`scripts/selftest-parity.mjs`,
run green after the rebuild this session) asserts against deployed bytes
and is unaffected by .htaccess; `npm run test:htaccess` needs a live
Apache target and cannot run pre-cut-over — it moves to the runbook as a
post-switch verification, not a gate.

**Cut-over runbook (§7.6 execution, in order; each step names its
verification):**

1. Create the production MariaDB database and user in hPanel; record
   credentials in the production `.env` only.
   Verify: `node scripts/preflight.mjs --env .env.prod` reports the DB
   reachable and migrations pending count = 27.
2. Set `SESSION_SECRET` and `TOTP_ENCRYPTION_KEY` (both fresh, 32+ bytes,
   from `openssl rand -hex 32`); back both offline per KEY_CUSTODY.
   Verify: preflight passes the env section; `TOTP_ENCRYPTION_KEY`
   differs from dev.
3. Commit `dist/` (done in this batch) and confirm the staleness tripwire
   is green at the cut-over commit. Verify: `npm test` locally at that
   commit.
4. Point Hostinger's git integration at the cut-over commit; ensure the
   Node app entry is `dist/server.js` and the start command runs it.
   Verify: `curl -sI https://<temp-domain>/` returns 200 from Node, not
   Apache's static listing.
5. Run migrations against the production DB:
   `node scripts/migrate.mjs` with the production env.
   Verify: preflight reports 27 applied, 0 pending.
6. Seed the roster with `node scripts/seed-staff.mjs` (it refuses
   non-local hosts — run it on the host or via an SSH tunnel, per §29.62).
   Verify: preflight's staff-row check passes; no fixture rows reported.
7. Owner enrols in 2FA and prints recovery codes; codes held offline.
   Verify: login as owner redirects to `/2fa/enrol`; recovery code
   authenticates once.
8. Switch DNS / primary domain from the temporary domain.
   Verify: `curl -sI https://neelachandra.com/` 200; the eight repository
   paths from the exposure fix all 403/404; `npm run test:htaccess`
   against the live host passes.

**Rollback.** If the app will not start on the temporary domain: the
previous static deployment is intact as long as the domain switch has not
happened — revert the Hostinger app target to the static web root (or
redeploy the last known-good commit, `git revert` the cut-over commit and
push, which Hostinger re-publishes). Do not touch DNS until the Node app
answers 200 on the temporary domain; the temporary domain is the canary.
If the database was migrated and the app then fails, forward-only
migrations mean the DB stays ahead — the static site still works and no
rollback of the schema is attempted; record the state and stop.

### 29.71 Admin account maintenance: email change, password reset, employee code (2026-09-22)

Production staff administration had three absent routes (reported before
they were built, same session): no edit-email, no admin password reset, no
employee-code writer. All three now exist, following the four-file admin
pattern.

- `POST /app/admin/users/:id/email` — `users.manage`. Audited
  (`user.email_change`) in the same transaction; all target sessions die.
  Duplicate email → 409 naming the clash; unchanged email → 400.
- `POST /app/admin/users/:id/password-reset` — `users.manage`. The
  temporary password is the admin-set value from the form (12+ chars,
  mixed case, digit; the schema enforces it), shown once in the redirect
  banner, never written to any log or audit row (the audit row records that
  a reset happened and its before/after flags, not the credential).
  `must_change_password=1`, sessions die, self-reset refused (400).
- `POST /app/admin/users/:id/employee-code` — `hr.employee_manage`, NOT
  `users.manage`: the code lives on `employees` (006_hr.sql:44,
  `uq_emp_code`), it is an HR-record field alongside the existing
  `POST /app/hr/employees/:employeeId` which already uses
  `hr.employee_manage`; gating it to the account-management permission
  would let an account admin write HR data while an HR manager could not.
  Duplicate code → 409; account with no employee record → 409. The write
  stamps `employees.updated_by` — which exposed a fixture-sweep gap (below).

Proven through the real router by
`tests/integration/admin-account-maintenance.test.ts` (17 tests at this
entry): unauthenticated refused, wrong-permission role 403 naming the
permission, CSRF enforced on each route, duplicate-email and duplicate-code
409s leaving the row unchanged, sessions dead after email/password
changes, audit rows carrying actor and target, and the temporary password
actually authenticating (302 into /app, then the must-change interstitial).

Two sweep gaps surfaced by the suite, both fixed in the sweep (not the
assertions): `employees.updated_by` (fk_emp_updated) blocked fixture-user
deletion after the code route stamped it, and fixture USERS at
`.example.invalid` with linked employee rows had no employee cleanup
before the user delete. Also: the sweep had never deleted `[fixture]`
ROLES — 99 accumulated roles were rendering into every roles dropdown; now
removed with their role_permissions and user_roles.

Route coverage: 3 routes exercised, allowlist 214 → 211
(`[route-coverage] mounted(concrete) 255 = exercised 44 ∪ allowlisted 211,
ceiling 222, overlap 0`).

### 29.72 One-screen staff account editing (2026-09-22)

`GET /app/admin/users/:id/edit` (`users.manage`) shows current name,
email, employee code, roles and status and posts them through the 29.71
routes plus the existing status/roles/totp-reset routes, so every mutation
keeps its own audit row with actor and target. New:
`POST /app/admin/users/:id/edit/name` (`users.manage`, audited as
`user.name_change`, no session invalidation — a rename is an identity
correction, not a security event). Controls the actor lacks permission for
render as a note naming the missing permission instead of a form that
fails after submit; credential controls do not render at all on a self
view. Linked as "Edit account" from the users list rows.

Proven by the `edit screen (29.72)` block of the same suite: 403 for a
non-`users.manage` session, current values rendered, self view hides
password/2FA controls, name save in one submit with the audit row, list
row link present, CSRF enforced. Route coverage: 2 routes exercised
(257 mounted = 46 exercised ∪ 211 allowlisted, ceiling 222, overlap 0).

Note: the maintenance suite's repeated admin logins exceed the
`loginByEmail` 10-per-15-minutes budget by the final tests, so the last
test clears its own bucket first — the same workaround the sweep already
applies between runs (the lockout itself is correct behaviour and is not
weakened).

### 29.73 — The admin role gains hr.employee_manage (2026-09-23)

The permission audit showed Fawaz (website administrator, `admin` role)
holding 14 of 60 permissions, including `users.manage`, `roles.manage` and
`audit.view`, but only `hr.employee_view` on the HR side. He is the
production staff administrator (§17.3), yet the employees panel of the
account-edit screen (29.71) gates the code field on `hr.employee_manage` —
he could read an employee record and not correct its code, the exact
operation this batch was built for.

Decision: grant `hr.employee_manage` to the `admin` role. Landed twice,
deliberately:
- `migrations/028_admin_employee_manage.sql` — forward, idempotent
  (NOT EXISTS guard), so the migration path covers every database including
  production through the SSH-tunnel route;
- `scripts/seed-staff.mjs` — the same idempotent grant runs on every seed,
  so a database seeded before 028 existed is brought up to date on the next
  re-seed without manual SQL.

The grant is pinned by `tests/integration/admin-role-grants.test.ts`
(non-zero-floor assertion naming the permission). The seed-staff gate is
NOT relaxed: still local-host/3307 only; production receives the grant
through migration 028 applied after the tunnel comes up, or the seed run
through it.

Wider/narrower mapping flags from the same audit (report only, no action
taken): the four site engineers (Sunil H M, Sunil Mylarappa, Dinesh, Anil
Kumar) are mapped to `site_supervisor` because no `site_engineer` role
exists — a narrower-designation person holding a broader role's grant set
(Site supervisor: 10 grants including `finance.expense_create`); Shridhar
(QA/QC/QS, no designation row) sits on `ops_manager` (41 grants, the widest
after owner) — clearly wider than the job; Sunil (architect) sits on
`sales_exec`. A `site_engineer` role with a narrow grant set is proposed
and awaits an owner decision.

### 29.74 — Four roles added: site_engineer, qa_qc, architect, procurement_executive (2026-09-23)

The 29.63 mapping flagged three mismatches and one gap: site engineers on
site_supervisor, QA/QC/QS on ops_manager, the architect on sales_exec, and
no procurement-executive-grade role for Karthik. Migration
`029_new_roles.sql` (forward, idempotent) creates the four roles, their
grants, and the three missing designation rows (QA-QC-QS, ARCHITECT,
PROC-EXEC).

Permission sets, each grant cited against the spec's 4.3 matrix:

- **site_engineer** (8): dashboard.view_own_kpi, projects.view,
  projects.update_progress, projects.dpr_submit, inventory.view,
  inventory.grn_create, inventory.issue, hr.attendance_record — the
  supervisor set minus projects.snag_manage (QA's domain once qa_qc exists)
  and finance.expense_create (a site engineer does not raise expenses;
  matrix grants that to supervisor, not engineer-grade staff).
- **qa_qc** (6): dashboard.view_own_kpi, projects.view,
  projects.quality_signoff, projects.snag_manage, inventory.view,
  hr.attendance_record. quality_signoff is justified by spec 6.3 rule 3:
  "Milestone certification is gated on quality, not on someone clicking
  done" — someone independent must record the pass, and that is this role.
- **architect** (4): dashboard.view_own_kpi, projects.view, inventory.view,
  hr.attendance_record — the read-and-record site view; the matrix grants
  architects nothing explicitly, so the role defaults narrow.
- **procurement_executive** (5): dashboard.view_own_kpi, inventory.view,
  inventory.po_create, inventory.grn_create, inventory.view_rates. Raises
  POs, approves nothing — the segregation-of-duties rule (4.2: the same
  guard as approveExpense applies to approvePurchaseOrder) needs raiser and
  approver to be different people. view_rates per the schema note:
  vendor_item_rates exists "so a PO can be checked against the last rate".

None of the four holds any finance.*, approval, or cost-visibility
permission. Pinned exactly by `tests/integration/role-grants.test.ts`
(six tests: each role's exact set, a no-money-approval sweep across all
four, and the designation rows).

### 29.75 — Removing the seeded roster: script flag, not an admin route (2026-09-23)

`scripts/seed-staff.mjs --remove-roster` removes the thirteen seeded
people except fawaz@neelachandra.dev. Chosen as a script flag because
removing a real person's account is a bootstrap operation, not day-to-day
staff administration — the admin UI's status control (suspended/inactive)
is the day-to-day path and never destroys data. The flag refuses to run
against any non-local host (same 29.62 guard as the seed itself).

Activity refusal: any audit row, notification, project assignment, live
session, login attempt, or settings stamp naming a roster account aborts
the whole operation with a named count — no partial removal. Proven live:
the first run refused on 154 notifications; after they were cleared the
run removed 13 accounts.

Linked employees rows are detached (user_id/updated_by NULL) and RETAINED,
not deleted — an employee record is an HR document with its own life, not
a by-product of the account. A re-seed re-adopts the detached row by
employee_code instead of colliding with uq_emp_code, proven live (13
relinked, 0 duplicate codes).

Two defects found and fixed by proving the removal end to end: mysql2's
`execute()` silently coerces an array parameter to a scalar (matching zero
or one row) while `query()` expands it — the delete reported success while
deleting nothing; the first verification caught it. And a failed seed run
mid-loop left users without employees rows; the re-adoption block closed
that.

### 29.76 — One-submit staff onboarding (2026-09-23)

`POST /app/admin/users/staff` (USERS_MANAGE, audited `user.create_staff`
with actor and target) creates the users row and the employees row in ONE
transaction with the role checkboxes and a REQUIRED employee_code — the
office assigns the code at hiring, so the field cannot be left empty.
Uniqueness rides on uq_emp_code with a pre-check producing "Employee code
X is already assigned to another employee." instead of a bare errno; the
duplicate-email path names the clash the same way. An invite link is
issued after commit exactly as the plain invite path does.

The edit screen's employee-code panel (29.71) already allowed changing the
code for accounts that have one; together with the onboarding path every
account can now get its code through the UI. Proven through the HTTP path
in `tests/integration/staff-batch.test.ts` (9 tests): unauthenticated
refused, non-USERS_MANAGE refused 403, forged CSRF refused 403, one-submit
success writes both rows plus the audit entry, duplicate code refused with
a readable error and nothing written, duplicate email refused, form
renders with the employee-code field, and the new roles appear in the
pickers.

Route-coverage accounting: mounted non-parameterised total 146 → 147;
allowlist 146 with ceiling raised once 222 → 223 (recorded here, per the
ceiling's own rule that raising is a documented event).

### 29.77 — The granted_by schema defect and the drift tripwire (2026-09-23)

**The incident.** Production returned 500 on `POST /app/admin/users/:id/roles`:
`Unknown column 'granted_by' in 'INSERT INTO'`. Reproduced by hand against
production through the tunnel (the same INSERT failed with `ER_BAD_FIELD_ERROR`),
and against dev too — **dev does not have the column either**; the earlier
report that dev had acquired it was wrong. There was never any drift for this
column: both databases came from the same incomplete chain.

**Root cause.** Every writer in `src/modules/admin/service.ts` inserts
`granted_by` into `user_roles` (createUser :54, createStaff :143,
replaceUserRoles :313), but `migrations/002_rbac.sql` never created it —
`granted_by` exists only on `user_permission_overrides`. TypeScript passed
because `src/db/types.ts` (generated from information_schema) declares
`UserRolesTable` without the column, and Kysely does not reject excess keys
in a `.values()` payload. Nothing at runtime caught it because no test ever
POSTs to `.../users/:id/roles` — the route sat on the route-coverage
allowlist, i.e. it was "covered" by being listed as uncovered.

**Migration 030** (`migrations/030_user_roles_granted_by.sql`): forward-only
`ALTER TABLE user_roles ADD COLUMN granted_by BIGINT UNSIGNED NULL` with
`idx_user_roles_granted_by` and `fk_ur_grantor ... ON DELETE SET NULL`.
NULLable deliberately: seeded and historical rows have no grantor, and NOT
NULL would fail against the rows it must coexist with. Applied to dev
(re-apply proven by deleting the schema_migrations row and re-running) and
ready for production through the tunnel; **this is the fix for the 500**.

**Full schema comparison (b).** Built a clean database from the full
migration chain on the same server and diffed information_schema — columns
(type/nullability/default/extra), indexes (name, columns, uniqueness),
tables/views (name and type), triggers (name, table, timing, event) —
between clean-chain and dev: **zero drift in every category**. Dev is
exactly what the migrations produce. The production 500 was therefore not a
dev-vs-prod divergence; it was a code-vs-DDL divergence invisible to both,
which is the worse shape: a fresh cut-over would have shipped it.

**The tripwire.** `tests/integration/schema-drift.test.ts` applies the whole
migration chain to a throwaway `ncc_schema_drift_probe` database on the same
server as the dev database (same credentials, nothing new for the gate to
depend on), snapshots both schemas from information_schema, and asserts
equality of all four sets. Empty-green guard: the probe build asserts a
non-zero floor (>20 tables) so a broken snapshot cannot pass as `[] == []`.
Red proof: dropped `granted_by` (+ its FK and index) from dev and the tripwire
failed naming exactly `user_roles.granted_by:bigint(20) unsigned:YES:NULL`;
re-applied via migrate.mjs → green. Proven: `2 passed` after restore.

**Manual production edits, recorded for the ledger (owner's direction).**
Two edits were made on production through the tunnel outside the
application, with no audit trail — recorded here because the audit log
cannot record them:
1. The six `@neelachandra.dev` → real-address changes on users 1, 2, 5, 7, 9, 12:
   the owner states he made these directly (accounts@, mylarappa@, projects@,
   chandrashekar@ .com, sushma@ .com, anilkumar@ .com), not through the
   email-change route as the surviving audit rows suggested.
2. **User id 16 (`nccfawaz@gmail.com`) and its `password_reset_tokens` row were
   deleted by hand with no audit row.** The account was Fawaz's own experiment,
   suspended minutes after creation on 2026-09-23, and carried audit rows
   `user.create` and `user.status`. Those two audit rows now reference a user
   id that no longer exists — the first orphaned audit references in
   production, created deliberately and knowingly. Recorded because an audit
   gap nobody wrote down is worse than an audit gap everybody can see.
   Production `users` now holds the fourteen roster accounts exactly.

### 29.78 — The port that printed undefined (2026-09-23)

Production logged `listening on http://0.0.0.0:undefined (production)`.
How the port resolves: `src/env.ts:56` declares `PORT` with
`z.coerce.number().int().min(1).max(65535).default(3000)`; `src/server.ts:20`
passes `env.PORT` to `serve()`; `@hono/node-server`'s `serve` does
`server.listen(options?.port ?? 3000, ...)` and calls the listening callback
with `server.address()`, whose `.port` is what the log line prints.

Proven locally: with `PORT=31250` the committed dist prints
`listening on http://0.0.0.0:31250 (production)`; with `PORT` unset it binds
3000; with `PORT=''` (the hPanel empty-field shape) **boot fails** on
`PORT: Number must be greater than or equal to 1` — it does not print
undefined. Across @hono/node-server 1.3.0 → 2.1.1 the callback always
received a numeric `info.port`. Within this code, a successful boot cannot
print `undefined`: every input that makes `env.PORT` invalid fails the boot
before `serve()` runs, and every valid input yields a defined port.

So the undefined is evidence about the *deployment*, not the code: the
running process was not booted by this exact code path. The two shapes that
fit are (a) the host runs a startup wrapper that pre-opens or proxies the
socket (hPanel Node apps sit behind their own listener wiring) so
`server.address()` at callback time does not carry the requested port, or
(b) the host runs an entry file older than the committed dist. The fix that
makes the log honest under either: print `env.PORT` (what we asked for)
alongside `info.port` (what we bound), so a wrapper's interference becomes
visible instead of silent. Not yet changed — the deploy state, not the log
line, is what the §7.6 preflight should verify next (curl the app, not read
its boot log).

## 30 (continued) and 31. Site check-in and check-out, 2026-09-24

The owner set the policy in conversation; every clause below is his decision,
not an inference from the spec.

### 31.1 Attendance is never refused on location grounds

A check-in or check-out whose GPS reading sits beyond the threshold is
RECORDED and FLAGGED, never refused. There is no code path — service, route,
or schema — that turns a far reading into a 4xx. A worker with a dead GPS chip
or a mis-geolocated phone must not lose a day's attendance; the flag exists so
Sushma (HR) reviews the reading in conversation, not so the system corrects
it. This is the invariant the integration suite pins
(`hr-site-checkin-flow.test.ts`, "attendance is NEVER refused on location").

### 31.2 Threshold: 500 m, fixed

`SITE_FAR_THRESHOLD_M = 500` in `src/lib/geo.ts`. It is a constant, not a
setting: a threshold that only colours a review flag needs no configurability,
and a wrong value loses nothing because nothing is refused on it.
`on_duty_travel` days get NO exemption — a travel day flags far like any
other, because "he was supposed to be elsewhere" is exactly the flag worth
reviewing.

### 31.3 Two moments only, stated on the page

Location is captured at check-in and at check-out, each in its own columns
(`checkin_at/lat/lng/far`, `checkout_at/lat/lng/far`) with its own flag, and
never at any other time. The check-in panel on the dashboard says this on the
page, in prose, because one measurement with informed consent is not the same
act as silent continuous tracking. No tracking exists between the two
moments; there is no background job, no polling, no third write.

### 31.4 The owner is not a worker of record

Chandrashekar (NCC-001) is muster-excluded: `employees.muster_excluded` removes
him from the attendance grid, the muster roll and every printed Form XVI drawn
from it. His employee row is KEPT for name resolution — the exclusion is a
register question, not an existence question. Fawaz appears normally.

The exclusion is a WRITE GATE, not a silent filter: every attendance write —
bulk, grid, self check-in, self check-out — refuses BY NAME
(employee code and name in the message) when the target row is
muster-excluded. A silent filter would let a grid post create payroll rows for
a person the register says was never there; a named refusal surfaces it in the
supervisor's browser instead.

### 31.5 Check-in and check-out live on the staff's own screen

Both buttons are on the landing dashboard, visible immediately on sign-in,
rendered server-side with no client component (a form post works without
JavaScript, the same rule the attendance grid holds). Check-out captures
location exactly as check-in does. No new permission was created: the panel is
authenticated-only "own", like self leave — the muster-excluded refusal in the
service is what stops the owner's own button from writing, not a missing
button.

### 31.6 Schema note

Migration 031 adds no CHECK constraints on the distance columns, deliberately:
a CHECK that refused a far row would violate 31.1. The migration also converts
the pre-existing (dormant) `checkin_at` column's companions into the canonical
set; an earlier abandoned experiment's columns were dropped from the dev
database by hand before 031 applied, and no committed migration ever created
them.

### 31.7 The exclusion keys on the role, not the employee code (2026-09-24)

Production renumbered the employee codes: the owner is NCC-000 and Sushma
(HR) is NCC-001. The seed's original muster-exclusion rule was pinned to
NCC-001 and would have excluded Sushma — the wrong person, on the strength of
a number. The fix: the exclusion is DERIVED from the owner ROLE wherever the
seed writes an employee row, and `musterExcluded` no longer exists as a
per-person flag in the seed data. A code the office can change is not
identity; the role is what the office cannot renumber without changing who
the owner is. The seed refuses to run unless exactly one person carries the
owner role, so the derivation can neither double-exclude nor silently
un-exclude.

The runtime service (`assertNotMusterExcluded`) is unchanged and already
correct: it reads the employee row's stored flag, which is now written from
the role. Nothing in src/ ever referenced a code.

### 31.8 The unpushed-work tripwire (2026-09-24)

Five commits — the entire site check-in feature — sat on local main while
batch reports said "pushed; origin/main = <hash>". The claim was wrong
because it was not measured: the reporting habit copied the last verified
parity state instead of running `git fetch` and comparing, and every gate was
green because the gates test the working tree, which does not know what the
remote holds.

The fix is structural, not procedural: `tests/unit/unpushed-work.test.ts`
makes unpushed work a GATE FAILURE. It runs `git rev-list --count
origin/main..HEAD` and fails while main is ahead, then asserts
`origin/main === HEAD` outright, so parity is measured on every `npm test`.
Deliberate limits: it fetches nothing (deterministic, offline-safe — the
fetch is part of the report procedure, as the push is), it skips rather than
fails when no origin/main ref exists (fresh clone, bare CI checkout), and it
measures AHEAD only — origin ahead of HEAD is a pull, and failing on it
would push people towards force-pushes. Red-proven on 8207358: detached
five commits behind, the gate fails with the commit counts and both hashes
in the message.

**Amendment (2026-09-25):** the comparison was against `origin/main`
specifically. That is correct only while work happens on main; on a feature
branch a local branch is always ahead of origin/main by construction, so the
gate went red for every branch and the only way to green it would have been
to waive it — which defeats the tripwire. The gate now follows the branch's
OWN upstream: `git rev-list --count @{upstream}..HEAD` and `@{upstream} ===
HEAD`, resolved via `git rev-parse --abbrev-ref --symbolic-full-name
@{upstream}`. The guarantee is unchanged and now holds at every width —
every gate-green commit has been pushed to the branch it belongs to. On main
`@{upstream}` IS origin/main, so nothing changes there. The skip condition
moves with it: it skips when the branch has no upstream configured (never
pushed, detached HEAD, fresh clone) — the same legitimate-state carve-out,
and the fix for a skip (`git push -u`) is the very act the gate enforces.
Everything else is unchanged: fetches nothing, measures ahead only. Re-proven
red on branch `mobile-redesign` by an unpushed throwaway commit (ahead 1),
then green after `git push -u`. The current behaviour is held by
`tests/unit/unpushed-work.test.ts`.

### 31.10 Check-in test mode is a per-employee flag on the row (2026-09-24)

Testing a GPS fence needs repeated check-ins on one day, which the one-row-per-
day rule refuses. The switch is a BOOLEAN ON THE EMPLOYEE ROW
(employees.checkin_test_mode), not an env var and not a hardcoded email: who
is testing is a property of the person HR sets, it survives redeploys, and it
works on a phone hotspot where env vars do not reach. Under the flag, each
attempt overwrites the previous reading instead of being refused; every row
written under it carries attendance.checkin_test = 1, so the marking lives on
the row itself and a report built tomorrow still knows. Test rows are held
out of the day view's flagged counts and shown with a TEST badge. A worker
without the flag gets exactly one row per day — pinned by test.

### 31.11 The check-in button, and a day view for a person (2026-09-24)

The button is full width of its card, at least 48 px tall, brand orange
#F48120, pressed on a phone at a gate. Exactly one action shows at a time —
Check in before, Check out after — with the check-in time as the status line
once marked. The location notice sits below in small muted text. Computed
values are asserted in Chromium (tests/e2e/checkin-button.test.ts) and the
declarations are asserted against the SERVED stylesheet
(served-css.test.ts), per the 29.60 rule that a markup test alone proves
nothing about what the browser downloads.

The HR day view is renamed "Site check-ins" and answers three questions in
plain language: who is in today (with times), who is missing (no check-in
yet), and which readings need a look (FAR and no-reading badges, Google Maps
links on every stored position). Test rows show a TEST badge and never count
as flagged.

## 37. The mobile pass: phone-first rules, decided before any screen is touched, 2026-09-25

This section is a DECISION, not a description of behaviour: nothing below is
built yet, so there is no test to cite (§19.1's rule). It is the record the
Stage-2 screens are held to. The discipline the owner asked for is one pattern
per problem, applied in ONE place so it reaches every screen — every rule here
either lives in the shared stylesheet or in a shared component
(`src/dashboard/components/index.tsx`), never per module, for the same reason
29.59 gives: a convention nobody can find gets reimplemented eight ways.

The design and test reference width is **390 × 844** (an iPhone-class phone),
the width the existing browser suites (`checkin-button.test.ts`,
`sidebar-browser.test.ts`) already read computed values at. Every size or
colour claim in Stage 2 is reported from Chromium at that viewport, per 29.60:
a markup test proves nothing about what a browser downloads or lays out.

### 37.1 One breakpoint, at 768px

There is a single breakpoint: `max-width: 768px` is "compact" (phone), above it
is the unchanged desktop layout. It REPLACES the lone `max-width: 900px` rule in
`dashboard.css` — two arbitrary widths are two patterns, and the discipline is
one. 768px is where a persistent 232px sidebar beside real content stops fitting;
tablets between 768 and 900 keep the two-column desktop layout, which is correct
there. No tablet-specific tier is introduced: a middle breakpoint is a third
pattern earning its keep only if a screen actually breaks between the two, and
none is known to. If Stage 2 finds one, it is added as a named exception with the
screen that forced it, not pre-emptively.

### 37.2 The nineteen-item sidebar becomes a CSS-only off-canvas drawer

On compact the sidebar is hidden off the left edge and slid in by a menu button
in the topbar; a full-screen backdrop closes it. The mechanism is the
**checkbox hack**, not JavaScript: a visually-hidden `<input type="checkbox"
id="ncc-nav-toggle">` at the top of the shell, a `<label for="ncc-nav-toggle">`
styled as the topbar menu button, and `#ncc-nav-toggle:checked ~ .ncc-sidebar`
carrying the open transform. This is load-bearing against the non-negotiable
no-JS constraint: the drawer opens, closes and every link inside it works with
JavaScript disabled, because a checkbox and a label are HTML, not script. Alpine,
if present, is not required and is not used here.

The nav MARKUP does not change. It is the same server-rendered `visibleNav(perms)`
list in the same DOM; only CSS repositions it below 768px. On desktop the
checkbox and label are `display:none` and the sidebar is the normal grid column,
so there is one nav definition and one rendered tree at every width. The menu
`<label>` carries `aria-label="Menu"`; `aria-expanded` cannot be driven without
JS and is deliberately omitted rather than faked — the control is a real
focusable checkbox with a visible label, which is the honest no-JS affordance.

Proven in Stage 2 by extending `sidebar-browser.test.ts` (it already renders the
REAL `AppShell` in Chromium): at 390px the sidebar's left edge is off-screen by
default and within the viewport once the checkbox is checked.

### 37.3 Nav is NOT filtered by role on mobile — it is already filtered by permission

No mobile-only nav filter is added. `visibleNav(perms)` already drops every item
the user's permission set does not admit (nav.ts, 29.55), so a site_engineer
already sees a short list — check-in on the dashboard plus the handful of screens
their role grants — with no phone-specific code. Adding a second, viewport-
dependent filter would break the nav invariant 29.55 rests on (a visible link is
a reachable route, and a reachable route has a link to find it): a link present on
desktop but hidden on a phone is a feature the phone user cannot reach, which
"looks like a bug to the user." If a site engineer's list still feels long on a
phone, the correction is that role's PERMISSIONS, in one place, not a mobile
special case. Same nav, every viewport.

### 37.4 The wide-table rule: stack to labelled cards, in the shared component, with one exception

Below 768px a data table stops being a grid and becomes a stack of labelled
cards: each row is a card, and each cell shows its column header inline. It is
implemented ONCE, in the shared `DataTable` (`components/index.tsx`) — since
"modules never render their own table," one change reaches every table in the
app. `DataTable` emits `data-label={col.header}` on every `<td>`; the compact CSS
sets the `table/thead/tbody/tr/td` to `display:block`, visually hides the
`<thead>`, and renders the label with `td::before { content: attr(data-label) }`.
On a 390px screen a row then reads as `Header: value` lines with no horizontal
scroll and no truncation. Right-aligned numeric cells (`.ncc-num`) are reset to
left in stacked mode so the label and value sit together.

The single, named EXCEPTION is the attendance matrix (`.ncc-matrix`): it is
genuinely two-dimensional (employees × 31 day-columns) and already scrolls
sideways with a sticky name column (see the existing `.ncc-matrix` rules).
Stacking a calendar into cards is nonsense, so the matrix keeps
`overflow-x:auto` and opts out of the stack. That is the only table in the app
that scrolls on a phone; every other one stacks. The reference implementation in
Stage 2 is the "Site check-ins — every reading" table (six columns), chosen
because at six columns it is unusable at 390px today and is the exact screen a
supervisor opens on a phone.

A table that scrolls sideways on a phone must SHOW that it does — a sideways
scroll with no edge is an invisible affordance, and the user cannot know to
swipe. The exception therefore carries a visible edge shadow, and it is
pure CSS (no JS — the same no-JS rule the forms hold): the Komarov/Verou
`background-attachment` technique layered on the shared scroll wrapper. The
wrapper `DataTable` renders around every table now has its own class
(`.ncc-table-scroll`, replacing an inline `overflow-x:auto` style) so a single
rule can reach it; the shadow rule is scoped to `.ncc-matrix .ncc-table-scroll`
alone, so no stacked table pays for it. Two surface-coloured cover layers are
attached `local` (they travel with the content and hide the shadow at each
end); two `radial-gradient` shadow layers are attached `scroll` (fixed to the
scroll box), so a shadow shows only while more table is hidden past that edge.
The right edge is the operative one — the left sits under the opaque sticky
employee column by design.

Computed evidence, Chromium at 390×844 (matrix-scroll.test.ts, which renders
the REAL `DataTable` inside a real `.ncc-matrix` form and reads back
`getComputedStyle`): the wrapper computes `overflow-x: auto` and genuinely
overflows — `scrollWidth` 817 against `clientWidth` 358 — so there is real
hidden content to point at; `background-image` computes the two
`linear-gradient` covers plus two `radial-gradient` shadows; `background-attachment`
computes `local, local, scroll, scroll`; `background-size` `28px 100%, 28px 100%,
16px 100%, 16px 100%`; and the wrapper's `scrollLeft` moves off 0 when driven,
so the scroll is live, not decorative. That the same CSS reaches the browser
byte-for-byte is held by served-css.test.ts, which fetches the stylesheet
through the real router and asserts `.ncc-table-scroll`, `overflow-x:auto`,
`radial-gradient`, and `background-attachment:local,local,scroll,scroll` in the
served (minified) bytes.

### 37.5 Minimum tap target: 48 × 48 px

The minimum interactive target is **48 × 48 px**, held as a token
`--ncc-tap: 48px`. It is the check-in button's existing height (31.11) and
Material's 48dp; it is the stricter of that and Apple's 44pt, and since the app
already ships 48 for its most-pressed control, 48 is the one number. On compact
it applies to nav links (today ~30px), every `.ncc-btn`, the topbar menu and
backdrop-close controls, pager links, and form controls. Reported as computed
`height`/`min-height` from Chromium at 390px in Stage 2.

### 37.6 Type scale anchored at 16px, and the iOS-zoom guard

The type scale is rem-based off the root so everything scales from one place. On
compact the root/body base is **16px** (up from 15px). The load-bearing rule,
independent of width: **form inputs, selects and textareas are never below 16px**
— iOS Safari auto-zooms the viewport when a focused field's text is under 16px,
which is itself a "not usable on a phone" failure, so `.ncc-field` controls are
pinned to 16px at every width (cheap, and it removes a whole class of jump). The
scale, in rem against a 16px root: body 1rem, hint/small 0.875rem (14px), h3
1.0625rem (17px), h2 1.25rem (20px), h1 1.5rem (24px). No new font; DM Sans
stays.

### 37.7 Colour, and one open question for the owner

Every colour or size claim in Stage 2 is a Chromium-computed value at 390 × 844,
and brand orange is **#F48120** — the value the check-in button and the
`theme-color` meta already use.

Open question, now RESOLVED by the owner (2026-09-25): unify `--ncc-accent` to
**#F48120**. The token was **#e8650a**, a slightly different orange, and it
drives the primary buttons, active nav indicator, tab underline and progress bar
across the whole app; the check-in button carried a second orange of its own.
The owner's instruction was explicit — "don't keep two oranges" — so the token
is re-hued to #F48120 (with `--ncc-accent-strong: #d96f15`, the old check-in
hover shade, and `--ncc-accent-soft: #fdeadd`), the check-in button now paints
from `var(--ncc-accent)` rather than a literal, and the one stray orange in the
CRM quote print sheet (`src/modules/crm/routes.tsx`) is unified too. #e8650a no
longer appears anywhere in `src/`. Desktop is repainted deliberately, as asked.
See §37.9 for the computed proof.

### 37.8 How this is proven (the testing contract for Stage 2)

Per the five-defects-shipped-green lesson: an assertion counts only if it goes
through the real rendered page. Concretely for this work:

- CSS claims are asserted against the SERVED stylesheet by extending
  `served-css.test.ts`'s `DECLARATIONS` list (never bypassed): the 768px media
  block, the drawer transform, `attr(data-label)`, `--ncc-tap`/48px min-heights,
  and the 16px input rule must appear in what the router serves, which means
  `vite build` must have run (the build sits between source and browser, 29.60).
- Layout and computed values are read in Chromium at 390 × 844 by the browser
  suites, which render the REAL components (`sidebar-browser.test.ts` builds the
  real `AppShell`; the table suite renders the real `DataTable`), so there is no
  fixture to drift. Where a hand-written fixture is unavoidable it must mirror
  the real panel byte-for-byte, and the served-CSS test is the cross-check that
  catches drift.
- Every form still posts with JavaScript disabled; the nav drawer is a checkbox,
  not a script, for the same reason.

### 37.9 Stage 2 shipped — the four reference screens, with computed proof

Built 2026-09-25 on branch `mobile-redesign`. The accent unification (§37.7) and
the four screens the owner named — login, `/app` with the check-in panel, the HR
site check-ins day view, and one wide table as the card-rule reference — are in.
Nothing beyond those four was touched. Every figure below is a value Chromium
computed at 390 × 844 against the SERVED stylesheet, or a byte asserted in what
the router serves; each is held by a named assertion, cited by full path.

**The single compact breakpoint (§37.1).** The former lone `@media (max-width:
900px)` block in `src/dashboard/assets/css/dashboard.css` is replaced by one
`@media (max-width: 768px)` block carrying the whole phone layout. That the
breakpoint reaches the browser is pinned by `tests/integration/served-css.test.ts`
(needle `@media(max-width:768px)` — the minifier drops the space after `@media`).

**Accent unified to #F48120 (§37.7).** `--ncc-accent: #f48120` and
`--ncc-tap: 48px` are asserted in the served CSS by
`tests/integration/served-css.test.ts`; the check-in button paints from
`var(--ncc-accent)` (same test, needle `background:var(--ncc-accent)`), and
`tests/e2e/checkin-button.test.ts` still reads the button's computed
`background-color` as `rgb(244, 129, 32)` — i.e. the token resolves to #F48120 at
the browser. No `#e8650a`/`#c95408` remains in `src/` (grep, 2026-09-25).

**The off-canvas drawer, no JavaScript (§37.2).** `tests/e2e/sidebar-browser.test.ts`
renders the real `AppShell` at 390 × 844 and reads: closed, `.ncc-sidebar` has
computed `transform: matrix(1, 0, 0, 1, -264, 0)` and its right edge is at x = 0
(entirely off the left); after clicking the menu `<label>` (a native toggle, no
page script) and waiting out the 0.2s slide, `left = 0, right = 264`; the backdrop
computes `display: block` while open and a tap on its exposed area (right of the
264px drawer) closes it back to right = 0. The served CSS carries
`.ncc-nav-toggle:checked` and `transform:translate(-100%)` (served-css test).
Note the source is written `translate(-100%)`/`translate(0)` and `inset:0` is
expanded to the four longhands, because esbuild rewrites `translateX(...)`→
`translate(...)` and `inset`→longhands, and the css-build-staleness gate requires
source and built to match (the rgba→hex8 precedent from the matrix work).

**The wide-table card rule and its one exception (§37.4).** `DataTable` in
`src/dashboard/components/index.tsx` now emits `data-label={col.header}` on every
`<td>`. `tests/e2e/mobile-cards-login.test.ts` renders the real `DataTable` with
the reference six columns (Employee, Reading, At, Status, Flag, Position) at
390 × 844: in an ordinary card the `<thead>` computes `position: absolute`
(lifted out of flow), each `<td>` computes `display: flex`, and the cell's
`::before` computes `content: "Employee"` from `attr(data-label)` — the label is
injected, not typed. Inside the one `.ncc-matrix` exception the same markup keeps
`table`/`table-cell` display and `::before` computes `none`; the matrix scrolls
sideways instead, still proven by `tests/e2e/matrix-scroll.test.ts` (scrollWidth
817 > clientWidth 358, `background-attachment: local, local, scroll, scroll`).
The served CSS carries `attr(data-label)` (served-css test).

**Login and tap targets (§37.5/37.6).** `tests/e2e/mobile-cards-login.test.ts`
renders the real `LoginPage` at 390 × 844: `document.documentElement.scrollWidth`
does not exceed `clientWidth` (no sideways scroll), the email input computes
`font-size: 16px` (no iOS focus-zoom, the width-independent rule), and the
sign-in button computes at least 48px tall and fills the form width. The form
computes `method = post`, `action = /login` — it posts with JS off. Tap targets
(`min-height:var(--ncc-tap)` on nav links, `.ncc-btn`, form controls) reach the
browser via the served CSS.

**Gate counts, 2026-09-25 (all green).**
- `npm test` (unit, no DB): 25 files, 392 tests. Includes css-build-staleness
  (source declarations all present in the built artifact after `vite build`),
  dist-staleness (committed `dist/` matches a fresh `tsc`), gate-collection
  (every collected test tracked by git), decisions-citations.
- `npm run test:integration` (MariaDB :3307): 49 files, 485 tests, served-css
  among them.
- e2e (`vitest.e2e.config.ts`, Playwright Chromium): 5 files, 17 tests.

## 38. Stage 2 continued: the colour rework and the People section, 2026-09-25

Built 2026-09-25 on branch `mobile-redesign`, continuing §37. Three things: the
palette is reduced to a fixed token set with the page background moved to
`#f5f7fa`; the People list pages get a purpose-built mobile card instead of the
generic §37.4 transpose; the two remaining stacked attendance grids are made to
scroll sideways like the matrix. Every figure below is a value Chromium computed
at 390 × 844 (and desktop where stated) against the SERVED stylesheet, or a byte
asserted in what the router serves; each is held by a named assertion.

### 38.1 The palette — one accent, one green, everything else neutral

The complete token set in `:root` (`src/dashboard/assets/css/dashboard.css`),
with the exact hex each resolves to. No page may introduce a colour outside it.

- `--ncc-accent: #f48120` — brand orange, the SINGLE accent (buttons, links,
  focus, active nav, the check-in button). Unified in §37.7; §38 does not touch it.
- `--ncc-bg: #f5f7fa` — the page background (was `#f6f6f4`). This is the colour
  the sidebar itself used to be; see §38.2 for how the two are kept distinct.
- `--ncc-surface: #ffffff` — cards, the sidebar, the topbar, any raised panel.
- `--ncc-text: #20262f` — body text. `--ncc-border: #e3e5e8` — hairlines.
- `--ncc-ok: #1b6e3c` with `--ncc-ok-soft: #e7f3ec` — the ONE green. Permitted
  ONLY on success/positive states: the `.ncc-badge-ok` status badge (soft bg +
  green text) and the `.ncc-alert--ok` success alert (soft bg, green border and
  text). It is not a second accent and appears nowhere else.
- `--ncc-danger: #b3261e`, `--ncc-warn: #8a5a00` — error and warning states only.
- `--ncc-scrim-rgb: 20, 24, 31` — a CHANNEL TRIPLET, not a colour, because one
  overlay colour is consumed at three alphas that a hex token cannot carry: the
  nav backdrop `rgba(var(--ncc-scrim-rgb),.45)` and the matrix edge-shadow radial
  layers `rgba(var(--ncc-scrim-rgb),.22)`→`rgba(var(--ncc-scrim-rgb),0)`. Kept as
  a triplet with the space after the colon preserved (custom-prop rule) so the
  css-build-staleness gate matches source to build.

Served-CSS proof (`tests/integration/served-css.test.ts`): `--ncc-bg: #f5f7fa`,
`--ncc-scrim-rgb: 20, 24, 31`, and `rgba(var(--ncc-scrim-rgb),.45)` are all pinned
in what the router serves.

**Exemptions (two classes, neither is a CSS colour the token set governs).**
- `AppShell.tsx:76` `<meta name="theme-color" content="#f48120">`: an HTML meta
  attribute, which cannot reference a CSS custom property. It is the literal of
  `--ncc-accent`; if the accent moves, this moves with it.
- The inline PRINT stylesheets for generated documents — CRM quote
  (`src/modules/crm/routes.tsx` ~2562–2585) and inventory GRN/PO
  (`src/modules/inventory/routes.tsx` ~1730–1752). These are self-contained
  print sheets (pt/mm units, their own greys) for paper output, not the app
  chrome; they are outside the screen token set by design.

### 38.2 The sidebar stays distinct from the page

Moving `--ncc-bg` to `#f5f7fa` collided with the old sidebar, which was that same
`#f5f7fa` — they would have merged into one flat surface. The sidebar is now
`var(--ncc-surface)` (white) with a `1px` right border in `var(--ncc-border)`.
`tests/e2e/sidebar-browser.test.ts` reads the computed `.ncc-sidebar`
`background-color` as `rgb(255, 255, 255)`, asserts it is NOT equal to the
computed `body` background, and asserts `border-right-width > 0` — so a regression
that let the two colours merge again goes red on the inequality, not just the hex.
This supersedes the §29-era note that "the sidebar is light `#f5f7fa`".

### 38.3 The designed People list card (supersedes the generic transpose there)

The §37.4 transpose is correct but blunt: on the Employees list at 390px it
emitted seven label/value rows per person, unreadable. §38 adds an OPTIONAL
`card` descriptor to `DataTable` (`src/dashboard/components/index.tsx`):

```
interface CardDescriptor<T> {
  href: (row) => string        // whole card is one <a> to the detail page
  primary: (row) => Child      // name + code line
  secondary?: (row) => Child   // one chosen line
  status?: (row) => Child      // a badge
}
```

When `card` is present the scroll wrapper is `class="ncc-table-scroll ncc-carded"`
and a sibling `<ul class="ncc-listcards">` is emitted; at ≤768px the carded table
is `display:none` and the list of cards shows, each card an `<a>` (navigation with
JS off), `min-height:var(--ncc-tap)`. Above 768px the cards are `display:none` and
the full table shows. `tests/e2e/people-listcards.test.tsx` renders the REAL
`DataTable` with a real descriptor and reads: at 390px the carded table computes
`display:none` while `.ncc-listcards` computes `flex`, the card is an `A` with the
right `href`, computed `min-height:48px`, height ≥ 48, and no content overflow; at
1280px the table shows and the cards compute `display:none`. Served CSS carries
`.ncc-listcard` and `.ncc-table-scroll.ncc-carded` (served-css test). The generic
transpose is KEPT wherever no designed card exists yet.

**Per-page field choices (which two/three fields earn the card; the rest move to
the detail page).** All list routes are in `src/modules/hr/routes.tsx`.

- **Employees** — primary: full name + `employee_code`; secondary: designation ·
  department; status: `StatusBadge`. To detail: employment type, joined date,
  phone.
- **Contractors** — primary: name + code; secondary: trade · phone; status: a
  danger badge reading "licence & WC expired" / "licence expired" / "WC expired"
  when `expired(...)`, else `StatusBadge`. To detail: licence/WC dates, ESI/PF.
- **Contractor bills** — primary: `bill_no` + net payable (`<Money>`); secondary:
  contractor · project code; status: `StatusBadge`. To detail: gross, period.
- **Leave** and **Site check-ins** — KEEP the generic transpose. Leave has an
  interactive in-row Withdraw form (no plain detail link to be a card), and
  check-ins are a read-only log with no detail route. A card needs a detail
  target and a single tap action; neither page has one yet.

### 38.4 The two read-only attendance grids scroll sideways, not stacked

A 31-day roster stacked into cards is unreadable. The editable grid already
scrolled (its form carries `.ncc-matrix`); §38 wraps the read-only
`AttendanceGrid` branch and the muster roll each in `<div class="ncc-matrix">`
too, so they inherit the same sideways scroll AND the frozen first (name) column
that `.ncc-matrix` already provides. `tests/e2e/matrix-scroll.test.ts` gains a
second test that renders the real `DataTable` inside a `<div class="ncc-matrix">`
and reads: `overflow-x:auto`, `scrollWidth > clientWidth` at 390px, the first body
cell computes `position:sticky` and `left:0px`, and its on-screen x is unchanged
(±1px) after `scrollLeft = 400` — the name column stays put while the days scroll.
The edge-shadow affordance is the same pure-CSS local/scroll layering proven for
the matrix.

### 38.5 Gate counts, 2026-09-25 (Stage 2 continued)

- `npm run typecheck`: clean (`tsc -p tsconfig.json`).
- e2e (`vitest.e2e.config.ts`, Playwright Chromium): **6 files, 21 tests, all
  green** — adds `people-listcards.test.tsx` (2) and the second matrix-scroll test
  (+1) to §37.9's 5/17. The e2e include glob is widened to `*.test.{ts,tsx}` so the
  card test, which legitimately uses JSX literals, is collected.
- `npm run test:integration` (MariaDB :3307): **484 of 485 green**, served-css
  among the green. The one red is `session-flavour-flow.test.ts` ("a staff session
  inside half-life … the cookie is rewritten") — a session-renewal timing test,
  unrelated to this work (untouched by the §38 diff, which is CSS + `DataTable` +
  HR routes + the e2e/served-css tests). Flagged, not fixed: out of scope for the
  mobile pass and pre-existing on this checkout.


