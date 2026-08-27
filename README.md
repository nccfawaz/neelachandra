# Neelachandra Construction and Interiors: Platform

Repository for the full-stack rebuild of Neelachandra Construction and Interiors: the public marketing site at `neelachandra.com` plus an internal staff platform, in one codebase, one Node process, one domain.

**Status: the public site is live on staging as static HTML. The internal platform is specified but not built.**

| | State |
|---|---|
| Public marketing site (10 pages) | **Live** on the staging domain, served as static HTML with clean URLs |
| Error pages, `.htaccess`, `robots.txt`, manifest | **Live** |
| `/login` page | **Live, but deliberately inert.** The screen exists; nothing authenticates yet |
| Staff accounts, database, dashboards | **Not built.** Specified in `NCC_BUILD_SPEC.md`, blocked on the answers in section 8.1 |

Staging: <https://bisque-porpoise-208310.hostingersite.com>
Production: `neelachandra.com` (not yet cut over)

---

## How to create staff profiles and log in

**Read this first: you cannot create a staff profile today.** There is no database, no server process and no `users` table. The staging site is static files on Apache. `/login` is the screen the platform will use, and it is intentionally disabled and says so on the page, because a form that accepted a password and silently discarded it would look like it worked.

Everything in this section describes what happens **after** phase 2 of the build ships. It is written now so the process is agreed before it is coded, and so you can see what is needed from you.

> **Commands and screens marked `[phase 2]` do not exist yet.** They are the specified design, not something you can run today. Pasting them into a terminal now will fail. Everything in the Commands section further down does work today.

### The rule that shapes the whole process

**Nobody ever types or sees another person's password. Not the owner, not the administrator, not the developer.**

Creating an account writes a row with **no password at all** and sends an invite link. The person sets their own password when they open it. This is specified in `NCC_BUILD_SPEC.md` section 4.5, and it means there is no moment where a password exists in an email, a chat message, a spreadsheet or someone's memory. There is also no public sign-up page anywhere in the application: the only routes are `/login`, `/logout`, `/forgot-password`, `/reset-password/:token` and `/2fa/verify`.

### Part A. The very first account, the owner (done once, ever)

The owner's account is the only one that cannot be invited, because there is nobody to send the invite yet. This is a one-time bootstrap.

1. **Provision the database.** In hPanel, Databases, create a MariaDB database and user. Copy the credentials into hPanel environment variables as `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`. Never put them in this repository.
2. **Run the migrations.** `[phase 2]` `npm run db:migrate` applies `001_core_auth.sql` and `002_rbac.sql`, creating `users`, `roles`, `permissions`, `role_permissions`, `user_roles`, `user_sessions`, `password_reset_tokens`, `user_recovery_codes` and `login_attempts`.
3. **Seed the eight roles** and their permission bundles, from the matrix in specification section 4.3.
4. **Run the bootstrap script:** `[phase 2]` `node scripts/seed-users.mjs --owner`. It asks for the owner's full name, work email and phone. It does **not** ask for a password. It creates the row with `status = 'invited'`, `password_hash = NULL`, attaches the `owner` role, and prints a single-use invite link valid for 24 hours. The script refuses to run a second time once an owner exists.
5. **Open that link in a browser** and set a password. Minimum 12 characters, checked against a list of the 10,000 most common passwords. No forced rotation, no composition rules.
6. **Enrol two-factor authentication.** The `owner` role requires it, so the app blocks every other page until this is done. Scan the QR code with Google Authenticator, Authy or any TOTP app, enter the six-digit code to confirm.
7. **Save the ten recovery codes.** Shown once, each usable once, stored only as hashes. Print them or put them in a password manager. Losing both the phone and these codes means an administrator has to reset the account from the database.

### Part B. Every other staff account (through the admin screen)

Once the owner is in, all remaining accounts are created in the UI by someone holding `users.manage`, which is `owner` and `admin` only.

1. **Sign in** at `/login`, then go to **`/app/admin/users`** `[phase 2]`.
2. **Click Create user.** Enter full name, work email, phone.
3. **Tick one or two roles.** Two is allowed and normal here: at ten people, most staff wear more than one hat. Use `user_permission_overrides` later for one-off grants rather than inventing a new role.
4. **Save.** The system writes the user with no password and emails an invite valid 24 hours. Nothing is sent to you to forward.
5. **The staff member opens the invite,** sets their own password, and enrols TOTP if their role requires it (`owner`, `admin`, `accounts_manager`).
6. **Confirm on the user list** that their status has moved from `invited` to `active`. Until it does, they have never signed in.

If an invite expires, reissue it from the same screen. A login attempt on an account that is still `invited` returns the same generic failure as a wrong password, so an outsider cannot use the login form to discover which addresses exist.

### Part C. Logging in, day to day

1. Go to **`/login`**.
2. Enter work email and password.
3. If the role requires 2FA, enter the six-digit code from the authenticator app.
4. You land on the dashboard, scoped to your permissions.

Details worth knowing:

- The session cookie lasts **12 hours** and renews on activity. Sessions are stored in the database, not in memory, specifically so that Hostinger putting an idle Node process to sleep does not log everyone out.
- **Five failed attempts in 15 minutes locks the account** with an exponential backoff, tracked by both email and IP.
- **Forgot password** goes through `/forgot-password` and emails a reset link. Again, nobody sees the new password.
- On first login after an invite, and any time an administrator forces a reset, every request redirects to the change-password screen until it is done.

### Part D. Changing and removing access

| Task | Where | What actually happens |
|---|---|---|
| Add or remove a role | `/app/admin/users/:id` | Effective permissions recalculate on their next request |
| Grant one extra permission temporarily | Same screen, overrides section | Recorded with who granted it and a required note, and revocable. Use this instead of creating a new role when someone covers for a colleague on leave |
| Suspend | Same screen | Blocks login, keeps the account |
| **Staff member leaves** | Set status `inactive` | Blocks login **and deletes their session rows in the same transaction.** Without that delete a departing employee keeps a working cookie for up to 12 hours |
| Delete a person | **Not possible, by design** | Every record carries `created_by`. A site report from two years ago must still name its author. Leavers go `inactive` |

### Two consequences to decide on before this is built

**Approving your own expense is blocked, including for the owner.** With one person holding the bank login, the only meaningful control is that two names appear on every voucher. If there is genuinely only one person touching money, say so and the second approver becomes an explicit, documented exception with a compensating control, rather than a control that exists on paper and gets worked around in practice.

**A supervisor asking for a project they are not assigned to gets 404, not 403.** They should not be able to learn that a project exists by trying ID numbers.

### What is needed from you before any of this can be built

This is blocked on people decisions, not on code. From specification section 8.1:

1. **The ten staff, one line each:** `full name | work email | phone | what they actually do day to day | role(s)`. The eight roles in section 4.2 are inferred from four names in your site's own structured data (Chandrashekar T, Sushma N, Vinay, Naveen Kumar) plus a stated headcount of about ten. That is a guess, and building permissions on a guessed org chart means reworking them.
2. **Who holds `owner`, `admin` and `accounts_manager`.** These three carry the real power.
3. **Is Naveen Kumar staff or an external consultant?** Decides whether he gets a login at all.
4. **Approval limits** (section 8.2): what can a project manager approve alone, for an expense and for a purchase order, and above what value are two approvals mandatory? Set too low and people route around the system; too high and it is decoration. No defaults have been invented.
5. **Do site supervisors have company-controlled smartphones, and will they file a daily report?** Below roughly 80 percent compliance the progress-tracking design needs rethinking rather than building.

Use work emails on `neelachandra.com` rather than the shared Gmail currently in the site footer. Invites, resets and approval mail all depend on authenticated sending from the domain.

---

## What is in this repository

| Path | Purpose |
|---|---|
| `NCC_BUILD_SPEC.md` | The complete implementation specification. Read fully before writing code. |
| `index.html` and 9 more page files | The ten live public pages, generated by `npm run build:site`. Do not hand-edit; see the freeze below. 24 `.html` files sit at the root in total: 10 public, 12 error, `login.html`, and the Google Search Console verification file. |
| `login.html` | The staff sign-in screen, generated. Inert until phase 2. |
| `400.html` ... `504.html` | Twelve error pages, generated. |
| `.htaccess` | Clean URLs, repository protection, legacy redirects, error documents. |
| `assets/`, `favicon.ico`, `robots.txt`, `sitemap.xml`, `site.webmanifest` | Site assets and infrastructure. |
| `legacy/golden/` | **The design of record.** HTML, assets and screenshots captured from the live site, SHA-256 per file. Never edit. |
| `legacy/CONTENT-QUERIES.md` | Content problems found on the live site, recorded rather than silently fixed. |
| `legacy/sandbox-scaffold/` | An unused Cloudflare starter, archived. See its README. |
| `scripts/lib/corrections.mjs` | The approved corrections applied on top of golden. Explained below. |
| `scripts/build-*.mjs` | Site, error page and login page generators. |
| `scripts/parity-check.mjs`, `selftest-parity.mjs` | The freeze gate and its self-test. |
| `scripts/capture-*.mjs` | Golden master and asset capture. |
| `scripts/test-htaccess.mjs` | 99 assertions covering routing and the live corrections. |

### Commands

```bash
npm install
npx playwright install chromium

npm run build:all          # regenerate site, error pages and login page
npm run build:site:check   # assert deployed files match golden plus approved corrections
npm run test:htaccess      # 99 routing and content assertions against a local Apache
npm run test:htaccess -- --base=https://bisque-porpoise-208310.hostingersite.com
npm run parity:selftest    # prove the freeze gate catches violations: 16 cases
npm run parity -- --candidate=https://bisque-porpoise-208310.hostingersite.com
npm run capture:assets:verify   # confirm the 62 mirrored assets are byte-intact
```

Last verified: `test:htaccess` **100 passed, 0 failed** against staging; parity **60/60 axis checks** across all ten pages; `capture:assets:verify` **62 ok, 6 known upstream 404s**.

---

## Two constraints that will cost you if you miss them

**The public site design and content are frozen.** The public work is a rendering-engine swap, not a redesign and not a copy rewrite. `legacy/golden/` stays pristine as the audit record of what the old site served, so approved changes are applied on the way out by `scripts/lib/corrections.mjs` rather than edited into golden. Both `build:site:check` and the parity gate compare against golden-plus-corrections, so unintended drift still fails while approved changes do not drown the signal.

Four corrections are approved and live:

| Correction | Why |
|---|---|
| One canonical per page | Nine of ten pages had a broken canonical, and seven had **two** tags, one correct and one empty. Conflicting canonicals cancel out. |
| Rating is 4.0 from 4 reviews | The 4.8 was fabricated. The real figure came from the Google Business Profile histogram: 3 five-star and 1 one-star, which is 16/4 = 4.0. It replaced four contradictory review counts (2, 4, 4, 30, 87) and appeared in **seven** visible formats plus JSON-LD. |
| `favicon.ico` everywhere | Five conventions across ten pages, several pointing at paths that 404. |
| Login link in the header | New entry point, reusing the existing `.nav-link` class. |

**Phase 0 step 1a is irreversible if missed. The capture half is done.** Deploying a Node app to a domain that already hosts a website on Hostinger requires removing that website first, and the removal destroys files, databases and email permanently. The golden masters and 62 mirrored assets are captured and committed, so the design reference exists outside that hosting account. Re-run `npm run capture:golden` immediately before cutover.

**Still outstanding and still mandatory: the full `public_html` archive** (specification section 7.2). The original PHP sources, the original `.htaccess` and `enquiry-handler.php` were never served over HTTP, so they are not in the mirror and cannot be recovered from the live site. Nobody should touch the hosting panel until that archive exists and has been verified restorable.

### Deployment, and a trap it created

The repository root **is** the web root on Hostinger. Every file here is a candidate URL. Before `.htaccess` existed, `NCC_BUILD_SPEC.md`, the golden masters, `package.json` and the tooling were all publicly downloadable while no site existed at all. `.htaccess` section 2 now returns 404 for those paths, chosen over 403 so their presence is not advertised.

`X-Robots-Tag: noindex` is scoped by host to `hostingersite.com`, so the staging domain cannot be indexed and the rule disappears by itself at cutover. The canonical-host redirect is written and commented at the bottom of `.htaccess`, ready to enable.

---

## Target stack

Section 2 of the specification, driven by the Hostinger constraints in section 1.9.

- Node.js 22 LTS, Hono 4, `@hono/node-server`
- `hono/jsx` server rendering, htmx 2 and Alpine.js 3 self-hosted, Chart.js on dashboard pages only
- MariaDB via `mysql2/promise` and Kysely 0.27
- Self-hosted session cookie auth, argon2id, TOTP for privileged roles
- Hostinger Business or Cloud, Node.js Web App, GitHub push-to-deploy

Not Cloudflare Workers, not Postgres, not Prisma. Section 2 gives the reasoning, including what was given up.

## Modules

Public marketing site, then eight internal modules under `/app`: authentication, admin, projects tracker, inventory, marketing, HR and recruiting, sales and CRM, budget and expense tracker. Build order and its dependency reasoning are in section 5, and it is not the order they are listed in.

## Open questions

| Question | Blocks |
|---|---|
| 8.1 Roles and actual org chart | Phase 2, staff accounts |
| 8.2 Approval limits per role and document type | Phase 7 |
| 8.3 Stage templates and payment milestones | Phase 3 |
| 8.4 Material consumption norms | Phase 4 |
| 8.7 Offline capability for site staff | Decide before phase 3 |
| 8.11 Hosting plan specifics | Phase 0 |

8.7 is the one most easily missed. If supervisors need to file reports without signal, idempotency keys have to be in the API from the first route rather than retrofitted, so the answer changes phase 3 architecture.

Resolved: CQ-1 (fabricated rating), CQ-2 (`robots.txt` belonged to the interiors site) and CQ-5 (broken manifest icons and five favicon conventions) are fixed and live. CQ-3 and CQ-4 remain open in `legacy/CONTENT-QUERIES.md`.
