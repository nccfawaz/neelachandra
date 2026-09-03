# Content queries

Things found in the live site's content that look wrong or carry risk. Per spec 7.3, these are recorded here and raised with the business. **They are not silently fixed during migration**, because a silent fix is indistinguishable from a parser bug.

Captured from the golden masters taken 2026-08-24 from `https://neelachandra.com`.

---

## CQ-1. The aggregate rating is emitted, and four different review counts are published (HIGH)

Spec 6.5 rule 6 and spec 1.8 item 10 both stated that the live pages emit **no** `aggregateRating`, based on a note in the old repository's `README.md` saying it had been deliberately removed. **The captured HTML disproves that.** Five of the ten pages emit an `AggregateRating` node, and they do not agree with each other:

| Page | `ratingValue` | `reviewCount` |
|---|---|---|
| `/construction-packages-in-bengaluru` | 4.8 | **2** |
| `/about-us` | 4.8 | **4** |
| `/construction-services-in-bengaluru` | 4.8 | **4** |
| `/best-construction-company-in-bengaluru` | 4.8 | **30** |
| `/construction-company-in-tumkur` | 4.8 | **87** |
| `/`, `/best-construction-company-in-bengaluru-projects`, `/contact-us`, `/terms`, `/privacy-policy` | none | none |

Verify with:

```
grep -o '"reviewCount": *"[^"]*"' legacy/golden/*.html
```

Why this matters, in order of severity:

1. **Four contradictory review counts for one business is a structured-data violation.** Google's review-snippet guidelines require the aggregate to reflect genuine reviews collected by the site. Self-serving markup that disagrees with itself across pages is the pattern manual actions are issued for. The exposure is a rich-result penalty, not a warning.
2. **A 4.8 average over 2 reviews is not a meaningful claim**, and 87 reviews is not reconcilable with 2 on a sibling page.
3. Under the Consumer Protection Act 2019 and the CCPA's 2022 guidelines on dark patterns, publishing unverifiable ratings is a misleading-advertisement risk independent of Google.

**Not changed during migration.** Per the freeze the port reproduces each page's current node exactly, including the disagreement, and the parity gate asserts it (`json-ld values` check). The dormant computed-rating mechanism in spec 6.5 rule 6 stays dormant.

**Needs a decision (spec 8.5).** Options: supply the real basis (a Google Business Profile export, for instance) and switch on the computed node; or remove the rating markup from all five pages as a deliberate, signed-off content change. Doing nothing leaves a live penalty risk.

---

## CQ-2. `robots.txt` belongs to the wrong website (HIGH)

The file served at `https://neelachandra.com/robots.txt` is the **interiors** site's robots file:

- Header comment names Neelachandra Interiors and the `neelachandrainteriors.com` domain
- `Sitemap:` directive points at `https://neelachandrainteriors.com/sitemap.xml`
- Body comments reason about "an interiors studio competing on best interior designers in Bengaluru"

Consequence: `neelachandra.com` advertises a sitemap on a different domain and never advertises its own. Spec 7.5 item 6 already flagged the sitemap line; the capture shows the whole file is misplaced, not just one line.

The `Disallow` rules are still valid for this domain (`/enquiry-handler.php`, `/contact-form.php`, `/header.php`, `/footer.php`, and the `?sent=`, `?error=`, `?reveal=` query forms), and the AI-crawler allowlist is deliberate and worth keeping.

**Action at migration:** correct the `Sitemap:` line to `https://neelachandra.com/sitemap.xml` and the header comment to name this site. Category 2 of the freeze (non-page infrastructure), already sanctioned by spec 7.5 item 6. The crawler directives are carried across unchanged.

---

## CQ-3. `/security.txt` 404s while `/.well-known/security.txt` resolves (LOW)

Spec 7.5 item 6 assumed `security.txt` was served at the root and needed **moving** to `/.well-known/`. The capture shows it is **already** correctly at `/.well-known/security.txt` (197 bytes) and the root path returns 404.

So there is nothing to move. The file's own `Canonical:` line already agrees with where it is served. Spec 7.5 has been corrected.

One real issue remains: its second contact line is `https://neelachandra.com/contact`, which is not a live URL on this site (the contact page is `/contact-us`). Spec 3.1 rule 2 already 301s `/contact` to `/contact-us`, so it will resolve after cutover, but the file should name the canonical path directly.

Also note `Expires: 2027-07-13`. RFC 9116 requires a future expiry; this one is valid now but needs review before that date.

---

## CQ-4. `foundingDate` is 2018 in JSON-LD (INFO, needs confirmation)

`/best-construction-company-in-bengaluru` carries `"foundingDate": "2018"`. Not contradicted anywhere else in the captured pages, but it is a factual claim that will be reused in the `settings` table (spec 6.2) and rendered on the public site, so it should be confirmed once rather than propagated unverified.

---

## CQ-5. Six referenced assets 404 on the live site (MEDIUM)

Mirroring every same-origin asset (`npm run capture:assets`) reached 66 of 72 successfully. Six return 404 from the live host. These are not capture failures; each was re-checked directly with `curl` against `https://neelachandra.com`.

The reference total was 68 on the original capture of 2026-08-27 and is 72 now. The four added on 2026-09-02 are not new references on the live site; they are references the scanner could not see, and are recorded as a dated amendment in `assets-manifest.json` rather than a re-capture. See `DECISIONS.md` 5.1 and the method note below.

| Path | Referenced by |
| --- | --- |
| `/favicon/site.webmanifest` | `home` via `<link rel="manifest">` |
| `/assets/images/favicon/favicon-32x32.png` | `projects` |
| `/assets/images/favicon/favicon-192x192.png` | `projects` |
| `/assets/images/favicon/apple-touch-icon.png` | `projects` |
| `/favicon.ico/web-app-manifest-192x192.png` | `site.webmanifest` `icons[0]` |
| `/favicon.ico/web-app-manifest-512x512.png` | `site.webmanifest` `icons[1]` |

Three separate faults are visible here.

1. **The home page's manifest link is broken.** It points at `/favicon/site.webmanifest`, which 404s. The real file is at `/site.webmanifest` and returns 200. Only `about` links to the correct path; the other eight pages emit no manifest link at all.

2. **`site.webmanifest` treats a file as a directory.** Both its icon entries are under `/favicon.ico/`, and `/favicon.ico` is a 15 KB icon file, not a folder. So even when the manifest is reached, both maskable icons fail. The site has no working PWA icons.

3. **`projects` uses a favicon convention no other page uses.** It points into `/assets/images/favicon/`, a directory that does not exist. Across the ten pages there are five different favicon conventions: the full modern block (`home`, `about`), a seven-line all-`favicon.ico` block (`contact`, `packages`, `services`), a single `favicon.ico` line (`bengaluru`, `privacy`, `terms`, `tumkur`), and the broken `assets/images/favicon/` variant (`projects`).

**Action at migration:** these fall under freeze category 1 and category 2, not a redesign. The rendered markup must stay byte-identical per spec 3.2, so the fix is to make the references resolve, not to restyle the head. Concretely: serve the manifest at both `/site.webmanifest` and `/favicon/site.webmanifest`, correct the two `icons[].src` values to real paths, and either generate the three `assets/images/favicon/` files or 301 them to the existing root icons. Consolidating the five favicon conventions into one is a **content change** and is therefore out of scope unless you approve it separately.

Note that nothing here is currently user-visible: every page also emits a working `/favicon.ico`, so browsers fall back successfully. The cost is failed requests and a non-functioning web app manifest.

---

## Method note

These five were found by capturing the live pages and their assets and reading them, not by reading the old repository. CQ-1 and CQ-3 both **contradict** what the repository's own `README.md` and file layout implied, which is the practical argument for the golden capture being a mandatory phase 0 step rather than a formality: the repository is not a reliable description of what is actually being served.

CQ-5 makes a second point. The golden HTML captures what the server *says*; only fetching every referenced asset reveals what the server can actually *deliver*. Six broken references were invisible until the assets were mirrored, and would have been indistinguishable from porting mistakes had they first appeared after cutover.

There is a third point, found on 2026-09-02 and worse than either. A reference the mirror *requests* and gets a 404 for is recorded as a 404, and shows up in the counts above. A reference the scanner never learns about is not recorded at all — it is absent from `assets-manifest.json` as neither a success nor a failure, so no count moves and nothing looks wrong. Four live, working assets were in that state: three hero WebPs reachable only through a CSS `url()` inside a `<style>` block, and `/og.webp`, reachable only through `<meta property="og:image">`. All four returned 200 the moment they were actually asked for. Had the live site been removed first, they would have been lost with no trace in the record that they had ever existed. The reference total in CQ-5 therefore moved 68 → 72 without any change to the live site. Cause, fix and evidence are in `DECISIONS.md` 5.1; the gate now has a dedicated mutation per reference mechanism so an unscanned mechanism fails a test instead of failing silently.
