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

- Header comment reads `robots.txt — Neelachandra Interiors` and `https://neelachandrainteriors.com`
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

## Method note

These four were found by capturing the live pages and reading them, not by reading the old repository. CQ-1 and CQ-3 both **contradict** what the repository's own `README.md` and file layout implied, which is the practical argument for the golden capture being a mandatory phase 0 step rather than a formality: the repository is not a reliable description of what is actually being served.
