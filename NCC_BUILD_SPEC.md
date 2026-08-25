# Neelachandra Construction and Interiors: Full-Stack Platform Build Specification

Target repository: `github.com/nccfawaz/neelachandrainteriors`
Target host: Hostinger Business/Cloud (Node.js Web App), domain `neelachandra.com`
Audience: implementing developer or Claude Code agent

**Binding constraint on the public site: the existing design and the existing page content do not change.** Every public page keeps its current layout, CSS, typography, spacing, imagery, wording, headings, and page order exactly as it renders today. The public work in this document is a rendering-engine swap from PHP includes to `hono/jsx`, not a redesign and not a copy rewrite. Where this document names a change to a public page, it is limited to one of three categories, and nothing else qualifies:

1. **Invalid markup that the browser is already error-correcting** (the `<34` tag, the nested `<style>`, the second `<head>`). Fixing these produces the same rendered result from valid source. If a fix would move a pixel, the invalid markup is ported as is instead and the discrepancy is recorded.
2. **Non-page infrastructure files** that are not visible page content: `site.webmanifest` icon paths that 404, and `robots.txt`, which is currently the interiors site's file and points this domain's sitemap directive at another domain (CQ-2).
3. **Making a dead form work.** The enquiry handler gains a real destination. Its visible fields, labels, order and copy stay as they are in `contact-form.php`.

Copy edits, price changes, new sections, removed sections, restyling, font substitution, image replacement, and reordering are all out of scope. Where I found content that is factually unsupported or legally risky, it is preserved as is and raised in section 8 for your decision rather than altered.

---

## 1. Repository findings

Inspected commit `c40249d` on `main` (the repo has exactly 3 commits, all titled "Add files via upload", so there is no meaningful history to bisect). 111 tracked files, all at the repository root, no subdirectories, no `package.json`, no `.gitignore`, no build tooling, no CI.

### 1.1 What the stack actually is

Hand-written PHP 8 with no framework, no router, and no autoloader. Verified live: `curl -I https://neelachandra.com/` returns `x-powered-by: PHP/8.4.19`, `platform: hostinger`, `server: hcdn`. Every page is a standalone `.php` file that emits its own complete `<!DOCTYPE html>` and its own `<head>`, with a few shared fragments pulled in by `include`.

### 1.2 The repository does not match the server layout

This is the single most important finding and it blocks any naive "clone and refactor" approach.

Twelve pages contain lines of the form:

```php
<?php include $_SERVER['DOCUMENT_ROOT'] . '/includes/top-social.php'; ?>
<?php include $_SERVER['DOCUMENT_ROOT'] . '/includes/header.php'; ?>
```

There is no `includes/` directory in the repository. `header.php`, `footer.php`, `footer-sub.php`, `top-social.php`, `floating-buttons.php` and `contact-form.php` sit loose at the root instead.

Similarly, every page references images as `/assets/images/home/hero1.webp`, `/assets/images/header/logo.svg`, `/assets/images/packages/silver.svg` and so on. There is no `assets/` directory in the repository. The image files are dumped flat at the root as `hero1.webp`, `logo.svg`, `silver.svg`.

The live server has the real structure: `https://neelachandra.com/assets/images/header/logo.svg` returns HTTP 200 with 19548 bytes, byte-identical in size to the root-level `logo.svg` in the repo. Also missing from the repo but referenced or implied on the server: `css/`, `js/`, `blog/`, `favicon/` (the live homepage links `/favicon/site.webmanifest` while the repo has `site.webmanifest` at root).

Consequence: the repo is a flattened, partial dump of `public_html`, not a source tree. **A full SSH or File Manager backup of `public_html` is mandatory before any change**, because the repository alone cannot reconstruct the running site.

### 1.3 Two different websites are mixed in one repository

The files split into two mutually inconsistent families.

**Family A, the construction site (`neelachandra.com`), the actual subject of this build:**

| File | Lines | Route (extensionless) |
|---|---|---|
| `index.php` | 1207 | `/` |
| `best-construction-company-in-bengaluru-projects.php` | 1045 | `/best-construction-company-in-bengaluru-projects` |
| `about-us.php` | 925 | `/about-us` |
| `construction-company-in-tumkur.php` | 826 | `/construction-company-in-tumkur` |
| `construction-packages-in-bengaluru.php` | 587 | `/construction-packages-in-bengaluru` |
| `construction-services-in-bengaluru.php` | 529 | `/construction-services-in-bengaluru` |
| `best-construction-company-in-bengaluru.php` | 497 | `/best-construction-company-in-bengaluru` |
| `error.php` | 406 | error handler, `?code=NNN` |
| `contact-us.php` | 239 | `/contact-us` |
| `coming-soon.php` | 184 | `/coming-soon` (excluded from sitemap) |
| `privacy-policy.php` | 99 | `/privacy-policy` |
| `terms.php` | 82 | `/terms` |
| `sitemap.php` | 100 | serves `/sitemap.xml` |
| `indexnow-submit.php` | 231 | IndexNow submitter |

These use the `$_SERVER['DOCUMENT_ROOT'] . '/includes/...'` convention.

**Family B, the interiors site (`neelachandrainteriors.com`), a different domain:**

`about.php` (467), `contact.php` (370), `process.php` (352), `contact-form.php` (171), `enquiry-handler.php` (272). These use `include __DIR__ . '/header.php'` instead, declare `$page_class = 'neelachandra-interiors-about'`, reference `css/style.css`, `css/pages.css`, `js/main.js` and `images/*.webp` (none of which are in the repo), and carry different contact details: `studio@neelachandrainteriors.com`, `careers@neelachandrainteriors.com`, `+91 80 4718 2200`, WhatsApp `919845102200`.

`README.md` (465 lines) documents Family B only. It describes an "Architectural Elegance" design system, a 10-project filterable portfolio, `$NC_PROJECTS` / `$NC_SERVICES` / `$NC_STAGES` arrays, and page routes `/about.php`, `/services.php`, `/process.php`, `/portfolio.php`, `/contact.php`. **`services.php` and `portfolio.php` do not exist in the repo.** So `README.md` is not documentation for `neelachandra.com` and must not be treated as the spec for this build. `README.txt` (76 lines) is unrelated to `README.md`: it documents the dynamic sitemap install steps for `neelachandra.com`.

`robots.txt` in the repo is also the interiors file. Its last line reads `Sitemap: https://neelachandrainteriors.com/sitemap.xml`, the wrong domain for this repository.

### 1.4 Form handling is broken in three different ways

There are three separate, conflicting enquiry mechanisms.

**(a) `contact-us.php`, the one actually live.** Verified on `https://neelachandra.com/contact-us`: `<form class="contact-form" method="post" action="#email-form" id="email-form">`. Self-POSTs, sanitises with `filter_var(..., FILTER_SANITIZE_FULL_SPECIAL_CHARS)`, runs a regex header-injection guard, then calls PHP `mail()` to `nccpmd@gmail.com`. No CSRF token, no honeypot, no rate limit, and critically **no persistence: every enquiry exists only as an email in one Gmail inbox**.

**(b) `enquiry-handler.php` plus `contact-form.php`, well built but wired to nothing on this domain.** The handler is genuinely good work: CSRF with `hash_equals` and token rotation on success, a `nc_website` honeypot that answers with a silent fake success, an `nc_started` time trap rejecting sub-3-second submissions, field validation, a `nc_is_header_safe` CRLF guard, and POST/Redirect/GET with a 303. Its delivery function is a switch on `NC_ENQUIRY_DELIVERY`, currently `define('NC_ENQUIRY_DELIVERY', 'log')`, appending fixed-format records to `enquiries.log`, with an explicit `TODO` for SMTP, CRM webhook or database insert.

Its own docblock states: "header.php requires it on line 1 for exactly that reason, do not move the require lower." **`header.php` does not contain the string `enquiry-handler` at all** (verified: `grep -c` returns 0). Meanwhile `index.php` line 1044 does `include $_SERVER['DOCUMENT_ROOT'] . '/includes/contact-form.php';`. So on the homepage the form markup renders, but the handler never loads, `nc_csrf_token()` falls back to the defensive stub in `contact-form.php` that returns `''`, and the POST is never processed. The homepage enquiry form is dead. Its `$NC_PROJECT_TYPES` are interiors values anyway (`Villa Interiors`, `Modular Kitchen & Wardrobes`), wrong for a construction enquiry.

**(c) A newsletter subscribe block** in `footer-sub.php` with styling only, no handler.

### 1.5 Routing, and a hazard for the Node migration

`.htaccess` is committed as an extensionless file literally named `download` (47 lines, CRLF). Contents that matter:

```apache
RewriteEngine On
ErrorDocument 400 /error.php?code=400   # ... through 505, 30 directives
RewriteRule ^sitemap\.xml$ sitemap.php [L]
RewriteCond %{THE_REQUEST} \s/+(.+?)\.php[\s?] [NC]
RewriteRule ^ %1 [R=301,L]
RewriteCond %{REQUEST_FILENAME} !-d
RewriteCond %{REQUEST_FILENAME}.php -f
RewriteRule ^(.+?)/?$ $1.php [L]
```

So the canonical URL scheme is extensionless, with a hard 301 from `/page.php` to `/page`. Every canonical tag, the sitemap, the IndexNow log and Search Console all use extensionless URLs. This must be preserved exactly.

The hazard: Hostinger's Node.js deployment **generates and overwrites `public_html/.htaccess`** to proxy into `/home/{user}/domains/{domain}/nodejs`. Custom rewrite and ErrorDocument rules placed there will be lost on redeploy. All of the above logic therefore has to move into application middleware, not `.htaccess`.

### 1.6 SEO surface that must survive

- `sitemap.php` holds a hardcoded `$staticPages` array of exactly 10 paths with priority and changefreq (`/` 1.00 weekly, `/construction-services-in-bengaluru` 0.90 monthly, `/construction-packages-in-bengaluru` 0.90 monthly, `/best-construction-company-in-bengaluru-projects` 0.80 weekly, `/best-construction-company-in-bengaluru` 0.90 monthly, `/construction-company-in-tumkur` 0.90 monthly, `/about-us` 0.70 monthly, `/contact-us` 0.80 monthly, `/terms` 0.30 yearly, `/privacy-policy` 0.30 yearly). It also globs `/blog/*.php`, a directory that does not exist yet. `lastmod` comes from `filemtime()`, which will break the moment PHP files stop existing.
- `indexnow-submit.php` hardcodes `$indexNowKey = '097ee841c58a4b25b8eb2c348ca67dce'`, verifies the key file at `https://neelachandra.com/097ee841c58a4b25b8eb2c348ca67dce.txt` (that file is in the repo, containing exactly the key), posts to `api.indexnow.org`, and appends to `indexnow-log.txt`. The log shows real runs on 2026-07-22 (HTTP 202) and 2026-07-23 (HTTP 200), always the same 10 URLs.
- GA4 tag `G-QX0C128DKX` is hardcoded in `header.php`.
- Google Search Console verification file `google9706eb5d9d6a7b15.html`.
- Extensive JSON-LD `@graph` blocks inline in every page: `LocalBusiness`, `GeneralContractor`, `HomeAndConstructionBusiness`, `WebSite`, `WebPage`, `BreadcrumbList`, `FAQPage`, `ItemList` with 7 `CreativeWork` project nodes, `Offer` nodes for the 4 packages, `areaServed` of Bengaluru, Nelamangala, Tumakuru, Doddaballapura, Karnataka, and a 10-entry `knowsAbout` list.
- `llms.txt` (55 lines) and `llms-full.txt` (544 lines) hand-maintained AI-crawler summaries. They already document content gaps: the Interiors page and a Commercial Construction page are flagged as "full page content not yet available".
- `humans.txt`, `security.txt`. Verified from the live capture: `security.txt` is served **correctly** at `/.well-known/security.txt` (197 bytes) and the root path 404s, so RFC 9116 placement is already satisfied and there is nothing to move. Its `Canonical` line agrees. Two minor issues remain: its second contact line names `https://neelachandra.com/contact`, which is not a live path on this site (3.1 rule 2 301s it to `/contact-us`), and `Expires: 2027-07-13` will need renewing. Recorded as CQ-3.

### 1.7 Business data currently hardcoded in markup

There is no database anywhere in the project. All of the following lives as literal HTML and JSON-LD, duplicated between the visible accordion and the schema block, which is exactly why drift is already visible between pages:

- **Packages:** Silver Rs 2,299/sqft, Platinum Rs 2,699/sqft, Gold Rs 3,099/sqft (marked most popular), Diamond Rs 3,499/sqft. Worked examples: 1,200 sqft to roughly Rs 27 to 42 lakh; a 30x40 G+1 at Gold to Rs 55 to 62 lakh.
- **7 featured projects** with structured attributes already modelled as `PropertyValue` pairs (Built-up Area, Project Type, Scope of Work, Client Sector, Delivery Status, Compliance Standards): Excellence Technologies Phase 02, 8,000 sqft, Janhavi Industrial Estate. Recipharma machine foundation, T Begur, vibration tolerance engineering. Honda Cars India civil and structural, KIADB Doddaballapura, OEM material traceability. VRL Automation, 40,000 sqft multi-phase, Janhavi. Mandot Steel, 85,000 sqft, Mantankurchi Village. Nambiar Builders Ellegenza, 30 acre villa community, Hosur/Sarjapur Road. Capstone Life Circular Reflections, Sarjapura Road.
- **Developer partners named:** Godrej Properties, Salarpuria Sattva, Casagrand, Nambiar Builders, Capstone Life, plus logo assets `nambiar.webp`, `capstone.webp`, `marvel.webp`, `primex.webp`, `dev.webp`.
- **6 services:** architecture and structural civil engineering, landscape construction and garden design, structural waterproofing and sealing, renovation and remodeling, construction equipment and machinery rental, construction consultation and specialist assistance. The rental fleet is enumerated: excavators and earth-moving, concrete mixers and batching support, tower cranes and material handling, compactors and road work machinery, scaffolding systems, generators and power backup, site logistics.
- **Team of 4:** Chandrashekar T (Founder), Naveen Kumar (Technical Advisor in `index.php` JSON-LD, "Chief Technical Advisor (Construction)" in `humans.txt`), Sushma N (Operations Analyst), Vinay (Procurement Lead). `llms.txt` additionally names a "Roshan (Project Manager)" who appears nowhere in the markup.
- **Delivery process, 4 stages:** Consult and Plan (dedicated Project Coordinator, site visit, soil test, initial drawings), Design and Approve (2D plans, 3D elevations, structural drawings, signed agreement, price locked), Build and Update (weekly progress reports with site photos, "24x7 live site access"), Handover and Move In (quality walkthrough, keys, warranty documents, compliance certificates, as-built drawings).
- **Payments:** milestone based across "10 to 12 stages tied directly to physical site progress: footing completion, plinth level, individual slab castings, plastering".
- **Approvals:** BBMP, BMRDA, Gram Panchayat plan sanction; BESCOM electricity; BWSSB water and sewerage; statutory fees paid directly by the owner. Tumkur page adds TUDA.
- **Quality regime:** mandatory soil test, slump test before every pour, 7-day and 28-day cube compressive strength at certified third-party labs, reports handed to client.
- **Materials, brand-specified:** cement UltraTech / ACC / Birla Super OPC 53 Grade; TMT steel JSW Neo / Tata Tiscon / Indus in Fe500D or Fe550D; tiles Kajaria or Somany vitrified; sanitaryware Jaquar or Hindware; wiring Finolex; switches Havells or Legrand or Anchor; waterproofing Fosroc and Dr. Fixit; paint Asian Paints and SmartCare. Also underground sump, branded overhead tank, BBMP-compliant rainwater harvesting, anti-termite treatment.
- **Warranty:** 10-year structural (foundations, columns, beams, slabs) plus 1-year on waterproofing integrity, plumbing and electrical fixtures.
- **Timeline:** G+1 or G+2 in 10 to 14 months. Minimum residential plot 600 sqft.
- **Contact:** `#193/1c NH-4, Near Harsha Hospital, Byraveshwara Nagara, Nelamangala, Karnataka 562123`. Phone `+91 78292 92929` (also the WhatsApp number), landline `+91 8029652243`, email `nccpmd@gmail.com`, hours Mon to Sat 09:30 to 19:00. Founded 2018 by Chandrashekar T. Claims of 30+ projects, 60+ acres, 8+ years, 4.8 of 5.0 rating.
- **Social:** Facebook `profile.php?id=61570692116172`, Instagram `neelachandra_construction`, LinkedIn `neelachandra-constructions`, YouTube `@neelachandra_constructions`, X `neelachandra_`, two Google Maps short links.

### 1.8 Defects found, and which of them may be touched

Listed because an implementer needs to know they exist, not because all of them get fixed. The design and content freeze means most are ported as they are. The verdict column at the end of each item is binding.

1. `index.php` line 1022 contains `<34 class="accordion-heading">`, a corrupted opening tag closed by `</h3>`. Live invalid markup. **Fix.** Browsers currently parse this as an unknown element, so it inherits no `h3` styling. Emitting a valid `h3` would therefore change how the accordion heading looks. The port emits the element the browser actually renders today, an unknown inline element carrying `class="accordion-heading"`, which in `hono/jsx` is written as a `<span class="accordion-heading">` only if the computed styles match. Verified against the live page in the parity check of 5, phase 1. If they do not match, the raw string is emitted verbatim through `dangerouslySetInnerHTML`. Visual parity wins over markup validity.
2. `header.php` opens a `<style>` block that immediately contains a second nested `<style>`, and emits a full `<head>` even though it is included from inside `<body>` (for example `index.php` line 716). Every page therefore ships two `<head>` blocks. **Fix.** The second `<head>` is discarded by the parser and its contents are relocated into `<body>`, so consolidating to one `<head>` is safe. The nested `<style>` terminates the first at the inner tag, meaning some declarations are currently live and some are being parsed as text. Both variants are diffed in the parity check and whichever matches the live computed style is kept.
3. `site.webmanifest` icon paths are `"/favicon.ico/web-app-manifest-192x192.png"`, treating a file as a directory. Both icons 404. **Fix.** Category 2, not page content.
4. `og.webp` is 1,091,756 bytes and `Favicon.png` is 675,879 bytes. Both are served on the homepage path. **Port as is.** Re-encoding changes an image the client approved. Raised in 8.12.
5. Duplicate and near-duplicate assets: `maps.webp` and `maps (3).webp` (identical 10672 bytes), `excellence.webp` and `exellence.webp`, `hero (1).webp`, `hero (2).webp`, `hero (4).webp`, `hero (5).webp`, `hero.webp`, `hero1.webp`, `hero-mobile.webp`, `Favicon.png` and `Favicon.webp` and `favicon.svg` and `favicon.ico` and `favicon-96x96.png` and `32_32.png` and `48_48.png` and `180_180.png` and `192_192.png`. **Port all of them, at their current paths.** An unreferenced file costs disk and nothing else. A file I judged unreferenced but which is hotlinked, cached, or used by a page I have not seen becomes a 404. Deletion is deferred to phase 9 and only for files the access log shows zero hits on over 30 days.
6. Filenames containing spaces and parentheses, which are fragile behind rewrite rules. **Port as is,** at the same paths, URL-encoded in `src` attributes exactly as the PHP does today. Renaming breaks any external reference and changes the HTML.
7. Every page inlines its own multi-thousand-line `<style>` block with a duplicated CSS reset, and each page loads a different Google Fonts family set (compare the font query strings in `index.php`, `construction-packages-in-bengaluru.php` and `contact-us.php`). Font Awesome 6.5.2 is pulled from cdnjs on some pages only. **Port as is, per page.** This is the single biggest temptation to consolidate and the single biggest way to break the design. The per-page font sets and per-page CSS are why the pages look the way they do, including where they are inconsistent with each other. Each page's `<style>` block is extracted to its own file, byte for byte, and linked only from that page. See 3.2.
8. `about-us.php` and `about.php` are two different About pages for two different brands, both in one directory. Same for `contact-us.php` and `contact.php`. **Not a defect to fix, a scoping fact.** The `about.php` and `contact.php` pair belong to the interiors brand and are archived, not ported, because they are not part of this domain's live site.
9. `header.php` navigation links "Interiors" to the external `https://neelachandrainteriors.com`, while `coming-soon.php` exists locally as an unused placeholder for the same slot. **Port as is.** The nav link keeps its current external target.
10. **The `4.8 / 5.0` rating IS emitted in schema on five pages, with four contradictory review counts.** `README.md` claims `aggregateRating` was deliberately removed; the captured live HTML disproves that. Verified from `legacy/golden/`: `/construction-packages-in-bengaluru` says `reviewCount` 2, `/about-us` says 4, `/construction-services-in-bengaluru` says 4, `/best-construction-company-in-bengaluru` says 30, `/construction-company-in-tumkur` says 87, all at `ratingValue` 4.8. The other five pages emit no rating node. The rating is also rendered as visible text and as images (`rating.webp`, `stars.webp`). There is no source of record for any of the figures. **Port as is, unchanged, including the disagreement, and the parity gate asserts it.** Removing it is a content edit. But this is the highest-risk item found in the whole inspection: four different review counts for one business is the pattern Google issues manual actions for, and it is a Consumer Protection Act exposure independently of Google. Recorded as CQ-1 in `legacy/CONTENT-QUERIES.md` and raised in 8.5. Not acted on without your instruction.

### 1.9 Hostinger platform constraints verified against vendor documentation

These drive the stack section and are not assumptions:

- Node.js Web Apps are available on Business and Cloud plans. Supported Node versions 18, 20, 22, 24. **Hono is on the officially supported backend framework list**, alongside Express, NestJS, Fastify, Next, Nuxt, Nitro, SvelteKit.
- **MySQL only.** Hostinger documentation states plainly that "other database engines (PostgreSQL, MongoDB, etc.) are not supported on shared or managed hosting plans", and that Web/Cloud plans run MariaDB. Host is `localhost`, port 3306.
- **The app process sleeps.** "After a period without incoming traffic, your app's process is stopped automatically to free up server resources. The next request starts it again." Crashes auto-restart.
- Backend build output lands in `/home/{username}/domains/{domain}/nodejs`, and `/home/{username}/domains/{domain}/public_html/.htaccess` is auto-created and regenerated to route into it.
- A server app requires an explicit entry file ending in `.js`, `.mjs` or `.cjs`.
- Environment variables are set in hPanel, stored encrypted, injected into both build and runtime, capped at 1,000 per app, keys `[A-Z0-9_]` only. Saving them triggers a redeploy.
- GitHub push-to-deploy is supported, one GitHub account per hosting plan.
- `npm` commands cannot be run over SSH on Business and Cloud plans; only the build script chosen in hPanel runs.
- **Deploying a Node.js app to a domain that already has a website requires removing that website first**, and removal is irreversible and destroys files, databases and email. This dictates the cutover plan in section 7.
- Cron jobs are available in hPanel.

---

## 2. Recommended tech stack

Every choice below is argued against the four constraints that actually apply: Hostinger managed Node.js with a sleeping process, MySQL only, ten internal users, and one codebase shared with a live SEO-critical marketing site.

### 2.1 Runtime and framework: Node.js 22 LTS + Hono 4 + `@hono/node-server`

Hono is on Hostinger's supported list, so framework auto-detection and the managed start command work without fighting the platform. The decisive reason over Express is the documented sleep behaviour: the first request after an idle period pays a full cold start, and Hono's router plus a minimal dependency tree keeps that measurable rather than noticeable. Express would work; it simply adds middleware weight and a heavier `require` graph for no benefit at this scale.

Tradeoff, stated plainly: Hono's third-party middleware ecosystem is much smaller than Express's. For this build that costs almost nothing because the security-sensitive middleware (RBAC, CSRF, rate limit, audit) is written in-house anyway, and the rest (`hono/logger`, `hono/secure-headers`, `hono/compress`, `hono/jsx`) ships in core.

Not chosen and why: **Next.js** would drag a second rendering model, a `.next` build artifact, React hydration and a much larger cold start into a project whose public pages are pure content and whose dashboard has ten users. **NestJS** brings decorators, DI and a module system sized for a team, not for one developer maintaining a marketing site in the same tree.

### 2.2 Public site rendering: Hono JSX, server-rendered, zero client bundle

`hono/jsx` renders to a string on the server. The marketing pages keep exactly the SEO characteristics they have today (full HTML in the first response, JSON-LD emitted server-side) with none of the current copy-paste duplication. No React runtime is shipped to visitors.

Concretely this replaces `header.php` / `footer.php` / `top-social.php` / `floating-buttons.php` / `footer-sub.php` with `src/public/layouts/SiteLayout.tsx` plus components, and replaces the per-page inline `<style>` blocks with two static stylesheets served from `public/assets/css/`.

Tradeoff: JSX means a build step where PHP had none, so "edit a file over FTP and refresh" stops working. That is intentional; that workflow is what produced the `<34 class=...>` bug and the duplicated `<head>`.

### 2.3 Dashboard interactivity: server-rendered HTML + htmx 2 + Alpine.js 3, both from `public/assets/vendor/`

The dashboard is form-heavy CRUD with tables, filters and approvals. htmx handles partial swaps (a table row updating after an approval, a filter re-rendering a tbody) by returning HTML fragments from the same Hono routes. Alpine covers local UI state (modals, tabs, dependent selects). Chart.js is added only on the dashboard pages that need charts, never on marketing pages.

Why not a React/Vue SPA: it would require a second build target, a JSON API surface duplicating every server-rendered view, and client-side auth handling, to serve ten people on Indian mobile networks visiting from construction sites. Server-rendered HTML with partial swaps is both less code and faster on a bad 4G connection.

Tradeoff: no optimistic UI, no offline capability. If site supervisors genuinely need to file daily progress reports with no connectivity, that is a different architecture (local-first with sync) and is raised as an open question in section 8, not silently designed around.

Vendor files are self-hosted rather than CDN-loaded so that a blocked CDN cannot break internal tooling, and so the dashboard has no third-party runtime dependency.

### 2.4 Database: MariaDB via `mysql2/promise` + Kysely 0.27 query builder

MySQL/MariaDB is not a preference, it is the only engine Hostinger supports on this plan. The alternative would be Supabase Postgres over the network (Hostinger even ships a connect wizard for it), which adds cross-region latency to every query and a second provider to the failure domain, in exchange for Postgres features this application does not need.

`mysql2/promise` connection pool with `connectionLimit: 5`. Deliberately small: shared hosting caps concurrent MySQL connections and the app is stopped when idle anyway, so a large pool only wastes the allowance.

Kysely for typed SQL. Chosen over Prisma specifically because Prisma ships a native query engine binary that must match the platform's `binaryTarget`, adds tens of megabytes to the deployment and adds real cold-start cost. Kysely is pure TypeScript at runtime and compiles to plain SQL, which also means every query in the codebase is reviewable as SQL.

Tradeoff: no generated migrations. Migrations are hand-written SQL in `migrations/NNN_name.sql`, applied by `scripts/migrate.mjs` which tracks applied files in a `schema_migrations` table. On Hostinger these are run either from the hPanel cron entry described in 2.9 or manually via phpMyAdmin for the first release.

MariaDB specifics to write into the code: `InnoDB`, `utf8mb4` with `utf8mb4_unicode_ci`, `DECIMAL(14,2)` for all money (never `FLOAT`), `DATETIME(3)` with `DEFAULT CURRENT_TIMESTAMP(3)`, no reliance on `RETURNING` (use `insertId`), and no reliance on Postgres-style partial indexes or `JSONB` operators. Where JSON is genuinely the right shape (for example a snapshot of quotation inclusions at the moment of sending), use a `JSON` column plus a generated column with an index if it must be queried.

### 2.5 Authentication: self-hosted session cookies, argon2id, sessions in MySQL

- Password hashing: `@node-rs/argon2` with argon2id, `memoryCost 19456, timeCost 2, parallelism 1` (the OWASP baseline). It ships prebuilt binaries, so no compiler is needed at build time. Fallback if the prebuilt binary is rejected by the Hostinger builder: `bcryptjs` at cost 12, pure JS, slower but portable. Verify on first deploy and record which one is in use.
- Sessions: opaque 32-byte random id from `crypto.randomBytes`, sent as cookie `ncc_sid`, stored in the `user_sessions` table as a SHA-256 hash so a database dump does not yield usable session tokens. Cookie flags `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200` (12 hours), rolling renewal on activity.
- **This is a platform-driven decision, not a stylistic one.** An in-memory session store would silently log every user out each time Hostinger stops the idle process. Storing sessions in MySQL is what makes sessions survive process sleep.
- Not JWT: with ten staff and role changes happening in person, the ability to revoke instantly (delete the session row, deactivate the user) matters more than statelessness. There is no second service to federate to.
- Not Auth0/Clerk: there is no client portal, no external user base and no social login requirement, so an external identity provider adds a monthly cost, a network dependency and a second user directory for zero functional gain.
- 2FA: TOTP via `otplib`, optional per user, enforced for the roles that can move money (`owner`, `admin`, `accounts_manager`). Recovery codes stored hashed.
- CSRF: own middleware, per-session token in `user_sessions.csrf_token`, required as a hidden `_csrf` field on every non-GET form and as the `X-CSRF-Token` header on htmx requests. Rejection returns 403 without leaking whether the session or the token was the problem.
- Login throttling: `login_attempts` table keyed on email and IP, exponential lockout after 5 failures in 15 minutes. DB-backed rather than in-memory for the same sleep reason as sessions.
- Password policy: minimum 12 characters, checked against a bundled list of the 10,000 most common passwords, no composition rules, no forced rotation.

### 2.6 Validation: Zod at every route boundary

One schema per route input in `src/modules/<module>/schemas.ts`, parsed before any business logic. Failures render the form again with field-level errors for HTML requests and return a 422 JSON body for htmx requests. Zod is also the single source of truth for allowed enum values, so the drift seen today between the visible package list and the JSON-LD offer list cannot recur.

### 2.7 File storage: two locations, chosen by sensitivity

Deployment replaces the application directory, so nothing user-uploaded may live inside it.

- **Public files** (project photos intended for the website, logos): `/home/{user}/domains/neelachandra.com/public_html/uploads/YYYY/MM/`. Served directly by Apache, which is faster than streaming through Node and survives Node redeploys because build output goes to the sibling `nodejs` directory.
- **Private files** (vendor bills, client invoices, candidate resumes, statutory employee documents, lab test reports): `/home/{user}/domains/neelachandra.com/private_uploads/`, **outside the web root**, never directly reachable. Served only through `GET /app/files/:id` which checks the session, the permission and the row-level scope before streaming with `Content-Disposition: attachment`.

Every upload is recorded in a `stored_files` table (see 6.2) with the storage area, relative path, original filename, MIME type, size, SHA-256 checksum and uploader. Filenames on disk are generated UUIDs; original names live only in the database, which removes path traversal and encoding problems in one step.

Upload handling: `hono/body-limit` at 15 MB, MIME sniffing on the first bytes rather than trusting `Content-Type`, an allowlist of `image/jpeg`, `image/png`, `image/webp`, `application/pdf`. No server-side image processing in phase 1, because `sharp` needs a matching native binary on the build platform and is a redeploy risk. Photos are downscaled in the browser with a canvas before upload (`src/dashboard/assets/js/image-resize.js`), capped at 2000 px on the long edge.

Open risk to flag now rather than later: if the hosting plan is ever migrated or the domain rebuilt, these directories are not part of the git repository. A weekly cron `tar` of `private_uploads` into the hPanel backup area is included in 2.9.

### 2.8 Email: Nodemailer over authenticated Hostinger SMTP

`smtp.hostinger.com:465` with implicit TLS, authenticating as a real mailbox on the domain, for example `system@neelachandra.com`. This replaces PHP `mail()`, which currently sends unauthenticated from `website@$SERVER_NAME` and depends on the domain's SPF alignment holding by luck.

Uses: enquiry notifications to sales, password reset, expense approval requests, low stock alerts, weekly client progress emails. Every send is logged in `email_log` with the template key, recipient, related record and provider response, so "the client says they never got it" is answerable.

### 2.9 Scheduled work: hPanel cron hitting authenticated internal routes

There is no Redis and no worker process on this plan, and a `setInterval` inside the app would stop when the process sleeps. Instead, hPanel cron entries call the app over HTTP with a shared secret header, which also has the useful side effect of waking the process:

```
*/15 * * * *  curl -fsS -H "X-Cron-Key: $CRON_SECRET" https://neelachandra.com/internal/cron/notifications
5 1 * * *     curl -fsS -H "X-Cron-Key: $CRON_SECRET" https://neelachandra.com/internal/cron/daily-rollup
15 1 * * *    curl -fsS -H "X-Cron-Key: $CRON_SECRET" https://neelachandra.com/internal/cron/stock-alerts
30 1 * * *    curl -fsS -H "X-Cron-Key: $CRON_SECRET" https://neelachandra.com/internal/cron/document-expiry
0 2 * * 1     curl -fsS -H "X-Cron-Key: $CRON_SECRET" https://neelachandra.com/internal/cron/weekly-client-updates
0 3 * * *     tar -czf ~/backups/private_uploads_$(date +\%F).tar.gz ~/domains/neelachandra.com/private_uploads
```

`/internal/cron/*` compares `X-Cron-Key` against `process.env.CRON_SECRET` with `crypto.timingSafeEqual`, is excluded from the session middleware, and writes to `cron_run_log`. Every run is idempotent, keyed on the date it processes, because cron on shared hosting does occasionally double-fire.

### 2.10 Security specifics, named

- `hono/secure-headers` with `contentSecurityPolicy`: `default-src 'self'`, `script-src 'self' https://www.googletagmanager.com`, `style-src 'self' https://fonts.googleapis.com`, `font-src 'self' https://fonts.gstatic.com`, `img-src 'self' data:`, `frame-ancestors 'none'`, `object-src 'none'`. The current inline `<style>` and inline `gtag` blocks must move to files or carry a per-request nonce; do not weaken the policy with `unsafe-inline`.
- HSTS `max-age=31536000; includeSubDomains` set by the same middleware.
- All SQL through Kysely's parameter binding. No string concatenation into SQL anywhere, enforced by an ESLint rule banning template literals inside `sql` tags except `sql.raw` in the migration runner.
- Rate limiting on `POST /login`, `POST /enquiry` and `POST /app/files` via a `rate_limit_hits` table with a windowed counter.
- `audit_log` rows written inside the same transaction as the mutation for every create, update, delete and status transition on financial, HR and project records. Fields in 6.2.
- `.gitignore` must include `.env`, `*.log`, `enquiries.log`, `node_modules/`, `dist/`, `uploads/`, `private_uploads/`. Note that `indexnow-log.txt` and `indexnow-key` material are currently committed; the IndexNow key stays public by design (it is served as a file), but the log should not be in git.

### 2.11 Tooling

TypeScript 5.9 strict, Vite 6 for the client asset build and `tsc` for the server, `tsx` for local dev, Vitest for unit tests on permission resolution and financial calculations (the two places where a bug is expensive), Playwright for a smoke suite covering login, one approval flow and the ten public routes returning 200. ESLint plus Prettier. Node engine pinned to `22.x` in `package.json` so hPanel's detection selects the right runtime.

### 2.12 Deployment

GitHub push-to-deploy from `main`. hPanel build settings: build command `npm run build`, output directory `dist`, entry file `dist/server.js`. Secrets exclusively in hPanel environment variables (`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `SESSION_SECRET`, `CRON_SECRET`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `UPLOAD_PUBLIC_DIR`, `UPLOAD_PRIVATE_DIR`, `INDEXNOW_KEY`, `APP_BASE_URL`, `NODE_ENV`). Never in the repository. A `develop` branch deploys to a `staging.neelachandra.com` Node app with its own database, which is what makes the cutover in section 7 rehearsable.

---

## 3. Unified codebase folder and file structure

One repository, one Node process, one domain. Public marketing routes and `/app/*` dashboard routes share the session layer, the database pool and the deployment. The existing repository files are either converted, replaced or archived; nothing is left ambiguous.

```
neelachandrainteriors/                     (existing repo, restructured in place)
├── package.json                           NEW  engines.node "22.x", type "module"
├── tsconfig.json                          NEW  strict, moduleResolution bundler
├── vite.config.ts                         NEW  client asset build only
├── .env.example                           NEW  documents every key, no values
├── .gitignore                             NEW  .env, node_modules, dist, *.log, uploads
├── ecosystem.config.cjs                   NEW  local PM2 only, not used on Hostinger
│
├── migrations/                            NEW  hand-written SQL, applied in order
│   ├── 001_core_auth.sql
│   ├── 002_public_content.sql
│   ├── 003_crm.sql
│   ├── 004_projects.sql
│   ├── 005_inventory.sql
│   ├── 006_finance.sql
│   ├── 007_hr.sql
│   ├── 008_marketing.sql
│   └── 009_seed_reference_data.sql
│
├── scripts/
│   ├── migrate.mjs                        applies pending migrations, tracks schema_migrations
│   ├── seed-users.mjs                     creates the 10 staff accounts interactively
│   ├── extract-legacy-content.mjs         parses the old PHP into content/*.ts + seed SQL
│   ├── capture-golden.mjs                 PHASE 0 ONLY: saves live HTML + screenshots
│   │                                      to legacy/golden/. Irreplaceable after cutover.
│   ├── parity-check.mjs                   THE FREEZE GATE: 6 HTML axes + pixels at
│   │                                      1440/768/390 (see 3.2)
│   ├── selftest-parity.mjs                proves the gate catches violations, 16 cases
│   ├── lib/pages.mjs                      the 10 public paths + viewports + infra files
│   ├── lib/normalise.mjs                  text nodes, element+class seq, JSON-LD, SEO, assets
│   ├── snapshot-urls.mjs                  crawls live site to legacy/url-inventory.json
│   └── verify-routes.mjs                  asserts all 10 legacy URLs return 200
│
├── src/
│   ├── server.ts                          entry: @hono/node-server, reads PORT, mounts app
│   ├── app.ts                             route composition, middleware order
│   ├── env.ts                             Zod-validated process.env, fails fast on boot
│   │
│   ├── db/
│   │   ├── pool.ts                        mysql2 pool, connectionLimit 5
│   │   ├── kysely.ts                      Kysely instance with MysqlDialect
│   │   └── types.ts                       generated table interfaces
│   │
│   ├── lib/
│   │   ├── password.ts                    argon2id hash/verify
│   │   ├── session.ts                     create/read/rotate/destroy, SHA-256 stored ids
│   │   ├── csrf.ts                        token issue and timing-safe compare
│   │   ├── permissions.ts                 PERMISSIONS + ROLE_PERMISSIONS + can()
│   │   ├── scope.ts                       row-level project scoping for supervisors
│   │   ├── audit.ts                       writeAudit(trx, ...) called inside transactions
│   │   ├── mailer.ts                      Nodemailer transport + email_log write
│   │   ├── files.ts                       upload, MIME sniff, checksum, stored_files row
│   │   ├── money.ts                       integer-paise helpers, GST, retention
│   │   ├── numbering.ts                   document number generator (see 6.1)
│   │   ├── dates.ts                       Asia/Kolkata, FY Apr-Mar helpers
│   │   └── ratelimit.ts                   DB-backed window counter
│   │
│   ├── middleware/
│   │   ├── session.ts                     loads user, roles, permissions into c.var
│   │   ├── requireAuth.ts                 redirects to /login?next=
│   │   ├── requirePermission.ts           requirePermission('projects.approve')
│   │   ├── requireProjectAccess.ts        enforces project_assignments for scoped roles
│   │   ├── cronAuth.ts                    X-Cron-Key timingSafeEqual
│   │   ├── legacyRedirects.ts             the .htaccess rules, in code (see 3.1)
│   │   └── errorHandler.ts                replaces error.php, all 4xx/5xx
│   │
│   ├── public/                            THE MARKETING SITE, design frozen, see 3.2
│   │   ├── routes/
│   │   │   ├── home.tsx                   /                     from index.php
│   │   │   ├── projects.tsx               /best-construction-company-in-bengaluru-projects
│   │   │   ├── packages.tsx               /construction-packages-in-bengaluru
│   │   │   ├── services.tsx               /construction-services-in-bengaluru
│   │   │   ├── bengaluru.tsx              /best-construction-company-in-bengaluru
│   │   │   ├── tumkur.tsx                 /construction-company-in-tumkur
│   │   │   ├── about.tsx                  /about-us
│   │   │   ├── contact.tsx                /contact-us  + POST enquiry
│   │   │   ├── legal.tsx                  /terms, /privacy-policy
│   │   │   ├── blog.tsx                   /blog, /blog/:slug   (new, sitemap already globs it)
│   │   │   ├── sitemap.ts                 /sitemap.xml         same 10 paths, same priorities
│   │   │   ├── robots.ts                  /robots.txt          domain corrected, else identical
│   │   │   └── llms.ts                    /llms.txt, /llms-full.txt  served as-is from public/
│   │   ├── layouts/SiteLayout.tsx         header.php + footer.php, ONE <head>, same output
│   │   ├── content/                       THE FROZEN COPY, one file per page
│   │   │   ├── home.ts                    every string from index.php, verbatim
│   │   │   ├── packages.ts                package names, rates, spec lines, verbatim
│   │   │   ├── projects.ts                the 7 showcase entries, verbatim
│   │   │   ├── services.ts  bengaluru.ts  tumkur.ts  about.ts  contact.ts
│   │   │   └── faqs.ts                    question and answer text, verbatim
│   │   ├── components/
│   │   │   ├── TopSocialBar.tsx           from top-social.php, same 5 links
│   │   │   ├── SiteNav.tsx                from header.php nav block, same items and targets
│   │   │   ├── FloatingButtons.tsx        from floating-buttons.php (WhatsApp, Maps)
│   │   │   ├── FooterSubscribe.tsx        from footer-sub.php, same markup, real handler
│   │   │   ├── SiteFooter.tsx
│   │   │   ├── EnquiryForm.tsx            from contact-form.php, SAME fields/labels/order
│   │   │   ├── FaqAccordion.tsx           same DOM as the current accordion + FAQPage JSON-LD
│   │   │   ├── PackageCards.tsx           props from content/packages.ts (DB only in phase 8)
│   │   │   ├── ProjectCard.tsx            props from content/projects.ts
│   │   │   └── StatStrip.tsx              props from content/home.ts
│   │   └── seo/
│   │       ├── jsonld.ts                  builds @graph as objects, JSON.stringify once
│   │       ├── organization.ts            LocalBusiness/GeneralContractor node, one place
│   │       └── meta.ts                    title, description, canonical, OG, hreflang
│   │
│   ├── dashboard/                         THE INTERNAL SYSTEM, all under /app
│   │   ├── layouts/AppShell.tsx           sidebar filtered by permissions
│   │   ├── components/
│   │   │   ├── DataTable.tsx              sortable, filterable, htmx tbody swap
│   │   │   ├── FormField.tsx              label + input + Zod error slot
│   │   │   ├── Money.tsx                  formats paise as Rs 12,34,567.00
│   │   │   ├── StatusBadge.tsx
│   │   │   ├── FileUpload.tsx             browser-side resize then POST
│   │   │   ├── ApprovalBar.tsx            approve/reject with reason, writes audit
│   │   │   ├── Timeline.tsx               stage and activity history
│   │   │   └── KpiCard.tsx
│   │   └── assets/
│   │       ├── css/dashboard.css
│   │       └── js/{htmx-init,image-resize,charts}.js
│   │
│   ├── modules/                           ONE FOLDER PER MODULE, same 5 files each
│   │   ├── auth/         {routes,service,schemas,queries}.ts
│   │   ├── admin/        {routes,service,schemas,queries}.ts
│   │   ├── projects/     {routes,service,schemas,queries}.ts
│   │   ├── inventory/    {routes,service,schemas,queries}.ts
│   │   ├── marketing/    {routes,service,schemas,queries}.ts
│   │   ├── hr/           {routes,service,schemas,queries}.ts
│   │   ├── crm/          {routes,service,schemas,queries}.ts
│   │   └── finance/      {routes,service,schemas,queries}.ts
│   │
│   └── internal/
│       └── cron/{notifications,daily-rollup,stock-alerts,document-expiry,weekly-client-updates}.ts
│
├── public/                                STATIC, served by Apache in front of Node
│   ├── assets/
│   │   ├── css/                           ONE FILE PER PAGE, byte-copied from each
│   │   │                                  page's inline <style>. No shared reset,
│   │   │                                  no merging, no dedupe. See 3.2.
│   │   │   ├── home.css  packages.css  projects.css  services.css
│   │   │   ├── bengaluru.css  tumkur.css  about.css  contact.css
│   │   │   └── legal.css
│   │   ├── js/site.js                     nav toggle, accordion, IntersectionObserver,
│   │   │                                  lifted from the existing inline <script>s
│   │   ├── images/                         EVERY image at its EXISTING path and filename,
│   │   │                                  spaces and parentheses preserved
│   │   └── vendor/{htmx.min.js,alpine.min.js,chart.umd.min.js}   /app only
│   ├── favicon.ico  favicon.svg  favicon-96x96.png  apple-touch-icon.png
│   ├── site.webmanifest                   icon paths corrected (category 2)
│   ├── og.webp                            UNCHANGED, byte-identical
│   ├── humans.txt
│   ├── 097ee841c58a4b25b8eb2c348ca67dce.txt   IndexNow key file, must keep exact content
│   ├── google9706eb5d9d6a7b15.html            Search Console verification, must keep
│   └── .well-known/security.txt           already correct on live, copied as-is (CQ-3)
│
├── tests/
│   ├── unit/{permissions,money,numbering}.test.ts
│   ├── e2e/{public-routes,login,expense-approval}.spec.ts
│   └── parity-out/                         diff images written on a freeze failure
│
└── legacy/                                READ-ONLY ARCHIVE, excluded from the build
    ├── golden/                            CAPTURED IN PHASE 0, KEPT PERMANENTLY
    │   ├── <slug>.html                     x9, live rendered HTML before cutover
    │   └── shots/<slug>-{1440,768,390}.png x27, the design of record
    ├── url-inventory.json                 assertion set for verify-routes.mjs
    ├── extraction-report.md               every text node: landed where, or nowhere
    ├── CONTENT-QUERIES.md                  things that look wrong, NOT silently fixed
    ├── RECOVERED-FILES.md                  server tree minus git tree
    ├── php-construction/                  index.php, about-us.php, contact-us.php, the 6 others,
    │                                      header.php, footer.php, footer-sub.php, top-social.php,
    │                                      floating-buttons.php, sitemap.php, indexnow-submit.php,
    │                                      error.php, coming-soon.php, terms.php, privacy-policy.php
    ├── php-interiors/                     about.php, contact.php, process.php,
    │                                      contact-form.php, enquiry-handler.php, README.md
    └── htaccess-original.txt              the file currently named `download`
```

Rules that keep this honest:

- `legacy/` exists so the content extraction in section 7 has a source and so nothing is lost, but it is in `.vercelignore`-style exclusion from the build and never imported. Delete it once section 7 step 6 is signed off.
- `src/modules/*` never renders JSX directly. Routes call the service, the service returns data, the route renders a component from `src/dashboard/components`. This is what stops the eight modules from becoming eight private conventions.
- The interiors files go to `legacy/php-interiors/` and are **not** ported. They belong to a different domain, and archiving them removes nothing from the live `neelachandra.com` site. The existing `README.md` moves there too, and a new `README.md` is written for this project. `enquiry-handler.php` and `contact-form.php` are the exception: they sit in this group by filename but their logic is the basis of 6.5 rule 1, so they are read from the archive rather than deleted.

### 3.1 Replacing `.htaccess` behaviour in `src/middleware/legacyRedirects.ts`

Because Hostinger regenerates `public_html/.htaccess` on every deploy, these rules move into code and run before routing:

1. If the path ends in `.php`, 301 to the same path without `.php`. Preserves the existing `RewriteRule ^ %1 [R=301,L]`.
2. Explicit 301 map for the paths that die in the rebuild: `/about.php` and `/about` to `/about-us`; `/contact.php` and `/contact` to `/contact-us`; `/process.php` to `/#process`; `/coming-soon` to `https://neelachandrainteriors.com`.
3. Strip a trailing slash on all non-root paths with a 301, matching the current `^(.+?)/?$` behaviour.
4. Force `https://neelachandra.com` as the canonical host with a 301 from any `www.` variant.
5. `/sitemap.xml` is a real route, not a rewrite.
6. `src/middleware/errorHandler.ts` renders the same code-specific copy that `error.php` holds today for 400 through 505, reading from a single `ERROR_COPY` record so the 30 `ErrorDocument` lines are no longer needed.

`scripts/verify-routes.mjs` asserts every one of these, run in CI and again after the first production deploy.

### 3.2 How the design and content freeze is enforced mechanically

Stating that the design does not change is worthless without a test that fails when it does. The port is treated as a refactor with a golden-master test, which is the only reliable way to move rendering engines without visual drift.

**CSS is copied per page, not consolidated.** Each of the nine construction pages has its inline `<style>` block extracted to exactly one file under `public/assets/css/`, byte for byte including the duplicated resets and any dead rules. `SiteLayout.tsx` takes a `pageCss` prop and emits a single `<link>` to that one file. The duplicated reset across nine files is accepted deliberately. Merging them into `site.css` would change specificity and cascade order, and the current pages depend on their own ordering, including where two pages define the same selector differently. Same rule for the Google Fonts query strings: each page emits the exact font URL it emits today, even where that means loading a family another page does not.

**Copy lives in `src/public/content/*.ts` as string constants extracted from the PHP, and is never edited.** The extraction is mechanical, done by `scripts/extract-legacy-content.mjs`, and the output is reviewed by diffing rendered text against the live page, not by reading it for sense. If a heading has a typo today, it has the same typo after the port. Content correction is a separate task the client can request after cutover, through the phase 8 editor.

**The golden-master check.** `scripts/parity-check.mjs` is the gate for phase 1 and runs on every commit that touches `src/public/`. It is implemented and working; the six comparison axes live in `scripts/lib/normalise.mjs` and the page list in `scripts/lib/pages.mjs`:

1. For each of the ten paths, fetch the live page from `neelachandra.com` once, before cutover, and store the HTML in `legacy/golden/<slug>.html` with its SHA-256 in `manifest.json`. This happens in phase 0, while the old site still exists, because after cutover the reference is gone forever.
2. Fetch the same path from staging.
3. Normalise both, stripping **only** what is genuinely volatile between two renders of the same content: the `nc_csrf` token, the `nc_started` timestamp, asset cache-busting query strings, and literal unix timestamps. Whitespace between tags and attribute order are normalised. Nothing else. Every additional thing stripped is a regression the gate would stop catching, so the list in `scripts/lib/normalise.mjs` requires a written justification per entry.
4. Compare the **visible text node sequence**. Any addition, removal, or reordering fails the build. This is the copy freeze. JSON-LD is excluded here and compared separately at higher precision, because leaving it in produces one 6 KB pseudo-text-node that swamps the diff and hides a one-word edit elsewhere on the page.
5. Compare the **element and class sequence**, including closing tags so that nesting-depth changes are caught. Any changed or dropped class fails. This is the DOM freeze, and it is what catches a well-intentioned `div` to `section` substitution that changes a descendant selector, or an added wrapper `div`.
6. Compare **JSON-LD twice**: once as a node set keyed on `@type` and `@id`, proving no node was lost when nine hand-written copies become one `buildGraph()`; and once as a flat sorted set of every leaf value, proving no price, rating, FAQ answer or offer changed. The node-set check alone would pass a page whose `Offer` price had been edited, which is why both exist.
7. Compare **SEO head fields** field by field (title, meta description, canonical, robots, og:title, og:image, h1) and the full **asset reference set** from `img`, `source`, `link` and `script`, so a renamed or dropped image fails.
8. Render both at 1440, 768 and 390 pixels wide in Playwright and compare screenshots with a per-pixel tolerance of 0. Both sides scroll the full page first to settle `IntersectionObserver` reveals and lazy images, so the comparison is of settled pages. Failures write a diff image to `tests/parity-out/`. This is the design freeze.

Step 8 is why the semantic-HTML preference stated elsewhere in this document does **not** apply to `src/public/`. It applies to `src/dashboard/`, which is new code with no existing appearance to preserve. On the public side, the existing tag is the correct tag because it is the one the CSS was written against.

**The gate is itself tested.** `scripts/selftest-parity.mjs` applies 16 known mutations to a golden master and asserts which are caught: copy edits, `div` to `section` swaps, renamed and dropped classes, added wrappers, changed JSON-LD types and values, changed title, meta description and canonical, and renamed images must all fail the gate, while whitespace reflow and attribute reordering must not. It also fails loudly if a mutation pattern no longer matches the fixture, so a test that has silently stopped testing anything cannot report a pass. Run it in CI alongside the gate. A parity gate nobody tests is a parity gate that quietly becomes a no-op, and this one already caught two real weaknesses in its own first implementation.

**Known and accepted consequence.** The ported public site inherits the current site's Lighthouse scores, its 1 MB `og.webp`, its per-page font loading and its CSS duplication. Performance work is deliberately not bundled into the port, because bundling it makes every parity failure ambiguous between "the port is wrong" and "the optimisation moved something." It is offered separately in 8.12.

## 4. Role and permission model

### 4.1 Why permissions, not roles, are checked at the route

With ten people, nobody holds one clean job. The site's own JSON-LD proves it: `index.php` lists Sushma N as "Operations Analyst" and Vinay as "Procurement Lead". An Operations Analyst at this headcount touches project schedules, material verification, and staff records. A Procurement Lead touches inventory and money. A role-string check (`if (user.role === 'admin')`) forces you to either over-grant or create a ninth and tenth role every time someone picks up a new duty.

So roles are a bundle of permissions, and route guards check the permission:

```
roles                       (id, key, label, description, require_2fa BOOL,
                             scope_to_assigned_projects BOOL, is_system BOOL)
permissions                 (id, key, module, label)          -- e.g. 'projects.view_cost'
role_permissions            (role_id, permission_id)          -- composite PK
user_roles                  (user_id, role_id)                -- composite PK, allows two roles
user_permission_overrides   (user_id, permission_id, effect ENUM('grant','deny'),
                             granted_by, granted_at, note)
```

Effective permission set is computed once per request in `src/middleware/session.ts`:

```
effective = union(role_permissions for all user_roles)
          - overrides where effect = 'deny'
          + overrides where effect = 'grant'
```

The result is stored on `c.var.perms` as a `Set<string>` and never recomputed inside a handler. `src/middleware/requirePermission.ts` is `requirePermission('inventory.issue')` and does a single `Set.has`. `src/lib/permissions.ts` holds the `PERMISSIONS` const object so `tsc` fails on a typo instead of the guard silently passing nobody.

`user_permission_overrides` is the pressure valve. When Sushma needs to approve one purchase order while Vinay is on leave, the owner grants `inventory.approve_po` to her user with a `note`, and it is visible and revocable in the admin UI rather than being a permanent new role.

### 4.2 Roles

Eight roles for ten people. Counts are my read of the org from `about-us.php` and the four named people in the JSON-LD, and need confirming (see 8.1).

| key | label | expected count | notes |
|---|---|---|---|
| `owner` | Owner / Founder | 1 | Chandrashekar T. Sees everything including margin. Cannot self-approve, see 4.3. |
| `admin` | System Administrator | 1 | User accounts, roles, reference data, audit log. Deliberately **not** granted `projects.view_cost` or expense approval by default. |
| `ops_manager` | Operations Manager | 1 | Sushma N's likely mapping. Cross-project read, schedule and inventory write, HR read. |
| `project_manager` | Project Manager | 2 | Full write on their assigned projects, including cost. |
| `site_supervisor` | Site Supervisor | 2 to 3 | Assigned projects only. Logs progress, DPRs, material receipt and issue, labour attendance. Never sees contract value or margin. |
| `accounts_manager` | Accounts Manager | 1 | All money across all projects. Cannot edit project scope or approve their own vouchers. |
| `hr_manager` | HR Manager | 1 | Employees, recruiting, attendance, statutory documents. Payroll figures gated separately. |
| `sales_exec` | Sales Executive | 1 to 2 | Own leads plus unassigned pool. Reads packages and project gallery. No inventory, no HR, no expense. |

Two rules that are not negotiable and drive the schema:

**Cost visibility is its own permission.** `projects.view_cost` is separate from `projects.view`. A site supervisor needs the drawing, the schedule, and the material list. He does not need the contract value, the client's payment status, the vendor rate card, or the margin. Every query in `src/modules/projects/queries.ts` that selects `contract_value_paise`, `budget_total_paise`, or any `*_margin_*` column takes a `canViewCost: boolean` and omits the columns rather than nulling them in the template, so the numbers never reach the HTML.

**Segregation of duties beats seniority.** `approveExpense()` in `src/modules/finance/service.ts` starts with:

```ts
if (expense.created_by === session.user_id) {
  throw new ForbiddenError('An expense cannot be approved by the person who raised it')
}
```

This throws for `owner` too. With ten people and one person holding the bank login, the only real control available is that two names must appear on every voucher. If the owner raises a payment himself, `accounts_manager` approves it, and vice versa. The same guard applies to `approvePurchaseOrder()` and `approveLeaveRequest()`.

### 4.3 Permission matrix

Notation: **F** full (create, read, update, delete or void) / **W** write (create and update, no delete) / **R** read / **A** approve only / **S** scoped to assigned projects or own records / **blank** no access.

| Capability | owner | admin | ops_mgr | proj_mgr | supervisor | accounts | hr_mgr | sales |
|---|---|---|---|---|---|---|---|---|
| **Auth / account** | | | | | | | | |
| `users.manage` | F | F | | | | | | |
| `roles.manage` | F | F | | | | | | |
| `sessions.revoke_others` | F | F | | | | | | |
| `audit.view` | R | R | | | | | | |
| **Admin dashboard** | | | | | | | | |
| `dashboard.view_company_kpi` | R | | R | | | R | | |
| `dashboard.view_own_kpi` | R | R | R | R | R | R | R | R |
| `reference.manage` (units, cost heads, stages) | F | F | W | | | | | |
| `site_content.manage` (packages, gallery, FAQ) | F | W | W | | | | | |
| `enquiries.view` | R | R | R | | | | | R |
| **Projects tracker** | | | | | | | | |
| `projects.view` | R | R | R | R | R+S | R | | R |
| `projects.manage` | F | | W | F+S | | | | |
| `projects.view_cost` | R | | R | R+S | | R | | |
| `projects.assign_staff` | F | F | W | W+S | | | | |
| `projects.update_progress` | W | | W | W+S | W+S | | | |
| `projects.dpr_submit` | W | | W | W+S | W+S | | | |
| `projects.quality_signoff` | A | | A | A+S | | | | |
| `projects.milestone_certify` | A | | | A+S | | R | | |
| `projects.snag_manage` | F | | W | F+S | W+S | | | |
| **Inventory** | | | | | | | | |
| `inventory.view` | R | | R | R+S | R+S | R | | |
| `inventory.item_manage` | F | | F | | | | | |
| `inventory.grn_create` (goods receipt) | W | | W | W+S | W+S | | | |
| `inventory.issue` | W | | W | W+S | W+S | | | |
| `inventory.transfer` | W | | W | W+S | | | | |
| `inventory.stock_adjust` | W | | W | | | | | |
| `inventory.po_create` | W | | W | W+S | | W | | |
| `inventory.approve_po` | A | | | | | A | | |
| `inventory.vendor_manage` | F | | W | | | W | | |
| `inventory.view_rates` | R | | R | R | | R | | |
| **Marketing** | | | | | | | | |
| `marketing.view` | R | R | R | | | | | R |
| `marketing.campaign_manage` | F | | F | | | | | W |
| `marketing.content_publish` | F | W | W | | | | | |
| `marketing.spend_record` | W | | W | | | W | | |
| `marketing.analytics_view` | R | R | R | | | R | | R |
| **HR and recruiting** | | | | | | | | |
| `hr.employee_view` | R | R | R | | | | R | |
| `hr.employee_manage` | F | | | | | | F | |
| `hr.attendance_record` | W | | W | W+S | W+S | | W | |
| `hr.attendance_approve` | A | | A | A+S | | | A | |
| `hr.leave_approve` | A | | A | A+S | | | A | |
| `hr.payroll_view` | R | | | | | R | R | |
| `hr.payroll_run` | A | | | | | W | W | |
| `hr.document_manage` (PF, ESI, ID, licence) | F | | | | | | F | |
| `hr.recruit_manage` (roles, applicants) | F | | R | R | | | F | |
| `hr.labour_contractor_manage` | F | | F | W+S | | R | R | |
| **Sales and CRM** | | | | | | | | |
| `crm.lead_view` | R | | R | | | | | R+S |
| `crm.lead_manage` | F | | F | | | | | F+S |
| `crm.lead_assign` | F | | F | | | | | |
| `crm.quote_create` | W | | W | W | | | | W+S |
| `crm.quote_approve` (below limit) | A | | A | | | A | | |
| `crm.quote_discount_override` | A | | | | | | | |
| `crm.convert_to_project` | A | | A | | | | | |
| `crm.view_pipeline_value` | R | | R | | | R | | R+S |
| **Budget and expense** | | | | | | | | |
| `finance.view_project_budget` | R | | R | R+S | | R | | |
| `finance.budget_set` | F | | | W+S | | W | | |
| `finance.expense_create` | W | | W | W+S | W+S | W | W | W+S |
| `finance.expense_approve` | A | | | A+S | | A | | |
| `finance.payment_record` | W | | | | | W | | |
| `finance.invoice_manage` | F | | | W+S | | F | | |
| `finance.view_company_pnl` | R | | | | | R | | |
| `finance.period_close` | A | | | | | A | | |
| `finance.export` | F | | R | R+S | | F | | |

Approval thresholds are data, not code, so they change without a deploy:

```
approval_limits (id, role_key, document_type ENUM('expense','purchase_order',
                 'quote_discount_pct','payment_release'),
                 max_value BIGINT,          -- paise, or basis points for a pct
                 requires_second_approval_above BIGINT NULL,
                 effective_from DATE, effective_to DATE NULL)
```

`src/lib/permissions.ts` exports `resolveApprovalLimit(roleKeys, documentType, onDate)` which takes the **highest** limit across the user's roles. A document above every limit the user holds escalates to `owner` and the UI says which role is needed rather than showing a dead button.

### 4.4 Row level scoping

`roles.scope_to_assigned_projects` is true for `site_supervisor` and `project_manager`. When set, `src/middleware/requireProjectAccess.ts` resolves `:projectId` and confirms a row in:

```
project_assignments (id, project_id, user_id, assignment_role ENUM('pm','supervisor',
                     'qs','accounts','observer'), from_date, to_date NULL,
                     UNIQUE KEY (project_id, user_id, assignment_role))
```

Two details that matter:

- List endpoints do not filter in JavaScript. `src/lib/scope.ts` exports `applyProjectScope(qb, ctx)` which appends `.where('projects.id', 'in', db.selectFrom('project_assignments').select('project_id').where('user_id','=',uid).where(...dateActive))` to the Kysely builder. Filtering after the fetch leaks row counts and pagination totals.
- An unassigned project returns **404, not 403**. A supervisor should not learn that "Honda Cars India Phase 3" exists by probing IDs.

`sales_exec` scoping is different and lives in `src/modules/crm/queries.ts`: visible leads are `assigned_to = me OR assigned_to IS NULL`. The unassigned pool has to be readable or nobody claims a new enquiry.

### 4.5 Account lifecycle

There is no public registration route anywhere in `src/`. `src/modules/auth/routes.ts` exposes `/login`, `/logout`, `/forgot-password`, `/reset-password/:token`, `/2fa/verify` and nothing else. Accounts are created only by `users.manage` holders.

- Creation writes a `users` row with `password_hash = NULL` and `must_change_password = 1`, then issues a `password_reset_tokens` row (`token_hash` SHA-256, `expires_at` 24 hours, `used_at` NULL). The invite email is the only way in.
- `src/middleware/requireAuth.ts` redirects to `/app/account/password` on every request while `must_change_password = 1`, allowing only that route and `/logout`.
- Deactivation sets `users.status = 'inactive'` and **deletes** the user's `user_sessions` rows in the same transaction. Without the delete, a fired employee keeps a valid cookie for up to 12 hours.
- Users are never hard deleted. Every module table carries `created_by` and `updated_by` foreign keys to `users.id`, and a DPR from two years ago must still name its author.
- `roles.require_2fa` is true for `owner`, `admin`, and `accounts_manager`. `totp_secret` and `totp_confirmed_at` live on `users`; an unconfirmed secret forces the enrolment screen before any other page renders. Ten recovery codes are stored as individual argon2 hashes in `user_recovery_codes`, single use.

---

## 5. Build and phasing plan

The order below is driven by structural dependency, not by which module sounds most useful. Three facts set it:

- The public site is currently earning enquiries and ranking. It cannot be down, its URLs cannot change, and by your instruction its design and content cannot change either. So the port of the marketing site happens first and ships alone, before any dashboard code exists to destabilise it, and it ships behind the parity gate in 3.2.
- Deploying a Node app to `neelachandra.com` on Hostinger requires **removing the existing website first, and that removal is irreversible** (see 1.9). This is a one-way door. It must happen once, deliberately, with a verified backup, and against a codebase that already renders every current page. That forces phase 1 to be feature-complete on the public side before cutover.
- Six of the eight modules write rows that reference `projects.id`. Inventory issues to a project, expenses hit a project budget, DPRs belong to a project, a won lead becomes a project. Building inventory or finance before the projects table is settled means reworking foreign keys.

So the dependency spine is: **platform, then public site, then auth, then projects, then everything that hangs off projects.**

### Phase 0. Backup and environment, before any code

Not optional and not a formality, because of the irreversible-removal issue.

1. Full download of `public_html` over SSH or File Manager, including `includes/`, `assets/`, `css/`, `js/`, `favicon/`, and the `.htaccess` that git records as `download`. The git repo is a partial flattened dump (see 1.2) and cannot reconstruct the site.
1a. **Capture the golden masters while the old site is still up. ALREADY DONE.** `scripts/capture-golden.mjs` saves the rendered HTML of every public page to `legacy/golden/*.html`, the ten non-page infrastructure files to `legacy/golden/infra/`, and Playwright screenshots at 1440, 768 and 390 pixels to `legacy/golden/shots/`. This is the only reference for the design and content freeze, the removal in 7.6 step 5 is irreversible, and there is no way to recreate this afterwards. **This capture was executed on 2026-08-24 against the live site and the results are committed**: 10 of 10 pages, 9 of 10 infra files (the tenth, `/security.txt`, correctly 404s per CQ-3), 30 screenshots, with SHA-256 per file in `legacy/golden/manifest.json`. Re-run it immediately before cutover to catch any content the client changes in the meantime; the committed capture is the floor, not the ceiling. Note the page count is ten, not the nine stated elsewhere in this document, because `/terms` and `/privacy-policy` are both live and in the sitemap.
2. Export `enquiries.log` and archive the Gmail label holding enquiries to `nccpmd@gmail.com`. These are the only records of past leads and section 7 step 5 needs them.
3. Create the MySQL database and user in hPanel. Record `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` as hPanel environment variables.
4. Point `staging.neelachandra.com` at a separate Hostinger Node deployment fed by the `develop` branch. Every phase gate below is verified on staging first. Without staging, the one-way door gets opened to test something.
5. Set `SESSION_SECRET`, `CRON_KEY`, `SMTP_*`, `INDEXNOW_KEY` (value `097ee841c58a4b25b8eb2c348ca67dce`, already published at the key file so it must not change).

Gate: staging serves a Hono "hello" page at `staging.neelachandra.com` and `scripts/verify-routes.mjs` can reach it.

### Phase 1. Public marketing site, at parity

Port the nine construction pages to `hono/jsx` routes with a shared layout. **This is a rendering-engine swap, not a rebuild.** The output HTML is intended to be equivalent to what the PHP emits today, and the only permitted deviations are the three categories in the header block: the consolidated single `<head>` (the second one is already discarded by the parser), the `<34` tag, and the nested `<style>`. Each page's CSS is extracted to its own file per 3.2. Copy is extracted verbatim into `src/public/content/*.ts` and not edited. It stays out of the database at this stage; putting packages in MySQL before the admin UI exists to edit them adds a query and a failure mode for zero benefit, and phase 8 moves it.

Also in phase 1: `legacyRedirects.ts` and `errorHandler.ts` per 3.1, `sitemap.xml` as a real route with the same 10 paths and the same priority and changefreq values, and JSON-LD emitted from `src/public/seo/schema.ts` so the nine drifted copies have one source. The JSON-LD is generated to reproduce **what each page already emits**, node for node and value for value, which per the verified capture includes the five contradictory `aggregateRating` nodes (see 1.8 item 10 and CQ-1). `BreadcrumbList` becomes derived from the route rather than hand-written, which changes the source and not the output. `scripts/parity-check.mjs` enforces this with two separate checks, `json-ld nodes` for node sets and `json-ld values` for the deep payload, so a changed price or rating cannot slip through a node-set comparison that still looks correct.

Not in phase 1, despite being tempting: image re-encoding, duplicate-asset deletion, CSS consolidation, font consolidation, copy corrections, and the rating. All frozen. The only infrastructure corrections are the `site.webmanifest` icon paths and `robots.txt` (which per CQ-2 is the interiors site's file entirely, not merely a wrong sitemap line). `security.txt` needs no move; it is already correctly placed.

The enquiry form is wired to **MySQL plus email**, not email alone, keeping its current visible fields, labels, order and copy exactly. This is the one piece of dashboard-shaped work pulled forward, because every day it is not live is a day of leads that exist only as Gmail. It needs one table, `enquiries`, and no auth.

Gate, all four required: (1) `scripts/parity-check.mjs --candidate=https://staging.neelachandra.com` exits 0, meaning zero differences on all six axes (text nodes, element and class sequence, JSON-LD node set, JSON-LD deep values, SEO head fields, asset references) plus zero pixel differences at three viewports against the `legacy/golden/` masters. (2) `scripts/verify-routes.mjs` returns the expected status for all 10 sitemap paths, all `.php` 301s, and the redirect map. (3) A submitted form appears in `enquiries` and in the inbox. (4) `scripts/selftest-parity.mjs` exits 0, proving the gate itself still detects violations rather than having been quietly weakened into a no-op. Then, and only then, the production cutover.

On (4): this is not ceremony. While building the gate I found that an over-broad volatile-value filter (masking every four-digit year) was hiding real copy differences, and that comparing only opening tags let a `div` to `section` swap pass. Both were caught by the self-test and fixed. A parity gate nobody tests is a parity gate that silently stops working.

### Phase 2. Auth, users, roles, audit

Nothing in phases 3 to 8 can be built without a session and a permission check, and retrofitting `requirePermission` onto handlers written without it is how modules end up with inconsistent guards. Ships: migrations `001_core_auth.sql` and `002_rbac.sql`, `src/lib/{password,session,csrf,permissions,audit}.ts`, the four middleware files, `/login`, TOTP enrolment, invite and reset flow, the admin user and role screens, and the `audit_log` writer.

Ships with it: the `/app` shell (`src/dashboard/layouts/AppShell.tsx`), the nav that renders only permitted modules, and the empty-state dashboard. Building the shell here means the seven module UIs slot into a settled layout.

Gate: all eight roles seeded with their matrix rows, `tests/unit/permissions.test.ts` asserting the matrix in 4.3 cell by cell, `tests/e2e/login.spec.ts` covering wrong password, locked account, 2FA, forced password change, and session survival across an app-process sleep (stop and start the Node process, confirm the cookie still works, which proves sessions are in MySQL and not in memory).

### Phase 3. Projects tracker

The spine. Everything after this references it. Ships `projects`, `project_assignments`, `project_stages`, `project_milestones`, `daily_progress_reports`, `snags`, `project_documents`, plus the stage template seeding from the four-stage process in `index.php` and the 10 to 12 payment milestones from `construction-packages-in-bengaluru.php`.

Deliberately deferred out of this phase: cost fields are created in the schema now (`contract_value_paise`, `budget_total_paise`) but only read, never computed against actuals, because actuals arrive in phase 7. Creating the columns now avoids an `ALTER TABLE` on a live table later.

Gate: a real in-flight project is entered by the owner end to end, a supervisor account files a DPR from a phone, and that supervisor's page source is grepped for the contract value to prove `projects.view_cost` gating works at the query level.

### Phase 4. Inventory

Placed here rather than later because material control is the loudest spreadsheet problem in a construction business, and because it depends only on `projects` and `users`, both now settled. Ships `items`, `vendors`, `purchase_orders`, `po_lines`, `goods_receipts`, `grn_lines`, `stock_ledger`, `material_issues`, `stock_transfers`, and the item master seeded from the brand list already published in `construction-packages-in-bengaluru.php`.

Gate: receive against a PO, issue to a project, transfer between two sites, and confirm `stock_ledger` running balance reconciles to the `items` cached quantity. A negative stock attempt is rejected.

### Phase 5. Sales and CRM

Now, not earlier, because `crm.convert_to_project` needs `projects` to exist (phase 3) and because the `enquiries` table it inherits was already filling from phase 1, so there is real data to work with on day one rather than an empty pipeline. Ships `leads`, `lead_activities`, `quotes`, `quote_lines`, `lead_sources`, and the `enquiries` to `leads` promotion path.

Gate: an enquiry from the live site becomes a lead, becomes a quote priced off the published per-sqft package rates, and converts to a phase 3 project carrying its own client and contract value.

### Phase 6. HR and recruiting

Independent of projects for employee records, but `hr.attendance_record` is per project per day and labour contractor billing feeds phase 7 expenses, so it sits between them. Ships `employees`, `attendance`, `leave_requests`, `leave_balances`, `employee_documents`, `labour_contractors`, `contractor_attendance`, `job_openings`, `applicants`, `applicant_stages`.

Gate: a month of attendance recorded across two projects, statutory document expiry alert fires from `src/internal/cron/document-expiry.ts`, one applicant moves through every stage.

### Phase 7. Budget and expense tracker

Last of the operational modules by necessity. It consumes phase 3 (project and milestone), phase 4 (GRN values become material cost), and phase 6 (contractor attendance becomes labour cost). Building it earlier means hand-entering numbers the other modules will later produce, then reconciling twice. Ships `cost_heads`, `project_budgets`, `budget_lines`, `expenses`, `expense_lines`, `payments`, `client_invoices`, `invoice_lines`, `accounting_periods`.

Gate: one project shows budget versus committed versus actual where committed traces to open POs and actual traces to approved expenses and GRNs, with no figure typed in twice. Self-approval is attempted by the owner and rejected.

### Phase 8. Marketing

Genuinely last, and this is a recommendation rather than a constraint. Its only hard dependency is `site_content.manage`, and its highest-value feature, attribution of spend to won revenue, cannot be computed until phases 5 and 7 exist. Building it first produces a campaign list with no ROI column. Ships `campaigns`, `campaign_spend`, `content_items`, `seo_keywords`, the move of packages, gallery, services, and FAQ content from `src/public/content/*.ts` into database tables so marketing can edit the live site, and the GA4 and Search Console read integration.

Gate, and this one is unusual because it is the second time the freeze is verified: `scripts/parity-check.mjs` passes against the same `legacy/golden/` masters **after** the content moves from `src/public/content/*.ts` into MySQL, proving the database-driven render is byte-equivalent to the hardcoded one and therefore to the original PHP. Only then is the editor unlocked for staff. Then: a campaign shows cost per qualified lead and cost per won project, both derived, not entered. A package price edited in `/app/marketing/site-content` changes `/construction-packages-in-bengaluru` and its JSON-LD `Offer` node without a deploy, and that first intentional edit is the point at which parity stops being asserted, by design.

### Phase 9. Hardening

Backup verification by restoring the production dump to staging, `tests/e2e` full pass, rate limit and lockout tuning against real logs, the `audit_log` retention job, and deletion of `legacy/php-*` once section 7 sign-off is recorded. `legacy/golden/` is kept permanently as the record of what the site looked like at cutover.

The deferred asset work sits here, and only with explicit approval per 8.12: image re-encoding, removal of duplicate assets that show zero access-log hits over 30 days, and any performance work. Each is a separate commit that must re-run `parity-check.mjs`, with any intended visual difference approved in writing before merge. Nothing in this phase is bundled with anything else, so a regression is always attributable.

### What is explicitly not in any phase

Client portal, vendor or contractor login, mobile app, offline sync, and payroll disbursement. The first two were ruled out. Offline capability is flagged in 8.7 because site supervisors on a Doddaballapura or T Begur site may have no signal, and that answer changes phase 3 architecture, so it needs deciding before phase 3 starts, not after.

---

## 6. Per module specifications

Conventions used throughout, defined once so the eight subsections do not repeat them:

- Every table has `id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY`, `created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP`, `updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`. Tables that a human edits also have `created_by BIGINT UNSIGNED NOT NULL` and `updated_by BIGINT UNSIGNED NULL`, both FK to `users.id` `ON DELETE RESTRICT`. These are not restated per table.
- **All money is `BIGINT` in paise**, column names suffixed `_paise`. `DECIMAL` invites float drift through Node's JSON layer and INR at construction scale exceeds safe integer only above 90,000 crore. `src/lib/money.ts` owns parsing, formatting to the Indian digit grouping (`12,34,567`), and GST arithmetic. No handler does raw division.
- Quantities are `DECIMAL(14,3)` because cement is in bags, steel in tonnes to three decimals, and sand in cubic metres. Rates are `BIGINT` paise per unit.
- Engine `InnoDB`, charset `utf8mb4`, collation `utf8mb4_0900_ai_ci`.
- All soft-deletable records use `status` enums, never a `deleted BOOL`. `voided_at`, `voided_by`, `void_reason` on financial documents, which are never updated or deleted once approved.
- Every route below is under `/app/<module>` for pages and `/api/<module>` for htmx fragments and JSON. Every one is behind `sessionMiddleware` then `requireAuth` then `requirePermission(...)`. Scoped modules add `requireProjectAccess`. This chain is not restated per route.
- Every mutating route requires a valid `_csrf` field checked by `src/lib/csrf.ts` against the session, and writes an `audit_log` row inside the same transaction as the mutation.

### 6.1 Login and authentication

**Tables** (`migrations/001_core_auth.sql`)

```
users
  id, email VARCHAR(190) NOT NULL UNIQUE,
  full_name VARCHAR(120) NOT NULL,
  phone VARCHAR(20) NULL,                      -- E.164, used for password reset SMS later
  password_hash VARCHAR(255) NULL,             -- NULL until invite accepted
  password_algo ENUM('argon2id','bcrypt') NOT NULL DEFAULT 'argon2id',
  must_change_password TINYINT(1) NOT NULL DEFAULT 1,
  password_changed_at DATETIME NULL,
  totp_secret VARBINARY(255) NULL,             -- AES-256-GCM ciphertext, key from SESSION_SECRET derivation
  totp_confirmed_at DATETIME NULL,
  status ENUM('invited','active','suspended','inactive') NOT NULL DEFAULT 'invited',
  failed_login_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  locked_until DATETIME NULL,
  last_login_at DATETIME NULL,
  last_login_ip VARBINARY(16) NULL,
  employee_id BIGINT UNSIGNED NULL,            -- FK employees.id, nullable, set in phase 6
  KEY idx_users_status (status)

user_sessions
  id CHAR(64) PRIMARY KEY,                     -- SHA-256 hex of the 32-byte cookie value
  user_id BIGINT UNSIGNED NOT NULL,
  created_at, last_seen_at DATETIME NOT NULL,
  expires_at DATETIME NOT NULL,
  ip VARBINARY(16) NULL, user_agent VARCHAR(255) NULL,
  totp_verified TINYINT(1) NOT NULL DEFAULT 0, -- half-authenticated between password and TOTP
  revoked_at DATETIME NULL,
  KEY idx_sessions_user (user_id), KEY idx_sessions_expiry (expires_at)

password_reset_tokens (id, user_id, token_hash CHAR(64) UNIQUE, purpose
  ENUM('invite','reset'), expires_at, used_at NULL, created_ip VARBINARY(16))

user_recovery_codes (id, user_id, code_hash VARCHAR(255), used_at NULL)

login_attempts (id, email VARCHAR(190), ip VARBINARY(16), succeeded TINYINT(1),
  attempted_at DATETIME, KEY idx_attempt_email_time (email, attempted_at),
  KEY idx_attempt_ip_time (ip, attempted_at))

audit_log
  id, user_id BIGINT UNSIGNED NULL,            -- NULL for cron and system actions
  action VARCHAR(80) NOT NULL,                 -- 'expense.approve', 'user.suspend'
  entity_type VARCHAR(60) NULL, entity_id BIGINT UNSIGNED NULL,
  before_json JSON NULL, after_json JSON NULL,
  ip VARBINARY(16) NULL, created_at DATETIME NOT NULL,
  KEY idx_audit_entity (entity_type, entity_id), KEY idx_audit_user_time (user_id, created_at)
```

`user_sessions` and `login_attempts` are in MySQL and not in memory specifically because the Hostinger app process sleeps and restarts (1.9). An in-memory session store logs all ten people out on every idle period, and an in-memory rate limiter resets its counters on every restart, which is a trivially defeatable lockout.

**Routes** (`src/modules/auth/routes.ts`)

| Method | Path | Behaviour |
|---|---|---|
| GET | `/login` | Renders form. Redirects to `/app` if already authenticated. `?next=` retained and validated against a same-origin path allowlist. |
| POST | `/login` | Zod: `email` email, `password` min 1. Constant-time path regardless of whether the email exists: always run a dummy argon2 verify on miss so timing does not enumerate users. On success create session with `totp_verified = 0`. |
| GET | `/2fa/verify` | Only reachable with a half-authenticated session. |
| POST | `/2fa/verify` | `otplib.authenticator.check` with `window: 1`. Accepts a recovery code as an alternative. Sets `totp_verified = 1` and rotates the session id. |
| GET | `/2fa/enrol` | Forced when `roles.require_2fa` and `totp_confirmed_at IS NULL`. Renders the `otpauth://` QR generated server side. |
| POST | `/logout` | Deletes the `user_sessions` row, clears the cookie. POST only, so a stray `<img>` cannot log people out. |
| GET/POST | `/forgot-password` | Always returns the same success page whether or not the email exists. Rate limited to 3 per email per hour and 10 per IP per hour. |
| GET/POST | `/reset-password/:token` | Looks up by SHA-256 of the token. On success deletes **all** the user's sessions, so a stolen session cannot survive a reset. |
| GET/POST | `/app/account/password` | The `must_change_password` gate. Requires current password unless the user arrived from an invite. |
| GET | `/app/account/sessions` | Own active sessions with device and IP, individually revocable. |

**Business logic that is not generic**

- Lockout is progressive and per identity plus per IP, computed from `login_attempts`: 5 failures in 15 minutes locks for 15 minutes, 10 in an hour locks for 24 hours and emails the owner. Written into `users.locked_until` so it survives a process restart.
- Session rotation on privilege change. Any successful TOTP verify, password change, or role edit issues a new session id and deletes the old row. This is the mitigation for session fixation and it is cheap here because there is a DB session table anyway.
- `POST /login` on a user whose `status = 'invited'` does not say "no password set". It returns the same generic failure and silently re-sends the invite if the last one expired.
- Cookie `ncc_sid`: `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200`. Twelve hours matches a long site day and avoids a supervisor being logged out mid shift. Absolute expiry, not sliding, plus `last_seen_at` for idle display only.

**Pages and components**

`src/modules/auth/pages/{LoginPage,TotpVerifyPage,TotpEnrolPage,ForgotPasswordPage,ResetPasswordPage,ChangePasswordPage,MySessionsPage}.tsx`, all wrapped in `src/public/layouts/BareLayout.tsx` which loads no Alpine, no htmx, and no Chart.js. The login page must work with JavaScript disabled.

### 6.2 Admin dashboard

This is two different things that get conflated, so they are separated: **system administration** (users, roles, reference data, audit) and **the landing dashboard** every user sees at `/app`. The permission split in 4.3 reflects this, `admin` gets the former and not the company financials.

**Tables** (`migrations/002_rbac.sql`, `003_reference.sql`)

The RBAC tables and `approval_limits` are defined in 4.1 and 4.3 and not repeated. Additional:

```
settings                                       -- single-row-per-key company config
  id, key_name VARCHAR(80) UNIQUE, value_json JSON NOT NULL,
  data_type ENUM('string','int','money','bool','json'), is_secret TINYINT(1),
  label VARCHAR(160), updated_by
  -- seeded from what is currently hardcoded in PHP:
  -- company.legal_name, company.gstin, company.address_line, company.phone_primary
  --   ('+91 78292 92929' per floating-buttons.php), company.email_enquiry
  --   ('nccpmd@gmail.com' per contact-us.php), company.whatsapp,
  --   finance.gst_default_pct, finance.tds_default_pct, finance.retention_default_pct,
  --   projects.default_stage_template_id, numbering.* (see below)

document_numbering
  id, doc_type ENUM('project','quote','po','grn','expense','invoice','payment','issue'),
  prefix VARCHAR(12) NOT NULL,                 -- 'NCC/PRJ', 'NCC/PO'
  fy_reset TINYINT(1) NOT NULL DEFAULT 1,      -- Indian FY, 1 April
  financial_year CHAR(7) NOT NULL,             -- '2026-27'
  last_number INT UNSIGNED NOT NULL DEFAULT 0,
  UNIQUE KEY uq_numbering (doc_type, financial_year)

cost_heads                                     -- shared by projects, inventory, finance
  id, code VARCHAR(20) UNIQUE, name VARCHAR(120),
  parent_id BIGINT UNSIGNED NULL,              -- one level of nesting only
  head_type ENUM('material','labour','subcontract','equipment','statutory','overhead'),
  is_direct_cost TINYINT(1) NOT NULL DEFAULT 1, sort_order SMALLINT

units (id, code VARCHAR(10) UNIQUE, name VARCHAR(40), decimal_places TINYINT)
  -- seeded: bag, MT, kg, cum, sqft, sqm, rmt, nos, litre, day, trip

notifications
  id, user_id, kind VARCHAR(60), title VARCHAR(200), body TEXT NULL,
  link_path VARCHAR(255) NULL, severity ENUM('info','warn','critical'),
  read_at DATETIME NULL, KEY idx_notif_user_unread (user_id, read_at)
```

`src/lib/numbering.ts` exports `nextNumber(trx, docType)`. It must run inside the caller's transaction and use `SELECT ... FOR UPDATE` on the `document_numbering` row. Reading a max and adding one produces duplicate PO numbers under concurrent submits, and a duplicate PO number is a real dispute with a vendor, not a cosmetic bug. Indian financial year rollover on 1 April is handled by `src/lib/dates.ts` `currentFinancialYear()`.

**Routes**

| Method | Path | Permission | Behaviour |
|---|---|---|---|
| GET | `/app` | `dashboard.view_own_kpi` | Role-aware landing, see below. |
| GET | `/api/dashboard/widget/:key` | varies per widget | htmx fragment, each widget loads independently so one slow query does not block the page. |
| GET | `/app/admin/users` | `users.manage` | List with status, roles, last login. |
| POST | `/app/admin/users` | `users.manage` | Create and send invite. |
| PATCH | `/api/admin/users/:id/status` | `users.manage` | Suspend or reactivate. Suspend deletes sessions in the same transaction. |
| PUT | `/api/admin/users/:id/roles` | `roles.manage` | Replaces the `user_roles` set. Blocks removing the last `owner`. |
| POST | `/api/admin/users/:id/overrides` | `roles.manage` | The 4.1 grant or deny, `note` required by Zod, min 10 chars. |
| GET/PUT | `/app/admin/roles/:id` | `roles.manage` | Permission checkboxes grouped by module. `is_system` roles cannot be deleted. |
| GET/PUT | `/app/admin/approval-limits` | `roles.manage` | The `approval_limits` editor. |
| GET/PUT | `/app/admin/settings` | `reference.manage` | Renders from `settings.data_type`, so adding a key needs no new UI code. |
| GET/POST/PUT | `/app/admin/cost-heads`, `/app/admin/units`, `/app/admin/numbering` | `reference.manage` | Reference CRUD. A `cost_head` in use cannot be deleted, only deactivated. |
| GET | `/app/admin/audit` | `audit.view` | Filter by user, action, entity, date. `before_json` and `after_json` rendered as a field-level diff. |
| GET | `/app/admin/enquiries` | `enquiries.view` | The phase 1 table, with a "promote to lead" action once phase 5 lands. |
| POST | `/internal/cron/daily-rollup` | `X-Cron-Key` | Materialises `dashboard_daily_snapshot`. |

**The landing dashboard is not one page with hidden divs.** `src/dashboard/components/DashboardRouter.tsx` selects a widget list from the user's permission set:

- `owner` and `accounts_manager`: cash position, receivables ageing, projects over budget, pending approvals queue, month revenue against target.
- `project_manager` and `site_supervisor`: only their assigned projects, with today's DPR status (a red row for any assigned project with no DPR filed yesterday), open snags, material shortfalls, milestones due in 14 days.
- `sales_exec`: unassigned enquiry count, own leads by stage, quotes awaiting client response past 7 days.
- `hr_manager`: attendance not yet approved, documents expiring in 30 days, open job openings by stage.

Company KPI numbers come from `dashboard_daily_snapshot` written by the nightly cron, not computed live. Ten users do not justify caching for load reasons, but a cold app process computing six aggregate queries across `stock_ledger` and `expenses` before first paint is a visibly slow login, and the numbers are a day-scale metric anyway. Anything needing to be live (pending approvals, today's DPR status) is queried directly and is a cheap indexed lookup.

### 6.3 Projects tracker

The module the business actually runs on, and the one where generic CRUD fails hardest. A construction project is not a task list. It is a physical thing built in a fixed sequence, paid for against certified milestones, and constrained by weather, approvals, and concrete that cannot be poured on a whim. The published pages already state the operating model, so the schema encodes it rather than inventing one:

- `index.php` publishes a four-stage process with anchors `id="step1"` to `id="step4"`.
- `construction-packages-in-bengaluru.php` publishes 10 to 12 payment milestones, slump and 7 or 28 day cube tests, a 10-year structural warranty, and the BBMP, BMRDA, Gram Panchayat, BESCOM, and BWSSB approval set. `construction-company-in-tumkur.php` adds TUDA.
- `best-construction-company-in-bengaluru-projects.php` shows the real project mix as `PropertyValue` attributes: Built-up Area, Project Type, Scope of Work, Client Sector, Delivery Status, Compliance Standards. Honda Cars India carries "OEM standards", Recipharma is a machine foundation. These are not residential villas and a residential-only schema will not hold them.

**Tables** (`migrations/004_projects.sql`)

```
clients
  id, code VARCHAR(20) UNIQUE, name VARCHAR(180) NOT NULL,
  client_type ENUM('individual','company','institution','government') NOT NULL,
  sector VARCHAR(80) NULL,                     -- 'Pharmaceutical', 'Automotive OEM', 'Real Estate'
  gstin CHAR(15) NULL, pan CHAR(10) NULL,
  billing_address TEXT NULL, city VARCHAR(80), state VARCHAR(80) DEFAULT 'Karnataka',
  primary_contact_name VARCHAR(120), primary_contact_phone VARCHAR(20),
  primary_contact_email VARCHAR(190) NULL,
  status ENUM('active','dormant','blacklisted') DEFAULT 'active'

projects
  id, code VARCHAR(24) NOT NULL UNIQUE,        -- from document_numbering, 'NCC/PRJ/2026-27/014'
  name VARCHAR(200) NOT NULL,
  client_id BIGINT UNSIGNED NOT NULL,          -- FK clients ON DELETE RESTRICT
  project_type ENUM('residential_construction','commercial_construction',
    'industrial_construction','interior_fitout','civil_infrastructure',
    'machine_foundation','renovation','equipment_rental') NOT NULL,
  delivery_model ENUM('package_per_sqft','item_rate','lumpsum','cost_plus','labour_only')
    NOT NULL,                                  -- drives which costing view is shown
  package_id BIGINT UNSIGNED NULL,             -- FK site_packages, only for package_per_sqft
  built_up_area_sqft DECIMAL(12,2) NULL,
  plot_area_sqft DECIMAL(12,2) NULL,
  floors_count TINYINT UNSIGNED NULL,
  site_address TEXT NOT NULL, city VARCHAR(80) NOT NULL,
  survey_number VARCHAR(60) NULL,
  geo_lat DECIMAL(10,7) NULL, geo_lng DECIMAL(10,7) NULL,
  jurisdiction ENUM('BBMP','BMRDA','BDA','Gram Panchayat','TUDA','KIADB','Other') NULL,
  scope_of_work TEXT NULL,
  compliance_standards VARCHAR(255) NULL,      -- 'OEM standards', 'GMP', 'IS 456'
  contract_value_paise BIGINT NULL,            -- GATED by projects.view_cost
  contract_signed_on DATE NULL,
  rate_per_sqft_paise BIGINT NULL,             -- GATED
  retention_pct DECIMAL(5,2) DEFAULT 5.00,
  gst_pct DECIMAL(5,2) DEFAULT 18.00,
  planned_start DATE NULL, planned_end DATE NULL,
  actual_start DATE NULL, actual_end DATE NULL,
  status ENUM('prospect','mobilising','in_progress','on_hold','snagging',
    'handed_over','defect_liability','closed','cancelled') NOT NULL DEFAULT 'mobilising',
  hold_reason VARCHAR(255) NULL,
  physical_progress_pct DECIMAL(5,2) NOT NULL DEFAULT 0,   -- derived, see logic
  warranty_structural_until DATE NULL,         -- contract_signed_on + 10 years per the site
  warranty_general_until DATE NULL,            -- handover + 1 year per the site
  is_public_showcase TINYINT(1) NOT NULL DEFAULT 0,        -- feeds the marketing gallery
  KEY idx_projects_status (status), KEY idx_projects_client (client_id)

project_assignments        -- defined in 4.4

stage_templates (id, name VARCHAR(120), project_type, is_default TINYINT(1))
stage_template_items
  id, template_id, seq SMALLINT NOT NULL, name VARCHAR(140),
  weightage_pct DECIMAL(5,2) NOT NULL,         -- must sum to 100 per template, enforced in service
  typical_duration_days SMALLINT NULL,
  requires_quality_check TINYINT(1) NOT NULL DEFAULT 0,
  UNIQUE KEY uq_tpl_seq (template_id, seq)

project_stages             -- instantiated from the template at project creation
  id, project_id, seq SMALLINT, name VARCHAR(140),
  weightage_pct DECIMAL(5,2) NOT NULL,
  planned_start DATE NULL, planned_end DATE NULL,
  actual_start DATE NULL, actual_end DATE NULL,
  progress_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
  status ENUM('not_started','in_progress','blocked','complete') DEFAULT 'not_started',
  blocked_reason VARCHAR(255) NULL,
  predecessor_stage_id BIGINT UNSIGNED NULL,   -- FK self, finish-to-start only
  UNIQUE KEY uq_project_seq (project_id, seq)

project_milestones         -- PAYMENT milestones, distinct from stages
  id, project_id, seq SMALLINT, name VARCHAR(160),
  trigger_stage_id BIGINT UNSIGNED NULL,       -- FK project_stages, the physical trigger
  percent_of_contract DECIMAL(5,2) NULL,
  amount_paise BIGINT NULL,                    -- GATED
  due_basis ENUM('on_stage_complete','on_date','on_certification') NOT NULL,
  due_date DATE NULL,
  status ENUM('pending','ready_to_certify','certified','invoiced','part_paid',
    'paid','waived') NOT NULL DEFAULT 'pending',
  certified_by BIGINT UNSIGNED NULL, certified_on DATE NULL,
  invoice_id BIGINT UNSIGNED NULL,             -- FK client_invoices, set in phase 7
  KEY idx_ms_project_status (project_id, status)

daily_progress_reports
  id, project_id, report_date DATE NOT NULL,
  weather ENUM('clear','cloudy','light_rain','heavy_rain','unworkable') NOT NULL,
  work_stopped_hours DECIMAL(4,1) NOT NULL DEFAULT 0,
  stoppage_reason ENUM('none','rain','material_shortage','labour_shortage',
    'power_failure','client_instruction','statutory','equipment_breakdown',
    'safety_incident') NOT NULL DEFAULT 'none',
  labour_skilled SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  labour_unskilled SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  labour_contractor_id BIGINT UNSIGNED NULL,   -- FK labour_contractors, phase 6
  work_done TEXT NOT NULL,
  issues TEXT NULL, instructions_received TEXT NULL,
  submitted_by, submitted_at DATETIME NOT NULL,
  reviewed_by BIGINT UNSIGNED NULL, reviewed_at DATETIME NULL,
  UNIQUE KEY uq_dpr_project_date (project_id, report_date)

dpr_stage_progress (id, dpr_id, project_stage_id, progress_pct_at_eod DECIMAL(5,2))
dpr_photos (id, dpr_id, file_id BIGINT UNSIGNED, caption VARCHAR(200), taken_at DATETIME NULL)

quality_checks
  id, project_id, project_stage_id NULL,
  check_type ENUM('concrete_slump','cube_test_7day','cube_test_28day','steel_test',
    'plumb_level','waterproofing_ponding','electrical_insulation',
    'plumbing_pressure','soil_compaction','other') NOT NULL,
  reference_no VARCHAR(60) NULL,               -- lab report number
  sample_taken_on DATE NULL, tested_on DATE NULL,
  target_value DECIMAL(10,2) NULL, actual_value DECIMAL(10,2) NULL,
  unit VARCHAR(20) NULL,                       -- 'mm' for slump, 'N/mm2' for cube
  result ENUM('pass','fail','pending','retest') NOT NULL DEFAULT 'pending',
  lab_name VARCHAR(140) NULL, file_id BIGINT UNSIGNED NULL,
  signed_off_by BIGINT UNSIGNED NULL, signed_off_at DATETIME NULL,
  KEY idx_qc_project (project_id, result)

snags
  id, project_id, location VARCHAR(160) NOT NULL,   -- 'First floor, master bedroom'
  trade ENUM('civil','plaster','painting','electrical','plumbing','carpentry',
    'flooring','waterproofing','fabrication','other') NOT NULL,
  description TEXT NOT NULL,
  severity ENUM('cosmetic','functional','structural','safety') NOT NULL,
  raised_by, raised_on DATE NOT NULL, raised_source ENUM('internal','client','consultant'),
  assigned_to BIGINT UNSIGNED NULL, target_date DATE NULL,
  status ENUM('open','in_progress','resolved','verified','rejected','deferred')
    NOT NULL DEFAULT 'open',
  resolved_on DATE NULL, verified_by BIGINT UNSIGNED NULL, verified_on DATE NULL,
  before_file_id BIGINT UNSIGNED NULL, after_file_id BIGINT UNSIGNED NULL,
  KEY idx_snags_project_status (project_id, status)

project_approvals          -- the statutory set the site already advertises
  id, project_id,
  authority ENUM('BBMP','BMRDA','BDA','Gram Panchayat','TUDA','KIADB','BESCOM',
    'BWSSB','KSPCB','Fire','Lift Inspectorate','Other') NOT NULL,
  approval_type VARCHAR(140) NOT NULL,         -- 'Plan sanction', 'Temporary power', 'OC'
  reference_no VARCHAR(80) NULL,
  applied_on DATE NULL, received_on DATE NULL, valid_until DATE NULL,
  fee_paise BIGINT NULL, status ENUM('not_started','applied','queried','received',
    'rejected','expired') NOT NULL DEFAULT 'not_started',
  file_id BIGINT UNSIGNED NULL, blocks_stage_id BIGINT UNSIGNED NULL,
  KEY idx_appr_project (project_id, status)

project_documents
  id, project_id, doc_type ENUM('drawing','contract','boq','sanction','photo',
    'report','handover','warranty','correspondence','other') NOT NULL,
  title VARCHAR(200), revision VARCHAR(20) NULL,   -- 'R3', drawings revise constantly
  supersedes_id BIGINT UNSIGNED NULL,              -- FK self, so R2 is not lost
  is_current TINYINT(1) NOT NULL DEFAULT 1,
  file_id BIGINT UNSIGNED NOT NULL, visible_to_roles JSON NULL

files                      -- shared by every module
  id, storage_path VARCHAR(300) NOT NULL,      -- relative to STORAGE_ROOT, outside public_html
  original_name VARCHAR(255), mime VARCHAR(120), size_bytes INT UNSIGNED,
  sha256 CHAR(64), uploaded_by, KEY idx_files_sha (sha256)
```

**Routes**

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/app/projects` | `projects.view` | Scoped list. Filters: status, type, city, PM, overdue. |
| POST | `/app/projects` | `projects.manage` | Zod requires `client_id`, `project_type`, `delivery_model`, `site_address`. Creates stages from the template in one transaction. |
| GET | `/app/projects/:id` | `projects.view` + `requireProjectAccess` | Tabbed shell, tabs are separate htmx fragments. |
| GET | `/api/projects/:id/tab/:tab` | as tab requires | `tab` in overview, stages, dpr, quality, milestones, snags, approvals, materials, cost, documents, team. The `cost` tab route itself is behind `projects.view_cost` so it is not merely hidden. |
| PATCH | `/api/projects/:id/stages/:stageId/progress` | `projects.update_progress` | Body `{ progress_pct }`. Rejects if predecessor incomplete, see logic. |
| POST | `/api/projects/:id/dpr` | `projects.dpr_submit` | One per date, enforced by the unique key, so a double submit updates rather than duplicates. |
| POST | `/api/projects/:id/quality-checks` | `projects.dpr_submit` | Create. |
| PATCH | `/api/quality-checks/:id/signoff` | `projects.quality_signoff` | Records `signed_off_by`. |
| POST | `/api/projects/:id/milestones/:msId/certify` | `projects.milestone_certify` | The gate described below. |
| POST/PATCH | `/api/projects/:id/snags`, `/api/snags/:id` | `projects.snag_manage` | Status transitions validated against an allowed-transition map. |
| POST | `/api/projects/:id/approvals` | `projects.manage` | |
| POST | `/api/projects/:id/documents` | `projects.manage` | Multipart, 15 MB limit. Setting `supersedes_id` flips the old row's `is_current`. |
| PUT | `/api/projects/:id/team` | `projects.assign_staff` | Replaces `project_assignments`. |
| GET | `/api/projects/:id/export.csv` | `finance.export` | |
| POST | `/internal/cron/notifications` | `X-Cron-Key` | Missing DPR, milestone due, approval expiring, snag overdue. |

**Business logic**

1. **Progress is weighted and derived, never typed.** `projects.physical_progress_pct` is recomputed in `recalcProjectProgress(trx, projectId)` as `SUM(project_stages.progress_pct * weightage_pct) / 100` after any stage update. A PM cannot set project progress directly. This is the difference between a schedule and a wish. `stage_templates` weightage must sum to exactly 100.00 and `createProject` throws otherwise.

2. **Finish-to-start enforcement with an explicit override.** `PATCH .../progress` rejects moving a stage above 0 while its `predecessor_stage_id` is below 100, returning 422 with the blocking stage name. Sequence in construction is physical, not preference: you cannot plaster before the slab cures. The override requires `projects.manage` and writes `audit_log` with reason, because real sites do overlap trades and a hard block that cannot be broken gets worked around by lying about the data.

3. **Milestone certification is gated on quality, not on someone clicking done.** `certifyMilestone()` refuses when the `trigger_stage_id` stage has `progress_pct < 100`, or when any `quality_checks` row for that stage with `requires_quality_check` has `result != 'pass'`, or when a `cube_test_28day` for that stage is still `pending`. The site publicly promises slump and cube testing, so billing a slab milestone with a failed or missing cube test is both a quality failure and a claim the company already made in writing. On success the milestone moves to `certified` and becomes invoiceable in 6.8.

4. **Rain days are recorded because they are contractual.** `daily_progress_reports.work_stopped_hours` and `stoppage_reason` aggregate into a per-project rain-day count. Bengaluru monsoon delay is the single most common schedule dispute, and a DPR trail dated and signed at the time is the only defence against a liquidated-damages claim. `src/modules/projects/service.ts` exposes `getStoppageSummary(projectId)` which the delay-notice PDF reads.

5. **Missing DPR is a first-class alert.** The nightly cron creates a `notifications` row for the PM and `ops_manager` for any `in_progress` project with no DPR for the previous working day. A tracker nobody fills in is worse than a spreadsheet, because it looks authoritative while being stale.

6. **Warranty dates are computed, not entered.** On transition to `handed_over`, `warranty_general_until = actual_end + 1 year` and `warranty_structural_until = contract_signed_on + 10 years`, matching the published commitment. Status then auto-advances to `defect_liability` and the project stays visible to `site_supervisor` for snag work rather than disappearing from the list.

7. **Status transitions are a map, not free text.** `src/modules/projects/service.ts` holds `ALLOWED_TRANSITIONS: Record<ProjectStatus, ProjectStatus[]>`. `in_progress` to `closed` directly is not permitted; it must pass `snagging` and `handed_over`, and `handed_over` requires zero `snags` with `severity` in `structural` or `safety` still open.

8. **`is_public_showcase` closes the loop with the marketing site.** The seven `CreativeWork` nodes on `best-construction-company-in-bengaluru-projects.php` are currently hand-maintained markup. Once phase 8 lands, a project flagged showcase with its `built_up_area_sqft`, `project_type`, `scope_of_work`, `sector`, and `compliance_standards` renders both the gallery card and the JSON-LD `PropertyValue` list from one row.

**Pages and components**

`src/modules/projects/pages/{ProjectListPage,ProjectCreatePage,ProjectDetailPage}.tsx` plus tab fragments `tabs/{OverviewTab,StagesTab,DprTab,QualityTab,MilestonesTab,SnagsTab,ApprovalsTab,MaterialsTab,CostTab,DocumentsTab,TeamTab}.tsx`. Shared components in `src/dashboard/components/`: `StageGantt.tsx` (CSS grid bars, no charting library, because a 12-row Gantt does not justify shipping one), `ProgressRing.tsx`, `PhotoUploader.tsx` (Alpine, client-side resize to 1600px before upload so a 12 MP site photo does not hit the 15 MB body limit), `StatusPill.tsx`, `MoneyCell.tsx` (renders an em-free dash placeholder when `canViewCost` is false).

`DprTab` gets a dedicated mobile-first single-column form at `/app/projects/:id/dpr/new`. A supervisor fills this on a phone standing on a slab, so it is large tap targets, native `<input type="date">`, `capture="environment"` on the photo input, and it submits as a plain form post that works without htmx.

### 6.4 Inventory

Not a warehouse system. A construction inventory is multi-location by nature (a central store plus every active site), the same material moves between sites, and the two questions that matter are "did we receive what we paid for" and "is more cement leaving the store than the slab needs". The design point is therefore an **append-only stock ledger** with everything else derived from it, because a mutable `quantity_on_hand` column that gets updated by six code paths is how stock records stop matching reality.

The material specification is not invented. `construction-packages-in-bengaluru.php` already names the approved brands: UltraTech, ACC, Birla Super OPC 53 grade cement; JSW Neo, Tata Tiscon, Indus Fe500D and Fe550D steel; Kajaria and Somany tiles; Jaquar and Hindware sanitaryware; Finolex wiring; Havells, Legrand, Anchor switchgear; Fosroc and Dr. Fixit chemicals; Asian Paints SmartCare. Those become the seeded item master, and the approved-brand list is enforced, not decorative.

**Tables** (`migrations/005_inventory.sql`)

```
locations
  id, code VARCHAR(20) UNIQUE, name VARCHAR(140),
  location_type ENUM('central_store','site_store','yard','transit') NOT NULL,
  project_id BIGINT UNSIGNED NULL,             -- FK projects, set for site_store
  address TEXT NULL, is_active TINYINT(1) DEFAULT 1
  -- a project's site store is auto-created on project status -> mobilising

item_categories (id, code VARCHAR(20) UNIQUE, name VARCHAR(120),
  parent_id BIGINT UNSIGNED NULL, cost_head_id BIGINT UNSIGNED NOT NULL)
  -- FK cost_heads, so every material issue lands on the right cost line automatically

items
  id, code VARCHAR(30) NOT NULL UNIQUE,        -- 'CEM-OPC53-ULT'
  name VARCHAR(180) NOT NULL,
  category_id BIGINT UNSIGNED NOT NULL,
  unit_id BIGINT UNSIGNED NOT NULL,            -- FK units
  specification VARCHAR(255) NULL,             -- 'OPC 53 Grade, IS 269:2015'
  brand VARCHAR(80) NULL,
  is_approved_brand TINYINT(1) NOT NULL DEFAULT 1,
  tracking_mode ENUM('quantity','batch','serial') NOT NULL DEFAULT 'quantity',
  shelf_life_days SMALLINT UNSIGNED NULL,      -- cement 90, chemicals vary
  hsn_code VARCHAR(10) NULL, gst_pct DECIMAL(5,2) NOT NULL DEFAULT 18.00,
  reorder_level DECIMAL(14,3) NULL, reorder_qty DECIMAL(14,3) NULL,
  standard_rate_paise BIGINT NULL,             -- GATED by inventory.view_rates
  wastage_allowance_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
  is_active TINYINT(1) DEFAULT 1,
  KEY idx_items_category (category_id)

item_brands (id, item_id, brand VARCHAR(80), is_approved TINYINT(1),
  approved_by BIGINT UNSIGNED NULL, note VARCHAR(255) NULL)

vendors
  id, code VARCHAR(20) UNIQUE, name VARCHAR(180) NOT NULL,
  vendor_type ENUM('material','equipment_hire','subcontractor','service','transport'),
  gstin CHAR(15) NULL, pan CHAR(10) NULL, msme_udyam_no VARCHAR(20) NULL,
  -- msme matters: MSME Development Act payment terms are 45 days max and
  -- overrunning creates statutory interest, so the ageing report must flag it
  contact_name VARCHAR(120), phone VARCHAR(20), email VARCHAR(190) NULL,
  address TEXT NULL, city VARCHAR(80),
  payment_terms_days SMALLINT NOT NULL DEFAULT 30,
  bank_account_name VARCHAR(140) NULL, bank_account_no VARCHAR(30) NULL,
  bank_ifsc CHAR(11) NULL,
  rating_quality TINYINT NULL, rating_timeliness TINYINT NULL,  -- 1 to 5
  status ENUM('active','on_hold','blacklisted') DEFAULT 'active',
  blacklist_reason VARCHAR(255) NULL

vendor_item_rates            -- rate history, so a PO can be checked against the last rate
  id, vendor_id, item_id, rate_paise BIGINT NOT NULL,
  valid_from DATE NOT NULL, valid_to DATE NULL,
  freight_included TINYINT(1) DEFAULT 0, min_order_qty DECIMAL(14,3) NULL,
  KEY idx_vir (item_id, vendor_id, valid_from)

material_requisitions        -- site asks, store or procurement fulfils
  id, req_no VARCHAR(24) UNIQUE, project_id, requested_by, required_by_date DATE,
  project_stage_id BIGINT UNSIGNED NULL,
  status ENUM('draft','submitted','approved','partially_ordered','ordered',
    'closed','rejected') DEFAULT 'draft',
  approved_by BIGINT UNSIGNED NULL, approved_at DATETIME NULL, reject_reason VARCHAR(255)
requisition_lines (id, requisition_id, item_id, qty_requested DECIMAL(14,3),
  qty_approved DECIMAL(14,3) NULL, qty_ordered DECIMAL(14,3) DEFAULT 0, remarks VARCHAR(255))

purchase_orders
  id, po_no VARCHAR(24) NOT NULL UNIQUE,       -- document_numbering, FOR UPDATE
  vendor_id, project_id BIGINT UNSIGNED NULL,  -- NULL for central store stock
  requisition_id BIGINT UNSIGNED NULL,
  po_date DATE NOT NULL, expected_delivery DATE NULL,
  delivery_location_id BIGINT UNSIGNED NOT NULL,
  subtotal_paise BIGINT NOT NULL DEFAULT 0, gst_paise BIGINT NOT NULL DEFAULT 0,
  freight_paise BIGINT NOT NULL DEFAULT 0, total_paise BIGINT NOT NULL DEFAULT 0,
  payment_terms_days SMALLINT, advance_pct DECIMAL(5,2) DEFAULT 0,
  status ENUM('draft','pending_approval','approved','partially_received',
    'received','short_closed','cancelled') NOT NULL DEFAULT 'draft',
  approved_by BIGINT UNSIGNED NULL, approved_at DATETIME NULL,
  terms TEXT NULL, KEY idx_po_vendor (vendor_id), KEY idx_po_status (status)

po_lines (id, po_id, item_id, qty_ordered DECIMAL(14,3), rate_paise BIGINT,
  gst_pct DECIMAL(5,2), qty_received DECIMAL(14,3) NOT NULL DEFAULT 0,
  line_total_paise BIGINT, cost_head_id, remarks VARCHAR(255))

goods_receipts               -- GRN
  id, grn_no VARCHAR(24) UNIQUE, po_id BIGINT UNSIGNED NULL,  -- NULL allows direct receipt
  vendor_id, location_id, received_on DATE NOT NULL,
  vehicle_no VARCHAR(20) NULL, invoice_no VARCHAR(40) NULL, invoice_date DATE NULL,
  invoice_amount_paise BIGINT NULL,
  weighbridge_slip_no VARCHAR(40) NULL,        -- steel and sand arrive by weight
  gate_entry_no VARCHAR(30) NULL,
  status ENUM('draft','posted','cancelled') NOT NULL DEFAULT 'draft',
  received_by, inspected_by BIGINT UNSIGNED NULL,
  expense_id BIGINT UNSIGNED NULL              -- FK expenses, set when accounts books it

grn_lines
  id, grn_id, po_line_id BIGINT UNSIGNED NULL, item_id,
  qty_challan DECIMAL(14,3) NOT NULL,          -- what the delivery note claims
  qty_received DECIMAL(14,3) NOT NULL,         -- what was actually counted
  qty_accepted DECIMAL(14,3) NOT NULL,
  qty_rejected DECIMAL(14,3) NOT NULL DEFAULT 0,
  rejection_reason VARCHAR(255) NULL,
  batch_no VARCHAR(40) NULL, manufacture_date DATE NULL, expiry_date DATE NULL,
  rate_paise BIGINT NOT NULL, test_certificate_file_id BIGINT UNSIGNED NULL

stock_ledger                 -- APPEND ONLY, the single source of truth
  id, item_id, location_id,
  txn_date DATE NOT NULL, txn_type ENUM('grn','issue','return','transfer_out',
    'transfer_in','adjustment','opening') NOT NULL,
  ref_table VARCHAR(40) NOT NULL, ref_id BIGINT UNSIGNED NOT NULL,
  qty_in DECIMAL(14,3) NOT NULL DEFAULT 0, qty_out DECIMAL(14,3) NOT NULL DEFAULT 0,
  rate_paise BIGINT NULL, value_paise BIGINT NULL,
  balance_after DECIMAL(14,3) NOT NULL,        -- running balance, written under row lock
  project_id BIGINT UNSIGNED NULL, batch_no VARCHAR(40) NULL,
  created_by, KEY idx_ledger_item_loc (item_id, location_id, id),
  KEY idx_ledger_project (project_id, txn_date)

item_stock                   -- CACHE, rebuildable from stock_ledger at any time
  item_id, location_id, qty_on_hand DECIMAL(14,3) NOT NULL,
  value_paise BIGINT NOT NULL, last_txn_id BIGINT UNSIGNED,
  PRIMARY KEY (item_id, location_id)

material_issues
  id, issue_no VARCHAR(24) UNIQUE, location_id, project_id,
  project_stage_id BIGINT UNSIGNED NULL, issued_on DATE NOT NULL,
  issued_to_type ENUM('own_labour','labour_contractor','subcontractor') NOT NULL,
  labour_contractor_id BIGINT UNSIGNED NULL, received_by_name VARCHAR(120),
  purpose VARCHAR(255), status ENUM('posted','cancelled') DEFAULT 'posted', issued_by
issue_lines (id, issue_id, item_id, qty_issued DECIMAL(14,3),
  qty_returned DECIMAL(14,3) NOT NULL DEFAULT 0, rate_paise BIGINT,
  cost_head_id, batch_no VARCHAR(40) NULL)

stock_transfers (id, transfer_no VARCHAR(24) UNIQUE, from_location_id, to_location_id,
  dispatched_on DATE, received_on DATE NULL, vehicle_no VARCHAR(20) NULL,
  status ENUM('in_transit','received','cancelled') DEFAULT 'in_transit',
  dispatched_by, received_by BIGINT UNSIGNED NULL)
transfer_lines (id, transfer_id, item_id, qty_sent DECIMAL(14,3),
  qty_received DECIMAL(14,3) NULL, shortage_qty DECIMAL(14,3) NULL, rate_paise BIGINT)

stock_adjustments (id, location_id, adjustment_date DATE,
  reason ENUM('physical_count','damage','theft','expiry','wastage','correction'),
  narration VARCHAR(255) NOT NULL, approved_by BIGINT UNSIGNED NULL, created_by)
adjustment_lines (id, adjustment_id, item_id, qty_system DECIMAL(14,3),
  qty_physical DECIMAL(14,3), qty_diff DECIMAL(14,3), rate_paise BIGINT)

equipment                    -- the rental fleet enumerated in construction-services-in-bengaluru.php
  id, code VARCHAR(20) UNIQUE, name VARCHAR(140),
  equipment_type VARCHAR(80),                  -- 'JCB', 'Concrete Mixer', 'Scaffolding'
  ownership ENUM('owned','hired') NOT NULL,
  current_location_id BIGINT UNSIGNED NULL, current_project_id BIGINT UNSIGNED NULL,
  hire_rate_per_day_paise BIGINT NULL, hire_vendor_id BIGINT UNSIGNED NULL,
  next_service_due DATE NULL, insurance_valid_until DATE NULL,
  status ENUM('available','deployed','under_repair','retired') DEFAULT 'available'
equipment_deployments (id, equipment_id, project_id, from_date, to_date NULL,
  meter_start DECIMAL(10,1) NULL, meter_end DECIMAL(10,1) NULL,
  operator_name VARCHAR(120) NULL, expense_id BIGINT UNSIGNED NULL)
```

**Routes**

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/app/inventory` | `inventory.view` | Stock by item and location. Supervisors see only their site's locations. |
| GET | `/app/inventory/items`, POST, PUT `/api/inventory/items/:id` | `inventory.item_manage` | Master. Rates hidden without `inventory.view_rates`. |
| GET/POST | `/app/inventory/requisitions` | `inventory.view`, create needs `inventory.grn_create` | Site raises, procurement sees the queue. |
| POST | `/api/requisitions/:id/approve` | `inventory.approve_po` | |
| GET/POST | `/app/inventory/po` | `inventory.po_create` | Create from an approved requisition prefills lines. |
| POST | `/api/po/:id/submit` | `inventory.po_create` | Draft to `pending_approval`. |
| POST | `/api/po/:id/approve` | `inventory.approve_po` + limit | Self-approval blocked. Above the `approval_limits` value escalates. |
| GET | `/api/po/:id/print` | `inventory.view` | Server-rendered A4 HTML, printed to PDF by the browser. No PDF library on the server, which keeps the Worker-equivalent bundle small and the cold start fast. |
| POST | `/api/po/:id/short-close` | `inventory.po_create` | Reason mandatory. |
| GET/POST | `/app/inventory/grn` | `inventory.grn_create` | PO selection prefills expected quantities. |
| POST | `/api/grn/:id/post` | `inventory.grn_create` | Writes `stock_ledger`, updates `po_lines.qty_received`, flips PO status. Irreversible, only cancellable by a reversing entry. |
| GET/POST | `/app/inventory/issues` | `inventory.issue` | |
| POST | `/api/issues/:id/return` | `inventory.issue` | Unused material back to store. |
| GET/POST | `/app/inventory/transfers`, POST `/api/transfers/:id/receive` | `inventory.transfer` | Two-step, see logic. |
| GET/POST | `/app/inventory/adjustments` | `inventory.stock_adjust` | |
| GET | `/app/inventory/vendors`, `/app/inventory/vendors/:id` | `inventory.vendor_manage` | Includes rate history and the MSME flag. |
| GET | `/app/inventory/reports/consumption` | `inventory.view` | Actual versus theoretical, see logic. |
| GET | `/app/inventory/equipment` | `inventory.view` | Fleet and deployment. |
| POST | `/internal/cron/stock-alerts` | `X-Cron-Key` | Reorder level, expiry, equipment service and insurance. |

**Business logic**

1. **Every stock movement goes through `postStockMovement(trx, movement)` in `src/modules/inventory/service.ts`. There is exactly one writer.** It takes `SELECT ... FOR UPDATE` on the `item_stock` row, computes `balance_after`, inserts the `stock_ledger` row, and updates `item_stock`. GRN, issue, transfer, adjustment, and return all call it. Nothing else writes `item_stock`. `scripts/reconcile-stock.mjs` recomputes every `item_stock` row from the ledger and exits non-zero on a mismatch, run nightly as a canary.

2. **Negative stock is rejected, with one deliberate exception.** An issue exceeding `qty_on_hand` returns 422 naming the shortfall. The exception is `txn_type = 'opening'`, because during migration the physical count comes before the history. After phase 4 sign-off, `ALLOW_NEGATIVE` is false permanently.

3. **Three-way match on receipt.** `grn_lines` records `qty_challan`, `qty_received`, and `qty_accepted` as separate numbers. Sand and aggregate arrive short as a matter of routine, steel is billed by theoretical weight against actual weighbridge weight, and cement bags arrive torn. Recording only one quantity destroys the ability to claim a shortage. When `qty_challan != qty_received`, the GRN cannot post until `rejection_reason` is filled, and a `notifications` row goes to the procurement lead and accounts so the vendor invoice is queried before payment rather than after.

4. **Theoretical consumption comparison is the module's real payload.** `getConsumptionVariance(projectId)` compares issued quantity against a computed expectation: for a `package_per_sqft` project, `built_up_area_sqft * consumption_norm_per_sqft` per item, plus `items.wastage_allowance_pct`. Norms live in a seeded `consumption_norms` table (item, project type, quantity per sqft) with the initial values flagged in 8.4 because they are company-specific and must not be guessed. Cement issued at 0.45 bags per sqft against a 0.38 norm on a slab that is 60 percent complete is either theft, over-ordering, or a wrong mix ratio, and it is invisible without this comparison. This is the number that pays for the whole module.

5. **Transfers are two-step and hold stock in transit.** Dispatch moves quantity out of the source into a `transit` location, not directly into the destination. Receipt moves it from transit to destination and records `shortage_qty`. A single-step transfer means material that never arrived still shows as on hand at the destination site.

6. **Unapproved brand substitution is a controlled exception, not a silent one.** The published packages name specific brands, so a GRN line whose `items.brand` is not in `item_brands` with `is_approved = 1` requires `inventory.approve_po` to post and writes an `audit_log` entry plus a notification to the owner. A client who paid for UltraTech and got an unnamed brand is a warranty and reputation problem, and the site made that promise in public.

7. **Rate variance check at PO creation.** `createPurchaseOrder` compares each line rate against the latest `vendor_item_rates` row and the last three GRN rates for that item across all vendors. Above 10 percent it does not block, it surfaces "last purchased at X on date Y from vendor Z" inline in the form. Blocking a legitimate steel price rise is wrong, letting a rate quietly double is worse.

8. **Expiry drives issue order.** Items with `shelf_life_days` (cement, waterproofing chemicals, admixtures) are FIFO by `batch_no` and `expiry_date`. The issue screen preselects the oldest non-expired batch and warns on an expired one. Cement past 90 days loses strength, which links straight back to the cube tests in 6.3.

9. **Site store lifecycle is automatic.** A project moving to `mobilising` creates its `locations` row. A project moving to `closed` requires `qty_on_hand = 0` across its location, or the closure is refused with a return-or-transfer list. This is what stops phantom stock accumulating at finished sites, which is the single most common way construction inventory systems die.

**Pages and components**

`src/modules/inventory/pages/{StockDashboard,ItemMaster,ItemForm,RequisitionList,RequisitionForm,PoList,PoForm,PoPrint,GrnList,GrnForm,IssueList,IssueForm,TransferList,TransferForm,AdjustmentForm,VendorList,VendorDetail,ConsumptionReport,EquipmentList}.tsx`.

Components: `ItemPicker.tsx` (Alpine typeahead hitting `/api/inventory/items/search`, debounced 250ms, keyboard-first because a storekeeper enters twenty lines in a row), `LineItemGrid.tsx` (the shared editable grid for requisition, PO, GRN, and issue lines, with subtotal and GST computed client side for feedback and **recomputed server side** as authority), `StockBadge.tsx` (colour by `qty_on_hand` against `reorder_level`), `VarianceBar.tsx`, `BatchSelector.tsx`.

### 6.5 Marketing

This module is different in kind from the other seven. The rest are internal record keeping. This one **owns the public site**, so it is the only module whose writes are visible to the world and to Google. That single fact sets the whole design: content is versioned, publishing is a deliberate act with a preview, and the JSON-LD that currently sits hand-written in nine PHP files becomes generated output.

**How this module relates to the design and content freeze.** The freeze governs the port, not the client's future ability to edit their own site. This module is what makes the freeze sustainable rather than permanent: it gives the owner and marketing a way to change copy and prices deliberately, through a previewed and audited publish, instead of by editing PHP. So the sequence is strict. At phase 1 the content is frozen in `src/public/content/*.ts` and no one can change it. At phase 8 those exact values are migrated into the tables below, and `scripts/parity-check.mjs` is re-run against the same `legacy/golden/` masters to prove the migration to the database rendered the identical page. Only after that gate passes does anyone gain an edit box. Any change made through the editor afterwards is the client's own content decision, which is not what the freeze was protecting against.

The migration is therefore a **transcription, not an authoring exercise**. `site_pages.content_json` for the nine pages is generated by `scripts/extract-legacy-content.mjs` from the frozen content files, and the block types in the closed union exist because the current pages need them, not because a generic CMS would want them. The `parity-check.mjs` pass at the end of phase 8 is what proves no block type quietly dropped a piece of the page.

The existing SEO surface is substantial and must not be broken by giving a marketing user an edit box. `llms.txt` and `llms-full.txt` exist, the IndexNow key `097ee841c58a4b25b8eb2c348ca67dce` is live, GA4 `G-QX0C128DKX` is installed, and the JSON-LD `@graph` per page carries `LocalBusiness`, `GeneralContractor`, `HomeAndConstructionBusiness`, `WebSite`, `WebPage`, `BreadcrumbList`, `FAQPage`, and an `ItemList` of seven `CreativeWork` nodes. All of that becomes derived from the tables below, and per rule 7 the derived graph is diffed node for node against the archived original.

**Tables** (`migrations/006_marketing.sql`)

```
site_pages                   -- replaces the nine hand-edited PHP files
  id, slug VARCHAR(160) NOT NULL UNIQUE,       -- 'construction-packages-in-bengaluru', '' for home
  title VARCHAR(200) NOT NULL,                 -- <title>
  h1 VARCHAR(200) NULL,
  meta_description VARCHAR(320) NULL,
  canonical_path VARCHAR(200) NULL,
  og_image_file_id BIGINT UNSIGNED NULL,
  schema_types JSON NOT NULL,                  -- ['WebPage','FAQPage'], drives the @graph builder
  sitemap_priority DECIMAL(2,1) NOT NULL DEFAULT 0.5,   -- values from sitemap.php preserved
  sitemap_changefreq ENUM('always','hourly','daily','weekly','monthly','yearly','never')
    NOT NULL DEFAULT 'monthly',
  noindex TINYINT(1) NOT NULL DEFAULT 0,
  status ENUM('draft','published','archived') NOT NULL DEFAULT 'draft',
  published_at DATETIME NULL, published_by BIGINT UNSIGNED NULL,
  content_json JSON NOT NULL,                  -- ordered array of typed blocks, see below
  KEY idx_pages_status (status)

site_page_revisions          -- every publish snapshots the previous state
  id, page_id, revision_no INT UNSIGNED NOT NULL,
  content_json JSON NOT NULL, title, meta_description, schema_types JSON,
  changed_by, changed_at DATETIME NOT NULL, change_note VARCHAR(255) NULL,
  UNIQUE KEY uq_page_rev (page_id, revision_no)

site_packages                -- the four packages, currently hardcoded
  id, name VARCHAR(80) NOT NULL,               -- Silver, Platinum, Gold, Diamond
  slug VARCHAR(80) UNIQUE,
  rate_per_sqft_paise BIGINT NOT NULL,         -- 229900, 269900, 309900, 349900
  is_most_popular TINYINT(1) NOT NULL DEFAULT 0,   -- Gold is currently flagged
  min_area_sqft DECIMAL(10,2) NULL,
  summary VARCHAR(300) NULL, sort_order SMALLINT,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  effective_from DATE NOT NULL, effective_to DATE NULL
  -- effective dating matters: a project signed at the old rate must still
  -- resolve its rate, so package prices are never overwritten in place

package_spec_groups (id, package_id, group_name VARCHAR(120), sort_order SMALLINT)
  -- 'Foundation', 'Structure', 'Flooring', 'Electrical', 'Plumbing', 'Painting'
package_spec_lines
  id, group_id, label VARCHAR(160) NOT NULL, spec_value TEXT NOT NULL,
  item_id BIGINT UNSIGNED NULL,                -- FK items, links the promise to the store
  brand_options VARCHAR(255) NULL,             -- 'UltraTech / ACC / Birla Super'
  sort_order SMALLINT
  -- item_id is the join that makes 6.4 rule 6 enforceable: what was sold
  -- and what was received are the same row

site_services (id, slug UNIQUE, name VARCHAR(160), summary VARCHAR(300),
  body_json JSON, icon VARCHAR(60) NULL, sort_order SMALLINT, is_active TINYINT(1))
  -- the six services from construction-services-in-bengaluru.php

site_showcase                -- the seven CreativeWork nodes
  id, project_id BIGINT UNSIGNED NULL,         -- FK projects when is_public_showcase = 1
  title VARCHAR(200) NOT NULL,                 -- 'Excellence Technologies Phase 02'
  client_display_name VARCHAR(180) NULL,       -- may differ from clients.name for NDA reasons
  location VARCHAR(140) NULL,                  -- 'KIADB Doddaballapura', 'T Begur'
  built_up_area_display VARCHAR(60) NULL,      -- '40,000 sqft', kept as text for '30 acre'
  project_type_display VARCHAR(120) NULL, scope_of_work TEXT NULL,
  client_sector VARCHAR(120) NULL, delivery_status VARCHAR(80) NULL,
  compliance_standards VARCHAR(255) NULL,
  cover_file_id BIGINT UNSIGNED NULL, sort_order SMALLINT,
  is_published TINYINT(1) NOT NULL DEFAULT 1,
  client_consent_on_file TINYINT(1) NOT NULL DEFAULT 0    -- see logic
site_showcase_images (id, showcase_id, file_id, caption VARCHAR(200), sort_order)

site_faqs (id, page_id BIGINT UNSIGNED NULL, question VARCHAR(300),
  answer TEXT, sort_order SMALLINT, is_published TINYINT(1))
  -- page_id NULL means global; feeds the FAQPage JSON-LD per page

site_team (id, name VARCHAR(120), job_title VARCHAR(120), bio TEXT NULL,
  photo_file_id BIGINT UNSIGNED NULL, employee_id BIGINT UNSIGNED NULL,
  sort_order SMALLINT, is_published TINYINT(1))
  -- seeded: Chandrashekar T / Founder, Sushma N / Operations Analyst,
  -- Vinay / Procurement Lead, Naveen Kumar / Technical Advisor

site_testimonials (id, author_name VARCHAR(120), author_location VARCHAR(120) NULL,
  project_id BIGINT UNSIGNED NULL, rating TINYINT NULL, body TEXT NOT NULL,
  source ENUM('google','direct','email','whatsapp') NOT NULL,
  source_url VARCHAR(300) NULL, collected_on DATE, is_published TINYINT(1) DEFAULT 0)
  -- source and source_url are NOT NULL-in-practice for a reason, see logic

lead_sources (id, code VARCHAR(30) UNIQUE, name VARCHAR(120),
  channel ENUM('organic','paid_search','paid_social','referral','direct',
    'walk_in','whatsapp','call','listing_site','other') NOT NULL, is_active TINYINT(1))

campaigns
  id, name VARCHAR(160) NOT NULL, channel ENUM(...same as lead_sources.channel),
  platform VARCHAR(60) NULL,                   -- 'Google Ads', 'Meta', 'JustDial'
  objective ENUM('leads','awareness','recruitment','remarketing') NOT NULL,
  target_geo VARCHAR(160) NULL,                -- 'Bengaluru North', 'Tumkur'
  target_project_type VARCHAR(60) NULL,
  utm_source VARCHAR(60) NULL, utm_medium VARCHAR(60) NULL, utm_campaign VARCHAR(80) NULL,
  budget_paise BIGINT NULL, start_date DATE, end_date DATE NULL,
  status ENUM('planned','active','paused','completed','cancelled') DEFAULT 'planned',
  owner_user_id BIGINT UNSIGNED NULL,
  UNIQUE KEY uq_utm (utm_source, utm_medium, utm_campaign)

campaign_spend (id, campaign_id, spend_date DATE, amount_paise BIGINT,
  impressions INT UNSIGNED NULL, clicks INT UNSIGNED NULL,
  entry_mode ENUM('manual','api') DEFAULT 'manual', expense_id BIGINT UNSIGNED NULL,
  UNIQUE KEY uq_spend (campaign_id, spend_date))

seo_keywords (id, keyword VARCHAR(160), page_id BIGINT UNSIGNED NULL,
  target_city VARCHAR(80) NULL, is_tracked TINYINT(1) DEFAULT 1)
seo_rank_snapshots (id, keyword_id, captured_on DATE, position DECIMAL(5,1) NULL,
  impressions INT UNSIGNED NULL, clicks INT UNSIGNED NULL, ctr DECIMAL(6,4) NULL,
  UNIQUE KEY uq_rank (keyword_id, captured_on))

indexnow_submissions (id, url VARCHAR(300), submitted_at DATETIME,
  http_status SMALLINT NULL, response_body VARCHAR(500) NULL, triggered_by)
  -- replaces indexnow-log.txt

enquiries                    -- created in PHASE 1, before any of the above
  id, source_page VARCHAR(200) NULL, source_slug VARCHAR(160) NULL,
  name VARCHAR(120) NOT NULL, phone VARCHAR(20) NOT NULL,
  email VARCHAR(190) NULL, city VARCHAR(80) NULL,
  project_type VARCHAR(60) NULL, plot_size VARCHAR(60) NULL,
  budget_range VARCHAR(60) NULL, timeline VARCHAR(60) NULL, message TEXT NULL,
  utm_source VARCHAR(60) NULL, utm_medium VARCHAR(60) NULL,
  utm_campaign VARCHAR(80) NULL, utm_term VARCHAR(80) NULL, referrer VARCHAR(300) NULL,
  gclid VARCHAR(120) NULL, campaign_id BIGINT UNSIGNED NULL,
  ip VARBINARY(16) NULL, user_agent VARCHAR(255) NULL,
  is_spam TINYINT(1) NOT NULL DEFAULT 0, spam_reason VARCHAR(60) NULL,
  email_sent_at DATETIME NULL, email_error VARCHAR(255) NULL,
  lead_id BIGINT UNSIGNED NULL,                -- set on promotion in phase 5
  status ENUM('new','triaged','promoted','duplicate','spam','junk') DEFAULT 'new',
  KEY idx_enq_created (created_at), KEY idx_enq_status (status)
```

`content_json` block types are a closed union declared in `src/modules/marketing/schemas.ts` and validated by Zod on save: `hero`, `richtext`, `feature_grid`, `stat_row`, `process_steps`, `package_table`, `showcase_grid`, `faq_accordion`, `cta_band`, `testimonial_row`, `team_grid`, `image`, `table`, `raw_html`. Each renders through a matching component in `src/public/components/blocks/`. A free-form WYSIWYG storing arbitrary HTML would let a marketing user break the layout and the schema markup on a page ranking for "construction company in Bengaluru". `raw_html` exists as an escape hatch but requires `site_content.manage` plus a second confirm, and it is sanitised server side with an allowlist that strips `<script>`, `<style>`, `<iframe>`, and every `on*` attribute.

**Routes**

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/app/marketing` | `marketing.view` | Funnel: enquiries, qualified, won, spend, cost per won. |
| GET | `/app/marketing/pages` | `site_content.manage` | List with status, last published, revision count. |
| GET/PUT | `/app/marketing/pages/:id` | `site_content.manage` | Block editor. Saves to `draft`, never to live. |
| GET | `/app/marketing/pages/:id/preview` | `site_content.manage` | Renders the draft through the real public layout at `/app/...`, so what is previewed is what publishes. |
| POST | `/api/marketing/pages/:id/publish` | `marketing.content_publish` | Snapshots to `site_page_revisions`, sets `published_at`, purges the content cache, submits to IndexNow. |
| POST | `/api/marketing/pages/:id/revert/:revNo` | `marketing.content_publish` | Restores a revision as a new draft. |
| GET/PUT | `/app/marketing/packages` | `site_content.manage` | Rate change creates a new effective-dated row. |
| GET/PUT | `/app/marketing/showcase` | `site_content.manage` | Includes the consent checkbox. |
| GET/PUT | `/app/marketing/faqs`, `/team`, `/testimonials`, `/services` | `site_content.manage` | |
| GET/POST/PUT | `/app/marketing/campaigns` | `marketing.campaign_manage` | |
| POST | `/api/marketing/campaigns/:id/spend` | `marketing.spend_record` | Optionally creates the matching `expenses` row. |
| GET | `/app/marketing/attribution` | `marketing.analytics_view` | The report described below. |
| GET | `/app/marketing/seo` | `marketing.analytics_view` | Keyword positions from `seo_rank_snapshots`. |
| POST | `/api/marketing/indexnow` | `marketing.content_publish` | Manual resubmit. |
| GET | `/app/marketing/enquiries` | `enquiries.view` | Triage queue with spam toggle and promote action. |
| POST | `/internal/cron/seo-snapshot` | `X-Cron-Key` | Pulls Search Console, writes `seo_rank_snapshots`. |

Public routes owned by this module: `GET /sitemap.xml` (generated from `site_pages` where `status='published'` and `noindex=0`, preserving the priorities in `sitemap.php`), `GET /robots.txt` (with the domain corrected to `neelachandra.com`), `GET /llms.txt` and `/llms-full.txt` (regenerated from `site_pages`, so they stop drifting from the site), and `POST /enquiry` (the phase 1 handler).

**Business logic**

1. **The enquiry handler keeps the anti-spam design that already exists in `enquiry-handler.php` and fixes its three failures.** That file's honeypot `nc_website`, its `nc_started` time trap under three seconds, and its `hash_equals` CSRF check are good work and are ported directly into `src/modules/marketing/service.ts`. What changes: it is actually reachable (the current one is never included by `header.php`, verified), it writes to `enquiries` before attempting email so a Nodemailer failure cannot lose a lead, and `NC_ENQUIRY_DELIVERY = 'log'` is replaced by real SMTP with the send result recorded in `email_sent_at` or `email_error`. Honeypot and time-trap hits still return a fake success page and set `is_spam = 1` with `spam_reason`, because telling a bot it failed teaches it to retry.

2. **Attribution is derived across three modules, which is why this is phase 8.** `getAttribution(dateRange)` joins `campaign_spend` to `enquiries` on `campaign_id` (matched from UTM at capture, not guessed later), to `leads` via `enquiries.lead_id`, and to `projects` via `leads.converted_project_id`, producing cost per enquiry, cost per qualified lead, cost per won project, and revenue per rupee of spend by channel. Phone-only enquiries are counted honestly: a `walk_in` or `call` source with no UTM appears in an "unattributed" row rather than being silently distributed across channels. A construction business gets most leads by phone, so a report that hides that is worse than no report.

3. **Publishing invalidates one narrow cache and pings IndexNow.** Published `site_pages` rows are held in a module-level `Map` in `src/modules/marketing/queries.ts` keyed by slug. Publish clears the entry for that slug only. The cache is cold after every app-process sleep, which is acceptable because a page render is one indexed primary-key lookup. On publish, `submitToIndexNow([url])` posts to `api.indexnow.org` with the existing key and logs to `indexnow_submissions`. The key file `097ee841c58a4b25b8eb2c348ca67dce.txt` must keep serving its exact current content or every submission fails validation.

4. **Package rate changes are effective-dated, never overwritten.** Changing Gold from 3,099 to 3,299 per sqft closes the current row with `effective_to` and inserts a new one. Projects reference `package_id` at signing, and a client who signed at the old rate must still be billable at it. The public page always renders the row where `CURRENT_DATE BETWEEN effective_from AND COALESCE(effective_to, '9999-12-31')`.

5. **The showcase entries migrate exactly as published, and the consent flag is a warning, not a gate on existing rows.** The live site currently names Honda Cars India, Recipharma, Nambiar Ellegenza, and Mandot Steel. Those four migrate with `is_published = 1` and their current copy and images intact, because unpublishing them is a content change and the freeze forbids it. `client_consent_on_file` defaults to 0 on migrated rows and the admin list shows an unmissable flag against any published row where it is 0. The hard gate, `client_consent_on_file = 1` required before `is_published` can be set, applies **only to rows created after go-live**. Naming an automotive OEM or a pharmaceutical client as a reference without written permission is real contractual exposure and several of those sectors carry explicit confidentiality clauses, so the exposure is surfaced to the owner rather than silently accepted. Whether to act on it is 8.5, and it is your call, not the system's.

6. **The 4.8 rating is ported exactly as it appears today, including the five `aggregateRating` nodes and their four contradictory review counts.** `about-us.php` renders the rating as visible text plus `rating.webp` and `stars.webp`, and five of the ten pages emit an `AggregateRating` in JSON-LD at `reviewCount` 2, 4, 4, 30 and 87 respectively (verified from the golden capture; the old `README.md` claim that it was removed is wrong). All of that migrates unchanged, because it is existing content and the freeze governs it. Reproducing a known defect is uncomfortable, so the mechanism is explicit: `site_pages.schema_types` carries a per-page `aggregate_rating_override` holding the exact literal node that page emits today, and `buildGraph` emits it verbatim. That keeps the port faithful **and** makes the wrong data visible in one queryable place instead of buried in nine PHP files, which is what makes fixing it a one-row edit later. The dormant honest path stays available: when `aggregate_rating_override` is null, `buildGraph` emits a computed node only if `COUNT(site_testimonials WHERE is_published AND rating IS NOT NULL)` is at least 5, using the real average and count. Clearing the five overrides is the single change that switches the site from asserted to derived, and it needs your decision in 8.5 because it is a content change with SEO consequences either way.

7. **The JSON-LD builder is one function, not nine copies, and its output is diffed against the originals.** `src/public/seo/schema.ts` exports `buildGraph(page, context)`. Organisation-level nodes (`LocalBusiness`, `GeneralContractor`, `HomeAndConstructionBusiness`, address, `areaServed`, `knowsAbout`, `sameAs` from the five social links in `top-social.php`) come from `settings`. Page-level nodes come from `site_pages.schema_types`. `FAQPage` is emitted only when the page has published `site_faqs`, matching the pages that carry one today. `ItemList` of the seven `CreativeWork` nodes comes from `site_showcase`. `BreadcrumbList` is derived from the route instead of being hand-written. Consolidating nine drifting copies into one function is a source-code change with no rendered effect, so it is inside the freeze, but only if the emitted graph is equivalent. `scripts/parity-check.mjs` extracts every `application/ld+json` block from the golden master and from staging, parses both, and compares node sets by `@type` and `@id`. A node present in the original and absent from the port fails the build. This is the only safe way to deduplicate SEO markup on a site that ranks.

**Pages and components**

`src/modules/marketing/pages/{MarketingDashboard,PageList,PageEditor,PagePreview,PackageEditor,ShowcaseEditor,FaqEditor,TeamEditor,TestimonialEditor,ServiceEditor,CampaignList,CampaignDetail,SpendEntry,AttributionReport,SeoDashboard,EnquiryQueue}.tsx`.

`PageEditor.tsx` is the one place in the codebase where a real client-side component is justified: an Alpine store holding the block array, drag reordering, and per-block sub-forms rendered by htmx from `/api/marketing/blocks/:type/form`. Chart.js is loaded only on `MarketingDashboard`, `AttributionReport`, and `SeoDashboard`.

### 6.6 HR and recruiting

Two populations that must not share a table. **Employees** are the ten or so people on payroll with logins, PF, and ESI. **Labour** is contractor-supplied headcount that turns up in numbers on a site, is paid per day or per unit through a contractor, and never has a login. `daily_progress_reports` already counts `labour_skilled` and `labour_unskilled` as raw numbers, which is correct for a DPR and useless for payment. Modelling site labour as employees produces a 200-row employee master of people who worked three days each; modelling contractors as vendors only means no attendance record to verify their bill against. So both exist, separately, and both feed 6.8.

**Tables** (`migrations/007_hr.sql`)

```
departments (id, code VARCHAR(20) UNIQUE, name VARCHAR(80),
  head_employee_id BIGINT UNSIGNED NULL)
designations (id, title VARCHAR(120), department_id, grade VARCHAR(20) NULL)

employees
  id, employee_code VARCHAR(20) NOT NULL UNIQUE,
  user_id BIGINT UNSIGNED NULL UNIQUE,         -- FK users, NULL for staff with no login
  full_name VARCHAR(140) NOT NULL,
  father_or_spouse_name VARCHAR(140) NULL,     -- required on PF and ESI forms
  date_of_birth DATE NULL, gender ENUM('male','female','other') NULL,
  blood_group VARCHAR(5) NULL,                 -- site safety records need it
  personal_phone VARCHAR(20), personal_email VARCHAR(190) NULL,
  emergency_contact_name VARCHAR(120), emergency_contact_phone VARCHAR(20),
  permanent_address TEXT NULL, current_address TEXT NULL,
  department_id, designation_id,
  reporting_to_employee_id BIGINT UNSIGNED NULL,
  employment_type ENUM('permanent','probation','contract','intern','consultant')
    NOT NULL DEFAULT 'probation',
  date_of_joining DATE NOT NULL, probation_until DATE NULL,
  date_of_exit DATE NULL, exit_type ENUM('resigned','terminated','retired',
    'contract_ended','absconded') NULL, exit_reason VARCHAR(255) NULL,
  base_location_id BIGINT UNSIGNED NULL,       -- FK locations
  pan CHAR(10) NULL, aadhaar_last4 CHAR(4) NULL,   -- full Aadhaar deliberately NOT stored
  uan VARCHAR(12) NULL, pf_number VARCHAR(30) NULL, esi_number VARCHAR(20) NULL,
  bank_account_name VARCHAR(140) NULL, bank_account_no VARCHAR(30) NULL,
  bank_ifsc CHAR(11) NULL,
  status ENUM('active','on_notice','on_leave','suspended','exited')
    NOT NULL DEFAULT 'active',
  KEY idx_emp_status (status)

employee_compensation        -- SEPARATE TABLE, gated by hr.payroll_view
  id, employee_id, effective_from DATE NOT NULL, effective_to DATE NULL,
  ctc_annual_paise BIGINT NOT NULL,
  basic_paise BIGINT, hra_paise BIGINT, conveyance_paise BIGINT,
  special_allowance_paise BIGINT, site_allowance_paise BIGINT,
  employer_pf_paise BIGINT, employer_esi_paise BIGINT,
  revision_reason VARCHAR(160) NULL, approved_by,
  KEY idx_comp_emp (employee_id, effective_from)
  -- salary is a separate table, not columns on employees, so that
  -- hr.employee_view can be granted without exposing pay, and so history survives

employee_documents
  id, employee_id,
  doc_type ENUM('aadhaar','pan','passport','driving_licence','educational',
    'experience','offer_letter','appointment_letter','police_verification',
    'medical_fitness','safety_training','trade_certificate','other') NOT NULL,
  document_no VARCHAR(60) NULL, issued_on DATE NULL, expires_on DATE NULL,
  file_id BIGINT UNSIGNED NOT NULL, verified_by BIGINT UNSIGNED NULL,
  verified_on DATE NULL, KEY idx_empdoc_expiry (expires_on)

attendance
  id, employee_id, attendance_date DATE NOT NULL,
  project_id BIGINT UNSIGNED NULL,             -- which site, for cost allocation
  status ENUM('present','absent','half_day','weekly_off','holiday',
    'paid_leave','unpaid_leave','on_duty_travel','comp_off') NOT NULL,
  in_time TIME NULL, out_time TIME NULL,
  overtime_hours DECIMAL(4,1) NOT NULL DEFAULT 0,
  marked_by, marked_at DATETIME NOT NULL,
  approved_by BIGINT UNSIGNED NULL, approved_at DATETIME NULL,
  remarks VARCHAR(255) NULL,
  UNIQUE KEY uq_att (employee_id, attendance_date),
  KEY idx_att_project_date (project_id, attendance_date)

leave_types (id, code VARCHAR(20) UNIQUE, name VARCHAR(80),
  annual_quota DECIMAL(4,1), is_paid TINYINT(1), carry_forward_max DECIMAL(4,1),
  requires_document TINYINT(1) DEFAULT 0, min_notice_days SMALLINT DEFAULT 0)
  -- Karnataka Shops and Establishments baseline, exact quotas are 8.6

leave_balances (id, employee_id, leave_type_id, financial_year CHAR(7),
  opening DECIMAL(5,1), accrued DECIMAL(5,1), availed DECIMAL(5,1),
  encashed DECIMAL(5,1), balance DECIMAL(5,1),
  UNIQUE KEY uq_bal (employee_id, leave_type_id, financial_year))

leave_requests
  id, employee_id, leave_type_id, from_date DATE, to_date DATE,
  days DECIMAL(4,1) NOT NULL, reason VARCHAR(255),
  handover_to_employee_id BIGINT UNSIGNED NULL,
  status ENUM('pending','approved','rejected','cancelled','withdrawn')
    NOT NULL DEFAULT 'pending',
  approved_by BIGINT UNSIGNED NULL, approved_at DATETIME NULL,
  reject_reason VARCHAR(255) NULL, file_id BIGINT UNSIGNED NULL

labour_contractors
  id, code VARCHAR(20) UNIQUE, name VARCHAR(180) NOT NULL,
  vendor_id BIGINT UNSIGNED NULL,              -- FK vendors, so payment reuses 6.8
  contact_phone VARCHAR(20), pan CHAR(10) NULL, gstin CHAR(15) NULL,
  trade_specialisation VARCHAR(160) NULL,      -- 'Barbending', 'Masonry', 'Plumbing'
  licence_no VARCHAR(60) NULL,                 -- Contract Labour (R and A) Act licence
  licence_valid_until DATE NULL,
  esi_registered TINYINT(1) NOT NULL DEFAULT 0, pf_registered TINYINT(1) DEFAULT 0,
  wc_policy_no VARCHAR(60) NULL, wc_policy_valid_until DATE NULL,   -- workmen's comp
  rating TINYINT NULL, status ENUM('active','on_hold','blacklisted') DEFAULT 'active'

contractor_rates (id, contractor_id, project_id BIGINT UNSIGNED NULL,
  work_type VARCHAR(120), uom ENUM('per_day','per_sqft','per_cum','per_kg','lumpsum'),
  skill_level ENUM('skilled','semi_skilled','unskilled','mason','carpenter',
    'barbender','plumber','electrician','painter','helper') NULL,
  rate_paise BIGINT NOT NULL, effective_from DATE, effective_to DATE NULL)

contractor_attendance        -- headcount per day, the basis of the contractor bill
  id, contractor_id, project_id, attendance_date DATE NOT NULL,
  skill_level ENUM(...as above) NOT NULL,
  headcount SMALLINT UNSIGNED NOT NULL,
  overtime_hours DECIMAL(5,1) NOT NULL DEFAULT 0,
  rate_paise BIGINT NOT NULL,                  -- snapshot, not a join, rates change
  amount_paise BIGINT NOT NULL,
  recorded_by, approved_by BIGINT UNSIGNED NULL, approved_at DATETIME NULL,
  bill_id BIGINT UNSIGNED NULL,                -- FK contractor_bills
  UNIQUE KEY uq_ca (contractor_id, project_id, attendance_date, skill_level)

contractor_bills (id, bill_no VARCHAR(24) UNIQUE, contractor_id, project_id,
  period_from DATE, period_to DATE,
  gross_paise BIGINT, advance_recovered_paise BIGINT DEFAULT 0,
  retention_paise BIGINT DEFAULT 0, tds_paise BIGINT DEFAULT 0,
  penalty_paise BIGINT DEFAULT 0, net_payable_paise BIGINT,
  status ENUM('draft','submitted','verified','approved','paid','disputed')
    DEFAULT 'draft',
  verified_by BIGINT UNSIGNED NULL, approved_by BIGINT UNSIGNED NULL,
  expense_id BIGINT UNSIGNED NULL)

safety_incidents             -- statutory, and a site business will have them
  id, project_id, incident_date DATE, incident_time TIME NULL,
  severity ENUM('near_miss','first_aid','medical_treatment','lost_time',
    'permanent_disability','fatality') NOT NULL,
  affected_person_type ENUM('employee','contract_labour','visitor','third_party'),
  employee_id BIGINT UNSIGNED NULL, contractor_id BIGINT UNSIGNED NULL,
  affected_person_name VARCHAR(140) NULL,
  description TEXT NOT NULL, immediate_action TEXT NULL, root_cause TEXT NULL,
  corrective_action TEXT NULL, reported_to_authority TINYINT(1) DEFAULT 0,
  authority_reference VARCHAR(80) NULL, days_lost SMALLINT UNSIGNED DEFAULT 0,
  closed_on DATE NULL, reported_by

job_openings (id, code VARCHAR(20) UNIQUE, title VARCHAR(140),
  department_id, designation_id, openings TINYINT UNSIGNED DEFAULT 1,
  employment_type, experience_min_years TINYINT, experience_max_years TINYINT,
  budget_ctc_min_paise BIGINT NULL, budget_ctc_max_paise BIGINT NULL,
  location_city VARCHAR(80), job_description TEXT, requirements TEXT NULL,
  status ENUM('draft','open','on_hold','filled','cancelled') DEFAULT 'draft',
  is_published_on_site TINYINT(1) DEFAULT 0,   -- publishes to a public /careers route
  target_close_date DATE NULL, hiring_manager_employee_id BIGINT UNSIGNED NULL)

applicants (id, job_opening_id, full_name VARCHAR(140), phone VARCHAR(20),
  email VARCHAR(190) NULL, current_employer VARCHAR(160) NULL,
  total_experience_years DECIMAL(4,1) NULL, current_ctc_paise BIGINT NULL,
  expected_ctc_paise BIGINT NULL, notice_period_days SMALLINT NULL,
  resume_file_id BIGINT UNSIGNED NULL, source ENUM('referral','naukri','indeed',
  'website','walk_in','linkedin','consultant','other'),
  referred_by_employee_id BIGINT UNSIGNED NULL,
  stage ENUM('applied','screening','shortlisted','interview_1','interview_2',
    'technical_test','reference_check','offer_made','offer_accepted',
    'offer_declined','joined','rejected','on_hold') NOT NULL DEFAULT 'applied',
  rejection_reason VARCHAR(255) NULL, rating TINYINT NULL,
  converted_employee_id BIGINT UNSIGNED NULL)

applicant_stage_history (id, applicant_id, from_stage VARCHAR(30) NULL,
  to_stage VARCHAR(30), moved_by, moved_at DATETIME, note VARCHAR(500) NULL)
applicant_interviews (id, applicant_id, round_no TINYINT, scheduled_at DATETIME,
  mode ENUM('in_person','phone','video'), interviewer_employee_id,
  outcome ENUM('pending','pass','fail','no_show') DEFAULT 'pending',
  feedback TEXT NULL, score TINYINT NULL)
```

**Routes**

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/app/hr` | `hr.employee_view` | Headcount, attendance not approved, expiring documents, open positions. |
| GET/POST | `/app/hr/employees` | view / `hr.employee_manage` | |
| GET | `/app/hr/employees/:id` | `hr.employee_view` | Compensation tab is a separate fragment behind `hr.payroll_view`. |
| GET/PUT | `/api/hr/employees/:id/compensation` | `hr.payroll_view` + `hr.employee_manage` | Revision creates a new effective-dated row. |
| POST | `/api/hr/employees/:id/documents` | `hr.document_manage` | |
| POST | `/api/hr/employees/:id/exit` | `hr.employee_manage` | Runs the exit checklist, see logic. |
| GET | `/app/hr/attendance` | `hr.employee_view` | Month grid, employees down, days across. |
| POST | `/api/hr/attendance/bulk` | `hr.attendance_record` | One post for a whole day across a project. |
| POST | `/api/hr/attendance/approve` | `hr.attendance_approve` | Period lock, see logic. |
| GET/POST | `/app/hr/leave`, POST `/api/hr/leave/:id/approve` | own / `hr.leave_approve` | Any employee with a login raises their own. |
| GET/POST | `/app/hr/contractors` | `hr.labour_contractor_manage` | |
| POST | `/api/hr/contractor-attendance` | `hr.attendance_record` | Supervisor enters headcount per skill per day. |
| POST | `/api/hr/contractor-bills/generate` | `hr.labour_contractor_manage` | Builds the bill from approved attendance, see logic. |
| POST | `/api/hr/contractor-bills/:id/approve` | `hr.labour_contractor_manage` + limit | Creates the `expenses` row in 6.8. |
| GET/POST | `/app/hr/safety` | `hr.employee_view` / `hr.employee_manage` | Incident register. |
| GET/POST | `/app/hr/recruiting/openings` | `hr.recruit_manage` | |
| GET/POST | `/app/hr/recruiting/applicants` | `hr.recruit_manage` | Kanban by stage. |
| PATCH | `/api/hr/applicants/:id/stage` | `hr.recruit_manage` | Writes `applicant_stage_history`. |
| POST | `/api/hr/applicants/:id/convert` | `hr.employee_manage` | Creates `employees` and optionally invites a `users` row. |
| GET | `/app/hr/reports/muster` | `hr.employee_view` | Statutory muster roll for a month. |
| POST | `/internal/cron/document-expiry` | `X-Cron-Key` | Employee documents, contractor licences, WC policies. |

**Business logic**

1. **Attendance is per project per day, because that is the cost allocation key.** A supervisor who spends Monday at Doddaballapura and Tuesday at T Begur produces two rows with two `project_id` values, and 6.8 charges the right project. Attendance with `project_id` NULL falls to overhead. This is the reason attendance is in scope at all for a ten-person company: without it there is no defensible split of staff cost across projects, and the margin per project is guesswork.

2. **Contractor bills are generated from approved attendance, never typed.** `generateContractorBill(contractorId, projectId, from, to)` sums `contractor_attendance` rows with `approved_at IS NOT NULL` and no `bill_id`, using the `rate_paise` snapshotted on each row, then applies advance recovery, retention, TDS under section 194C, and any penalty. It stamps `bill_id` on every consumed row inside the transaction so the same day cannot be billed twice. Double-billed labour days are the most common leak in a site business and the unique key plus the `bill_id` stamp is what closes it.

3. **Contractor compliance blocks deployment, with an override.** Creating `contractor_attendance` against a contractor whose `licence_valid_until` or `wc_policy_valid_until` has passed returns 422. An uninsured worker injured on site is a personal liability for the owner, not a paperwork issue. The override needs `hr.labour_contractor_manage` and is audited.

4. **Attendance months lock.** Once `hr.attendance_approve` closes a month, `attendance` rows for that period reject updates unless `finance.period_close` is held, mirroring 6.8 rule 7. Otherwise a payroll figure changes after the payment is made.

5. **Compensation is a table, not columns.** `employee_compensation` is effective-dated and separately permissioned. `hr.employee_view` renders the profile with no pay figures at all, because the query does not select from that table. This is what lets `ops_manager` see the team without seeing salaries.

6. **Full Aadhaar is not stored.** Only `aadhaar_last4` plus the scanned document in `files` under an access-checked route. The Aadhaar Act restricts storage and there is no operational need for the number in a query. `files` sits outside `public_html` with `GET /api/files/:id` enforcing permission, so a leaked filename does not leak a document.

7. **Exit runs a checklist, not a status flip.** `POST .../exit` in one transaction: sets `date_of_exit` and `status`, deactivates the linked `users` row and deletes its sessions (6.1), lists open `project_assignments`, unreturned issued material where they were `received_by_name`, deployed `equipment`, and unapproved `expenses` they raised, and refuses to complete while any remain unless overridden with a reason. A person leaving with the site store keys and three open advances is the normal case, not the exception.

8. **Recruiting reflects what this company hires.** The `applicants.source` enum includes `consultant` and `walk_in` because site engineers and supervisors in Bengaluru arrive that way, and `referred_by_employee_id` exists because referral is the dominant channel at this size. `job_openings.is_published_on_site` drives a public `/careers` route generated from the same row, which is the second place where the internal system writes to the public site.

**Pages and components**

`src/modules/hr/pages/{HrDashboard,EmployeeList,EmployeeForm,EmployeeDetail,CompensationTab,AttendanceGrid,AttendanceBulkEntry,LeaveList,LeaveForm,ContractorList,ContractorDetail,ContractorAttendanceEntry,ContractorBillList,ContractorBillDetail,SafetyRegister,SafetyIncidentForm,OpeningList,OpeningForm,ApplicantBoard,ApplicantDetail,MusterRoll}.tsx`.

`AttendanceGrid.tsx` is a month-by-employee matrix with keyboard entry (arrow keys to move, single letter to set status) built in Alpine, because HR marks a whole month in one sitting and a click-per-cell form is unusable. `ContractorAttendanceEntry.tsx` is the mobile counterpart: skill rows, number steppers, one submit, usable one-handed at a site gate. `ApplicantBoard.tsx` uses htmx `hx-post` on drop rather than a drag library.

### 6.7 Sales and CRM

A construction sales cycle is not a SaaS funnel. It runs three to twelve months, the decisive artefact is a site visit and a per-sqft quote against a plot the client already owns, and the qualifying question is whether the plot has clear title and a sanctionable plan, not whether the prospect is interested. The pipeline stages below reflect that. Nothing here is a generic lead-status list.

The module inherits `enquiries` from phase 1 rather than duplicating capture. `contact-us.php` currently emails `nccpmd@gmail.com` and nothing more, so today there is no pipeline at all, which makes even a basic version an immediate improvement.

**Tables** (`migrations/008_crm.sql`)

```
leads
  id, lead_no VARCHAR(24) NOT NULL UNIQUE,
  enquiry_id BIGINT UNSIGNED NULL UNIQUE,      -- FK enquiries, NULL for phone or walk-in
  client_id BIGINT UNSIGNED NULL,              -- FK clients, set at conversion
  contact_name VARCHAR(140) NOT NULL,
  phone VARCHAR(20) NOT NULL, alt_phone VARCHAR(20) NULL,
  email VARCHAR(190) NULL,
  lead_source_id BIGINT UNSIGNED NULL, campaign_id BIGINT UNSIGNED NULL,
  referred_by_client_id BIGINT UNSIGNED NULL,  -- referral from a past client, tracked separately
  enquiry_type ENUM('residential_construction','commercial_construction',
    'industrial_construction','interior_fitout','renovation',
    'equipment_rental','consultation_only') NOT NULL,
  -- site and feasibility, the actual qualifiers
  site_city VARCHAR(80) NULL, site_locality VARCHAR(120) NULL,
  survey_number VARCHAR(60) NULL,
  plot_area_sqft DECIMAL(12,2) NULL,
  plot_dimensions VARCHAR(40) NULL,            -- '30x40', how clients actually describe it
  target_built_up_sqft DECIMAL(12,2) NULL,
  floors_wanted TINYINT UNSIGNED NULL,
  jurisdiction ENUM('BBMP','BMRDA','BDA','Gram Panchayat','TUDA','KIADB','Other') NULL,
  plot_ownership ENUM('owned_clear_title','owned_under_verification','agreement_stage',
    'joint_development','not_yet_purchased') NULL,
  has_sanctioned_plan TINYINT(1) NULL,
  has_architect TINYINT(1) NULL, architect_name VARCHAR(140) NULL,
  -- commercial
  budget_min_paise BIGINT NULL, budget_max_paise BIGINT NULL,
  preferred_package_id BIGINT UNSIGNED NULL,
  funding_mode ENUM('self','home_loan','loan_sanctioned','loan_applied',
    'company_capex') NULL,
  expected_start ENUM('immediate','within_1_month','1_to_3_months',
    '3_to_6_months','beyond_6_months','exploring') NULL,
  -- pipeline
  stage ENUM('new','contacted','qualified','site_visit_scheduled','site_visit_done',
    'estimate_shared','quote_sent','negotiation','verbal_agreement',
    'won','lost','dormant','disqualified') NOT NULL DEFAULT 'new',
  stage_changed_at DATETIME NOT NULL,
  score TINYINT UNSIGNED NOT NULL DEFAULT 0,   -- computed, see logic
  temperature ENUM('hot','warm','cold') NOT NULL DEFAULT 'warm',
  assigned_to BIGINT UNSIGNED NULL,            -- FK users, NULL = unassigned pool
  assigned_at DATETIME NULL,
  next_action VARCHAR(200) NULL, next_action_date DATE NULL,
  first_response_at DATETIME NULL,             -- for the SLA metric
  expected_value_paise BIGINT NULL,            -- computed, see logic
  probability_pct TINYINT UNSIGNED NULL,       -- from stage, overridable
  lost_reason ENUM('price','timeline','competitor','plot_issue','loan_rejected',
    'postponed','no_response','out_of_scope','duplicate','other') NULL,
  lost_to_competitor VARCHAR(140) NULL, lost_notes VARCHAR(500) NULL,
  converted_project_id BIGINT UNSIGNED NULL,   -- FK projects
  KEY idx_leads_stage (stage), KEY idx_leads_assigned (assigned_to, stage),
  KEY idx_leads_next (next_action_date)

lead_activities
  id, lead_id,
  activity_type ENUM('call_out','call_in','whatsapp','email','meeting',
    'site_visit','quote_sent','follow_up','note','status_change') NOT NULL,
  occurred_at DATETIME NOT NULL,
  duration_minutes SMALLINT UNSIGNED NULL,
  outcome ENUM('connected','no_answer','busy','wrong_number','call_back_later',
    'not_interested','positive','negative','neutral') NULL,
  summary VARCHAR(500) NOT NULL,
  next_action VARCHAR(200) NULL, next_action_date DATE NULL,
  file_id BIGINT UNSIGNED NULL, created_by,
  KEY idx_act_lead (lead_id, occurred_at)

lead_stage_history (id, lead_id, from_stage VARCHAR(30) NULL, to_stage VARCHAR(30),
  changed_by, changed_at DATETIME, days_in_previous_stage SMALLINT UNSIGNED NULL,
  note VARCHAR(300) NULL)
  -- days_in_previous_stage is stored, not computed on read, so the
  -- average-days-per-stage report is one aggregate rather than a window function

site_visits
  id, lead_id, scheduled_at DATETIME NOT NULL,
  visited_at DATETIME NULL,
  visited_by BIGINT UNSIGNED NULL,             -- who from NCC attended
  status ENUM('scheduled','completed','client_no_show','rescheduled','cancelled')
    NOT NULL DEFAULT 'scheduled',
  -- what a site visit actually establishes
  soil_type VARCHAR(80) NULL,
  road_access ENUM('good','narrow','no_access') NULL,
  water_availability ENUM('borewell','corporation','tanker','none') NULL,
  power_availability TINYINT(1) NULL,
  neighbouring_structures TEXT NULL,           -- affects excavation and shoring
  level_difference_ft DECIMAL(5,2) NULL,       -- drives earthwork cost
  demolition_required TINYINT(1) NULL,
  tree_cutting_permission_needed TINYINT(1) NULL,
  access_constraints TEXT NULL,                -- transit mixer reach, crane setup
  feasibility ENUM('feasible','feasible_with_conditions','not_feasible') NULL,
  conditions_notes TEXT NULL, estimated_extra_cost_paise BIGINT NULL,
  KEY idx_visit_lead (lead_id)

quotes
  id, quote_no VARCHAR(24) NOT NULL UNIQUE, revision TINYINT UNSIGNED NOT NULL DEFAULT 1,
  lead_id, package_id BIGINT UNSIGNED NULL,
  quote_date DATE NOT NULL, valid_until DATE NOT NULL,
  pricing_basis ENUM('per_sqft','item_rate','lumpsum') NOT NULL,
  built_up_area_sqft DECIMAL(12,2) NULL,
  rate_per_sqft_paise BIGINT NULL,
  base_amount_paise BIGINT NOT NULL DEFAULT 0,
  extras_amount_paise BIGINT NOT NULL DEFAULT 0,   -- from site_visits findings
  discount_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
  discount_amount_paise BIGINT NOT NULL DEFAULT 0,
  discount_approved_by BIGINT UNSIGNED NULL,
  subtotal_paise BIGINT NOT NULL DEFAULT 0,
  gst_pct DECIMAL(5,2) NOT NULL DEFAULT 18.00, gst_paise BIGINT NOT NULL DEFAULT 0,
  total_paise BIGINT NOT NULL DEFAULT 0,
  exclusions TEXT NULL,                        -- always long in construction, see logic
  payment_schedule_json JSON NULL,             -- the milestone plan offered
  status ENUM('draft','pending_approval','approved','sent','viewed',
    'accepted','rejected','expired','superseded') NOT NULL DEFAULT 'draft',
  sent_at DATETIME NULL, accepted_at DATETIME NULL,
  rejected_reason VARCHAR(300) NULL,
  supersedes_quote_id BIGINT UNSIGNED NULL,
  KEY idx_quotes_lead (lead_id, revision)

quote_lines (id, quote_id, line_type ENUM('package','addon','exclusion_note',
  'extra_work','discount'), description VARCHAR(300) NOT NULL,
  qty DECIMAL(14,3) NULL, unit_id BIGINT UNSIGNED NULL,
  rate_paise BIGINT NULL, amount_paise BIGINT NOT NULL DEFAULT 0,
  cost_head_id BIGINT UNSIGNED NULL, sort_order SMALLINT)

competitors (id, name VARCHAR(160) UNIQUE, notes TEXT NULL,
  typical_rate_per_sqft_paise BIGINT NULL)
```

**Routes**

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/app/crm` | `crm.lead_view` | Pipeline board by stage, value per column. Scoped for `sales_exec`. |
| GET | `/app/crm/leads` | `crm.lead_view` | Table view with filters. |
| POST | `/app/crm/leads` | `crm.lead_manage` | Manual creation for phone and walk-in. |
| POST | `/api/crm/leads/from-enquiry/:enquiryId` | `crm.lead_manage` | Promotion, sets `enquiries.lead_id` and status. Duplicate phone match warns before creating. |
| GET | `/app/crm/leads/:id` | `crm.lead_view` + scope | Detail with activity timeline. |
| PATCH | `/api/crm/leads/:id/stage` | `crm.lead_manage` | Validated transitions, writes `lead_stage_history` with the day count. |
| PATCH | `/api/crm/leads/:id/assign` | `crm.lead_assign` | |
| POST | `/api/crm/leads/:id/activities` | `crm.lead_manage` | Every touch. `next_action_date` cascades to the lead. |
| POST | `/api/crm/leads/:id/site-visits` | `crm.lead_manage` | |
| PUT | `/api/crm/site-visits/:id/complete` | `crm.lead_manage` | The feasibility form. |
| POST | `/app/crm/quotes` | `crm.quote_create` | Prefills from package and area, see logic. |
| POST | `/api/crm/quotes/:id/submit` | `crm.quote_create` | To `pending_approval` if discount exceeds the limit, else straight to `approved`. |
| POST | `/api/crm/quotes/:id/approve` | `crm.quote_approve` or `crm.quote_discount_override` | |
| POST | `/api/crm/quotes/:id/send` | `crm.quote_create` | Emails the PDF-printable link, stamps `sent_at`. |
| POST | `/api/crm/quotes/:id/revise` | `crm.quote_create` | New revision, old one to `superseded`. |
| GET | `/api/crm/quotes/:id/print` | `crm.lead_view` | A4 HTML with exclusions and payment schedule. |
| POST | `/api/crm/leads/:id/convert` | `crm.convert_to_project` | The transaction described below. |
| POST | `/api/crm/leads/:id/lose` | `crm.lead_manage` | `lost_reason` mandatory. |
| GET | `/app/crm/reports/funnel` | `crm.view_pipeline_value` | Conversion and days per stage. |
| GET | `/app/crm/reports/sources` | `crm.view_pipeline_value` | Win rate by source, feeds 6.5. |
| POST | `/internal/cron/crm-followups` | `X-Cron-Key` | Overdue `next_action_date`, unassigned enquiries, quotes near expiry. |

**Business logic**

1. **Lead scoring is computed from feasibility facts, not from enthusiasm.** `computeLeadScore(lead)` in `src/modules/crm/service.ts` returns 0 to 100 from weighted signals that actually predict a construction close: `plot_ownership = 'owned_clear_title'` scores highest and `'not_yet_purchased'` scores near zero; `has_sanctioned_plan`; `funding_mode = 'loan_sanctioned'` or `'self'`; `expected_start` within three months; budget range overlapping the package rate times target area; site city inside the served area published in `areaServed`. `temperature` derives from the score plus recency of the last `lead_activities` row. A prospect with no plot and no loan is not a hot lead however keen they sound, and a sales exec's optimism is not a data field.

2. **Expected value is derived, not entered.** `expected_value_paise = target_built_up_sqft * site_packages.rate_per_sqft_paise` for the preferred package, falling back to the midpoint of the budget range. Pipeline value is `SUM(expected_value_paise * probability_pct / 100)`. `probability_pct` defaults from a stage map (`qualified` 20, `site_visit_done` 35, `quote_sent` 50, `negotiation` 70, `verbal_agreement` 85) and is overridable with an audited note, so a forecast cannot be quietly inflated by editing a number.

3. **The site visit is a gate, not a calendar entry.** A lead cannot reach `quote_sent` without a `site_visits` row with `status = 'completed'` and a non-null `feasibility`. Quoting a per-sqft rate without seeing the plot is how a 4 ft level difference, a 12 ft approach road that no transit mixer fits down, or a neighbouring wall needing shoring turns a profitable job into a loss. `estimated_extra_cost_paise` from the visit prefills the quote's `extras_amount_paise`, so what the surveyor found reaches the price.

4. **Quote generation prices off the live package, and exclusions are mandatory.** `createQuote` reads the effective `site_packages` row (6.5 rule 4) plus its `package_spec_lines`, so the quote's inclusion list is exactly the published specification and cannot drift from what the site advertises. `exclusions` is required and non-empty by Zod, seeded from a standard list (compound wall, gate, landscaping, borewell, BESCOM and BWSSB deposits, statutory fees, soil improvement beyond a stated depth, lift, solar). Every construction dispute this company will have is about something the client assumed was included. A quote that does not enumerate exclusions is a liability, so the system will not send one.

5. **Discount above the limit escalates, and the number is not editable after approval.** `quotes.discount_pct` is checked against `approval_limits` for `quote_discount_pct` in basis points. Below the sales exec's limit it self-approves; above it moves to `pending_approval` and appears in the owner's queue. Once `status = 'approved'`, any change to price fields forces a new revision rather than an in-place edit, and the old row goes to `superseded`. The client's copy and the system's copy must match.

6. **Conversion is one transaction that creates real records.** `convertLeadToProject(leadId)`: upsert `clients` from the lead contact (matching on phone then GSTIN to avoid a duplicate client for a repeat customer), create `projects` with `contract_value_paise` from the accepted quote, `rate_per_sqft_paise`, `package_id`, `built_up_area_sqft`, `jurisdiction`, and site address carried across; instantiate `project_stages` from the template for that `project_type`; generate `project_milestones` from the quote's `payment_schedule_json`; create the site store `locations` row; set `leads.converted_project_id` and `stage = 'won'`; write `audit_log`. It refuses without an `accepted` quote. Nothing is retyped, which is the entire point of the module boundary.

7. **First response time is measured because it is the one controllable conversion lever.** `first_response_at` is stamped by the first outbound `lead_activities` row. The funnel report shows median first response and the count breaching a target held in `settings`. An enquiry from a paid Google click that sits unanswered for two days is money already spent and thrown away, and today nobody can see it happening because the enquiry is only a Gmail message.

8. **Lost reasons are a closed enum and feed pricing.** `lost_reason = 'price'` with `lost_to_competitor` populated builds a competitor rate picture in `competitors.typical_rate_per_sqft_paise`. Free-text loss notes produce no analysis. Losing eight jobs at Diamond rate to one named competitor is a pricing decision the owner should be able to see.

9. **Dormancy is automatic, so the pipeline stays honest.** The cron moves any lead with no `lead_activities` row for 45 days and no `next_action_date` to `dormant`. Pipeline value excludes dormant. A CRM whose forecast includes leads nobody has called since March is the spreadsheet problem with extra steps.

**Pages and components**

`src/modules/crm/pages/{PipelineBoard,LeadList,LeadForm,LeadDetail,ActivityTimeline,SiteVisitForm,QuoteList,QuoteBuilder,QuotePrint,FunnelReport,SourceReport}.tsx`.

`PipelineBoard.tsx` renders stage columns server side with htmx `hx-post` on card drop hitting `PATCH .../stage`, so no drag library ships. `QuoteBuilder.tsx` uses `LineItemGrid.tsx` shared with 6.4, recalculating totals on the server after each line change via htmx so the client never owns the arithmetic. `LeadScoreBadge.tsx` shows the score with a tooltip listing which signals contributed, because an opaque score gets ignored. `NextActionBar.tsx` is a persistent element on `LeadDetail` that will not let the page be left without a next action set once the stage is past `contacted`.

### 6.8 Budget and expense tracker

The module that answers whether the company made money, and the one that must not be a general ledger. This is not accounting software and it does not replace Tally or the CA's books. It is **project cost control**: budget against committed against actual, per project, per cost head, with every actual traceable to a document created in another module. GST returns, TDS filings, and statutory books stay with the accountant, and the export in this module feeds them.

The distinction that makes it useful is **committed cost**. Money is gone the moment a PO is approved, not when the invoice is paid. A project showing 60 percent of budget spent while holding 30 percent more in open POs is already over budget, and only a system that tracks commitment can say so before the money leaves.

**Tables** (`migrations/009_finance.sql`)

```
accounting_periods (id, financial_year CHAR(7), month TINYINT UNSIGNED,
  period_start DATE, period_end DATE,
  status ENUM('open','soft_closed','closed') NOT NULL DEFAULT 'open',
  closed_by BIGINT UNSIGNED NULL, closed_at DATETIME NULL,
  UNIQUE KEY uq_period (financial_year, month))

project_budgets (id, project_id, version TINYINT UNSIGNED NOT NULL DEFAULT 1,
  budget_type ENUM('original','revised','forecast') NOT NULL DEFAULT 'original',
  total_paise BIGINT NOT NULL,
  contingency_pct DECIMAL(5,2) NOT NULL DEFAULT 3.00,
  target_margin_pct DECIMAL(5,2) NULL,         -- GATED, owner and accounts only
  prepared_by, approved_by BIGINT UNSIGNED NULL, approved_at DATETIME NULL,
  revision_reason VARCHAR(300) NULL,
  status ENUM('draft','approved','superseded') DEFAULT 'draft',
  UNIQUE KEY uq_budget (project_id, version))

budget_lines (id, budget_id, cost_head_id, project_stage_id BIGINT UNSIGNED NULL,
  description VARCHAR(200) NULL,
  qty DECIMAL(14,3) NULL, unit_id BIGINT UNSIGNED NULL, rate_paise BIGINT NULL,
  amount_paise BIGINT NOT NULL,
  KEY idx_bl (budget_id, cost_head_id))

expenses                     -- the single actual-cost document, whatever the origin
  id, expense_no VARCHAR(24) NOT NULL UNIQUE,
  expense_date DATE NOT NULL,
  project_id BIGINT UNSIGNED NULL,             -- NULL = company overhead
  expense_type ENUM('material_purchase','labour_contractor','subcontract',
    'equipment_hire','equipment_fuel','transport','statutory_fee','professional_fee',
    'salary','site_overhead','office_overhead','marketing','travel',
    'utilities','repair_maintenance','insurance','interest','other') NOT NULL,
  payee_type ENUM('vendor','contractor','employee','authority','other') NOT NULL,
  vendor_id BIGINT UNSIGNED NULL, contractor_id BIGINT UNSIGNED NULL,
  employee_id BIGINT UNSIGNED NULL, payee_name VARCHAR(180) NULL,
  -- source document, so nothing is double counted
  source_type ENUM('manual','grn','contractor_bill','equipment_deployment',
    'campaign_spend','payroll') NOT NULL DEFAULT 'manual',
  source_table VARCHAR(40) NULL, source_id BIGINT UNSIGNED NULL,
  bill_no VARCHAR(60) NULL, bill_date DATE NULL,
  taxable_paise BIGINT NOT NULL DEFAULT 0,
  cgst_paise BIGINT NOT NULL DEFAULT 0, sgst_paise BIGINT NOT NULL DEFAULT 0,
  igst_paise BIGINT NOT NULL DEFAULT 0,
  tds_section VARCHAR(10) NULL,                -- '194C', '194J'
  tds_pct DECIMAL(5,2) NOT NULL DEFAULT 0, tds_paise BIGINT NOT NULL DEFAULT 0,
  total_paise BIGINT NOT NULL DEFAULT 0,       -- taxable + gst
  net_payable_paise BIGINT NOT NULL DEFAULT 0, -- total - tds
  is_reimbursable TINYINT(1) NOT NULL DEFAULT 0,
  advance_settlement_of BIGINT UNSIGNED NULL,  -- FK expenses, for site advance settlement
  status ENUM('draft','pending_approval','approved','rejected','part_paid',
    'paid','void') NOT NULL DEFAULT 'draft',
  approved_by BIGINT UNSIGNED NULL, approved_at DATETIME NULL,
  second_approved_by BIGINT UNSIGNED NULL, second_approved_at DATETIME NULL,
  rejected_reason VARCHAR(300) NULL,
  voided_at DATETIME NULL, voided_by BIGINT UNSIGNED NULL, void_reason VARCHAR(300) NULL,
  period_id BIGINT UNSIGNED NULL,              -- FK accounting_periods, set on approval
  narration VARCHAR(500) NULL,
  KEY idx_exp_project (project_id, status), KEY idx_exp_date (expense_date),
  KEY idx_exp_source (source_table, source_id)

expense_lines (id, expense_id, cost_head_id, project_stage_id BIGINT UNSIGNED NULL,
  item_id BIGINT UNSIGNED NULL, description VARCHAR(300),
  qty DECIMAL(14,3) NULL, rate_paise BIGINT NULL, amount_paise BIGINT NOT NULL,
  KEY idx_el (expense_id))

expense_attachments (id, expense_id, file_id, kind ENUM('bill','receipt',
  'measurement_sheet','photo','approval_mail','other'))

payments
  id, payment_no VARCHAR(24) NOT NULL UNIQUE, payment_date DATE NOT NULL,
  direction ENUM('outgoing','incoming') NOT NULL,
  mode ENUM('bank_transfer','neft','rtgs','imps','upi','cheque','cash',
    'card','adjustment') NOT NULL,
  bank_account_id BIGINT UNSIGNED NULL,        -- FK bank_accounts
  reference_no VARCHAR(60) NULL,               -- UTR or cheque number
  amount_paise BIGINT NOT NULL,
  payee_or_payer VARCHAR(180) NOT NULL,
  vendor_id, contractor_id, employee_id, client_id BIGINT UNSIGNED NULL,
  project_id BIGINT UNSIGNED NULL,
  status ENUM('recorded','cleared','bounced','cancelled') DEFAULT 'recorded',
  cleared_on DATE NULL, bounce_reason VARCHAR(200) NULL,
  narration VARCHAR(300) NULL, created_by,
  KEY idx_pay_date (payment_date), KEY idx_pay_project (project_id)

payment_allocations         -- one payment can settle several documents, and vice versa
  id, payment_id,
  document_type ENUM('expense','contractor_bill','client_invoice','advance') NOT NULL,
  document_id BIGINT UNSIGNED NOT NULL,
  allocated_paise BIGINT NOT NULL,
  UNIQUE KEY uq_alloc (payment_id, document_type, document_id)
  -- this table is why a part payment across three vendor bills reconciles

bank_accounts (id, account_name VARCHAR(140), bank_name VARCHAR(120),
  account_no_last4 CHAR(4), ifsc CHAR(11) NULL,
  account_type ENUM('current','savings','od','cc') NOT NULL,
  opening_balance_paise BIGINT NOT NULL DEFAULT 0, opening_date DATE,
  is_active TINYINT(1) DEFAULT 1)
  -- full account number NOT stored; this system does not initiate payments

client_invoices
  id, invoice_no VARCHAR(24) NOT NULL UNIQUE, project_id, client_id,
  invoice_date DATE NOT NULL, due_date DATE NOT NULL,
  invoice_type ENUM('advance','milestone','running_account','extra_work',
    'final','retention_release') NOT NULL,
  milestone_id BIGINT UNSIGNED NULL,           -- FK project_milestones
  work_done_pct DECIMAL(5,2) NULL,             -- for running account bills
  taxable_paise BIGINT NOT NULL DEFAULT 0,
  cgst_paise BIGINT NOT NULL DEFAULT 0, sgst_paise BIGINT NOT NULL DEFAULT 0,
  gst_pct DECIMAL(5,2) NOT NULL DEFAULT 18.00,
  total_paise BIGINT NOT NULL DEFAULT 0,
  retention_paise BIGINT NOT NULL DEFAULT 0,
  advance_adjusted_paise BIGINT NOT NULL DEFAULT 0,
  tds_deducted_by_client_paise BIGINT NOT NULL DEFAULT 0,
  net_receivable_paise BIGINT NOT NULL DEFAULT 0,
  received_paise BIGINT NOT NULL DEFAULT 0,
  status ENUM('draft','sent','part_paid','paid','overdue','disputed','cancelled')
    NOT NULL DEFAULT 'draft',
  dispute_note VARCHAR(500) NULL,
  KEY idx_inv_project (project_id, status), KEY idx_inv_due (due_date, status)

invoice_lines (id, invoice_id, description VARCHAR(300), qty DECIMAL(14,3) NULL,
  unit_id BIGINT UNSIGNED NULL, rate_paise BIGINT NULL, amount_paise BIGINT NOT NULL,
  hsn_sac VARCHAR(10) NULL, sort_order SMALLINT)

site_advances               -- imprest, the reality of site spending
  id, advance_no VARCHAR(24) UNIQUE, project_id, issued_to_employee_id,
  amount_paise BIGINT NOT NULL, issued_on DATE NOT NULL,
  purpose VARCHAR(300), settled_paise BIGINT NOT NULL DEFAULT 0,
  returned_paise BIGINT NOT NULL DEFAULT 0,
  status ENUM('open','part_settled','settled','written_off') DEFAULT 'open',
  due_settlement_date DATE NULL, approved_by

budget_alerts (id, project_id, cost_head_id BIGINT UNSIGNED NULL,
  threshold_pct DECIMAL(5,2) NOT NULL, triggered_at DATETIME,
  actual_pct DECIMAL(5,2), acknowledged_by BIGINT UNSIGNED NULL)
```

Two derived views, defined in `migrations/009` as SQL views so the same arithmetic is not reimplemented per report:

```
v_project_committed   -- open PO value not yet received, per project per cost head
  SELECT po.project_id, pl.cost_head_id,
         SUM((pl.qty_ordered - pl.qty_received) * pl.rate_paise) AS committed_paise
  FROM po_lines pl JOIN purchase_orders po ON po.id = pl.po_id
  WHERE po.status IN ('approved','partially_received') GROUP BY 1,2

v_project_actual      -- approved, non-void expense lines per project per cost head
  SELECT e.project_id, el.cost_head_id, SUM(el.amount_paise) AS actual_paise
  FROM expense_lines el JOIN expenses e ON e.id = el.expense_id
  WHERE e.status IN ('approved','part_paid','paid') AND e.voided_at IS NULL
  GROUP BY 1,2
```

**Routes**

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/app/finance` | `finance.view_company_pnl` | Cash, receivables ageing, payables ageing with MSME flag, projects over budget. |
| GET | `/app/finance/projects/:id/budget` | `finance.view_project_budget` + scope | Budget vs committed vs actual by cost head. |
| POST | `/app/finance/projects/:id/budget` | `finance.budget_set` | New version, never an edit. |
| POST | `/api/finance/budgets/:id/approve` | `finance.budget_set` | |
| GET/POST | `/app/finance/expenses` | `finance.expense_create` | Own drafts, plus all with `finance.view_project_budget`. |
| POST | `/api/finance/expenses/:id/submit` | `finance.expense_create` | |
| POST | `/api/finance/expenses/:id/approve` | `finance.expense_approve` + limit | Self-approval blocked, second approval above threshold. |
| POST | `/api/finance/expenses/:id/reject` | `finance.expense_approve` | Reason mandatory. |
| POST | `/api/finance/expenses/:id/void` | `finance.expense_approve` | Only for unpaid, reason mandatory, never a delete. |
| GET/POST | `/app/finance/payments` | `finance.payment_record` | Allocation UI across open documents. |
| PATCH | `/api/finance/payments/:id/clear` | `finance.payment_record` | Cheque clearance and bounce. |
| GET/POST | `/app/finance/invoices` | `finance.invoice_manage` | Create from a certified milestone, see logic. |
| GET | `/api/finance/invoices/:id/print` | `finance.invoice_manage` | GST-format A4 HTML. |
| GET/POST | `/app/finance/advances` | `finance.expense_create` | Issue and settle. |
| GET | `/app/finance/reports/pnl` | `finance.view_company_pnl` | Period P and L with project margin. |
| GET | `/app/finance/reports/project-margin` | `finance.view_company_pnl` | |
| GET | `/app/finance/reports/cashflow` | `finance.view_company_pnl` | Projected from milestones due and PO commitments. |
| GET | `/app/finance/reports/gst-summary` | `finance.export` | Output and input tax by period for the CA. |
| GET | `/app/finance/reports/tds-summary` | `finance.export` | By section and deductee for 26Q. |
| GET | `/api/finance/export/tally.xml` | `finance.export` | See logic. |
| POST | `/api/finance/periods/:id/close` | `finance.period_close` | |
| POST | `/internal/cron/finance-alerts` | `X-Cron-Key` | Budget thresholds, overdue receivables, MSME 45-day breach, unsettled advances. |

**Business logic**

1. **Actuals are never typed where another module already produced them.** Posting a GRN creates an `expenses` row with `source_type = 'grn'` and `source_id`. Approving a contractor bill creates one with `source_type = 'contractor_bill'`. `campaign_spend` and `equipment_deployments` do the same. A unique index on `(source_table, source_id)` where both are non-null makes double posting impossible at the database level rather than by convention. Manual expenses are for things with no upstream document: statutory fees, professional fees, site overheads, travel.

2. **Three numbers per cost head, always shown together.** Budget from `budget_lines`, committed from `v_project_committed`, actual from `v_project_actual`. The variance is `budget - (committed + actual)`. Showing actual alone is the mistake that lets a project look healthy while three approved POs for steel are in transit.

3. **Approval is threshold-based with mandatory dual approval above a limit, and self-approval is impossible.** `approveExpense()` enforces the 4.3 rule for every role including `owner`, then reads `approval_limits`. Above `requires_second_approval_above` the row needs `second_approved_by` distinct from `approved_by` before it can be paid. With one person holding the bank login, two names on a voucher is the only real control that exists.

4. **Budget overrun blocks approval at the cost-head level.** If approving an expense would push `committed + actual` past `budget_lines.amount_paise` for that cost head, the approval is refused with the exact overrun figure and the options are: revise the budget (a new `project_budgets` version with `revision_reason`), reallocate between heads, or override with `finance.budget_set` and an audited note. Discovering an overrun at the point of approval is the only moment where the information changes a decision. Discovering it in a month-end report is archaeology.

5. **Milestone invoicing is chained to physical certification.** `createInvoiceFromMilestone(milestoneId)` requires `project_milestones.status = 'certified'`, which per 6.3 rule 3 already required stage completion and passed cube tests. It computes taxable value, GST split by place of supply (intra-Karnataka is CGST plus SGST, inter-state is IGST), deducts `retention_pct`, adjusts any outstanding advance, and links back with `project_milestones.invoice_id`. So the chain is: work done, quality passed, milestone certified, invoice raised. Not one step can be skipped by clicking a different button, which is exactly what the current spreadsheet process cannot guarantee.

6. **Site advances are tracked to settlement and block re-issue.** A supervisor drawing 50,000 rupees for sand and labour must settle it with `expenses` rows carrying `advance_settlement_of`, plus any cash returned. `issueSiteAdvance` refuses a new advance to an employee with an `open` advance older than the `settings` threshold. Unsettled cash advances are the most common way money disappears on a construction site, and 6.6 rule 7 already blocks exit while one is open.

7. **Period close is a real lock.** Closing an `accounting_periods` row rejects any insert or update to `expenses`, `payments`, or `client_invoices` with a date inside it. `expenses.period_id` is stamped on approval so the lock is enforced by a single indexed check. Post-close corrections are a reversing entry in the current open period, never an edit to a closed one. Without this, last month's numbers change after the owner has looked at them.

8. **MSME payment terms are tracked because breaching them creates statutory interest.** The payables ageing report flags any `expenses` row for a vendor with a non-null `msme_udyam_no` approaching 45 days from `bill_date`, and the cron notifies `accounts_manager` and `owner` at day 35. This is a legal exposure most small contractors discover only when a vendor claims interest.

9. **Export is for the accountant, not a replacement for them.** `GET /api/finance/export/tally.xml` produces Tally-importable vouchers, and the GST and TDS summaries are period reports in the format a CA actually asks for. This module deliberately has no ledger, no journal entry screen, no trial balance, and no depreciation schedule. Building those means maintaining accounting software as a side effect of a construction tracker, and getting it subtly wrong in a way that surfaces at assessment time.

10. **Project margin is computed only where the cost picture is complete.** `getProjectMargin(projectId)` returns `contract_value - (actual + committed + accrued_staff_cost)`, where `accrued_staff_cost` comes from `attendance` rows joined to `employee_compensation` for the period. It is labelled with the date of the last posted expense and the count of open POs, because a margin figure without a completeness indicator gets quoted in a meeting as if it were final. Visible only to `owner` and `accounts_manager`, and never rendered on any page a supervisor can reach.

**Pages and components**

`src/modules/finance/pages/{FinanceDashboard,ProjectBudgetView,BudgetForm,ExpenseList,ExpenseForm,ExpenseApprovalQueue,PaymentList,PaymentForm,PaymentAllocator,InvoiceList,InvoiceForm,InvoicePrint,AdvanceList,AdvanceForm,PnlReport,ProjectMarginReport,CashflowReport,GstSummary,TdsSummary,PeriodClose}.tsx`.

Components: `BudgetVarianceTable.tsx` (the three-column budget, committed, actual grid with drill-through to source documents), `ApprovalQueue.tsx` (shared by expense, PO, quote, leave and contractor bill, driven by a `PendingApproval` union type so a new approvable document adds one case rather than a new screen), `MoneyInput.tsx` (accepts `12,34,567` and `1234567.50`, submits paise, rejects anything else client and server side), `AllocationGrid.tsx`, `AgeingBuckets.tsx` (0-30, 31-45, 46-60, 61-90, 90 plus, with the MSME band highlighted), `CostHeadPicker.tsx`.

---

## 7. Data migration plan

There is no database to migrate. The entire current dataset is content embedded in PHP markup, one append-only log file, and a Gmail mailbox. That makes this a **content extraction** exercise, not a schema conversion, and it means the risk is not data corruption but data loss: files that exist on the server and not in git, and enquiries that exist only as email.

### 7.1 What exists and where it actually lives

| Data | Current location | Destination | Method |
|---|---|---|---|
| 4 package rates and full specs | `construction-packages-in-bengaluru.php` markup | `site_packages`, `package_spec_groups`, `package_spec_lines` | Scripted parse, manual verification |
| 7 showcase projects with 6 attributes each | `best-construction-company-in-bengaluru-projects.php` JSON-LD `ItemList` | `site_showcase`, `site_showcase_images` | Parse the JSON-LD, not the HTML |
| 6 services | `construction-services-in-bengaluru.php` | `site_services` | Scripted parse |
| 4 team members | `index.php` and `about-us.php` JSON-LD `Person` nodes | `site_team` | Parse the JSON-LD |
| FAQs | `FAQPage` JSON-LD across several pages | `site_faqs` | Parse the JSON-LD |
| 4-stage process | `index.php` `id="step1"` to `id="step4"` | `site_pages.content_json` as a `process_steps` block, and `stage_templates` | Manual |
| 10 to 12 payment milestones | `construction-packages-in-bengaluru.php` | `stage_template_items` and the default quote `payment_schedule_json` | Manual |
| Approved material brands | `construction-packages-in-bengaluru.php` | `items`, `item_brands` | Manual, cross-checked with Vinay |
| Equipment fleet | `construction-services-in-bengaluru.php` | `equipment` | Manual |
| Company NAP, social links, GA4 id, IndexNow key | `header.php`, `footer.php`, `top-social.php`, `floating-buttons.php` | `settings` | Manual |
| Sitemap priorities and changefreq for 10 paths | `sitemap.php` `$staticPages` | `site_pages.sitemap_priority`, `sitemap_changefreq` | Scripted, values preserved exactly |
| Error page copy for 30 codes | `error.php` `$errors` map | `ERROR_COPY` const in `src/middleware/errorHandler.ts` | Scripted |
| Page titles, meta descriptions, canonicals | each PHP file's `<head>` | `site_pages` | Scripted parse |
| Past enquiries | `enquiries.log` on the server plus Gmail at `nccpmd@gmail.com` | `enquiries`, then `leads` | See 7.4 |
| Images, CSS, JS | server `assets/`, `css/`, `js/`, `favicon/`, **absent from git** | `public/assets/` | See 7.2 |
| IndexNow history | `indexnow-log.txt` | `indexnow_submissions` or discard | Optional |

Not migrated: the three interiors files (`about.php`, `contact.php`, `process.php`) belong to `neelachandrainteriors.com`; `coming-soon.php` is an orphan not linked from any live page; `README.md` documents the interiors site and is replaced. None of these four are reachable from the live `neelachandra.com` navigation, so archiving them removes nothing a visitor can currently see. If any of them turns out to be linked from an external source, `legacyRedirects.ts` handles it per 3.1 rule 2 rather than the page being resurrected.

### 7.2 Step 1, recover what git does not have

This is the first task and it blocks everything, including phase 0 of section 5.

The repository contains 111 files, all at root level, with no `includes/`, `assets/`, `css/`, `js/`, `favicon/`, or `blog/` directory. Every PHP page includes from `/includes/` and references `/assets/images/...`, and the live server serves those paths (verified: `https://neelachandra.com/assets/images/header/logo.svg` returns 200 with 19548 bytes, matching the root-level `logo.svg` in the repo). So the repo is a flattened partial dump of `public_html` and **the site cannot be rebuilt from git alone**.

1. Download the whole of `public_html` over SSH (`tar -czf` then `scp`) or File Manager. Not selected folders. The whole tree.
2. Store the archive twice: once in the repo at `legacy/public_html-YYYY-MM-DD.tar.gz` tracked with Git LFS or kept out of git and stored separately, and once outside the hosting account entirely.
3. Also export the MySQL databases visible in hPanel even though the project uses none, in case something unrelated is present.
4. Diff the server tree against the git tree and record the delta in `legacy/RECOVERED-FILES.md`. Files on the server and not in git are the ones nobody knew were at risk.
5. Only after this archive is verified restorable does anything else proceed. The Hostinger website removal required for a Node deploy is irreversible and destroys files, databases, and email.

### 7.3 Step 2, extract content into seed SQL

`scripts/extract-legacy-content.mjs` reads from `legacy/php-construction/` and writes `migrations/seeds/*.sql`. It runs offline against the archived copies, never against the live site.

- **JSON-LD first, HTML second.** Every page carries a `<script type="application/ld+json">` block whose `@graph` already holds the structured version of the content: `Person` nodes for the team, `CreativeWork` nodes with `PropertyValue` arrays for the seven projects, `Question` and `Answer` pairs for the FAQs, `Offer` nodes for pricing. Parsing that JSON is reliable. Parsing the surrounding HTML with a regex is not, especially given the corrupted `<34 class="accordion-heading">` tag in `index.php` at line 1022 and the nested `<style><style>` in `header.php`. The extractor uses `node-html-parser` for the HTML it must read and treats a parse failure as a hard stop, not a warning.
- **Money is converted to paise at extraction.** 2,299 becomes `229900`. The extractor rejects any rate it cannot parse into an integer rather than defaulting to zero.
- **Output is reviewed by a human before it is applied.** The generated SQL goes into a pull request. Package specifications and material brands are commercial promises published on a live site, and a mis-parsed specification line becomes a contractual claim. Chandrashekar and Vinay sign off on the packages and brands specifically.
- **Every extracted row records provenance.** A `source_note` column or a SQL comment naming the file and line it came from, so a disputed value can be traced back.
- **Transcription only. The extractor is forbidden from normalising.** No trimming beyond leading and trailing whitespace on a value, no smart-quote conversion, no title-casing, no spelling correction, no rewording, no reordering, no unit normalisation in display strings, no removal of what looks like a duplicate. If `index.php` says `exellence` in a filename or a heading carries an inconsistent capitalisation, that is what lands in the database. Review is a diff for **fidelity to the source**, not an editorial pass. Anything that looks wrong gets recorded in `legacy/CONTENT-QUERIES.md` and raised with the client after cutover; it is never silently fixed in the migration, because a silent fix is indistinguishable from a parser bug.
- **The extractor emits a completeness report.** `legacy/extraction-report.md` lists every text node in each source page and whether it landed in a content file, a database row, or neither. A text node in the "neither" column is either deliberately excluded with a reason or a bug. This is what catches copy silently lost between PHP and JSX, which is the most likely way the freeze gets violated by accident rather than by choice.

### 7.4 Step 3, the enquiry backlog

Two sources, neither complete.

- `enquiries.log` is written by `enquiry-handler.php` under `NC_ENQUIRY_DELIVERY = 'log'`. That handler is never included by `header.php` (verified by grep), so the homepage form was dead and the log may be empty or hold only test rows. Check it, and if it has content, parse it with `scripts/import-enquiry-log.mjs` into `enquiries` with `source_page` set to whatever the log records.
- The real backlog is Gmail. `contact-us.php` calls `mail()` to `nccpmd@gmail.com` with no persistence, so every genuine enquiry the site has produced is a mail message. Export the relevant label as `.mbox`, then parse the structured body that `contact-us.php` emits into `enquiries` rows with `created_at` taken from the mail `Date` header and `source_page = '/contact-us'`.

Two honest caveats to state rather than paper over: the mbox parse will be imperfect because the mail body format is a plain-text template that may have changed, and there is no way to recover enquiries that arrived by phone or WhatsApp. So the import sets `status = 'triaged'` rather than `'new'` on everything older than 90 days, to stop the CRM presenting a two-year-old enquiry as a fresh lead on day one. How far back to import at all is 8.9.

Live projects, clients, vendors, current stock, employees, and contractors are not in any system today. They are entered by hand at the start of the phase that needs them (3, 4, 6), which is why each phase gate in section 5 requires real data rather than test data.

### 7.5 Step 4, URL and SEO preservation

The highest-risk part of the whole project, because the site ranks and the removal is irreversible.

1. **Freeze the URL inventory before cutover.** `scripts/snapshot-urls.mjs` crawls the live site plus `sitemap.xml` and writes `legacy/url-inventory.json` with path, status, title, meta description, canonical, and h1 for every reachable page. This is the assertion set.
2. **Every path in the inventory must resolve identically after cutover.** `scripts/verify-routes.mjs` reads the inventory and fails on any status change, missing canonical, or title change. It runs in CI against staging and again against production within minutes of cutover.
3. **The 10 paths in `sitemap.php` `$staticPages` keep their exact priority and changefreq values.** They are copied into `site_pages`, not re-derived.
4. **The `.php` to extensionless 301s continue to work**, now from `legacyRedirects.ts` rather than `.htaccess`, because Hostinger regenerates that file on every deploy. The verifier asserts each one.
5. **Files that must survive byte-identical:** `097ee841c58a4b25b8eb2c348ca67dce.txt` (IndexNow key verification fails otherwise), `google9706eb5d9d6a7b15.html` (Search Console loses verification otherwise). Both are asserted by the verifier.
6. **Files that must survive with corrections.** This list is exhaustive and closed. Nothing else in `public/` changes. `robots.txt`: the live file is the **interiors site's robots.txt in its entirety**, not merely a wrong sitemap line. Its header comment names Neelachandra Interiors, it reasons about "an interiors studio", and its `Sitemap:` directive points at `https://neelachandrainteriors.com/sitemap.xml`, so this domain never advertises its own sitemap. Corrected at migration: the `Sitemap:` line and the header comment. Retained verbatim: every `Disallow` rule (still valid for this domain) and the whole AI-crawler allowlist, which is deliberate work. Recorded as CQ-2. `site.webmanifest`: icon paths are `/favicon.ico/web-app-manifest-192x192.png`, treating a file as a directory, so both icons 404. `security.txt`: **no change needed**, it is already correctly served at `/.well-known/security.txt` and the root 404s (CQ-3 corrects an earlier assumption in this document). Carried across untouched: `humans.txt`, `llms.txt`, `llms-full.txt`, `og.webp` at its current 1,091,756 bytes, every favicon variant, and every image including the duplicates and the ones with spaces and parentheses in their filenames.

6a. **The golden masters are the acceptance criteria, not a nice-to-have.** `legacy/golden/*.html` and `legacy/golden/shots/` are captured in phase 0 step 1a, before the irreversible removal, and `scripts/parity-check.mjs` compares against them at the phase 1 gate, at the phase 8 gate, and in CI on every commit touching `src/public/`. If the capture was skipped, there is no way to prove the design and content were preserved and no way to recover the reference.
7. **GA4 `G-QX0C128DKX` is carried across unchanged** so the historical series is unbroken. An annotation is added in GA4 on the cutover date.
8. **Submit the full URL set to IndexNow immediately after cutover** and monitor Search Console coverage daily for two weeks. Rendering changes, even correct ones, can cost impressions temporarily.

### 7.6 Step 5, cutover sequence

1. Staging fully verified against `url-inventory.json`.
2. Announce a maintenance window. Realistically two hours, in the early morning, on a weekday when someone is available to watch it.
3. Take a final `public_html` archive. The one from 7.2 is days old by now.
4. Lower DNS TTL 24 hours in advance if the domain will be repointed.
5. Remove the existing website in hPanel and deploy the Node app. **This is the irreversible step.** Nothing before this point can be half done.
6. Run `scripts/verify-routes.mjs` against production. Any failure is fixed immediately or the deploy is rolled back to a static export of the archive.
7. Submit `sitemap.xml` and the URL set to IndexNow and Search Console.
8. Submit a test enquiry through the live form and confirm both the `enquiries` row and the email arrive.
9. Watch `pm2 logs` and Search Console for 48 hours.

### 7.7 Step 6, decommission the legacy tree

Once phases 1 through 8 are signed off and the extracted content has been verified in the running system, delete `legacy/php-construction/` and `legacy/php-interiors/` from the working tree. Git history and the external archive keep them. The condition for deletion is that every row in the extraction manifest has been confirmed present and correct in the database, not that the site looks right.

---

## 8. Open questions for you to answer

These are the decisions I cannot make from the repository, the live site, or the platform documentation. Where a wrong assumption would be expensive, I have said so. The ones marked **blocking** stop a phase from starting.

### 8.1 Roles and the actual org chart (blocking, phase 2)

The eight roles in section 4.2 are inferred from four names in the JSON-LD (Chandrashekar T as Founder, Sushma N as Operations Analyst, Vinay as Procurement Lead, Naveen Kumar as Technical Advisor) plus a stated headcount of about ten.

- Who are the ten people and what does each actually do day to day?
- Which of them will hold `owner`, `accounts_manager`, and `admin`? These are the three that carry the real power, and `accounts_manager` in particular may not exist as a separate person today, in which case the owner holds it and the segregation-of-duties rule in 4.3 has nothing to bite on. If there is genuinely only one person touching money, say so and I will design the second approver as an explicit exception with a compensating control rather than pretend a control exists.
- Is Naveen Kumar (Technical Advisor) internal staff or an external consultant? That changes whether he gets a login and an `employees` row.
- Do site supervisors have smartphones the company controls, and will they actually file a DPR daily? If not, the DPR design in 6.3 needs rethinking, because a compliance rate below about 80 percent makes the whole progress-tracking chain worthless.

### 8.2 Approval limits (blocking, phase 7)

`approval_limits` needs real numbers. What is the maximum a project manager can approve without the owner, for an expense and for a purchase order? Above what value should two approvals be mandatory? What discount percentage can a sales executive give unilaterally? I have deliberately not invented defaults, because a threshold set too low makes the system an obstacle people route around, and set too high it is decoration.

### 8.3 Stage templates and payment milestones (blocking, phase 3)

`construction-packages-in-bengaluru.php` mentions 10 to 12 payment milestones but the page does not enumerate them in a form I can extract reliably.

- What is the actual milestone list and the percentage of contract value against each? This is the single most important dataset in the whole build, because it drives billing.
- The published four-stage process (`step1` to `step4`) is a marketing summary. What is the real internal stage breakdown you track against, with weightages? Twelve to eighteen stages is typical.
- Do industrial and commercial projects (Honda, Recipharma, VRL) use a different stage template and milestone structure from residential? The showcase page suggests they must.
- Is retention 5 percent, and is the defect liability period 12 months? The site promises a 1-year warranty and a 10-year structural warranty, which I have used, but the contractual retention terms are separate.

### 8.4 Material consumption norms (blocking, phase 4 rule 4)

The consumption variance report in 6.4 is the main return on the inventory module, and it needs your norms: bags of cement per sqft, kg of steel per sqft, cubic metres of sand and aggregate per sqft, per package tier or per project type, plus acceptable wastage percentages. These are company-specific and I will not guess them, because a wrong norm generates false theft alerts until people stop reading the report.

Also: is stock tracked at a central store today, or does material go straight from vendor to site? If it is direct-to-site only, the `central_store` location and the transfer flow are dead weight in phase 4 and can be deferred.

### 8.5 Public content risks I am preserving, not fixing (not blocking phase 1)

Per your instruction, the design and content are frozen, so **all three items below are ported exactly as they appear today and none of them blocks phase 1.** They are listed because a specification that noticed a legal or commercial exposure and stayed silent about it would be a bad specification. Each needs an answer eventually, but as a content decision you make, not as a prerequisite I impose.

- **The 4.8 out of 5 rating, and four contradictory review counts, ARE live in your schema markup right now.** This is the one item in this section I would not leave alone for long, and my earlier reading of it was wrong: I had taken the old `README.md` at its word that `aggregateRating` had been removed. Capturing the live pages disproved that. Five pages emit it, claiming 2, 4, 4, 30 and 87 reviews for the same business, all at 4.8. Full detail and verification commands are in `legacy/CONTENT-QUERIES.md` as CQ-1. The port reproduces it exactly, per your freeze, and the parity gate asserts it stays reproduced. What I need from you is one of two decisions: supply the real basis (a Google Business Profile review count, for instance) and I switch the markup to a computed node that matches reality, or authorise removing the rating markup from those five pages as a deliberate signed-off content change. Doing nothing keeps a live manual-action risk on a site that ranks, which is the one place where the freeze and your commercial interest actually conflict.
- **Client names in the showcase.** Honda Cars India, Recipharma, Nambiar Ellegenza, Mandot Steel, Excellence Technologies, VRL Automation, and Capstone Life are named publicly with sector and scope detail. All seven stay published with their current copy. Do you hold written consent for each? Automotive OEM and pharmaceutical contracts commonly carry confidentiality clauses, and naming such a client as a reference without permission is a contractual exposure that already exists today, independent of this project. The admin list will flag each of the seven as consent-unrecorded until you confirm. Rule 5's hard gate applies only to entries created after go-live.
- **Are the four package rates (2,299 / 2,699 / 3,099 / 3,499 per sqft) current?** The public page keeps whatever it shows today regardless. This matters for a different reason: 6.7 rule 4 generates quotes from these rates, so if the published rates are stale, the CRM will quote stale prices from phase 5 onward. Publishing a corrected rate is a content edit for you to make through the phase 8 editor; what I need before phase 5 is confirmation of the rates the business actually sells at, even if the site is not updated to match.

### 8.6 HR statutory specifics (phase 6)

- Is the company registered under EPF and ESI? At ten employees the thresholds may or may not be crossed, and it changes whether `uan`, `pf_number`, and `esi_number` are required fields or optional ones.
- Leave quotas per type. I have modelled `leave_types` on a Karnataka Shops and Establishments baseline but the actual entitlements (casual, sick, earned, carry-forward cap) are your policy.
- Does the financial year start 1 April for leave accrual, or is it calendar year? I have assumed 1 April, matching `document_numbering`.
- **Is payroll processing in scope at all?** I have specified compensation records, attendance, and payroll cost accrual into project margin, but no payslip generation, no PF or ESI challan output, and no salary disbursement. If you want payslips, that is a distinct piece of work with statutory formatting requirements and it should be its own phase.
- Do you use labour contractors, and roughly how many? The whole `labour_contractors` and `contractor_bills` design in 6.6 assumes yes. If site labour is directly employed instead, that part of the module changes shape substantially.

### 8.7 Offline capability for site staff (blocking, decide before phase 3)

Sites at KIADB Doddaballapura, T Begur, and Tumkur may have poor or no mobile data. If a supervisor cannot submit a DPR or a material issue from the site, they will write it on paper and enter it in the office days later, which destroys the timeliness that makes the data worth having.

Do you need offline entry with later sync? I have **not** specified it, because it is a large architectural commitment: a service worker, IndexedDB queueing, conflict resolution, and idempotency keys on every mutating endpoint. It roughly doubles the complexity of the DPR, issue, and attendance paths. It also has to be decided before phase 3, not retrofitted after, because idempotency keys have to be in the API from the start.

If the answer is "signal is usually fine", the answer is no and we move on. I need your read on actual site conditions.

### 8.8 Sales pipeline reality (phase 5)

- Does anyone hold a sales role today, or does Chandrashekar handle all enquiries himself? If it is the latter, `sales_exec` is a role for a future hire and the assignment and scoping logic can be simplified for now.
- Roughly how many enquiries per month arrive, and what proportion by phone versus the website form? This determines whether the enquiry queue needs triage tooling or is a short list.
- Do you issue formal written quotes today, and in what format? If there is an existing Word or Excel quote template, the `QuotePrint` layout should match it so clients see something familiar, and the standard exclusions list should be copied from it rather than invented.
- What is the typical enquiry to won conversion rate and cycle length? Used only to sanity-check the default `probability_pct` map in 6.7 rule 2.

### 8.9 Enquiry backlog scope (phase 1)

How far back should the Gmail enquiry archive be imported, and is it worth doing at all? Importing three years of dead enquiries clutters the CRM. My recommendation is 12 months, with everything older than 90 days marked `triaged` rather than `new`. Also: is `nccpmd@gmail.com` still the right destination for new enquiry notifications, or should it move to a domain mailbox now that authenticated SMTP is being configured?

### 8.10 Interiors business boundary (affects phase 1 and 8)

`neelachandrainteriors.com` exists as a separate site with separate contacts (`studio@neelachandrainteriors.com`, `careers@neelachandrainteriors.com`, `+91 80 4718 2200`), and its files are mixed into this repository.

- Is interiors a separate legal entity, a division, or just a separate brand and website?
- Should interiors projects, leads, and expenses live in **this** system alongside construction, or stay wholly separate? I have included `interior_fitout` in `projects.project_type` and `leads.enquiry_type` on the assumption that it is one business with two front doors, but if the books are separate that assumption is wrong and affects every financial report.
- Is `neelachandrainteriors.com` also being rebuilt, later or never? If later, the `site_pages` design in 6.5 can host both domains from one deployment with a host-based route prefix, which is worth knowing now rather than discovering later.

### 8.11 Hosting plan specifics (blocking, phase 0)

- Which exact Hostinger plan is active? Node.js support and the number of deployable Node applications differ by tier, and `npm` cannot be run over SSH on Business and Cloud plans, which affects the debugging workflow.
- Confirm a staging subdomain can be created and given its own Node deployment. Section 5 phase 0 depends on it, and without staging the irreversible website removal gets used as a test.
- Who holds the hPanel account and the domain registrar login? The cutover in 7.6 needs both available in the same window.
- Is there an existing MySQL database on the plan, and how much storage does the plan allow? Site photos are the growth driver here: `dpr_photos` at a few images per project per day adds up, and the current `og.webp` alone is 1,091,756 bytes, which suggests image discipline has not been a priority. If plan storage is tight, `files` should move to object storage (Cloudflare R2 or Backblaze B2) behind the same `GET /api/files/:id` route, and that is a phase 0 decision because the storage abstraction in `src/lib/files.ts` has to be written for it from the start.
- What is the actual mail sending situation? I have specified authenticated SMTP over `smtp.hostinger.com:465`. Confirm the plan includes mailboxes and what the daily send limit is, since enquiry notifications, invite emails, password resets, quote sends, and cron alerts all go through it.

### 8.12 Scope of the design and content freeze, and what it defers (phase 1, then phase 9)

You have instructed that the existing design and page content do not change. I have applied that strictly: 1.8 now marks six of its ten findings as port-as-is, the CSS stays per page rather than consolidated, every image keeps its current path and bytes, and `scripts/parity-check.mjs` fails the build on any pixel, text-node or class-sequence difference. Four questions follow from it.

- **Confirm the three permitted deviation categories in the header block are acceptable.** They are: consolidating the two `<head>` blocks into one (the second is already discarded by the browser, so nothing rendered changes), emitting the corrupted `<34` tag as something valid-but-visually-identical, and correcting `site.webmanifest` and the `robots.txt` domain. If you want even these left alone, say so and the port emits the invalid markup verbatim through `dangerouslySetInnerHTML`. That is technically achievable and I would rather ask than assume.
- **The port inherits the current performance profile, deliberately.** `og.webp` stays at 1,091,756 bytes, each page keeps loading its own Google Fonts set, and the CSS reset stays duplicated nine times. This will show in Lighthouse and possibly in Core Web Vitals. I judged that bundling optimisation into the port is the wrong trade, because when a parity check fails you cannot tell whether the port is wrong or the optimisation moved something. Confirm you accept that, and confirm you want the deferred work offered as a separate phase 9 task rather than dropped.
- **Which unreferenced assets may eventually be deleted?** I am porting all of them, including `maps (3).webp`, the five `hero (n).webp` variants, `exellence.webp` and every favicon variant. Phase 9 can remove files that show zero hits in the access log over 30 days, but only with your approval, because a file I believe is unused may be hotlinked from a listing site, an old email, or a social post.
- **Who signs off the parity result?** The phase 1 gate produces a diff report and, on failure, per-viewport diff images in `tests/parity-out/`. Some differences will be legitimately unavoidable, font rasterisation across a rendering-engine change being the likely one. I need a named person who can look at a 3-pixel text-reflow difference and say whether it ships. Without that, the gate either blocks forever or gets waived informally, and the second outcome is how freezes quietly stop being freezes.
