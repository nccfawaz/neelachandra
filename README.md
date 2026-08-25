# Neelachandra Construction and Interiors: Platform

Repository for the full-stack rebuild of Neelachandra Construction and Interiors: the public marketing site at `neelachandra.com` plus an internal staff platform, in one codebase, one Node process, one domain.

**Status: specification complete, phase 0 tooling built and executed. No application code yet.**

## What is in this repository right now

| Path | Purpose |
|---|---|
| `NCC_BUILD_SPEC.md` | The complete implementation specification. Read this first and read it fully before writing code. |
| `legacy/golden/` | **The design of record.** Rendered HTML, infrastructure files and screenshots captured from the live site on 2026-08-24, with SHA-256 per file in `manifest.json`. Irreplaceable, see below. |
| `legacy/CONTENT-QUERIES.md` | Content problems found on the live site, recorded rather than silently fixed. CQ-1 is a live SEO and consumer-protection risk and needs a decision. |
| `scripts/capture-golden.mjs` | Captures the golden masters. Already run; re-run immediately before cutover. |
| `scripts/parity-check.mjs` | The freeze gate. Compares a candidate render against the golden masters on six HTML axes plus pixels at three viewports. |
| `scripts/selftest-parity.mjs` | Proves the gate actually catches violations. 16 mutation cases. |
| `scripts/lib/` | `pages.mjs` (the canonical page list) and `normalise.mjs` (the comparison logic). |

```bash
npm install                 # playwright, pngjs, pixelmatch
npx playwright install chromium
npm run parity:selftest     # verify the gate works: expect 16 passed, 0 failed
npm run parity -- --candidate=https://staging.neelachandra.com
```

The gate is verified working: it passes 10/10 against the live site with no
false positives, and its self-test passes 16/16. Two real bugs in its own
first implementation were caught by that self-test, so run it in CI.

## Start here

`NCC_BUILD_SPEC.md` is the single source of truth for this build. Its eight sections are:

1. **Repository findings** with what the current PHP site actually is, verified against the live server
2. **Recommended tech stack** with the reasoning tied to real hosting constraints
3. **Unified codebase folder and file structure** including the design-freeze enforcement in section 3.2
4. **Role and permission model** across all eight modules
5. **Build and phasing plan**, phases 0 through 9, each with an explicit gate
6. **Per module specifications** with tables, fields, routes and business logic
7. **Data migration plan** from the current static site
8. **Open questions** that need answers from the business

## Two constraints that will cost you if you miss them

**The public site design and content are frozen.** The public work is a rendering-engine swap from PHP to `hono/jsx`, not a redesign and not a copy rewrite. Only three narrow categories of change are permitted and they are listed at the top of the specification. Section 3.2 defines the parity gate that enforces this mechanically, and section 1.8 gives a per-defect verdict on what may and may not be touched.

**Phase 0 step 1a is time-critical and irreversible if missed. The first half is now done.** Deploying a Node.js app to a domain that already hosts a website on Hostinger requires removing that website first, and the removal destroys files, databases and email permanently. The golden-master capture in `legacy/golden/` has been taken and committed, so the design and content reference now exists outside that hosting account. Re-run `npm run capture:golden` immediately before cutover to pick up anything the client changes in the meantime.

Still outstanding and still mandatory: **the full `public_html` archive** in specification section 7.2. The old repository is a partial flattened dump with no `includes/`, `assets/`, `css/` or `js/` directories even though every page references them, so the site cannot be rebuilt from git alone. Nobody should touch the hosting panel until that archive exists and has been verified restorable.

### One live risk found while capturing

`legacy/CONTENT-QUERIES.md` CQ-1: five pages emit an `aggregateRating` claiming **four different review counts for the same business** (2, 4, 4, 30 and 87, all at 4.8 stars). The old repository's README said this markup had been removed, which is what the specification originally recorded; capturing the live pages disproved it. Contradictory self-serving review markup is the pattern Google issues manual actions for, and it is a Consumer Protection Act exposure independently of Google. The freeze means the port reproduces it exactly and the gate asserts that, so **this does not block the build**, but it is live on a site that ranks and it needs a decision. See specification section 8.5.

## Target stack

Decided in section 2 of the specification, driven by the Hostinger constraints in section 1.9.

- Node.js 22 LTS, Hono 4, `@hono/node-server`
- `hono/jsx` server rendering, htmx 2 and Alpine.js 3 self-hosted, Chart.js on dashboard pages only
- MariaDB via `mysql2/promise` and Kysely 0.27
- Self-hosted session cookie auth, argon2id, TOTP for privileged roles
- Hosting: Hostinger Business or Cloud, Node.js Web App, GitHub push-to-deploy

Not Cloudflare Workers, not Postgres, not Prisma. Section 2 gives the reasoning for each, including what was given up.

## Modules

Public marketing site, then eight internal modules under `/app`: authentication, admin, projects tracker, inventory, marketing, HR and recruiting, sales and CRM, budget and expense tracker. Build order and the dependency reasoning behind it are in section 5. It is not the order they are listed in.

## Before implementation starts

Section 8 holds the open questions. These block the phases named against them:

| Question | Blocks |
|---|---|
| 8.1 Roles and actual org chart | Phase 2 |
| 8.2 Approval limits per role and document type | Phase 7 |
| 8.3 Stage templates and payment milestones | Phase 3 |
| 8.4 Material consumption norms | Phase 4 |
| 8.7 Offline capability for site staff | Decide before phase 3 |
| 8.11 Hosting plan specifics | Phase 0 |

8.7 is the one most easily missed. If site supervisors need to file reports without signal, idempotency keys have to be in the API from the first route rather than retrofitted, so the answer changes phase 3 architecture.

## Note on the sandbox scaffold

A Cloudflare Pages starter (`wrangler.jsonc`, `vite.config.ts`, `src/index.tsx`, `public/static/`) exists in the working directory as an artefact of the environment the specification was authored in. It is deliberately **not tracked in this repository**, because Cloudflare Workers contradicts the Hostinger target in section 2 and a stray `wrangler.jsonc` would send an implementer down the wrong path. Ignore it if you see it locally.
