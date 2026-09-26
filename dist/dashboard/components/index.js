import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "hono/jsx/jsx-runtime";
import { formatPaiseAsRupeesWithRs, formatPaiseAsRupeesCompact } from '../../lib/money.js';
import { formatDate, formatDateTime } from '../../lib/dates.js';
/**
 * The shared component set (spec 3: src/dashboard/components).
 *
 * Modules never render their own table or badge. That rule is what stops the
 * eight modules from becoming eight private conventions, and it is why these
 * live in one file: a component nobody can find gets reimplemented.
 */
/* Money ------------------------------------------------------------------ */
/**
 * Renders paise. `hidden` is the cost-visibility path (spec 4.2): a caller
 * without projects.view_cost passes hidden and the number never reaches the
 * HTML, rather than being blanked with CSS where View Source still shows it.
 */
export function Money(props) {
    if (props.hidden)
        return _jsx("span", { class: "ncc-muted", children: "restricted" });
    if (props.paise === null || props.paise === undefined)
        return _jsx("span", { class: "ncc-muted", children: "-" });
    return (_jsx("span", { class: "ncc-num", children: props.compact ? formatPaiseAsRupeesCompact(props.paise) : formatPaiseAsRupeesWithRs(props.paise) }));
}
export function Qty(props) {
    if (props.value === null || props.value === undefined)
        return _jsx("span", { class: "ncc-muted", children: "-" });
    // Trailing zeros on a quantity are noise: 12.000 bags reads worse than 12.
    const n = Number(props.value);
    const text = Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)));
    return (_jsxs("span", { class: "ncc-num", children: [text, props.unit ? ` ${props.unit}` : ''] }));
}
export function DateText(props) {
    const text = props.withTime ? formatDateTime(props.value) : formatDate(props.value);
    if (!text)
        return _jsx("span", { class: "ncc-muted", children: "-" });
    return _jsx("span", { children: text });
}
/**
 * One status vocabulary for the whole app. A status word means the same
 * colour on every screen, so "on_hold" is never amber in projects and grey in
 * inventory.
 */
const TONES = {
    // generic
    draft: 'muted',
    submitted: 'warn',
    pending: 'warn',
    pending_approval: 'warn',
    approved: 'ok',
    rejected: 'danger',
    cancelled: 'danger',
    void: 'danger',
    closed: 'muted',
    open: 'warn',
    // users
    invited: 'warn',
    active: 'ok',
    suspended: 'danger',
    inactive: 'muted',
    // projects
    prospect: 'muted',
    mobilising: 'warn',
    in_progress: 'ok',
    on_hold: 'danger',
    snagging: 'warn',
    handed_over: 'ok',
    defect_liability: 'warn',
    // stock and quality
    in_stock: 'ok',
    low: 'warn',
    out_of_stock: 'danger',
    passed: 'ok',
    failed: 'danger',
    // finance
    paid: 'ok',
    part_paid: 'warn',
    unpaid: 'danger',
    overdue: 'danger',
    soft_closed: 'warn',
};
export function StatusBadge(props) {
    if (!props.status)
        return _jsx("span", { class: "ncc-muted", children: "-" });
    const tone = props.tone ?? TONES[props.status] ?? 'muted';
    return (_jsx("span", { class: `ncc-badge ncc-badge-${tone}`, children: props.status.replace(/_/g, ' ') }));
}
export function FormField(props) {
    const value = props.value === null || props.value === undefined ? '' : String(props.value);
    return (_jsxs("label", { class: "ncc-field", children: [_jsxs("span", { children: [props.label, props.required ? _jsx("abbr", { title: "required", children: " *" }) : null] }), props.options ? (_jsx("select", { name: props.name, required: props.required, disabled: props.disabled, children: props.options.map((o) => (_jsx("option", { value: o.value, selected: o.selected, children: o.label }))) })) : props.rows ? (_jsx("textarea", { name: props.name, rows: props.rows, required: props.required, placeholder: props.placeholder, disabled: props.disabled, children: value })) : (_jsx("input", { name: props.name, type: props.type ?? 'text', value: value, required: props.required, placeholder: props.placeholder, step: props.step, min: props.min, max: props.max, autocomplete: props.autocomplete, disabled: props.disabled })), props.hint ? _jsx("span", { class: "ncc-hint", children: props.hint }) : null, props.error ? _jsx("strong", { class: "ncc-field-error", children: props.error }) : null] }));
}
export function CsrfInput(props) {
    return _jsx("input", { type: "hidden", name: "nc_csrf", value: props.token });
}
export function DataTable(props) {
    if (props.rows.length === 0) {
        return _jsx("div", { class: "ncc-empty", children: props.empty ?? 'Nothing to show yet.' });
    }
    const card = props.card;
    return (_jsxs(_Fragment, { children: [_jsx("div", { class: card ? 'ncc-table-scroll ncc-carded' : 'ncc-table-scroll', children: _jsxs("table", { class: "ncc-table", children: [props.caption ? _jsx("caption", { class: "ncc-hint", children: props.caption }) : null, _jsx("thead", { children: _jsx("tr", { children: props.columns.map((col) => (_jsx("th", { scope: "col", class: col.numeric ? 'ncc-num' : undefined, children: col.header }))) }) }), _jsx("tbody", { children: props.rows.map((row) => (_jsx("tr", { children: props.columns.map((col) => (_jsx("td", { class: col.numeric ? 'ncc-num' : undefined, "data-label": col.header, children: col.cell(row) }))) }))) })] }) }), card ? (_jsx("ul", { class: "ncc-listcards", children: props.rows.map((row) => (_jsx("li", { children: _jsxs("a", { class: "ncc-listcard", href: card.href(row), children: [_jsx("span", { class: "ncc-listcard__primary", children: card.primary(row) }), card.secondary ? _jsx("span", { class: "ncc-listcard__secondary", children: card.secondary(row) }) : null, card.status ? _jsx("span", { class: "ncc-listcard__status", children: card.status(row) }) : null] }) }))) })) : null] }));
}
/* Widgets ---------------------------------------------------------------- */
export function KpiCard(props) {
    const body = (_jsxs("div", { class: "ncc-card", children: [_jsx("p", { class: "ncc-kpi__label", children: props.label }), _jsx("div", { class: "ncc-kpi__value", children: props.value }), props.hint ? _jsx("div", { class: "ncc-kpi__hint", children: props.hint }) : null] }));
    return props.href ? _jsx("a", { href: props.href, style: "text-decoration:none;color:inherit", children: body }) : body;
}
export function Panel(props) {
    return (_jsxs("section", { class: "ncc-card", children: [_jsxs("div", { class: "ncc-page-head", style: "margin-bottom:.75rem", children: [_jsx("h2", { style: "margin:0", children: props.title }), props.actions ? _jsx("div", { class: "ncc-row", children: props.actions }) : null] }), props.children] }));
}
export function Progress(props) {
    const pct = Math.max(0, Math.min(100, Number(props.pct ?? 0)));
    return (_jsxs("span", { class: "ncc-row", style: "gap:.5rem", children: [_jsx("span", { class: "ncc-progress", role: "img", "aria-label": `${pct.toFixed(1)} percent complete`, children: _jsx("span", { style: `width:${pct}%` }) }), _jsxs("span", { class: "ncc-num", style: "min-width:3.5rem", children: [pct.toFixed(1), "%"] })] }));
}
export function Alert(props) {
    const tone = props.tone ? ` ncc-alert--${props.tone}` : '';
    return (_jsx("div", { class: `ncc-alert${tone}`, role: props.tone === 'error' ? 'alert' : undefined, children: props.children }));
}
export function DefinitionList(props) {
    return (_jsx("dl", { class: "ncc-dl", children: props.rows.map(([k, v]) => (_jsxs(_Fragment, { children: [_jsx("dt", { children: k }), _jsx("dd", { children: v })] }))) }));
}
export function Tabs(props) {
    return (_jsx("nav", { class: "ncc-tabs", "aria-label": "Sections", children: props.tabs.map((t) => (_jsx("a", { href: t.href, "aria-current": t.href === props.active ? 'page' : undefined, children: t.label }))) }));
}
/**
 * Approve / reject with a reason (spec 3).
 *
 * The reject reason is required, not optional. A rejection with no reason
 * sends the raiser back to guess what was wrong, and the audit row then says
 * nothing useful a year later.
 */
export function ApprovalBar(props) {
    if (!props.canApprove) {
        return _jsx(Alert, { tone: "warn", children: props.blockedReason ?? 'You cannot approve this document.' });
    }
    return (_jsxs("form", { class: "ncc-card ncc-stack", method: "post", action: props.action, children: [_jsx(CsrfInput, { token: props.csrfToken }), _jsx(FormField, { label: "Note or reason", name: "note", rows: 2, hint: "Required when rejecting. Recorded in the audit log either way." }), _jsxs("div", { class: "ncc-row", children: [_jsx("button", { class: "ncc-btn ncc-btn-primary", type: "submit", name: "decision", value: "approve", children: "Approve" }), _jsx("button", { class: "ncc-btn ncc-btn-danger", type: "submit", name: "decision", value: "reject", children: "Reject" })] })] }));
}
export function Timeline(props) {
    if (props.entries.length === 0)
        return _jsx("div", { class: "ncc-empty", children: "No history yet." });
    return (_jsx("ol", { class: "ncc-stack", style: "list-style:none;padding:0;margin:0", children: props.entries.map((e) => (_jsxs("li", { style: "border-left:2px solid var(--ncc-border);padding-left:.85rem", children: [_jsxs("div", { class: "ncc-hint", children: [formatDateTime(e.when), e.who ? ` by ${e.who}` : ''] }), _jsx("div", { children: e.what })] }))) }));
}
export function Pager(props) {
    const pages = Math.max(1, Math.ceil(props.total / props.pageSize));
    if (pages <= 1)
        return null;
    const sep = props.baseHref.includes('?') ? '&' : '?';
    return (_jsxs("nav", { class: "ncc-row", "aria-label": "Pagination", style: "margin-top:.9rem", children: [props.page > 1 ? (_jsx("a", { class: "ncc-btn", href: `${props.baseHref}${sep}page=${props.page - 1}`, children: "Previous" })) : null, _jsxs("span", { class: "ncc-hint", children: ["Page ", props.page, " of ", pages, ", ", props.total, " record", props.total === 1 ? '' : 's'] }), props.page < pages ? (_jsx("a", { class: "ncc-btn", href: `${props.baseHref}${sep}page=${props.page + 1}`, children: "Next" })) : null] }));
}
