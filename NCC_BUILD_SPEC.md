# Neelachandra Construction and Interiors: Full-Stack Platform Build Specification

Target repository: `github.com/nccfawaz/neelachandrainteriors`
Target host: Hostinger Business/Cloud (Node.js Web App), domain `neelachandra.com`
Audience: implementing developer or Claude Code agent

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
- `humans.txt`, `security.txt`. Note `security.txt` declares `Canonical: https://neelachandra.com/.well-known/security.txt` but the file is served from the root, which violates RFC 9116 placement.

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

### 1.8 Defects found that the rebuild should fix rather than port

1. `index.php` line 1022 contains `<34 class="accordion-heading">`, a corrupted opening tag closed by `</h3>`. Live invalid markup.
2. `header.php` opens a `<style>` block that immediately contains a second nested `<style>`, and emits a full `<head>` even though it is included from inside `<body>` (for example `index.php` line 716). Every page therefore ships two `<head>` blocks.
3. `site.webmanifest` icon paths are `"/favicon.ico/web-app-manifest-192x192.png"`, treating a file as a directory. Both icons 404.
4. `og.webp` is 1,091,756 bytes and `Favicon.png` is 675,879 bytes. Both are served on the homepage path.
5. Duplicate and near-duplicate assets: `maps.webp` and `maps (3).webp` (identical 10672 bytes), `excellence.webp` and `exellence.webp`, `hero (1).webp`, `hero (2).webp`, `hero (4).webp`, `hero (5).webp`, `hero.webp`, `hero1.webp`, `hero-mobile.webp`, `Favicon.png` and `Favicon.webp` and `favicon.svg` and `favicon.ico` and `favicon-96x96.png` and `32_32.png` and `48_48.png` and `180_180.png` and `192_192.png`.
6. Filenames containing spaces and parentheses, which are fragile behind rewrite rules.
7. Every page inlines its own multi-thousand-line `<style>` block with a duplicated CSS reset, and each page loads a different Google Fonts family set (compare the font query strings in `index.php`, `construction-packages-in-bengaluru.php` and `contact-us.php`). Font Awesome 6.5.2 is pulled from cdnjs on some pages only.
8. `about-us.php` and `about.php` are two different About pages for two different brands, both in one directory. Same for `contact-us.php` and `contact.php`.
9. `header.php` navigation links "Interiors" to the external `https://neelachandrainteriors.com`, while `coming-soon.php` exists locally as an unused placeholder for the same slot.
10. The `4.8 / 5.0` rating is rendered as visible text and as an image (`rating.webp`, `stars.webp`) with no `aggregateRating` in schema. `README.md` records that `aggregateRating` was deliberately removed and that fabricated testimonials were deleted. There is no source of record for the rating.

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
│   ├── import-legacy-content.mjs          parses the old PHP into the DB (see section 7)
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
│   ├── public/                            THE MARKETING SITE
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
│   │   │   ├── sitemap.ts                 /sitemap.xml         from sitemap.php, DB-driven
│   │   │   ├── robots.ts                  /robots.txt          rewritten for this domain
│   │   │   └── llms.ts                    /llms.txt, /llms-full.txt  generated
│   │   ├── layouts/SiteLayout.tsx         replaces header.php + footer.php, ONE <head>
│   │   ├── components/
│   │   │   ├── TopSocialBar.tsx           from top-social.php
│   │   │   ├── SiteNav.tsx                from header.php nav block
│   │   │   ├── FloatingButtons.tsx        from floating-buttons.php (WhatsApp, Maps)
│   │   │   ├── FooterSubscribe.tsx        from footer-sub.php, now with a real handler
│   │   │   ├── SiteFooter.tsx
│   │   │   ├── EnquiryForm.tsx            from contact-form.php, construction field set
│   │   │   ├── FaqAccordion.tsx           renders faq rows AND emits FAQPage JSON-LD
│   │   │   ├── PackageCards.tsx           reads packages table
│   │   │   ├── ProjectCard.tsx            reads projects + project_media
│   │   │   └── StatStrip.tsx              reads site_stats
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
│   │   ├── css/{site.css,packages.css,tumkur.css}      extracted from the inline <style> blocks
│   │   ├── js/site.js                                  nav toggle, accordion, IntersectionObserver
│   │   ├── images/{header,home,about,contact,packages,projects,favicon}/
│   │   └── vendor/{htmx.min.js,alpine.min.js,chart.umd.min.js}
│   ├── favicon.ico  favicon.svg  favicon-96x96.png  apple-touch-icon.png
│   ├── site.webmanifest                   FIXED icon paths
│   ├── og.webp                            RE-ENCODED, target under 150 KB
│   ├── humans.txt
│   ├── 097ee841c58a4b25b8eb2c348ca67dce.txt   IndexNow key file, must keep exact content
│   ├── google9706eb5d9d6a7b15.html            Search Console verification, must keep
│   └── .well-known/security.txt           MOVED here to match its own Canonical line
│
├── tests/
│   ├── unit/{permissions,money,numbering}.test.ts
│   └── e2e/{public-routes,login,expense-approval}.spec.ts
│
└── legacy/                                READ-ONLY ARCHIVE, excluded from the build
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
- The interiors files go to `legacy/php-interiors/` and are **not** ported. They belong to a different domain. `README.md` moves there too, and a new `README.md` is written for this project.

### 3.1 Replacing `.htaccess` behaviour in `src/middleware/legacyRedirects.ts`

Because Hostinger regenerates `public_html/.htaccess` on every deploy, these rules move into code and run before routing:

1. If the path ends in `.php`, 301 to the same path without `.php`. Preserves the existing `RewriteRule ^ %1 [R=301,L]`.
2. Explicit 301 map for the paths that die in the rebuild: `/about.php` and `/about` to `/about-us`; `/contact.php` and `/contact` to `/contact-us`; `/process.php` to `/#process`; `/coming-soon` to `https://neelachandrainteriors.com`.
3. Strip a trailing slash on all non-root paths with a 301, matching the current `^(.+?)/?$` behaviour.
4. Force `https://neelachandra.com` as the canonical host with a 301 from any `www.` variant.
5. `/sitemap.xml` is a real route, not a rewrite.
6. `src/middleware/errorHandler.ts` renders the same code-specific copy that `error.php` holds today for 400 through 505, reading from a single `ERROR_COPY` record so the 30 `ErrorDocument` lines are no longer needed.

`scripts/verify-routes.mjs` asserts every one of these, run in CI and again after the first production deploy.
