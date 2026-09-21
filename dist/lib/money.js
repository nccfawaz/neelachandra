/**
 * Integer paise arithmetic, GST, TDS and retention (spec: src/lib/money.ts).
 *
 * Every money column in the schema is BIGINT paise. Nothing in this file
 * returns a float for a money value, because a rupee amount that has been
 * through a float is an amount that can print as 12,34,566.99 on an invoice
 * the client then disputes.
 *
 * Rounding is half-up at the paise, which is what Indian invoicing does and
 * what the GST rules assume. Math.round is half-up for positives but rounds
 * -0.5 to -0, so negatives are handled explicitly: a credit note is a real
 * case and it must round the same magnitude as the debit it reverses.
 */
export const PAISE_PER_RUPEE = 100;
export function roundPaise(value) {
    return value < 0 ? -Math.round(-value) : Math.round(value);
}
export function rupeesToPaise(rupees) {
    const n = typeof rupees === 'string' ? Number(rupees.replace(/,/g, '').trim()) : rupees;
    if (!Number.isFinite(n))
        return 0;
    return roundPaise(n * PAISE_PER_RUPEE);
}
export function paiseToRupees(paise) {
    return paise / PAISE_PER_RUPEE;
}
/**
 * Indian grouping: last three digits, then pairs. 1234567 paise renders as
 * "12,345.67". The Intl en-IN formatter does this correctly, and it is used
 * rather than a hand-rolled regex so a change to the grouping rules is not
 * this code's problem.
 */
const inrFormatter = new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
});
/** "12,34,567.00". No currency symbol, the template supplies "Rs". */
export function formatPaiseAsRupees(paise) {
    if (paise === null || paise === undefined)
        return '';
    return inrFormatter.format(paiseToRupees(Number(paise)));
}
/** "₹12,34,567.00" — the rupee-symbol form used by the dashboard KPI tiles. */
const inrSymbolFormatter = new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
});
export function formatPaiseAsRupeesSymbol(paise) {
    if (paise === null || paise === undefined)
        return '';
    return inrSymbolFormatter.format(paiseToRupees(Number(paise)));
}
/** "Rs 12,34,567.00", the form used in tables and on printed documents. */
export function formatPaiseAsRupeesWithRs(paise) {
    if (paise === null || paise === undefined)
        return '';
    return `Rs ${formatPaiseAsRupees(paise)}`;
}
/**
 * Compact form for KPI cards: "Rs 1.24 Cr", "Rs 12.35 L", "Rs 45,600".
 * Crore and lakh are the units this business actually speaks in; a contract
 * value printed as 12,400,000 is harder to read at a glance than 1.24 Cr.
 */
export function formatPaiseAsRupeesCompact(paise) {
    if (paise === null || paise === undefined)
        return '';
    const rupees = paiseToRupees(Number(paise));
    const abs = Math.abs(rupees);
    const sign = rupees < 0 ? '-' : '';
    if (abs >= 10_000_000)
        return `${sign}Rs ${(abs / 10_000_000).toFixed(2)} Cr`;
    if (abs >= 100_000)
        return `${sign}Rs ${(abs / 100_000).toFixed(2)} L`;
    return `${sign}Rs ${inrFormatter.format(abs).replace(/\.00$/, '')}`;
}
/** A percentage applied to a paise amount, rounded to whole paise. */
export function applyPct(paise, pct) {
    return roundPaise(paise * (pct / 100));
}
/**
 * Splits GST on a taxable amount. Intra-state supply, which is every
 * Karnataka-to-Karnataka transaction this business does, splits into equal
 * CGST and SGST. Inter-state is IGST at the full rate.
 *
 * The split is computed by halving the total tax and giving the remainder
 * paisa to CGST, rather than computing each half independently. Computing
 * both halves at pct/2 and adding them can produce a total one paisa away
 * from the tax on the full rate, and that one paisa is what makes a GSTR-1
 * reconciliation fail.
 */
export function splitGst(taxablePaise, gstPct, interState = false) {
    const tax = applyPct(taxablePaise, gstPct);
    if (interState) {
        return {
            taxablePaise,
            cgstPaise: 0,
            sgstPaise: 0,
            igstPaise: tax,
            totalPaise: taxablePaise + tax,
        };
    }
    const sgst = Math.floor(tax / 2);
    const cgst = tax - sgst;
    return {
        taxablePaise,
        cgstPaise: cgst,
        sgstPaise: sgst,
        igstPaise: 0,
        totalPaise: taxablePaise + tax,
    };
}
/**
 * TDS is deducted on the taxable value, not on the GST-inclusive total. This
 * is the rule under the Income Tax Act and getting it wrong overstates every
 * deduction by the GST rate.
 */
export function computeTds(taxablePaise, tdsPct) {
    return applyPct(taxablePaise, tdsPct);
}
/**
 * The full arithmetic of an expense voucher or a contractor bill:
 * taxable, GST, gross total, TDS on taxable, net payable.
 */
export function computeVoucher(opts) {
    const gst = splitGst(opts.taxablePaise, opts.gstPct, opts.interState ?? false);
    const tds = computeTds(opts.taxablePaise, opts.tdsPct ?? 0);
    return {
        ...gst,
        tdsPaise: tds,
        netPayablePaise: gst.totalPaise - tds,
    };
}
/**
 * Retention on a client invoice. Held back from the payable amount until the
 * defect liability period ends, then released by a retention_release invoice.
 */
export function computeRetention(taxablePaise, retentionPct) {
    return applyPct(taxablePaise, retentionPct);
}
/** Sums a list of paise safely, tolerating null columns. */
export function sumPaise(values) {
    let total = 0;
    for (const v of values)
        total += Number(v ?? 0);
    return total;
}
/**
 * Variance as a percentage of the expectation, guarded against a zero
 * expectation. Returns null rather than Infinity when there is no baseline,
 * because "no norm set" and "infinitely over" are different answers and the
 * consumption report must not print the second when it means the first.
 */
export function variancePct(actual, expected) {
    if (expected === 0)
        return null;
    return ((actual - expected) / expected) * 100;
}
/**
 * Parses a rupee amount typed by a user. Accepts "12,34,567.89", "1234567.89"
 * and "12 34 567". Returns null for anything else so the caller can produce a
 * field error rather than silently booking zero.
 */
export function parseRupeeInput(raw) {
    if (raw === null || raw === undefined)
        return null;
    const cleaned = String(raw).replace(/[,\s]/g, '').replace(/^Rs\.?/i, '');
    if (cleaned === '')
        return null;
    if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned))
        return null;
    return rupeesToPaise(Number(cleaned));
}
