// Single source of truth for owner-verified business facts, used to ensure
// consistency across all marketing pages and prevent drift.
//
// Every value here has been verified with the business owner and documented in
// docs/seo/OWNER-FACTS.md or DECISIONS.md. Do not change these without explicit
// owner approval.
// Company founding year, per owner confirmation (DECISIONS §42). Use
// yearsInBusiness() to compute current duration so claims stay accurate.
export const FOUNDING_YEAR = 2018;
// Canonical contact phone number. The only number that should appear on public
// pages. Previously the site displayed three different numbers
// (7829292929, 8029652243, 6157069211) inconsistently across pages.
export const PHONE = '+91 7829292929';
// Google Business Profile rating, read from the live listing at
// https://maps.app.goo.gl/xKXFta3YY4gzuJFU6 on 2026-08-27.
export const GOOGLE_RATING = {
    value: 4.0,
    count: 4,
    // With only 4 reviews, Google does not display an aggregate rating publicly.
    // Schema.org aggregateRating nodes must be removed from all pages to avoid
    // claiming a displayed rating that does not exist.
    displayAggregateRating: false
};
// All per-sq-ft prices include GST. This must be stated explicitly next to
// every price table to avoid customer confusion.
export const PRICES_INCLUDE_GST = true;
// Verified client relationships. Every name here is proven to appear in the
// served pages (legacy/golden/*.html) and confirmed genuine per owner review
// (DECISIONS §42). The grouping mirrors how the owner listed them: the six
// flagship engagements, plus the three named residential developers. Names not
// present in the served bytes (previously BEML, Mangalam Cement, Viom Networks,
// Biocon) were invented and have been removed.
export const CLIENTS = {
    tier1: [
        'Honda Cars India',
        'Mandot Steel',
        'VRL Automation Engineering',
        'Recipharma Pharma Services',
        'Nambiar Builders',
        'Capstone Life'
    ],
    residentialDevelopers: [
        'Godrej Properties',
        'Salarpuria Sattva',
        'Casagrand'
    ]
};
/**
 * Compute years in business from FOUNDING_YEAR to the current date.
 * Use this in copy instead of hardcoded durations like "over a decade" or
 * "10+ years" so claims stay accurate as time passes.
 *
 * @returns Number of full years since founding (e.g., 8 for 2026)
 */
export function yearsInBusiness() {
    const now = new Date();
    return now.getFullYear() - FOUNDING_YEAR;
}
/**
 * Format yearsInBusiness() as a user-facing string.
 * Returns "N+ years" for consistency with existing copy style.
 */
export function yearsInBusinessFormatted() {
    return `${yearsInBusiness()}+ years`;
}
