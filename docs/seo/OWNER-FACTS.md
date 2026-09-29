# OWNER-FACTS — facts the public site asserts that only the owner can confirm

Stage 1 SEO audit, 2026-09-26, branch `seo-audit`. One row per **unresolved**
fact the marketing pages state as true. Nothing here is invented: every
"canonical answer needed" is left blank or given as a range *observed on the
pages*, never resolved by picking a number. Where pages disagree, the
disagreement is recorded — it is **not** silently reconciled to the higher
figure (per the audit brief and DECISIONS §28 empty-green ethos).

Legend — **Risk**: what breaks if we publish the wrong value.
Line refs are into the **served root HTML** (the deployed bytes, per §29.60).

---

## A. Identity & registration (all currently placeholders)

| # | Fact | Canonical answer needed | Pages / file:line | Risk if wrong |
|---|------|------------------------|-------------------|---------------|
| 1 | Legal entity name (`legalName`) | _[owner]_ | index.html:114 | Schema `Organization.legalName` is a literal placeholder → invalid/embarrassing structured data |
| 2 | GSTIN | _[owner]_ | index.html:128 | Placeholder ships as fact; a wrong GSTIN is a compliance/trust failure |
| 3 | RERA registration no. | _[owner]_ | index.html:129 | Construction firm claiming RERA cover with a placeholder is a legal-exposure risk |
| 4 | Team headcount | _[owner]_ | index.html:131 | Placeholder in `numberOfEmployees` |
| 5 | Founder full name | _[owner]_ | best-construction-company-in-bengaluru-projects.html:85 (`[PLACEHOLDER: Founder full name]`) | Named founder used in author/about credit — placeholder is visible breakage |
| 6 | Canonical phone number | _[owner: pick ONE primary]_ | 7829292929, 8029652243, 6157069211 (about-us.html:81,89,493…), `+91-XXXXXXXXXX` placeholder (best-construction-company-in-bengaluru.html:259) | Three different numbers + one placeholder across pages → NAP inconsistency hurts local ranking and loses calls |

## B. Track-record numbers (pages contradict each other)

| # | Fact | Values seen (unreconciled) | Pages / file:line | Risk if wrong |
|---|------|----------------------------|-------------------|---------------|
| 7 | Google rating | **4.8** (index.html:1089) vs **4.0 / 5.0** (index.html:1204); `aggregateRating` 4.0 from 4 reviews everywhere | index.html:1089,1204; about-us.html:87; services:82; packages:51; bengaluru:270; projects:1143; tumkur:590,997 | Two ratings on the home page; schema rating must match a **real, on-page, verifiable** count or the `aggregateRating` must be removed (brief + Google policy) |
| 8 | Review count | "4" (schema) vs "4.0-star from 4 reviews" prose | bengaluru.html:315,700; projects.html:1143; tumkur | 4 reviews is implausibly low for the trust claims; if not the real GBP count, remove aggregateRating |
| 9 | Years in business | **2018 / 8 yrs** (index.html:125), "**over a decade**" (about-us.html:846; tumkur:573), "**10+ Years**" (tumkur:611), "**over 8 years**" (bengaluru:315,482,700) | as listed | "Over a decade" vs foundingDate 2018 is a direct contradiction; pick the true founding year |
| 10 | Project count | "**30+**" (projects H1, index) vs "**200+ Projects Delivered Across Karnataka**" (tumkur:615) vs "**over 60 acres**" (index:128; projects:128) | projects.html:1143; tumkur:615; index:128 | 30+ vs 200+ is a 6× contradiction on the same brand; "60 acres" is an area, not a count — don't let copy conflate them |

## C. Warranty / guarantee terms (four different promises)

| # | Fact | Values seen | Pages / file:line | Risk if wrong |
|---|------|-------------|-------------------|---------------|
| 11 | Structural warranty | "10-year structural" | index.html (throughout); about-us.html:114 | A written warranty is a contractual promise; must match the actual customer contract |
| 12 | Waterproofing warranty | **1 year** (about-us.html:114; packages:77,741) vs **"5 to 10 years"** (services:105,688) | as listed | Same service, 1 yr on one page and up to 10 yr on another — whichever is wrong is either a broken promise or under-selling |
| 13 | Finishing warranty | 1 year (about-us.html:114) | about-us.html:114 | Contractual |
| 14 | Defect-liability period | "12-month defect liability period, in writing" (tumkur:864) | tumkur.html:864 | Must match contract; and reconcile with the "10-year structural" wording elsewhere |

## D. Pricing

| # | Fact | Values seen | Pages / file:line | Risk if wrong |
|---|------|-------------|-------------------|---------------|
| 15 | Package per-sq-ft rates | ₹2,299 / ₹?/ ₹? / ₹3,499 (Silver/Platinum/Gold/Diamond) | packages.html:41,64,74,525; and price tables duplicated on index, bengaluru, tumkur | Stale prices on 4 pages; a wrong floor/ceiling misleads and multiplies the correction surface |
| 16 | Is the per-sq-ft rate GST-inclusive? | _[owner — NOT STATED ANYWHERE on the site]_ | packages.html (no GST statement found) | **Competitors state GST-inclusive explicitly** (Sqft.Expert, buildAhome both say "incl. GST"). Silence here loses the comparison and risks a quoted-price dispute. Highest-value single fact for the cost query. |

## E. Client / developer relationships — HIGHEST LEGAL RISK

Named third parties are asserted as clients. Two tiers, very different risk.
Do **not** publish, keep, or re-use any of these (including logos) without the
owner confirming a real contract **and** permission to name/use the mark.

| # | Named party | Exact claimed relationship | Substantiation on site | Pages / file:line | Risk if wrong |
|---|-------------|----------------------------|------------------------|-------------------|---------------|
| 17 | Honda Cars India | "civil & structural works, KIADB Doddaballapura, OEM standards" | Case study + logo | projects.html:788,791; index.html:1168 | Named OEM + logo use without consent = trademark/defamation exposure |
| 18 | Mandot Steel | "85,000 sq ft industrial facility, Mantankurchi" | Case study + logo | projects.html:820,823; index.html:1172 | As above |
| 19 | VRL Automation Engineering | "40,000 sq ft, Janhavi Industrial Estate" | Case study | projects.html:806,815 | As above |
| 20 | Recipharma Pharma Services | "machine foundation & structural works, T Begur" | Case study | projects.html:774,783 | As above |
| 21 | Nambiar Builders (Ellegenza Purple Crust) | luxury-villa civil works, Hosur/Sarjapur Rd | Case study + logo | projects.html:838,847; index.html:1175 | Premium-developer name + logo use |
| 22 | Capstone Life | "ultra-luxury villa community, Sarjapura Rd" | Case study + logo | projects.html:70; index.html:1174 | As above |
| 23 | **Godrej Properties, Salarpuria Sattva, Casagrand** | "trusted by developers such as…" | **NONE — name-drop only, no case study, no logo** | index.html:1549; **terms.html:490; privacy-policy.html:507** | **Biggest risk:** three top-tier developer brands claimed with zero project, and the claim sits even on the legal (terms/privacy) pages. If there is no engagement, this is a false brand-association claim on every page footer. |

## F. Approval-authority facts (see verified research below the table)

| # | Fact | Canonical answer needed | Pages / file:line | Risk if wrong |
|---|------|------------------------|-------------------|---------------|
| 24 | Nelamangala building-approval authority + ULB grade | Nelamangala ULB (grade CMC vs TMC **unconfirmed**) + online Nambike Nakshe/Nirman 2.0; NOT BBMP | (to be written Stage 2; brief says verify authority) | Naming the wrong body (esp. "BBMP", which no longer exists — see below) is a factual error competitors already make |
| 25 | Bengaluru city approval authority | **BBMP dissolved → Greater Bengaluru Authority (GBA)**, in existence 15 May 2025; **five** corporations; ~709–712 sq km | any page naming BBMP as current | Stating BBMP as the live authority is now out of date |
| 26 | Tumkur approval authority | Building licence **inside Tumakuru City Corporation** limits = the City Corporation; **TUDA** is the planning authority for the wider local planning area | tumkur.html:909,1037 (TUDA refs) | "TUDA approves your building plan" is only true plot-by-plot; overclaim |
| 27 | Nelamangala within GBA? | **No** — Nelamangala is ~30 km NW in Bengaluru Rural district, outside the ~712 sq km GBA footprint | location copy | Placing Nelamangala "in Bengaluru/GBA" is wrong |
| 28 | e-khata / khata conversion facts (if cited in copy) | e-khata **mandatory for plan approval since 1 Jul 2025**; B→A khata window **to 31 Dec 2027** (a separate 2% fee concession ends 23 Aug 2026 — don't conflate); DC conversion **waived inside master-plan areas**, still required for agri land outside | any khata/approval copy | Quoting a 2026 conversion "deadline" is wrong (it's 2027) |

### Verified vs. the third-party research leads (web research, 2026-09-26)

- **CORRECTED:** the notion of "seven corporations" — the Act permits *up to* seven; the notification created **five**. GBA area is **~709–712 sq km** (cite both), not one round figure.
- **CORRECTED:** any "B-khata→A-khata by 2026" deadline → the conversion window runs **to 31 Dec 2027**.
- **CORRECTED:** "DC conversion always required" → **not** inside notified master-plan areas (deemed conversion).
- **Could not fully source (verify before publishing):** Nelamangala ULB grade (CMC vs TMC); the Doddaballapura "residential <500 sq m / G+1 → CMC, larger → planning authority" numeric threshold; and the TUDA-vs-City-Corporation issuer split for a given Tumkur plot.
- **Sources:** Greater Bengaluru Governance Act 2024 (Karnataka Act 36 of 2025); The Hindu (GBA 709 sq km; e-khata mandatory 1 Jul 2025); Times of India (B→A khata to 2027; no DC nod within master-plan areas); en.wikipedia.org/wiki/Greater_Bengaluru_Authority. Full URLs in the chat audit report.

## G. Literal placeholders & breakage still in the served bytes

These are not "facts to confirm" — they are strings that should never have
shipped. Listed here so the owner sees exactly what a visitor/crawler can read.

| Placeholder / defect | file:line |
|----------------------|-----------|
| `[PLACEHOLDER: Founder full name]` | best-construction-company-in-bengaluru-projects.html:85 |
| `[PLACEHOLDER: replace with a specific named commercial project…]` | best-construction-company-in-bengaluru-projects.html:1000 |
| `+91-XXXXXXXXXX` telephone placeholder | best-construction-company-in-bengaluru.html:259 |
| legalName / GSTIN / RERA / headcount placeholders | index.html:114,128,129,131 |
| gallery `alt` placeholders | index.html:1069,1070,1071 |
| map embed width/height placeholder | index.html:1184 |
| review-number placeholder | index.html:1089 |
| **Malformed tag `<34 class="accordion-heading">`** (should be `<h3`) | index.html:1258 |
| **EMPTY `<title>`** | best-construction-company-in-bengaluru.html; terms.html; privacy-policy.html |
| **EMPTY meta description** | best-construction-company-in-bengaluru.html |
| **"Rs" instead of ₹** in meta/schema/H1 | construction-packages-in-bengaluru.html:7,12,16,41,64,74,525 |
| **Broken internal links** `/about`, `/contact` (should be `/about-us`, `/contact-us`) | best-construction-company-in-bengaluru-projects.html |

_No mojibake (`â‚¹`) found; the only rupee defect is the "Rs" text on the
packages page. 23 correct ₹ on home, 47 on tumkur, 16 in packages body._


