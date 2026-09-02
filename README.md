# Neelachandra Construction and Interiors platform

## Project overview

- **Name**: Neelachandra Construction and Interiors full-stack platform
- **Goal**: replace the hand-edited PHP marketing site with a Node application
  that serves the same bytes, and add the internal system the business runs on:
  authentication, an admin panel, and seven role-aware dashboards.
- **Spec**: `NCC_BUILD_SPEC.md` is authoritative. Where this README and the
  spec disagree, the spec wins.

## Stack

Node.js 22 LTS, Hono 4, `hono/jsx` rendered on the server, htmx 2 and
Alpine.js 3 self-hosted, Chart.js vendored for dashboards only, MariaDB 11.8
through `mysql2` and Kysely, self-hosted session-cookie auth with argon2id and
TOTP for privileged roles. Target host is Hostinger's Node.js web app.

No Cloudflare Workers, no Postgres, no ORM beyond Kysely's query builder.

## Running it

```
node scripts/migrate.mjs          # apply migrations/001..009
node scripts/seed-users.mjs --owner   # creates the first owner, prints the password once
npm run build                     # tsc, runtime data copy, vite
pm2 start ecosystem.config.cjs    # listens on 3000
```

`ecosystem.config.cjs` reads `.env` and passes it as real environment
variables, which is how Hostinger's app manager supplies them too.

## What works today

**Public site.** All ten pages serve as frozen bytes from the repo root at
extensionless paths, verified 200:
`/`, `/about-us`, `/contact-us`, `/construction-packages-in-bengaluru`,
`/construction-services-in-bengaluru`,
`/best-construction-company-in-bengaluru`,
`/best-construction-company-in-bengaluru-projects`,
`/construction-company-in-tumkur`, `/privacy-policy`, `/terms`.
Plus `/robots.txt`, `/sitemap.xml`, the IndexNow key and `llms.txt`.
The contact form POSTs to a real `enquiries` row, rate limited per IP.

**Authentication.** `/login`, `/forgot-password`, `/reset-password`, TOTP
enrolment and verification, recovery codes, forced password change on first
sign-in, session listing and revocation under `/app/account`.

**Admin panel.** `/app/admin/{users,roles,approval-limits,reference,settings,audit,enquiries}`.
Users, role assignment, per-user permission overrides, approval limits,
reference data, settings, the audit log and the enquiry queue.

**Dashboard.** `/app` renders 16 widgets filtered by the signed-in user's
effective permission set. `/app/notifications`.

**Projects module.** Complete. `/app/projects` with an eleven-tab detail view
(overview, stages, daily reports, quality, milestones, snags, approvals,
materials, cost, documents, team), project creation from a stage template,
DPR submission and review, stage progress with a finish-to-start override
that requires a reason and is audited, quality checks and sign-off, milestone
certification gated on stage completion and passed checks, snag lifecycle,
approvals, team assignment, and the cross-project `/app/projects/dprs` and
`/app/projects/snags` queues.

**Cron.** `/internal/cron/{housekeeping,stock-alerts,document-expiry}` behind
`X-Cron-Key`.

**Inventory, CRM, Finance, HR, Marketing.** Schema, permission keys, sidebar
and routes are live and guarded. Every route in the sidebar resolves and
reports its real row count. The transactional forms are the next phase.

## Security model

The middleware order in `src/app.ts` *is* the security model:
secureHeaders, legacyRedirects, session, csrfProtect, requireAuth, then
per-route permissions. `csrfProtect` deliberately precedes `requireAuth` so a
forged request is rejected without a database read.

Guards check permission keys, never role names. Effective permissions are
`union(role_permissions) - deny_overrides + grant_overrides`, computed once
per request. Row-level scoping is a SQL predicate, not a JavaScript filter,
and an unassigned project returns 404 rather than 403 because the project name
is itself commercially sensitive. Cost visibility is its own permission and
the money columns are omitted from the SELECT, not hidden in the template.
Self-approval is blocked in SQL, including for the owner.

## Data conventions

Money is `BIGINT` paise everywhere; rupees convert to paise exactly once, at
the Zod boundary. Dates are Asia/Kolkata local business date strings, never
instants. The financial year runs 1 April to 31 March, labelled `2026-27`.
Stock is an append-only `stock_ledger` with `item_stock` as a rebuildable
cache.

## Remaining work

1. Transactional screens for inventory (GRN three-way match, issues,
   transfers through a transit location, PO approval, consumption variance),
   CRM (lead scoring, quotes, conversion to project), finance (expense dual
   approval, invoices from certified milestones, period close), HR
   (attendance as the cost allocation key, contractor bills), and marketing
   (funnel attribution, the page editor with preview and publish).
2. `scripts/seed-reference.mjs` and `scripts/reconcile-stock.mjs`.
3. Unit tests for permissions, money and numbering; end-to-end tests for the
   public routes, login and expense approval.
4. Re-run `npm run parity` after the phase 8 content migration.

## Deployment

- **Platform**: Hostinger Node.js web app
- **Status**: running locally on port 3000, verified by curl
- **Last updated**: 2026-09-02
