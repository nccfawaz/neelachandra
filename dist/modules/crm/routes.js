import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "hono/jsx/jsx-runtime";
import { Hono } from 'hono';
import { html } from 'hono/html';
import { currentUser, currentSession } from '../../types.js';
import { page, banner, okRedirect, errRedirect, pageParam, queryParam } from '../../dashboard/render.js';
import { Alert, ApprovalBar, CsrfInput, DataTable, DateText, DefinitionList, FormField, KpiCard, Money, Pager, Panel, Progress, Qty, StatusBadge, Timeline, } from '../../dashboard/components/index.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { PERMISSIONS } from '../../lib/permissions.js';
import { readBody } from '../../middleware/csrf.js';
import { NotFoundError, isAppError } from '../../lib/errors.js';
import { parseJsonColumnArray } from '../../lib/json.js';
import { formatPaiseAsRupeesWithRs, paiseToRupees } from '../../lib/money.js';
import { addDays, financialYear, financialYearBounds, formatDate, nowSqlDateTime, today } from '../../lib/dates.js';
import { getSetting } from '../../lib/settings.js';
import * as q from './queries.js';
import * as svc from './service.js';
import { ACTIVITY_OUTCOMES, ACTIVITY_TYPES, ENQUIRY_TYPES, EXPECTED_STARTS, FEASIBILITIES, FUNDING_MODES, JURISDICTIONS, LOST_REASONS, PLOT_OWNERSHIPS, POSTABLE_STAGES, PRICING_BASES, QUOTE_LINE_TYPES, QUOTE_STATUSES, ROAD_ACCESS, VISIT_STATUSES, WATER_AVAILABILITY, activitySchema, assignSchema, convertOverridesSchema, firstError, leadFromEnquirySchema, leadSchema, loseSchema, noteSchema, probabilitySchema, quoteSchema, reasonSchema, stageSchema, visitCompleteSchema, visitScheduleSchema, visitStatusSchema, } from './schemas.js';
/**
 * CRM routes (spec 6.7).
 *
 * Same shape as src/modules/inventory/routes.tsx, which replicates the projects
 * module: queries.ts reads, service.ts writes, schemas.ts validates at the
 * boundary, and this file only wires them to URLs and renders. Pipeline value is
 * passed into the queries as canViewValue so the forecast columns are absent
 * from the SELECT for a caller without crm.view_pipeline_value, rather than
 * blanked in the template (spec 4.2).
 *
 * Row-level scoping is the LeadScope predicate documented at the top of
 * queries.ts: a caller holding crm.lead_assign sees every lead, everyone else
 * sees their own plus the unassigned pool. It is built here once, in scopeOf,
 * and passed down. Nothing in this file recomputes a permission.
 *
 * Eight places where this file departs from the letter of spec 6.7, recorded
 * here rather than resolved silently:
 *
 * 1. Spec 6.7 guards nothing for GET /app/crm/quotes and GET /app/crm/visits —
 *    its route table has POST /app/crm/quotes and no list route for either.
 *    nav.ts links to both, so they exist. Quotes reads take crm.quote_create
 *    *or* crm.quote_approve, matching what nav.ts already shows the link to; an
 *    approver who could not open the list would be looking at a link that 403s,
 *    which breaks the navigation invariant. Every write keeps its own narrow
 *    permission. Same reasoning as inventory's departure 1.
 *
 * 2. The spec's PATCH verbs cannot come from an HTML form, which submits GET or
 *    POST only. Both stage and assign are registered on POST and PATCH, so the
 *    documented verb works for an API client and the form works for a browser.
 *    requiresCsrf() in src/middleware/csrf.ts covers every method that is not
 *    GET, HEAD or OPTIONS, so the PATCH registration is still token-checked.
 *
 * 3. errorHandler answers any /api/ path with JSON (wantsJson, in
 *    src/middleware/errorHandler.ts), and spec 6.7 puts every write under /api/
 *    while the only client posting to them is a form in this file. Left alone,
 *    rule 3's site-visit refusal would reach a sales executive as a JSON body in
 *    a blank tab. The writes below run through `guard`, which turns a refusal
 *    into a flash on the page the form came from and rethrows anything that is
 *    not an AppError so a genuine 500 still reaches the log. The same latent
 *    problem exists in inventory's /api/po/... handlers; it is reported, not
 *    changed here.
 *
 * 4. Routes the spec's table does not list, added because the module does not
 *    work without them: GET /app/crm/leads/new (admin/routes.tsx already links
 *    to it with ?enquiry=), GET and POST for lead edit, GET /app/crm/quotes/new
 *    and /app/crm/quotes/:id/revise to render the builder, POST
 *    /api/crm/site-visits/:id/status (reschedule, cancel, no-show — the enum has
 *    the members and nothing could set them), POST /api/crm/quotes/:id/accept
 *    and /reject (rule 6 refuses to convert without an accepted quote, so with
 *    no accept route conversion is unreachable), POST
 *    /api/crm/leads/:id/probability (rule 2's audited override), and GET
 *    /app/crm/reports/losses (rule 8's report, which the table omits though the
 *    rule requires it).
 *
 *    Declining a discount is not a new route: /api/crm/quotes/:id/approve takes
 *    the shared ApprovalBar's `decision` field, so approve and decline are one
 *    endpoint and one permission, which is what the spec's single row says.
 *
 * 5. convertSchema is wider than convertLeadToProject accepts. The service takes
 *    only { plannedStart, contractSignedOn } and derives the name, type, address,
 *    contract value, rate, area and delivery model from the lead and the accepted
 *    quote, which is rule 6's "nothing is retyped". The conversion form therefore
 *    posts the two dates and reads the rest back, and convertSchema stays unused
 *    by this file. Flagged rather than either widening the service or deleting a
 *    schema another caller may be intended to use.
 *
 * 6. The spec's PipelineBoard drops cards with htmx and QuoteBuilder recalculates
 *    totals over htmx. htmx and Alpine are loaded by the shell
 *    (src/dashboard/layouts/AppShell.tsx), so both are available; no module in
 *    the tree uses them yet and inventory built its line grids as plain forms.
 *    Following that: the board gives each card one "advance" button that moves it
 *    to the next open stage, the accessible equivalent of dragging it one column
 *    right, and the quote builder posts once. A live total would be a second
 *    implementation of computeQuoteTotals in the browser, and two copies of a
 *    price calculation is how a client is shown a figure the database will not
 *    agree with. The server owns the arithmetic; the form shows it after the post.
 *
 * 7. NextActionBar "will not let the page be left without a next action set".
 *    That is a client-side guard and there is no client-side code here. The lead
 *    detail shows a warning instead when the stage is past contacted and no next
 *    action is set, and the activity form is the thing that sets one.
 *
 * 8. Spec 6.7 names src/modules/crm/pages/*.tsx. Projects, the module this
 *    replicates, keeps its JSX in routes.tsx and has no pages/ directory
 *    (DECISIONS.md 4.9). Following the pattern wins here.
 */
const crm = new Hono();
function actorOf(c) {
    return { userId: currentUser(c).id, ip: c.get('clientIp') };
}
function can(c, key) {
    return c.get('perms').has(key);
}
/**
 * Who this caller may see.
 *
 * Derived from crm.lead_assign, for the reason set out at the top of
 * queries.ts: that is the grant the seeded roles actually differ on, so a new
 * role gets the visibility its permissions imply with no list to maintain here.
 */
function scopeOf(c) {
    return { all: can(c, PERMISSIONS.CRM_LEAD_ASSIGN), userId: currentUser(c).id };
}
/** Forecast visibility (spec 6.7: pipeline value behind crm.view_pipeline_value). */
function canValue(c) {
    return can(c, PERMISSIONS.CRM_VIEW_PIPELINE_VALUE);
}
function idParam(c, name) {
    const n = Number(c.req.param(name));
    if (!Number.isInteger(n) || n < 1)
        throw new NotFoundError('Not found');
    return n;
}
const PAGE_SIZE = 25;
const QUOTE_READ = [PERMISSIONS.CRM_QUOTE_CREATE, PERMISSIONS.CRM_QUOTE_APPROVE];
const QUOTE_APPROVE = [PERMISSIONS.CRM_QUOTE_APPROVE, PERMISSIONS.CRM_QUOTE_DISCOUNT_OVERRIDE];
/**
 * Runs a write and reports the outcome as a flash on the page the form came
 * from. Departure 3 above is the whole reason it exists.
 *
 * Anything that is not an AppError is rethrown untouched, so a programming
 * mistake still becomes a logged 500 rather than a friendly banner over a
 * broken transaction.
 */
async function guard(c, back, run) {
    try {
        const out = await run();
        if (typeof out === 'string')
            return okRedirect(c, back, out);
        return okRedirect(c, out.to, out.message);
    }
    catch (err) {
        if (!isAppError(err))
            throw err;
        return errRedirect(c, back, err.message);
    }
}
/** Every lead route answers 404, not 403, for a lead outside the caller's scope. */
async function requireVisibleLead(c, leadId) {
    const visible = await q.leadVisible(c.get('db'), scopeOf(c), leadId);
    if (!visible)
        throw new NotFoundError('That lead does not exist.');
}
function selectOptions(rows, selected, blank = 'Choose one') {
    return [
        { value: '', label: blank },
        ...rows.map((r) => ({
            value: String(r.id),
            label: r.code ? `${r.code} - ${r.name}` : r.name,
            selected: selected === r.id,
        })),
    ];
}
function userOptions(rows, selected, blank = 'Unassigned') {
    return [
        { value: '', label: blank },
        ...rows.map((r) => ({ value: String(r.id), label: r.full_name, selected: selected === r.id })),
    ];
}
function enumOptions(values, selected, blank) {
    const opts = values.map((v) => ({ value: v, label: v.replace(/_/g, ' '), selected: selected === v }));
    return blank ? [{ value: '', label: blank }, ...opts] : opts;
}
/**
 * The three-valued qualifier select.
 *
 * "Nobody has asked yet" is a different sales position from "no", which is why
 * the columns are TINYINT(1) NULL and why yesNoNull exists in schemas.ts. A
 * two-option select here would quietly answer the question on the lead's behalf.
 */
const YES_NO_NULL = (selected) => [
    { value: '', label: 'Not asked', selected: selected === null },
    { value: '1', label: 'Yes', selected: selected === 1 },
    { value: '0', label: 'No', selected: selected === 0 },
];
/** Paise columns the queries only select when the caller holds view_pipeline_value. */
function paiseOf(row, key) {
    const v = row[key];
    return v === null || v === undefined ? null : Number(v);
}
function pctOf(row, key) {
    const v = row[key];
    return v === null || v === undefined ? null : Number(v);
}
const TEMPERATURE_TONE = { hot: 'danger', warm: 'warn', cold: 'muted' };
/**
 * Stage colour. Not in components/index.tsx's TONES, and deliberately not added
 * to it: thirteen lead stages are a CRM vocabulary, not an app-wide one, and
 * "new" or "qualified" would collide with other modules' meanings.
 */
const STAGE_TONE = {
    new: 'muted',
    contacted: 'muted',
    qualified: 'warn',
    site_visit_scheduled: 'warn',
    site_visit_done: 'warn',
    estimate_shared: 'warn',
    quote_sent: 'warn',
    negotiation: 'ok',
    verbal_agreement: 'ok',
    won: 'ok',
    lost: 'danger',
    dormant: 'muted',
    disqualified: 'danger',
};
const QUOTE_TONE = {
    draft: 'muted',
    pending_approval: 'warn',
    approved: 'ok',
    sent: 'warn',
    viewed: 'warn',
    accepted: 'ok',
    rejected: 'danger',
    expired: 'danger',
    superseded: 'muted',
};
const VISIT_TONE = {
    scheduled: 'warn',
    completed: 'ok',
    client_no_show: 'danger',
    rescheduled: 'warn',
    cancelled: 'danger',
};
const FEASIBILITY_TONE = {
    feasible: 'ok',
    feasible_with_conditions: 'warn',
    not_feasible: 'danger',
};
/** datetime-local wants YYYY-MM-DDTHH:MM; MariaDB hands back a space. */
function dtLocal(value) {
    if (!value)
        return '';
    return String(value).replace(' ', 'T').slice(0, 16);
}
/* Pipeline board ---------------------------------------------------------- */
/**
 * The board (spec 6.7: "Pipeline board by stage, value per column").
 *
 * Two value figures per column, because they answer different questions:
 * value_paise is the column if everything in it closes, weighted_paise applies
 * each lead's probability and is the only one of the two that is a forecast.
 * Both come from pipelineTotals, which excludes dormant leads inside the
 * aggregate (rule 9), so the board and the report cannot disagree.
 */
crm.get('/app/crm', requirePermission(PERMISSIONS.CRM_LEAD_VIEW), async (c) => {
    const db = c.get('db');
    const scope = scopeOf(c);
    const value = canValue(c);
    const csrf = currentSession(c).csrfToken;
    const manage = can(c, PERMISSIONS.CRM_LEAD_MANAGE);
    const [cards, totals, kpis] = await Promise.all([
        q.boardCards(db, scope, { canViewValue: value }),
        q.pipelineTotals(db, scope),
        q.crmKpis(db, scope, { canViewValue: value }),
    ]);
    const byStage = new Map();
    for (const stage of q.OPEN_STAGES)
        byStage.set(stage, []);
    for (const card of cards)
        byStage.get(card.stage)?.push(card);
    const totalByStage = new Map(totals.map((t) => [t.stage, t]));
    return page(c, {
        title: 'Pipeline',
        path: '/app/crm',
        subtitle: scope.all ? 'Every open lead' : 'Your leads and the unassigned pool',
        actions: (_jsxs(_Fragment, { children: [_jsx("a", { class: "ncc-btn", href: "/app/crm/leads", children: "Table view" }), manage ? (_jsx("a", { class: "ncc-btn ncc-btn-primary", href: "/app/crm/leads/new", children: "New lead" })) : null] })),
    }, _jsxs(_Fragment, { children: [banner(c), _jsxs("div", { class: "ncc-grid ncc-grid--kpi", children: [_jsx(KpiCard, { label: "Open leads", value: String(kpis.openLeads), hint: `${q.DORMANT_DAYS}-day dormancy applied` }), _jsx(KpiCard, { label: "Weighted pipeline", value: _jsx(Money, { paise: kpis.weightedPaise, compact: true, hidden: !value }), hint: "Expected value times probability" }), _jsx(KpiCard, { label: "Follow-ups due", value: String(kpis.followupsDue), hint: "Next action today or overdue", href: "/app/crm/leads?due=1" }), _jsx(KpiCard, { label: "Unassigned", value: String(kpis.unassigned), hint: "The pool everyone can see", href: "/app/crm/leads?unassigned=1" }), _jsx(KpiCard, { label: "Visits upcoming", value: String(kpis.visitsUpcoming), hint: "Scheduled from today", href: "/app/crm/visits?status=scheduled" }), _jsx(KpiCard, { label: "Quotes to approve", value: String(kpis.quotesPending), hint: "Discount above the limit", href: "/app/crm/quotes?status=pending_approval" })] }), _jsx("div", { style: "overflow-x:auto", children: _jsx("div", { class: "ncc-row", style: "align-items:flex-start;gap:.75rem;padding-bottom:.5rem", children: q.OPEN_STAGES.map((stage, i) => {
                        const column = byStage.get(stage) ?? [];
                        const totalsRow = totalByStage.get(stage);
                        const nextStage = q.OPEN_STAGES[i + 1] ?? null;
                        return (_jsxs("section", { class: "ncc-card", style: "min-width:15rem;flex:1 0 15rem", children: [_jsx("h3", { style: "margin:0 0 .2rem;font-size:.95rem", children: stage.replace(/_/g, ' ') }), _jsxs("p", { class: "ncc-hint", style: "margin:0 0 .6rem", children: [Number(totalsRow?.n ?? 0), " lead", Number(totalsRow?.n ?? 0) === 1 ? '' : 's', value ? ' - ' : '', value ? _jsx(Money, { paise: Number(totalsRow?.weighted_paise ?? 0), compact: true }) : null, value ? ' weighted' : ''] }), column.length === 0 ? _jsx("p", { class: "ncc-muted", children: "Empty." }) : null, column.map((card) => (_jsxs("article", { class: "ncc-stack", style: "border-top:1px solid var(--ncc-border);padding:.5rem 0;gap:.25rem", children: [_jsx("a", { href: `/app/crm/leads/${card.id}`, children: _jsx("strong", { children: card.contact_name }) }), _jsxs("div", { class: "ncc-hint", children: [card.lead_no, card.site_locality ? ` - ${card.site_locality}` : ''] }), _jsxs("div", { class: "ncc-row", style: "gap:.35rem;flex-wrap:wrap", children: [_jsx(StatusBadge, { status: card.temperature, tone: TEMPERATURE_TONE[card.temperature] ?? 'muted' }), _jsxs("span", { class: "ncc-hint", children: ["score ", Number(card.score)] }), value ? _jsx(Money, { paise: paiseOf(card, 'expected_value_paise'), compact: true }) : null] }), _jsxs("div", { class: "ncc-hint", children: [card.assignee_name ?? 'Unassigned', card.next_action_date ? ` - due ${formatDate(card.next_action_date)}` : ''] }), manage && nextStage ? (_jsxs("form", { method: "post", action: `/api/crm/leads/${card.id}/stage`, children: [_jsx(CsrfInput, { token: csrf }), _jsx("input", { type: "hidden", name: "stage", value: nextStage }), _jsx("input", { type: "hidden", name: "note", value: "Advanced from the pipeline board." }), _jsxs("button", { class: "ncc-btn", type: "submit", children: ["To ", nextStage.replace(/_/g, ' ')] })] })) : null] })))] }));
                    }) }) }), _jsx(Panel, { title: "Reading this board", children: _jsxs("p", { class: "ncc-muted", children: ["A lead with no activity for ", q.DORMANT_DAYS, " days drops out of these columns and out of the weighted total, because a forecast that counts leads nobody has called since March is the spreadsheet problem with extra steps. The cron moves it to dormant; it is still on the table view."] }) })] }));
});
/* Leads ------------------------------------------------------------------- */
crm.get('/app/crm/leads', requirePermission(PERMISSIONS.CRM_LEAD_VIEW), async (c) => {
    const db = c.get('db');
    const scope = scopeOf(c);
    const value = canValue(c);
    const { page: pageNo, offset, pageSize } = pageParam(c, PAGE_SIZE);
    const search = queryParam(c, 'q') ?? null;
    const stage = queryParam(c, 'stage') ?? null;
    const temperature = queryParam(c, 'temperature') ?? null;
    const source = Number(queryParam(c, 'source') ?? '') || null;
    const assignedTo = Number(queryParam(c, 'assignedTo') ?? '') || null;
    const unassigned = queryParam(c, 'unassigned') === '1';
    const due = queryParam(c, 'due') === '1';
    const filters = { q: search, stage, temperature, source, assignedTo, unassigned };
    const [rows, total, sources, users, followups] = await Promise.all([
        q.listLeads(db, scope, { ...filters, canViewValue: value, limit: pageSize, offset }),
        q.countLeads(db, scope, filters),
        q.leadSourceOptions(db),
        q.assignableUsers(db),
        due ? q.dueFollowups(db, scope) : Promise.resolve([]),
    ]);
    const columns = [
        {
            header: 'Lead',
            cell: (r) => (_jsxs(_Fragment, { children: [_jsx("a", { href: `/app/crm/leads/${r.id}`, children: _jsx("strong", { children: r.contact_name }) }), _jsxs("div", { class: "ncc-muted", children: [r.lead_no, " - ", r.phone] })] })),
        },
        { header: 'Stage', cell: (r) => _jsx(StatusBadge, { status: r.stage, tone: STAGE_TONE[r.stage] ?? 'muted' }) },
        {
            header: 'Temp',
            cell: (r) => _jsx(StatusBadge, { status: r.temperature, tone: TEMPERATURE_TONE[r.temperature] ?? 'muted' }),
        },
        { header: 'Score', numeric: true, cell: (r) => _jsx(Progress, { pct: Number(r.score) }) },
        {
            header: 'Site',
            cell: (r) => [r.site_locality, r.site_city].filter((p) => p !== null && p !== '').join(', ') || _jsx("span", { class: "ncc-muted", children: "-" }),
        },
        { header: 'Source', cell: (r) => r.source_name ?? _jsx("span", { class: "ncc-muted", children: "untagged" }) },
        { header: 'Owner', cell: (r) => r.assignee_name ?? _jsx("span", { class: "ncc-muted", children: "pool" }) },
        {
            header: 'Next action',
            cell: (r) => r.next_action_date === null ? (_jsx("span", { class: "ncc-muted", children: "none set" })) : (_jsxs(_Fragment, { children: [_jsx(DateText, { value: r.next_action_date }), _jsx("div", { class: "ncc-muted", children: r.next_action ?? '' })] })),
        },
        {
            header: 'Value',
            numeric: true,
            cell: (r) => _jsx(Money, { paise: paiseOf(r, 'expected_value_paise'), compact: true, hidden: !value }),
        },
        {
            header: 'Odds',
            numeric: true,
            cell: (r) => {
                if (!value)
                    return _jsx("span", { class: "ncc-muted", children: "restricted" });
                const pct = pctOf(r, 'probability_pct');
                return pct === null ? _jsx("span", { class: "ncc-muted", children: "-" }) : `${pct}%`;
            },
        },
    ];
    const qs = new URLSearchParams();
    if (search)
        qs.set('q', search);
    if (stage)
        qs.set('stage', stage);
    if (temperature)
        qs.set('temperature', temperature);
    if (source)
        qs.set('source', String(source));
    if (assignedTo)
        qs.set('assignedTo', String(assignedTo));
    if (unassigned)
        qs.set('unassigned', '1');
    if (due)
        qs.set('due', '1');
    return page(c, {
        title: 'Leads',
        path: '/app/crm/leads',
        subtitle: scope.all ? undefined : 'Your leads and the unassigned pool',
        actions: (_jsxs(_Fragment, { children: [_jsx("a", { class: "ncc-btn", href: "/app/crm", children: "Pipeline" }), can(c, PERMISSIONS.CRM_LEAD_MANAGE) ? (_jsx("a", { class: "ncc-btn ncc-btn-primary", href: "/app/crm/leads/new", children: "New lead" })) : null] })),
    }, _jsxs(_Fragment, { children: [banner(c), due ? (_jsx(Panel, { title: "Due and overdue", children: _jsx(DataTable, { columns: [
                        {
                            header: 'Lead',
                            cell: (r) => _jsx("a", { href: `/app/crm/leads/${r.id}`, children: r.contact_name }),
                        },
                        { header: 'Phone', cell: (r) => r.phone },
                        { header: 'Stage', cell: (r) => _jsx(StatusBadge, { status: r.stage, tone: STAGE_TONE[r.stage] ?? 'muted' }) },
                        { header: 'Due', cell: (r) => _jsx(DateText, { value: r.next_action_date }) },
                        { header: 'Action', cell: (r) => r.next_action ?? '-' },
                        { header: 'Owner', cell: (r) => r.assignee_name ?? 'pool' },
                    ], rows: followups, empty: "Nothing is due.", caption: "Oldest first. Answer the oldest lead first: the first response is the one thing on this list you still control, and the strongest lever on whether a lead converts." }) })) : null, _jsxs(Panel, { title: "Leads", children: [_jsxs("form", { method: "get", action: "/app/crm/leads", class: "ncc-row", style: "flex-wrap:wrap;gap:.75rem", children: [_jsx(FormField, { label: "Search", name: "q", value: search, placeholder: "Name, phone, lead no, locality" }), _jsx(FormField, { label: "Stage", name: "stage", options: enumOptions(POSTABLE_STAGES, stage, 'All') }), _jsx(FormField, { label: "Temperature", name: "temperature", options: enumOptions(['hot', 'warm', 'cold'], temperature, 'All') }), _jsx(FormField, { label: "Source", name: "source", options: selectOptions(sources, source, 'All') }), _jsx(FormField, { label: "Owner", name: "assignedTo", options: userOptions(users, assignedTo, 'Anyone') }), _jsx(FormField, { label: "Pool only", name: "unassigned", options: [
                                    { value: '', label: 'No', selected: !unassigned },
                                    { value: '1', label: 'Yes', selected: unassigned },
                                ] }), _jsx("button", { class: "ncc-btn", type: "submit", children: "Filter" })] }), _jsx(DataTable, { columns: columns, rows: rows, empty: "No lead matches that filter.", caption: "Highest score first, then the longest untouched: the order a sales executive works in." }), _jsx(Pager, { page: pageNo, pageSize: pageSize, total: total, baseHref: qs.toString() === '' ? '/app/crm/leads' : `/app/crm/leads?${qs.toString()}` })] })] }));
});
function val(row, key) {
    const v = row?.[key];
    if (v === null || v === undefined)
        return null;
    return typeof v === 'number' ? v : String(v);
}
/** Paise column, rupee input. The inverse of rupeesToPaiseField in schemas.ts. */
function rupeeVal(row, key) {
    const v = row?.[key];
    if (v === null || v === undefined)
        return null;
    return String(paiseToRupees(Number(v)));
}
/** A TINYINT(1) NULL qualifier, for the three-valued select. */
function flag(row, key) {
    const v = row?.[key];
    if (v === null || v === undefined)
        return null;
    return Number(v) === 1 ? 1 : 0;
}
function LeadFormFields(props) {
    const { row, lookups } = props;
    return (_jsxs(_Fragment, { children: [_jsxs("fieldset", { class: "ncc-fieldset", children: [_jsx("legend", { children: "Contact" }), _jsxs("div", { class: "ncc-grid ncc-grid--form", children: [_jsx(FormField, { label: "Contact name", name: "contactName", value: val(row, 'contact_name'), required: true }), _jsx(FormField, { label: "Phone", name: "phone", value: val(row, 'phone'), required: true, autocomplete: "tel" }), _jsx(FormField, { label: "Alternate phone", name: "altPhone", value: val(row, 'alt_phone') }), _jsx(FormField, { label: "Email", name: "email", type: "email", value: val(row, 'email') }), _jsx(FormField, { label: "Existing client", name: "clientId", options: selectOptions(lookups.clients, Number(val(row, 'client_id')) || null, 'Not an existing client'), hint: "Set only for repeat business. Conversion creates the client otherwise." })] })] }), _jsxs("fieldset", { class: "ncc-fieldset", children: [_jsx("legend", { children: "Where it came from" }), _jsxs("div", { class: "ncc-grid ncc-grid--form", children: [_jsx(FormField, { label: "Source", name: "leadSourceId", options: selectOptions(lookups.sources, Number(val(row, 'lead_source_id')) || null, 'Untagged'), hint: "Untagged leads show as their own row on the source report." }), _jsx(FormField, { label: "Campaign", name: "campaignId", options: selectOptions(lookups.campaigns, Number(val(row, 'campaign_id')) || null, 'None') }), _jsx(FormField, { label: "Referred by", name: "referredByClientId", options: selectOptions(lookups.clients, Number(val(row, 'referred_by_client_id')) || null, 'Nobody') }), _jsx(FormField, { label: "Enquiry type", name: "enquiryType", options: enumOptions(ENQUIRY_TYPES, val(row, 'enquiry_type') ?? 'residential_construction'), required: true })] })] }), _jsxs("fieldset", { class: "ncc-fieldset", children: [_jsx("legend", { children: "Plot" }), _jsxs("div", { class: "ncc-grid ncc-grid--form", children: [_jsx(FormField, { label: "City", name: "siteCity", value: val(row, 'site_city'), hint: "Bengaluru, Nelamangala, Tumakuru and Doddaballapura score as served." }), _jsx(FormField, { label: "Locality", name: "siteLocality", value: val(row, 'site_locality') }), _jsx(FormField, { label: "Survey number", name: "surveyNumber", value: val(row, 'survey_number') }), _jsx(FormField, { label: "Plot area (sqft)", name: "plotAreaSqft", type: "number", step: "0.01", min: "0", value: val(row, 'plot_area_sqft') }), _jsx(FormField, { label: "Dimensions", name: "plotDimensions", value: val(row, 'plot_dimensions'), placeholder: "30x40" }), _jsx(FormField, { label: "Target built-up (sqft)", name: "targetBuiltUpSqft", type: "number", step: "0.01", min: "0", value: val(row, 'target_built_up_sqft') }), _jsx(FormField, { label: "Floors wanted", name: "floorsWanted", type: "number", step: "1", min: "0", value: val(row, 'floors_wanted') }), _jsx(FormField, { label: "Jurisdiction", name: "jurisdiction", options: enumOptions(JURISDICTIONS, val(row, 'jurisdiction'), 'Not known') })] })] }), _jsxs("fieldset", { class: "ncc-fieldset", children: [_jsx("legend", { children: "Qualifiers" }), _jsxs("div", { class: "ncc-grid ncc-grid--form", children: [_jsx(FormField, { label: "Plot ownership", name: "plotOwnership", options: enumOptions(PLOT_OWNERSHIPS, val(row, 'plot_ownership'), 'Not asked') }), _jsx(FormField, { label: "Sanctioned plan", name: "hasSanctionedPlan", options: YES_NO_NULL(flag(row, 'has_sanctioned_plan')), hint: "Not asked is a different answer from no, and scores differently." }), _jsx(FormField, { label: "Has an architect", name: "hasArchitect", options: YES_NO_NULL(flag(row, 'has_architect')) }), _jsx(FormField, { label: "Architect name", name: "architectName", value: val(row, 'architect_name') }), _jsx(FormField, { label: "Funding", name: "fundingMode", options: enumOptions(FUNDING_MODES, val(row, 'funding_mode'), 'Not asked') }), _jsx(FormField, { label: "Expected start", name: "expectedStart", options: enumOptions(EXPECTED_STARTS, val(row, 'expected_start'), 'Not asked') })] })] }), _jsxs("fieldset", { class: "ncc-fieldset", children: [_jsx("legend", { children: "Budget and package" }), _jsxs("div", { class: "ncc-grid ncc-grid--form", children: [_jsx(FormField, { label: "Budget floor (Rs)", name: "budgetMinPaise", type: "number", step: "0.01", min: "0", value: rupeeVal(row, 'budget_min_paise') }), _jsx(FormField, { label: "Budget ceiling (Rs)", name: "budgetMaxPaise", type: "number", step: "0.01", min: "0", value: rupeeVal(row, 'budget_max_paise') }), _jsx(FormField, { label: "Preferred package", name: "preferredPackageId", options: selectOptions(lookups.packages, Number(val(row, 'preferred_package_id')) || null, 'None chosen'), hint: "Feeds the score and the first estimate. The quote prices off the live rate, not this." })] })] }), _jsxs("fieldset", { class: "ncc-fieldset", children: [_jsx("legend", { children: "Next action" }), _jsxs("div", { class: "ncc-grid ncc-grid--form", children: [_jsx(FormField, { label: "Next action", name: "nextAction", value: val(row, 'next_action'), placeholder: "Call back after the plan is approved" }), _jsx(FormField, { label: "Due", name: "nextActionDate", type: "date", value: val(row, 'next_action_date') })] })] })] }));
}
async function leadFormLookups(db) {
    const [sources, campaigns, clients, packages] = await Promise.all([
        q.leadSourceOptions(db),
        q.campaignOptions(db),
        q.clientOptions(db),
        q.packageOptions(db),
    ]);
    return { sources, campaigns, clients, packages };
}
/**
 * New lead.
 *
 * ?enquiry= is honoured because src/modules/admin/routes.tsx already links here
 * with it from the enquiry list. With an enquiry named this renders the promote
 * form instead of the blank one: leadFromEnquiry copies the name, phone, email,
 * city, message and UTM tags from the enquiry row inside the transaction, so
 * retyping them into a blank form would be both slower and a chance to get them
 * wrong.
 */
crm.get('/app/crm/leads/new', requirePermission(PERMISSIONS.CRM_LEAD_MANAGE), async (c) => {
    const db = c.get('db');
    const csrf = currentSession(c).csrfToken;
    const enquiryId = Number(queryParam(c, 'enquiry') ?? '') || null;
    const [lookups, users, enquiry] = await Promise.all([
        leadFormLookups(db),
        q.assignableUsers(db),
        enquiryId ? q.findEnquiry(db, enquiryId) : Promise.resolve(undefined),
    ]);
    if (enquiryId && enquiry) {
        return page(c, { title: 'Promote enquiry', path: '/app/crm/leads', subtitle: `Enquiry ${enquiry.id}` }, _jsxs(_Fragment, { children: [banner(c), _jsx(Panel, { title: enquiry.name, children: _jsx(DefinitionList, { rows: [
                            ['Phone', enquiry.phone],
                            ['Email', enquiry.email ?? '-'],
                            ['City', enquiry.city ?? '-'],
                            ['Interested in', enquiry.service_interest ?? '-'],
                            ['Received', _jsx(DateText, { value: enquiry.created_at, withTime: true })],
                            ['Campaign', enquiry.utm_campaign ?? enquiry.utm_source ?? 'direct'],
                            ['Message', enquiry.message ?? '-'],
                        ] }) }), _jsx(Panel, { title: "Create the lead", children: _jsxs("form", { class: "ncc-stack", method: "post", action: `/api/crm/leads/from-enquiry/${enquiry.id}`, children: [_jsx(CsrfInput, { token: csrf }), _jsx(FormField, { label: "Assign to", name: "assignedTo", options: userOptions(users, currentUser(c).id, 'Leave in the pool'), hint: "An unassigned lead sits in the pool everyone can see, and the cron chases it." }), _jsx("p", { class: "ncc-muted", children: "The contact details, city and campaign tags are copied from the enquiry. Qualifiers are added on the lead once someone has spoken to them." }), _jsxs("div", { class: "ncc-row", children: [_jsx("button", { class: "ncc-btn ncc-btn-primary", type: "submit", children: "Create lead" }), _jsx("a", { class: "ncc-btn", href: "/app/admin/enquiries", children: "Cancel" })] })] }) })] }));
    }
    return page(c, {
        title: 'New lead',
        path: '/app/crm/leads',
        subtitle: enquiryId ? 'That enquiry is already a lead, or does not exist. Entering by hand instead.' : undefined,
    }, _jsxs(_Fragment, { children: [banner(c), _jsx(Panel, { title: "Lead", children: _jsxs("form", { class: "ncc-stack", method: "post", action: "/app/crm/leads", children: [_jsx(CsrfInput, { token: csrf }), _jsx(LeadFormFields, { row: null, lookups: lookups }), _jsxs("fieldset", { class: "ncc-fieldset", children: [_jsx("legend", { children: "Ownership" }), _jsx(FormField, { label: "Assign to", name: "assignedTo", options: userOptions(users, currentUser(c).id, 'Leave in the pool') })] }), _jsxs("div", { class: "ncc-row", children: [_jsx("button", { class: "ncc-btn ncc-btn-primary", type: "submit", children: "Create lead" }), _jsx("a", { class: "ncc-btn", href: "/app/crm/leads", children: "Cancel" })] })] }) }), _jsx(Panel, { title: "What the score reads", children: _jsx("p", { class: "ncc-muted", children: "Only the name, phone and enquiry type are required, because a lead is usually typed while the caller is still on the line. Every qualifier above is a scoring signal and every one left blank scores zero, so the score says how much is known about the lead, not how good it is." }) })] }));
});
crm.post('/app/crm/leads', requirePermission(PERMISSIONS.CRM_LEAD_MANAGE), async (c) => {
    const body = await readBody(c);
    const parsed = leadSchema.safeParse(body);
    if (!parsed.success)
        return errRedirect(c, '/app/crm/leads/new', firstError(parsed.error));
    const assignedTo = Number(body.assignedTo ?? '') || null;
    return guard(c, '/app/crm/leads/new', async () => {
        const created = await svc.createLead(c.get('db'), actorOf(c), parsed.data, assignedTo);
        return {
            to: `/app/crm/leads/${created.leadId}`,
            message: `${created.leadNo} created. Score ${created.score}.`,
        };
    });
});
crm.post('/api/crm/leads/from-enquiry/:enquiryId', requirePermission(PERMISSIONS.CRM_LEAD_MANAGE), async (c) => {
    const enquiryId = idParam(c, 'enquiryId');
    const body = (await readBody(c));
    const parsed = leadFromEnquirySchema.safeParse({ enquiryId, assignedTo: body.assignedTo });
    if (!parsed.success)
        return errRedirect(c, '/app/admin/enquiries', firstError(parsed.error));
    return guard(c, '/app/admin/enquiries', async () => {
        const created = await svc.leadFromEnquiry(c.get('db'), actorOf(c), parsed.data.enquiryId, parsed.data.assignedTo);
        return { to: `/app/crm/leads/${created.leadId}`, message: `${created.leadNo} created from the enquiry.` };
    });
});
crm.get('/app/crm/leads/:id/edit', requirePermission(PERMISSIONS.CRM_LEAD_MANAGE), async (c) => {
    const db = c.get('db');
    const leadId = idParam(c, 'id');
    await requireVisibleLead(c, leadId);
    const [lead, lookups] = await Promise.all([q.findLead(db, leadId, canValue(c)), leadFormLookups(db)]);
    if (!lead)
        throw new NotFoundError('That lead does not exist.');
    return page(c, { title: `Edit ${lead.lead_no}`, path: '/app/crm/leads', subtitle: lead.contact_name }, _jsxs(_Fragment, { children: [banner(c), _jsx(Panel, { title: "Lead", children: _jsxs("form", { class: "ncc-stack", method: "post", action: `/app/crm/leads/${leadId}/edit`, children: [_jsx(CsrfInput, { token: currentSession(c).csrfToken }), _jsx(LeadFormFields, { row: lead, lookups: lookups }), _jsxs("div", { class: "ncc-row", children: [_jsx("button", { class: "ncc-btn ncc-btn-primary", type: "submit", children: "Save" }), _jsx("a", { class: "ncc-btn", href: `/app/crm/leads/${leadId}`, children: "Cancel" })] })] }) })] }));
});
crm.post('/app/crm/leads/:id/edit', requirePermission(PERMISSIONS.CRM_LEAD_MANAGE), async (c) => {
    const leadId = idParam(c, 'id');
    await requireVisibleLead(c, leadId);
    const back = `/app/crm/leads/${leadId}/edit`;
    const parsed = leadSchema.safeParse(await readBody(c));
    if (!parsed.success)
        return errRedirect(c, back, firstError(parsed.error));
    return guard(c, back, async () => {
        const out = await svc.updateLead(c.get('db'), actorOf(c), leadId, parsed.data);
        return { to: `/app/crm/leads/${leadId}`, message: `Saved. Score is now ${out.score}.` };
    });
});
/* Lead detail ------------------------------------------------------------- */
function numOrNull(v) {
    if (v === null || v === undefined)
        return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}
crm.get('/app/crm/leads/:id', requirePermission(PERMISSIONS.CRM_LEAD_VIEW), async (c) => {
    const db = c.get('db');
    const leadId = idParam(c, 'id');
    await requireVisibleLead(c, leadId);
    const value = canValue(c);
    const csrf = currentSession(c).csrfToken;
    const manage = can(c, PERMISSIONS.CRM_LEAD_MANAGE);
    const lead = await q.findLead(db, leadId, value);
    if (!lead)
        throw new NotFoundError('That lead does not exist.');
    const [activities, history, visits, quotes, visited, users, duplicates] = await Promise.all([
        q.leadActivities(db, leadId),
        q.leadStageHistory(db, leadId),
        q.leadVisits(db, leadId),
        q.leadQuotes(db, leadId),
        q.hasCompletedVisit(db, leadId),
        can(c, PERMISSIONS.CRM_LEAD_ASSIGN) ? q.assignableUsers(db) : Promise.resolve([]),
        svc.duplicatesByPhone(db, lead.phone, leadId),
    ]);
    const scored = svc.computeLeadScore({
        plotOwnership: lead.plot_ownership,
        hasSanctionedPlan: numOrNull(lead.has_sanctioned_plan),
        fundingMode: lead.funding_mode,
        expectedStart: lead.expected_start,
        budgetMinPaise: numOrNull(lead.budget_min_paise),
        budgetMaxPaise: numOrNull(lead.budget_max_paise),
        targetBuiltUpSqft: numOrNull(lead.target_built_up_sqft),
        packageRatePaise: numOrNull(lead.package_rate_paise),
        siteCity: lead.site_city,
    });
    const terminal = lead.stage === 'won' || lead.stage === 'lost';
    const accepted = quotes.filter((quote) => quote.status === 'accepted');
    const stageOptions = POSTABLE_STAGES.filter((s) => s !== lead.stage);
    return page(c, {
        title: lead.contact_name,
        path: '/app/crm/leads',
        subtitle: `${lead.lead_no} - ${lead.phone}`,
        actions: (_jsxs(_Fragment, { children: [manage && !terminal ? (_jsx("a", { class: "ncc-btn", href: `/app/crm/leads/${leadId}/edit`, children: "Edit" })) : null, can(c, PERMISSIONS.CRM_QUOTE_CREATE) && !terminal ? (_jsx("a", { class: "ncc-btn ncc-btn-primary", href: `/app/crm/quotes/new?lead=${leadId}`, children: "New quote" })) : null] })),
    }, _jsxs(_Fragment, { children: [banner(c), duplicates.length > 0 ? (_jsxs(Alert, { tone: "warn", children: [duplicates.length, " other lead", duplicates.length === 1 ? '' : 's', " carr", duplicates.length === 1 ? 'ies' : 'y', " this phone number:", ' ', duplicates.map((d, i) => (_jsxs(_Fragment, { children: [i > 0 ? ', ' : '', _jsx("a", { href: `/app/crm/leads/${d.id}`, children: d.lead_no }), " (", d.stage.replace(/_/g, ' '), ")"] }))), ". Two executives chasing one client is how a discount gets quoted twice."] })) : null, lead.converted_project_id ? (_jsxs(Alert, { tone: "ok", children: ["Won and converted to project ", _jsx("a", { href: `/app/projects/${lead.converted_project_id}`, children: lead.project_code }), "."] })) : null, lead.stage === 'lost' ? (_jsxs(Alert, { tone: "error", children: ["Lost: ", (lead.lost_reason ?? 'no reason recorded').replace(/_/g, ' '), lead.lost_to_competitor ? ` to ${lead.lost_to_competitor}` : '', ". ", lead.lost_notes ?? ''] })) : null, !terminal && lead.next_action_date === null && svc.STAGE_RANK[lead.stage] >= 1 ? (_jsxs(Alert, { tone: "warn", children: ["No next action is set. A lead past first contact with nothing scheduled is the one that goes dormant at", ' ', q.DORMANT_DAYS, " days without anybody deciding to drop it. Log an activity below and set the next action."] })) : null, _jsxs("div", { class: "ncc-grid ncc-grid--kpi", children: [_jsx(KpiCard, { label: "Stage", value: _jsx(StatusBadge, { status: lead.stage, tone: STAGE_TONE[lead.stage] ?? 'muted' }), hint: `Since ${formatDate(lead.stage_changed_at.slice(0, 10))}` }), _jsx(KpiCard, { label: "Temperature", value: _jsx(StatusBadge, { status: lead.temperature, tone: TEMPERATURE_TONE[lead.temperature] ?? 'muted' }), hint: "Score and how recently anyone touched it" }), _jsx(KpiCard, { label: "Score", value: _jsx(Progress, { pct: Number(lead.score) }), hint: "How much is known, not how good it is" }), _jsx(KpiCard, { label: "Expected value", value: _jsx(Money, { paise: paiseOf(lead, 'expected_value_paise'), compact: true, hidden: !value }), hint: "Built-up area times package rate, or the budget midpoint" }), _jsx(KpiCard, { label: "Probability", value: value ? `${pctOf(lead, 'probability_pct') ?? '-'}%` : _jsx("span", { class: "ncc-muted", children: "restricted" }), hint: "Stage default unless overridden" }), _jsx(KpiCard, { label: "Site visit", value: visited ? 'On record' : 'None', hint: visited ? 'A quote may go out' : 'A quote cannot be sent without one' })] }), _jsx(Panel, { title: "Lead", children: _jsx(DefinitionList, { rows: [
                        ['Owner', lead.assignee_name ?? 'Unassigned (in the pool)'],
                        ['Source', lead.source_name ?? 'Untagged'],
                        ['Campaign', lead.campaign_name ?? '-'],
                        ['Enquiry type', lead.enquiry_type.replace(/_/g, ' ')],
                        ['Contact', `${lead.phone}${lead.alt_phone ? ` / ${lead.alt_phone}` : ''}${lead.email ? ` - ${lead.email}` : ''}`],
                        ['Client', lead.client_name ? `${lead.client_code ?? ''} ${lead.client_name}`.trim() : 'New client on conversion'],
                        ['Site', [lead.site_locality, lead.site_city].filter((p) => p).join(', ') || '-'],
                        ['Survey number', lead.survey_number ?? '-'],
                        ['Plot', lead.plot_area_sqft ? _jsx(Qty, { value: Number(lead.plot_area_sqft), unit: "sqft" }) : '-'],
                        ['Dimensions', lead.plot_dimensions ?? '-'],
                        ['Target built-up', lead.target_built_up_sqft ? _jsx(Qty, { value: Number(lead.target_built_up_sqft), unit: "sqft" }) : '-'],
                        ['Floors', lead.floors_wanted === null ? '-' : String(lead.floors_wanted)],
                        ['Jurisdiction', lead.jurisdiction ?? '-'],
                        ['Plot ownership', lead.plot_ownership?.replace(/_/g, ' ') ?? 'not asked'],
                        ['Sanctioned plan', lead.has_sanctioned_plan === null ? 'not asked' : Number(lead.has_sanctioned_plan) === 1 ? 'yes' : 'no'],
                        ['Architect', lead.has_architect === null ? 'not asked' : Number(lead.has_architect) === 1 ? lead.architect_name ?? 'yes' : 'no'],
                        ['Funding', lead.funding_mode?.replace(/_/g, ' ') ?? 'not asked'],
                        ['Expected start', lead.expected_start?.replace(/_/g, ' ') ?? 'not asked'],
                        ['Budget', _jsx(Money, { paise: numOrNull(lead.budget_min_paise), hidden: !value })],
                        ['Budget ceiling', _jsx(Money, { paise: numOrNull(lead.budget_max_paise), hidden: !value })],
                        ['Preferred package', lead.package_name ?? '-'],
                        ['First response', lead.first_response_at ? _jsx(DateText, { value: lead.first_response_at, withTime: true }) : 'not yet'],
                        ['Next action', lead.next_action ? `${lead.next_action} (${formatDate(lead.next_action_date)})` : 'none set'],
                    ] }) }), _jsxs(Panel, { title: `Score: ${scored.score}`, children: [_jsx(DataTable, { columns: [
                            { header: 'Signal', cell: (s) => s.label },
                            { header: 'Points', numeric: true, cell: (s) => `${s.points} / ${s.max}` },
                        ], rows: scored.signals, caption: "Recomputed here from the stored facts. It should equal the stored score; a difference means the weights changed since the lead was last saved." }), scored.score !== Number(lead.score) ? (_jsxs(Alert, { tone: "warn", children: ["The stored score is ", Number(lead.score), ". Saving the lead recomputes it."] })) : null] }), manage && !terminal ? (_jsx(Panel, { title: "Move the lead", children: _jsxs("form", { class: "ncc-stack", method: "post", action: `/api/crm/leads/${leadId}/stage`, children: [_jsx(CsrfInput, { token: csrf }), _jsxs("div", { class: "ncc-grid ncc-grid--form", children: [_jsx(FormField, { label: "Stage", name: "stage", options: enumOptions(stageOptions, null, 'Choose one'), required: true }), _jsx(FormField, { label: "Note", name: "note", placeholder: "Why it moved" })] }), _jsxs("p", { class: "ncc-muted", children: ["Won is not on this list: a lead is won by converting it, which is what creates the client and the contract. Lost is not either, because it needs a reason. Quote sent needs a completed site visit first", visited ? ' — there is one on record' : ' — there is none on record', "."] }), _jsx("button", { class: "ncc-btn ncc-btn-primary", type: "submit", children: "Move" })] }) })) : null, can(c, PERMISSIONS.CRM_LEAD_ASSIGN) && !terminal ? (_jsx(Panel, { title: "Assign", children: _jsxs("form", { class: "ncc-stack", method: "post", action: `/api/crm/leads/${leadId}/assign`, children: [_jsx(CsrfInput, { token: csrf }), _jsxs("div", { class: "ncc-grid ncc-grid--form", children: [_jsx(FormField, { label: "Owner", name: "assignedTo", options: userOptions(users, lead.assigned_to, 'Return to the pool') }), _jsx(FormField, { label: "Note", name: "note" })] }), _jsx("button", { class: "ncc-btn", type: "submit", children: "Save owner" })] }) })) : null, manage && !terminal ? (_jsx(Panel, { title: "Log an activity", children: _jsxs("form", { class: "ncc-stack", method: "post", action: `/api/crm/leads/${leadId}/activities`, children: [_jsx(CsrfInput, { token: csrf }), _jsxs("div", { class: "ncc-grid ncc-grid--form", children: [_jsx(FormField, { label: "Type", name: "activityType", options: enumOptions(ACTIVITY_TYPES, 'call_out'), required: true }), _jsx(FormField, { label: "When", name: "occurredAt", type: "datetime-local", value: dtLocal(nowSqlDateTime()), required: true }), _jsx(FormField, { label: "Minutes", name: "durationMinutes", type: "number", step: "1", min: "0" }), _jsx(FormField, { label: "Outcome", name: "outcome", options: enumOptions(ACTIVITY_OUTCOMES, null, 'Not recorded') }), _jsx(FormField, { label: "Next action", name: "nextAction", placeholder: "Send the package comparison" }), _jsx(FormField, { label: "Next action due", name: "nextActionDate", type: "date" })] }), _jsx(FormField, { label: "What happened", name: "summary", rows: 3, required: true }), _jsx("button", { class: "ncc-btn ncc-btn-primary", type: "submit", children: "Log it" })] }) })) : null, _jsx(Panel, { title: "Activity", children: _jsx(Timeline, { entries: activities.map((a) => ({
                        when: a.occurred_at,
                        who: a.by_name,
                        what: (_jsxs(_Fragment, { children: [_jsx("strong", { children: a.activity_type.replace(/_/g, ' ') }), a.outcome ? ` - ${a.outcome.replace(/_/g, ' ')}` : '', a.duration_minutes ? ` - ${a.duration_minutes} min` : '', _jsx("div", { children: a.summary }), a.next_action ? (_jsxs("div", { class: "ncc-hint", children: ["Next: ", a.next_action, a.next_action_date ? ` by ${formatDate(a.next_action_date)}` : ''] })) : null] })),
                    })) }) }), _jsxs(Panel, { title: "Site visits", actions: manage && !terminal ? (_jsx("a", { class: "ncc-btn", href: "/app/crm/visits", children: "All visits" })) : null, children: [_jsx(DataTable, { columns: [
                            { header: 'Scheduled', cell: (v) => _jsx(DateText, { value: v.scheduled_at, withTime: true }) },
                            { header: 'Status', cell: (v) => _jsx(StatusBadge, { status: v.status, tone: VISIT_TONE[v.status] ?? 'muted' }) },
                            { header: 'Visited', cell: (v) => _jsx(DateText, { value: v.visited_at, withTime: true }) },
                            { header: 'By', cell: (v) => v.visited_by_name ?? '-' },
                            {
                                header: 'Verdict',
                                cell: (v) => v.feasibility ? (_jsx(StatusBadge, { status: v.feasibility, tone: FEASIBILITY_TONE[v.feasibility] ?? 'muted' })) : (_jsx("span", { class: "ncc-muted", children: "-" })),
                            },
                            { header: 'Extra cost', numeric: true, cell: (v) => _jsx(Money, { paise: numOrNull(v.estimated_extra_cost_paise), hidden: !value }) },
                            { header: '', cell: (v) => _jsx("a", { class: "ncc-btn", href: `/app/crm/visits/${v.id}`, children: "Open" }) },
                        ], rows: visits, empty: "No visit has been booked." }), manage && !terminal ? (_jsxs("form", { class: "ncc-row", method: "post", action: `/api/crm/leads/${leadId}/site-visits`, style: "margin-top:.9rem;align-items:flex-end;gap:.75rem", children: [_jsx(CsrfInput, { token: csrf }), _jsx(FormField, { label: "Schedule a visit", name: "scheduledAt", type: "datetime-local", required: true }), _jsx(FormField, { label: "Who is going", name: "visitedBy", options: userOptions(users.length ? users : [], lead.assigned_to, 'Decide later') }), _jsx("button", { class: "ncc-btn", type: "submit", children: "Book it" })] })) : null] }), _jsx(Panel, { title: "Quotes", actions: can(c, PERMISSIONS.CRM_QUOTE_CREATE) && !terminal ? (_jsx("a", { class: "ncc-btn", href: `/app/crm/quotes/new?lead=${leadId}`, children: "New quote" })) : null, children: _jsx(DataTable, { columns: [
                        { header: 'Quote', cell: (quote) => _jsx("a", { href: `/app/crm/quotes/${quote.id}`, children: `${quote.quote_no} r${quote.revision}` }) },
                        { header: 'Date', cell: (quote) => _jsx(DateText, { value: quote.quote_date }) },
                        { header: 'Valid until', cell: (quote) => _jsx(DateText, { value: quote.valid_until }) },
                        { header: 'Status', cell: (quote) => _jsx(StatusBadge, { status: quote.status, tone: QUOTE_TONE[quote.status] ?? 'muted' }) },
                        { header: 'Discount', numeric: true, cell: (quote) => `${Number(quote.discount_pct)}%` },
                        { header: 'Total', numeric: true, cell: (quote) => _jsx(Money, { paise: Number(quote.total_paise), hidden: !value }) },
                    ], rows: quotes, empty: "No quote has been raised." }) }), can(c, PERMISSIONS.CRM_CONVERT_TO_PROJECT) && !terminal ? (_jsx(Panel, { title: "Convert to a project", children: accepted.length === 0 ? (_jsx(Alert, { tone: "warn", children: "Conversion needs an accepted quote. Without one there is no agreed contract value, and the project would start with a number somebody typed rather than a number the client signed." })) : (_jsxs("form", { class: "ncc-stack", method: "post", action: `/api/crm/leads/${leadId}/convert`, children: [_jsx(CsrfInput, { token: csrf }), _jsxs("div", { class: "ncc-grid ncc-grid--form", children: [_jsx(FormField, { label: "Planned start", name: "plannedStart", type: "date", hint: "Defaults to today." }), _jsx(FormField, { label: "Contract signed on", name: "contractSignedOn", type: "date" })] }), _jsxs("p", { class: "ncc-muted", children: ["Everything else comes from the lead and quote ", accepted[0]?.quote_no, ": the client, the site address, the contract value (", _jsx(Money, { paise: Number(accepted[0]?.total_paise ?? 0), compact: true, hidden: !value }), ' ', "inclusive of GST, of which the contract takes the pre-GST subtotal), the stages and the payment milestones. Nothing here is retyped, so nothing here can drift from what was agreed."] }), _jsx("button", { class: "ncc-btn ncc-btn-primary", type: "submit", children: "Convert" })] })) })) : null, manage && !terminal ? (_jsxs(_Fragment, { children: [_jsxs(Panel, { title: "Override the odds", children: [_jsxs("form", { class: "ncc-row", method: "post", action: `/api/crm/leads/${leadId}/probability`, style: "align-items:flex-end;gap:.75rem", children: [_jsx(CsrfInput, { token: csrf }), _jsx(FormField, { label: "Probability %", name: "probabilityPct", type: "number", step: "1", min: "0", max: "100", required: true }), _jsx(FormField, { label: "Why", name: "note", required: true, placeholder: "Client confirmed budget approval" }), _jsx("button", { class: "ncc-btn", type: "submit", children: "Set" })] }), _jsx("p", { class: "ncc-muted", children: "Every stage carries a default probability. Overriding it is audited, because the pipeline forecast is built from this number and an unexplained 90% is how a forecast stops being believed." })] }), _jsx(Panel, { title: "Mark it lost", children: _jsxs("form", { class: "ncc-stack", method: "post", action: `/api/crm/leads/${leadId}/lose`, children: [_jsx(CsrfInput, { token: csrf }), _jsxs("div", { class: "ncc-grid ncc-grid--form", children: [_jsx(FormField, { label: "Reason", name: "lostReason", options: enumOptions(LOST_REASONS, null, 'Choose one'), required: true }), _jsx(FormField, { label: "Lost to", name: "lostToCompetitor", placeholder: "Competitor name, if known" }), _jsx(FormField, { label: "Their rate (Rs/sqft)", name: "competitorRatePerSqft", type: "number", step: "0.01", min: "0" })] }), _jsx(FormField, { label: "Notes", name: "lostNotes", rows: 2 }), _jsx("p", { class: "ncc-muted", children: "The reason is a fixed list because the loss report is built from it, and free text produces ten spellings of \"price\". A named competitor and their rate go on the competitor record." }), _jsx("button", { class: "ncc-btn ncc-btn-danger", type: "submit", children: "Record the loss" })] }) })] })) : null, _jsx(Panel, { title: "Stage history", children: _jsx(DataTable, { columns: [
                        { header: 'When', cell: (h) => _jsx(DateText, { value: h.changed_at, withTime: true }) },
                        { header: 'From', cell: (h) => (h.from_stage ?? '-').replace(/_/g, ' ') },
                        { header: 'To', cell: (h) => h.to_stage.replace(/_/g, ' ') },
                        { header: 'Days in previous', numeric: true, cell: (h) => (h.days_in_previous_stage === null ? '-' : String(h.days_in_previous_stage)) },
                        { header: 'By', cell: (h) => h.by_name },
                        { header: 'Note', cell: (h) => h.note ?? '-' },
                    ], rows: history, empty: "No stage change yet.", caption: "The funnel report is built from these rows, not from the current stage." }) })] }));
});
/* Lead writes ------------------------------------------------------------- */
/**
 * Spec 6.7 lists this as PATCH. A browser form cannot send PATCH, so both verbs
 * are registered on the same handler: the documented verb works for an API
 * client and POST works for the form above. requiresCsrf() in
 * src/middleware/csrf.ts covers every method except GET, HEAD and OPTIONS, so
 * neither registration escapes the token check.
 */
crm.on(['POST', 'PATCH'], '/api/crm/leads/:id/stage', requirePermission(PERMISSIONS.CRM_LEAD_MANAGE), async (c) => {
    const leadId = idParam(c, 'id');
    await requireVisibleLead(c, leadId);
    const back = `/app/crm/leads/${leadId}`;
    const parsed = stageSchema.safeParse(await readBody(c));
    if (!parsed.success)
        return errRedirect(c, back, firstError(parsed.error));
    return guard(c, back, async () => {
        const moved = await svc.changeStage(c.get('db'), actorOf(c), leadId, parsed.data);
        return `Moved from ${moved.from.replace(/_/g, ' ')} to ${moved.to.replace(/_/g, ' ')}${moved.days === null ? '.' : ` after ${moved.days} day${moved.days === 1 ? '' : 's'}.`}`;
    });
});
crm.on(['POST', 'PATCH'], '/api/crm/leads/:id/assign', requirePermission(PERMISSIONS.CRM_LEAD_ASSIGN), async (c) => {
    const leadId = idParam(c, 'id');
    const back = `/app/crm/leads/${leadId}`;
    const parsed = assignSchema.safeParse(await readBody(c));
    if (!parsed.success)
        return errRedirect(c, back, firstError(parsed.error));
    return guard(c, back, async () => {
        await svc.assignLead(c.get('db'), actorOf(c), leadId, parsed.data);
        return parsed.data.assignedTo === null ? 'Returned to the pool.' : 'Owner saved.';
    });
});
crm.post('/api/crm/leads/:id/activities', requirePermission(PERMISSIONS.CRM_LEAD_MANAGE), async (c) => {
    const leadId = idParam(c, 'id');
    await requireVisibleLead(c, leadId);
    const back = `/app/crm/leads/${leadId}`;
    const parsed = activitySchema.safeParse(await readBody(c));
    if (!parsed.success)
        return errRedirect(c, back, firstError(parsed.error));
    return guard(c, back, async () => {
        const logged = await svc.logActivity(c.get('db'), actorOf(c), leadId, parsed.data);
        return logged.firstResponse ? 'Logged, and recorded as the first response.' : 'Logged.';
    });
});
crm.post('/api/crm/leads/:id/site-visits', requirePermission(PERMISSIONS.CRM_LEAD_MANAGE), async (c) => {
    const leadId = idParam(c, 'id');
    await requireVisibleLead(c, leadId);
    const back = `/app/crm/leads/${leadId}`;
    const body = (await readBody(c));
    const parsed = visitScheduleSchema.safeParse({ ...body, leadId });
    if (!parsed.success)
        return errRedirect(c, back, firstError(parsed.error));
    return guard(c, back, async () => {
        const booked = await svc.scheduleVisit(c.get('db'), actorOf(c), parsed.data);
        return { to: `/app/crm/visits/${booked.visitId}`, message: 'Visit booked.' };
    });
});
crm.post('/api/crm/leads/:id/probability', requirePermission(PERMISSIONS.CRM_LEAD_MANAGE), async (c) => {
    const leadId = idParam(c, 'id');
    await requireVisibleLead(c, leadId);
    const back = `/app/crm/leads/${leadId}`;
    const parsed = probabilitySchema.safeParse(await readBody(c));
    if (!parsed.success)
        return errRedirect(c, back, firstError(parsed.error));
    return guard(c, back, async () => {
        const set = await svc.setProbability(c.get('db'), actorOf(c), leadId, parsed.data);
        return `${set.leadNo} is now at ${parsed.data.probabilityPct}%, from ${set.previousPct ?? 'no figure'}.`;
    });
});
crm.post('/api/crm/leads/:id/lose', requirePermission(PERMISSIONS.CRM_LEAD_MANAGE), async (c) => {
    const leadId = idParam(c, 'id');
    await requireVisibleLead(c, leadId);
    const back = `/app/crm/leads/${leadId}`;
    const parsed = loseSchema.safeParse(await readBody(c));
    if (!parsed.success)
        return errRedirect(c, back, firstError(parsed.error));
    return guard(c, back, async () => {
        const lost = await svc.loseLead(c.get('db'), actorOf(c), leadId, {
            lostReason: parsed.data.lostReason,
            lostToCompetitor: parsed.data.lostToCompetitor,
            lostNotes: parsed.data.lostNotes,
            competitorRatePerSqftPaise: parsed.data.competitorRatePerSqft,
        });
        return `${lost.leadNo} recorded as lost.`;
    });
});
/**
 * Conversion (spec 6.7 rule 6).
 *
 * The body carries two dates and nothing else — see convertOverridesSchema.
 * Everything the project needs is read from the lead and the accepted quote
 * inside convertLeadToProject's single transaction, so the client, the project,
 * its stages, its milestones and the site store are either all created or none
 * of them are.
 */
crm.post('/api/crm/leads/:id/convert', requirePermission(PERMISSIONS.CRM_CONVERT_TO_PROJECT), async (c) => {
    const leadId = idParam(c, 'id');
    await requireVisibleLead(c, leadId);
    const back = `/app/crm/leads/${leadId}`;
    const parsed = convertOverridesSchema.safeParse(await readBody(c));
    if (!parsed.success)
        return errRedirect(c, back, firstError(parsed.error));
    return guard(c, back, async () => {
        const out = await svc.convertLeadToProject(c.get('db'), actorOf(c), leadId, parsed.data);
        return {
            to: `/app/projects/${out.projectId}`,
            message: `${out.projectCode} created${out.clientCreated ? ' with a new client' : ''}: ${out.stageCount} stages, ${out.milestoneCount} payment milestones.`,
        };
    });
});
/* Site visits ------------------------------------------------------------- */
crm.get('/app/crm/visits', requirePermission(PERMISSIONS.CRM_LEAD_VIEW), async (c) => {
    const db = c.get('db');
    const scope = scopeOf(c);
    const { page: pageNo, offset, pageSize } = pageParam(c, PAGE_SIZE);
    const status = queryParam(c, 'status') ?? null;
    const from = queryParam(c, 'from') ?? null;
    const to = queryParam(c, 'to') ?? null;
    const filters = { status, from, to };
    const [rows, total] = await Promise.all([
        q.listVisits(db, scope, { ...filters, limit: pageSize, offset }),
        q.countVisits(db, scope, filters),
    ]);
    const qs = new URLSearchParams();
    if (status)
        qs.set('status', status);
    if (from)
        qs.set('from', from);
    if (to)
        qs.set('to', to);
    return page(c, { title: 'Site visits', path: '/app/crm/visits', subtitle: scope.all ? undefined : 'Visits on your leads and the pool' }, _jsxs(_Fragment, { children: [banner(c), _jsxs(Panel, { title: "Visits", children: [_jsxs("form", { method: "get", action: "/app/crm/visits", class: "ncc-row", style: "flex-wrap:wrap;gap:.75rem", children: [_jsx(FormField, { label: "Status", name: "status", options: enumOptions(VISIT_STATUSES, status, 'All') }), _jsx(FormField, { label: "From", name: "from", type: "date", value: from }), _jsx(FormField, { label: "To", name: "to", type: "date", value: to }), _jsx("button", { class: "ncc-btn", type: "submit", children: "Filter" })] }), _jsx(DataTable, { columns: [
                            { header: 'Scheduled', cell: (v) => _jsx(DateText, { value: v.scheduled_at, withTime: true }) },
                            {
                                header: 'Lead',
                                cell: (v) => (_jsxs(_Fragment, { children: [_jsx("a", { href: `/app/crm/leads/${v.lead_id}`, children: v.contact_name }), _jsxs("div", { class: "ncc-muted", children: [v.lead_no, " - ", v.phone] })] })),
                            },
                            {
                                header: 'Site',
                                cell: (v) => [v.site_locality, v.site_city].filter((p) => p).join(', ') || _jsx("span", { class: "ncc-muted", children: "-" }),
                            },
                            { header: 'Status', cell: (v) => _jsx(StatusBadge, { status: v.status, tone: VISIT_TONE[v.status] ?? 'muted' }) },
                            { header: 'By', cell: (v) => v.visited_by_name ?? _jsx("span", { class: "ncc-muted", children: "unassigned" }) },
                            {
                                header: 'Verdict',
                                cell: (v) => v.feasibility ? (_jsx(StatusBadge, { status: v.feasibility, tone: FEASIBILITY_TONE[v.feasibility] ?? 'muted' })) : (_jsx("span", { class: "ncc-muted", children: "-" })),
                            },
                            { header: '', cell: (v) => _jsx("a", { class: "ncc-btn", href: `/app/crm/visits/${v.id}`, children: "Open" }) },
                        ], rows: rows, empty: "No visit matches that filter.", caption: "A quote cannot be sent until somebody has completed a site visit and recorded a verdict." }), _jsx(Pager, { page: pageNo, pageSize: pageSize, total: total, baseHref: qs.toString() === '' ? '/app/crm/visits' : `/app/crm/visits?${qs.toString()}` })] })] }));
});
crm.get('/app/crm/visits/:id', requirePermission(PERMISSIONS.CRM_LEAD_VIEW), async (c) => {
    const db = c.get('db');
    const visitId = idParam(c, 'id');
    const visit = await q.findVisit(db, visitId);
    if (!visit)
        throw new NotFoundError('That visit does not exist.');
    await requireVisibleLead(c, visit.lead_id);
    const value = canValue(c);
    const csrf = currentSession(c).csrfToken;
    const manage = can(c, PERMISSIONS.CRM_LEAD_MANAGE);
    const users = manage ? await q.assignableUsers(db) : [];
    const done = visit.status === 'completed';
    return page(c, {
        title: `Site visit - ${visit.contact_name}`,
        path: '/app/crm/visits',
        subtitle: `${visit.lead_no} - ${[visit.site_locality, visit.site_city].filter((p) => p).join(', ') || 'no address recorded'}`,
        actions: (_jsx("a", { class: "ncc-btn", href: `/app/crm/leads/${visit.lead_id}`, children: "Open the lead" })),
    }, _jsxs(_Fragment, { children: [banner(c), _jsx(Panel, { title: "Visit", children: _jsx(DefinitionList, { rows: [
                        ['Status', _jsx(StatusBadge, { status: visit.status, tone: VISIT_TONE[visit.status] ?? 'muted' })],
                        ['Scheduled', _jsx(DateText, { value: visit.scheduled_at, withTime: true })],
                        ['Visited', visit.visited_at ? _jsx(DateText, { value: visit.visited_at, withTime: true }) : 'not yet'],
                        ['By', visit.visited_by_name ?? 'not assigned'],
                        [
                            'Verdict',
                            visit.feasibility ? (_jsx(StatusBadge, { status: visit.feasibility, tone: FEASIBILITY_TONE[visit.feasibility] ?? 'muted' })) : ('none recorded'),
                        ],
                        ['Soil', visit.soil_type ?? '-'],
                        ['Road access', visit.road_access ?? '-'],
                        ['Water', visit.water_availability ?? '-'],
                        ['Power', visit.power_availability === null ? '-' : Number(visit.power_availability) === 1 ? 'available' : 'none'],
                        ['Level difference', visit.level_difference_ft === null ? '-' : `${Number(visit.level_difference_ft)} ft`],
                        ['Demolition', visit.demolition_required === null ? '-' : Number(visit.demolition_required) === 1 ? 'required' : 'no'],
                        [
                            'Tree cutting permission',
                            visit.tree_cutting_permission_needed === null
                                ? '-'
                                : Number(visit.tree_cutting_permission_needed) === 1
                                    ? 'needed'
                                    : 'no',
                        ],
                        ['Neighbouring structures', visit.neighbouring_structures ?? '-'],
                        ['Access constraints', visit.access_constraints ?? '-'],
                        ['Conditions', visit.conditions_notes ?? '-'],
                        ['Estimated extra cost', _jsx(Money, { paise: numOrNull(visit.estimated_extra_cost_paise), hidden: !value })],
                    ] }) }), manage && !done ? (_jsx(Panel, { title: "Record the findings", children: _jsxs("form", { class: "ncc-stack", method: "post", action: `/api/crm/site-visits/${visitId}/complete`, children: [_jsx(CsrfInput, { token: csrf }), _jsxs("div", { class: "ncc-grid ncc-grid--form", children: [_jsx(FormField, { label: "Visited at", name: "visitedAt", type: "datetime-local", value: dtLocal(visit.scheduled_at), required: true }), _jsx(FormField, { label: "Visited by", name: "visitedBy", options: userOptions(users, visit.visited_by, 'Not recorded') }), _jsx(FormField, { label: "Feasibility", name: "feasibility", options: enumOptions(FEASIBILITIES, null, 'Choose one'), required: true }), _jsx(FormField, { label: "Soil type", name: "soilType", placeholder: "Red soil, hard rock at 4 ft" }), _jsx(FormField, { label: "Road access", name: "roadAccess", options: enumOptions(ROAD_ACCESS, null, 'Not recorded'), hint: "Narrow means no transit mixer." }), _jsx(FormField, { label: "Water", name: "waterAvailability", options: enumOptions(WATER_AVAILABILITY, null, 'Not recorded') }), _jsx(FormField, { label: "Power on site", name: "powerAvailability", options: YES_NO_NULL(null) }), _jsx(FormField, { label: "Level difference (ft)", name: "levelDifferenceFt", type: "number", step: "0.01" }), _jsx(FormField, { label: "Demolition required", name: "demolitionRequired", options: YES_NO_NULL(null) }), _jsx(FormField, { label: "Tree cutting permission", name: "treeCuttingPermissionNeeded", options: YES_NO_NULL(null) }), _jsx(FormField, { label: "Estimated extra cost (Rs)", name: "estimatedExtraCostPaise", type: "number", step: "0.01", min: "0", hint: "Levelling, demolition, a longer pump run." })] }), _jsx(FormField, { label: "Neighbouring structures", name: "neighbouringStructures", rows: 2 }), _jsx(FormField, { label: "Access constraints", name: "accessConstraints", rows: 2 }), _jsx(FormField, { label: "Conditions", name: "conditionsNotes", rows: 2, hint: "What a feasible-with-conditions verdict depends on." }), _jsx("p", { class: "ncc-muted", children: "The verdict is required. A visit recorded with no verdict is the same as no visit as far as the quote gate is concerned, because the gate exists to make somebody stand on the plot before a rate is quoted against it." }), _jsx("button", { class: "ncc-btn ncc-btn-primary", type: "submit", children: "Complete the visit" })] }) })) : null, manage && !done ? (_jsxs(Panel, { title: "Reschedule or close it", children: [_jsxs("form", { class: "ncc-row", method: "post", action: `/api/crm/site-visits/${visitId}/status`, style: "align-items:flex-end;gap:.75rem", children: [_jsx(CsrfInput, { token: csrf }), _jsx(FormField, { label: "Status", name: "status", options: enumOptions(VISIT_STATUSES.filter((s) => s !== 'completed'), null, 'Choose one'), required: true }), _jsx(FormField, { label: "New time", name: "scheduledAt", type: "datetime-local", hint: "Required when rescheduling." }), _jsx("button", { class: "ncc-btn", type: "submit", children: "Save" })] }), _jsx("p", { class: "ncc-muted", children: "Completed is not on this list. A visit is completed through the findings form above, so the facts a quote depends on are on the record rather than a status word saying somebody went." })] })) : null] }));
});
/** Spec 6.7 lists this as PUT. Same reasoning as the PATCH routes above. */
crm.on(['POST', 'PUT'], '/api/crm/site-visits/:id/complete', requirePermission(PERMISSIONS.CRM_LEAD_MANAGE), async (c) => {
    const visitId = idParam(c, 'id');
    const visit = await q.findVisit(c.get('db'), visitId);
    if (!visit)
        throw new NotFoundError('That visit does not exist.');
    await requireVisibleLead(c, visit.lead_id);
    const back = `/app/crm/visits/${visitId}`;
    const parsed = visitCompleteSchema.safeParse(await readBody(c));
    if (!parsed.success)
        return errRedirect(c, back, firstError(parsed.error));
    return guard(c, back, async () => {
        const out = await svc.completeVisit(c.get('db'), actorOf(c), visitId, parsed.data);
        return { to: `/app/crm/leads/${out.leadId}`, message: `Visit recorded as ${parsed.data.feasibility.replace(/_/g, ' ')}.` };
    });
});
crm.post('/api/crm/site-visits/:id/status', requirePermission(PERMISSIONS.CRM_LEAD_MANAGE), async (c) => {
    const visitId = idParam(c, 'id');
    const visit = await q.findVisit(c.get('db'), visitId);
    if (!visit)
        throw new NotFoundError('That visit does not exist.');
    await requireVisibleLead(c, visit.lead_id);
    const back = `/app/crm/visits/${visitId}`;
    const parsed = visitStatusSchema.safeParse(await readBody(c));
    if (!parsed.success)
        return errRedirect(c, back, firstError(parsed.error));
    return guard(c, back, async () => {
        await svc.setVisitStatus(c.get('db'), actorOf(c), visitId, parsed.data);
        return `Visit marked ${parsed.data.status.replace(/_/g, ' ')}.`;
    });
});
/* Quotes ------------------------------------------------------------------ */
/** How many blank grid rows to render. ?rows= so a long quote is one page. */
function rowCount(c, dflt = 6) {
    const raw = Number(queryParam(c, 'rows') ?? '');
    if (!Number.isInteger(raw))
        return dflt;
    return Math.max(1, Math.min(40, raw));
}
function blankRows(n) {
    return Array.from({ length: Math.max(0, n) }, () => null);
}
/**
 * Reads payment_schedule_json for display and for prefilling a revision.
 *
 * The column arrives already parsed; src/lib/json.ts explains why. Reading it
 * as a string is what made this return an empty schedule for every quote: the
 * print view showed no payment terms and a revision silently dropped the
 * milestones it was meant to carry forward.
 *
 * service.ts keeps its own shape check on the same column. The parse is shared
 * and the validation is not, because that one guards a transaction that creates
 * project milestones and this one fills in a form: the service's must stay
 * strict about what it will act on, and merging them would make a change to the
 * display loosen the conversion. Both treat a malformed value as empty.
 */
function readSchedule(raw) {
    const parsed = parseJsonColumnArray(raw);
    const out = [];
    for (const item of parsed) {
        if (typeof item !== 'object' || item === null)
            continue;
        const row = item;
        const name = typeof row.name === 'string' ? row.name.trim() : '';
        const percent = Number(row.percent);
        if (name === '' || !Number.isFinite(percent) || percent <= 0)
            continue;
        const seq = Number(row.triggerStageSeq);
        out.push({ name, percent, triggerStageSeq: Number.isFinite(seq) && seq > 0 ? seq : null });
    }
    return out;
}
/**
 * The quote builder (spec 6.7 rule 4).
 *
 * There is no total on this form. The base amount, the discount amount, GST and
 * the total are computed in the service from the package rate and the lines, so
 * what is posted here is the inputs to the arithmetic and never its result — a
 * hand-edited total is not a number the system can be made to believe.
 */
function QuoteForm(props) {
    const { quote } = props;
    const basis = val(quote, 'pricing_basis') ?? 'per_sqft';
    const editable = props.lines.filter((l) => l.line_type === 'addon' || l.line_type === 'extra_work');
    return (_jsxs("form", { class: "ncc-stack", method: "post", action: props.action, children: [_jsx(CsrfInput, { token: props.csrf }), _jsx("input", { type: "hidden", name: "leadId", value: String(props.leadId) }), _jsxs("fieldset", { class: "ncc-fieldset", children: [_jsxs("legend", { children: ["Quote for ", props.leadLabel] }), _jsxs("div", { class: "ncc-grid ncc-grid--form", children: [_jsx(FormField, { label: "Package", name: "packageId", options: selectOptions(props.packages, Number(val(quote, 'package_id')) || null, 'No package (item rate or lumpsum)'), hint: "Priced off the package rate live at the quote date, not off whatever was quoted last time." }), _jsx(FormField, { label: "Quote date", name: "quoteDate", type: "date", value: val(quote, 'quote_date') ?? today(), required: true }), _jsx(FormField, { label: "Valid until", name: "validUntil", type: "date", value: val(quote, 'valid_until') ?? addDays(today(), 30), required: true, hint: "The cron expires the quote after this date and warns before it." }), _jsx(FormField, { label: "Pricing basis", name: "pricingBasis", options: enumOptions(PRICING_BASES, basis), required: true }), _jsx(FormField, { label: "Built-up area (sqft)", name: "builtUpAreaSqft", type: "number", step: "0.01", min: "0", value: val(quote, 'built_up_area_sqft'), hint: "Required for a per-square-foot quote." }), _jsx(FormField, { label: "Rate (Rs/sqft)", name: "ratePerSqft", type: "number", step: "0.01", min: "0", value: rupeeVal(quote, 'rate_per_sqft_paise'), hint: "Leave blank to take the package rate." }), _jsx(FormField, { label: "Discount %", name: "discountPct", type: "number", step: "0.01", min: "0", max: "100", value: val(quote, 'discount_pct') ?? '0', hint: "Above the approval limit this escalates instead of being applied." }), _jsx(FormField, { label: "GST %", name: "gstPct", type: "number", step: "0.01", min: "0", max: "28", value: val(quote, 'gst_pct') ?? '18' })] })] }), _jsxs("fieldset", { class: "ncc-fieldset", children: [_jsx("legend", { children: "Add-ons and extra work" }), _jsx("div", { style: "overflow-x:auto", children: _jsxs("table", { class: "ncc-table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { scope: "col", children: "Type" }), _jsx("th", { scope: "col", children: "Description" }), _jsx("th", { scope: "col", class: "ncc-num", children: "Qty" }), _jsx("th", { scope: "col", children: "Unit" }), _jsx("th", { scope: "col", class: "ncc-num", children: "Rate or amount (Rs)" }), _jsx("th", { scope: "col", children: "Cost head" })] }) }), _jsxs("tbody", { children: [editable.map((line) => (_jsxs("tr", { children: [_jsx("td", { children: _jsx("select", { name: "lineType", children: QUOTE_LINE_TYPES.map((t) => (_jsx("option", { value: t, selected: t === line.line_type, children: t.replace(/_/g, ' ') }))) }) }), _jsx("td", { children: _jsx("input", { name: "lineDescription", value: line.description }) }), _jsx("td", { class: "ncc-num", children: _jsx("input", { name: "lineQty", type: "number", step: "0.001", min: "0", value: line.qty === null || line.qty === undefined ? '' : String(Number(line.qty)) }) }), _jsx("td", { children: _jsxs("select", { name: "lineUnitId", children: [_jsx("option", { value: "", children: "-" }), props.units.map((u) => (_jsx("option", { value: String(u.id), selected: u.code === line.unit_code, children: u.code })))] }) }), _jsx("td", { class: "ncc-num", children: _jsx("input", { name: "lineRate", type: "number", step: "0.01", value: line.rate_paise === null || line.rate_paise === undefined ? '' : String(paiseToRupees(Number(line.rate_paise))) }) }), _jsx("td", { children: _jsxs("select", { name: "lineCostHeadId", children: [_jsx("option", { value: "", children: "-" }), props.costHeads.map((h) => (_jsx("option", { value: String(h.id), children: h.code })))] }) })] }))), blankRows(props.extraRows).map(() => (_jsxs("tr", { children: [_jsx("td", { children: _jsx("select", { name: "lineType", children: QUOTE_LINE_TYPES.map((t) => (_jsx("option", { value: t, children: t.replace(/_/g, ' ') }))) }) }), _jsx("td", { children: _jsx("input", { name: "lineDescription" }) }), _jsx("td", { class: "ncc-num", children: _jsx("input", { name: "lineQty", type: "number", step: "0.001", min: "0" }) }), _jsx("td", { children: _jsxs("select", { name: "lineUnitId", children: [_jsx("option", { value: "", children: "-" }), props.units.map((u) => (_jsx("option", { value: String(u.id), children: u.code })))] }) }), _jsx("td", { class: "ncc-num", children: _jsx("input", { name: "lineRate", type: "number", step: "0.01" }) }), _jsx("td", { children: _jsxs("select", { name: "lineCostHeadId", children: [_jsx("option", { value: "", children: "-" }), props.costHeads.map((h) => (_jsx("option", { value: String(h.id), children: h.code })))] }) })] })))] })] }) }), _jsx("p", { class: "ncc-hint", children: "A line with no quantity is a lump sum and its rate cell is the whole amount. Rows with no description are ignored. Add more rows with ?rows= in the address bar." })] }), _jsxs("fieldset", { class: "ncc-fieldset", children: [_jsx("legend", { children: "Payment schedule" }), _jsx("div", { style: "overflow-x:auto", children: _jsxs("table", { class: "ncc-table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { scope: "col", children: "Milestone" }), _jsx("th", { scope: "col", class: "ncc-num", children: "Percent" }), _jsx("th", { scope: "col", class: "ncc-num", children: "Trigger stage seq" })] }) }), _jsxs("tbody", { children: [props.schedule.map((m) => (_jsxs("tr", { children: [_jsx("td", { children: _jsx("input", { name: "scheduleName", value: m.name }) }), _jsx("td", { class: "ncc-num", children: _jsx("input", { name: "schedulePercent", type: "number", step: "0.01", min: "0", max: "100", value: String(m.percent) }) }), _jsx("td", { class: "ncc-num", children: _jsx("input", { name: "scheduleStageSeq", type: "number", step: "1", min: "1", value: m.triggerStageSeq === null ? '' : String(m.triggerStageSeq) }) })] }))), blankRows(props.schedule.length === 0 ? 6 : 3).map(() => (_jsxs("tr", { children: [_jsx("td", { children: _jsx("input", { name: "scheduleName", placeholder: "On completion of the plinth" }) }), _jsx("td", { class: "ncc-num", children: _jsx("input", { name: "schedulePercent", type: "number", step: "0.01", min: "0", max: "100" }) }), _jsx("td", { class: "ncc-num", children: _jsx("input", { name: "scheduleStageSeq", type: "number", step: "1", min: "1" }) })] })))] })] }) }), _jsx("p", { class: "ncc-hint", children: "The percentages must sum to exactly 100. Conversion turns this schedule into the project's payment milestones, so this is the last screen where a bad split is something a sales executive can fix." })] }), _jsxs("fieldset", { class: "ncc-fieldset", children: [_jsx("legend", { children: "Exclusions" }), _jsx(FormField, { label: "What this quote does not cover", name: "exclusions", rows: 8, required: true, value: val(quote, 'exclusions'), placeholder: 'One per line, for example:\nCompound wall and gate\nBorewell and sump\nBESCOM and BWSSB deposits and sanction charges\nSoil filling and levelling beyond 1 ft\nInterior furniture and loose fittings', hint: "These print on the quote as a numbered list. A quote cannot be sent without them: the client is entitled to see what is excluded before they sign." })] }), _jsxs("div", { class: "ncc-row", children: [_jsx("button", { class: "ncc-btn ncc-btn-primary", type: "submit", children: props.submitLabel }), _jsx("a", { class: "ncc-btn", href: props.cancelHref, children: "Cancel" })] })] }));
}
crm.get('/app/crm/quotes', requirePermission(...QUOTE_READ), async (c) => {
    const db = c.get('db');
    const scope = scopeOf(c);
    const value = canValue(c);
    const { page: pageNo, offset, pageSize } = pageParam(c, PAGE_SIZE);
    const status = queryParam(c, 'status') ?? null;
    const search = queryParam(c, 'q') ?? null;
    const leadId = Number(queryParam(c, 'lead') ?? '') || null;
    const filters = { status, q: search, leadId };
    const [rows, total] = await Promise.all([
        q.listQuotes(db, scope, { ...filters, limit: pageSize, offset }),
        q.countQuotes(db, scope, filters),
    ]);
    const qs = new URLSearchParams();
    if (status)
        qs.set('status', status);
    if (search)
        qs.set('q', search);
    if (leadId)
        qs.set('lead', String(leadId));
    return page(c, { title: 'Quotes', path: '/app/crm/quotes', subtitle: scope.all ? undefined : 'Quotes on your leads and the pool' }, _jsxs(_Fragment, { children: [banner(c), _jsxs(Panel, { title: "Quotes", children: [_jsxs("form", { method: "get", action: "/app/crm/quotes", class: "ncc-row", style: "flex-wrap:wrap;gap:.75rem", children: [_jsx(FormField, { label: "Search", name: "q", value: search, placeholder: "Quote no or client" }), _jsx(FormField, { label: "Status", name: "status", options: enumOptions(QUOTE_STATUSES, status, 'All') }), _jsx("button", { class: "ncc-btn", type: "submit", children: "Filter" })] }), _jsx(DataTable, { columns: [
                            {
                                header: 'Quote',
                                cell: (r) => (_jsxs(_Fragment, { children: [_jsx("a", { href: `/app/crm/quotes/${r.id}`, children: _jsx("strong", { children: r.quote_no }) }), _jsxs("div", { class: "ncc-muted", children: ["revision ", r.revision] })] })),
                            },
                            {
                                header: 'Lead',
                                cell: (r) => (_jsxs(_Fragment, { children: [_jsx("a", { href: `/app/crm/leads/${r.lead_id}`, children: r.contact_name }), _jsx("div", { class: "ncc-muted", children: r.lead_no })] })),
                            },
                            { header: 'Date', cell: (r) => _jsx(DateText, { value: r.quote_date }) },
                            { header: 'Valid until', cell: (r) => _jsx(DateText, { value: r.valid_until }) },
                            { header: 'Status', cell: (r) => _jsx(StatusBadge, { status: r.status, tone: QUOTE_TONE[r.status] ?? 'muted' }) },
                            { header: 'Discount', numeric: true, cell: (r) => `${Number(r.discount_pct)}%` },
                            { header: 'Total', numeric: true, cell: (r) => _jsx(Money, { paise: Number(r.total_paise), hidden: !value }) },
                            { header: 'Raised by', cell: (r) => r.created_by_name ?? '-' },
                        ], rows: rows, empty: "No quote matches that filter." }), _jsx(Pager, { page: pageNo, pageSize: pageSize, total: total, baseHref: qs.toString() === '' ? '/app/crm/quotes' : `/app/crm/quotes?${qs.toString()}` })] })] }));
});
crm.get('/app/crm/quotes/new', requirePermission(PERMISSIONS.CRM_QUOTE_CREATE), async (c) => {
    const db = c.get('db');
    const leadId = Number(queryParam(c, 'lead') ?? '') || 0;
    if (!leadId)
        throw new NotFoundError('Open a quote from the lead it belongs to.');
    await requireVisibleLead(c, leadId);
    const [lead, packages, units, costHeads, visited] = await Promise.all([
        q.findLead(db, leadId, canValue(c)),
        q.packageOptions(db),
        q.unitOptions(db),
        q.costHeadOptions(db),
        q.hasCompletedVisit(db, leadId),
    ]);
    if (!lead)
        throw new NotFoundError('That lead does not exist.');
    return page(c, { title: 'New quote', path: '/app/crm/quotes', subtitle: `${lead.lead_no} - ${lead.contact_name}` }, _jsxs(_Fragment, { children: [banner(c), visited ? null : (_jsx(Alert, { tone: "warn", children: "No completed site visit is on record for this lead. A quote can be drafted, but it cannot be sent: the send waits until somebody has stood on the plot and recorded a verdict." })), _jsx(Panel, { title: "Quote", children: _jsx(QuoteForm, { action: "/app/crm/quotes", csrf: currentSession(c).csrfToken, leadId: leadId, leadLabel: `${lead.lead_no} ${lead.contact_name}`, submitLabel: "Create the draft", cancelHref: `/app/crm/leads/${leadId}`, packages: packages, units: units, costHeads: costHeads, quote: { built_up_area_sqft: lead.target_built_up_sqft, package_id: lead.preferred_package_id }, lines: [], schedule: [], extraRows: rowCount(c) }) })] }));
});
crm.post('/app/crm/quotes', requirePermission(PERMISSIONS.CRM_QUOTE_CREATE), async (c) => {
    const body = (await readBody(c));
    const leadId = Number(body.leadId ?? '') || 0;
    if (leadId)
        await requireVisibleLead(c, leadId);
    const back = `/app/crm/quotes/new?lead=${leadId}`;
    const parsed = quoteSchema.safeParse(body);
    if (!parsed.success)
        return errRedirect(c, back, firstError(parsed.error));
    return guard(c, back, async () => {
        const created = await svc.createQuote(c.get('db'), actorOf(c), parsed.data);
        return {
            to: `/app/crm/quotes/${created.quoteId}`,
            message: `${created.quoteNo} drafted at ${formatPaiseAsRupeesWithRs(created.totals.totalPaise)}.`,
        };
    });
});
crm.get('/app/crm/quotes/:id/revise', requirePermission(PERMISSIONS.CRM_QUOTE_CREATE), async (c) => {
    const db = c.get('db');
    const quoteId = idParam(c, 'id');
    const quote = await q.findQuote(db, quoteId);
    if (!quote)
        throw new NotFoundError('That quote does not exist.');
    await requireVisibleLead(c, quote.lead_id);
    const [lines, packages, units, costHeads] = await Promise.all([
        q.quoteLines(db, quoteId),
        q.packageOptions(db),
        q.unitOptions(db),
        q.costHeadOptions(db),
    ]);
    return page(c, {
        title: `Revise ${quote.quote_no}`,
        path: '/app/crm/quotes',
        subtitle: `Revision ${quote.revision} becomes revision ${quote.revision + 1}`,
    }, _jsxs(_Fragment, { children: [banner(c), _jsxs(Alert, { tone: "warn", children: ["An approved price cannot be edited in place. Saving this supersedes revision ", quote.revision, " and starts the approval again, so the client and the audit trail both see that the price changed rather than finding a different number under the same quote."] }), _jsx(Panel, { title: "Quote", children: _jsx(QuoteForm, { action: `/api/crm/quotes/${quoteId}/revise`, csrf: currentSession(c).csrfToken, leadId: quote.lead_id, leadLabel: `${quote.lead_no} ${quote.contact_name}`, submitLabel: "Save as a new revision", cancelHref: `/app/crm/quotes/${quoteId}`, packages: packages, units: units, costHeads: costHeads, quote: quote, lines: lines, schedule: readSchedule(quote.payment_schedule_json), extraRows: rowCount(c, 3) }) })] }));
});
crm.get('/app/crm/quotes/:id', requirePermission(...QUOTE_READ), async (c) => {
    const db = c.get('db');
    const quoteId = idParam(c, 'id');
    const quote = await q.findQuote(db, quoteId);
    if (!quote)
        throw new NotFoundError('That quote does not exist.');
    await requireVisibleLead(c, quote.lead_id);
    const value = canValue(c);
    const csrf = currentSession(c).csrfToken;
    const [lines, revisions, visited] = await Promise.all([
        q.quoteLines(db, quoteId),
        q.quoteRevisions(db, quote.quote_no),
        q.hasCompletedVisit(db, quote.lead_id),
    ]);
    const schedule = readSchedule(quote.payment_schedule_json);
    const status = quote.status;
    const mine = Number(quote.created_by) === currentUser(c).id;
    const canCreate = can(c, PERMISSIONS.CRM_QUOTE_CREATE);
    const canApprove = can(c, PERMISSIONS.CRM_QUOTE_APPROVE) || can(c, PERMISSIONS.CRM_QUOTE_DISCOUNT_OVERRIDE);
    return page(c, {
        title: `${quote.quote_no} r${quote.revision}`,
        path: '/app/crm/quotes',
        subtitle: `${quote.lead_no} - ${quote.contact_name}`,
        actions: (_jsxs(_Fragment, { children: [_jsx("a", { class: "ncc-btn", href: `/api/crm/quotes/${quoteId}/print`, target: "_blank", rel: "noopener", children: "Print" }), _jsx("a", { class: "ncc-btn", href: `/app/crm/leads/${quote.lead_id}`, children: "Open the lead" }), canCreate && status !== 'superseded' && status !== 'accepted' ? (_jsx("a", { class: "ncc-btn", href: `/app/crm/quotes/${quoteId}/revise`, children: "Revise" })) : null] })),
    }, _jsxs(_Fragment, { children: [banner(c), status === 'pending_approval' ? (_jsx(Alert, { tone: "warn", children: "The discount on this quote is above the approver's limit, so it is waiting for a decision. Until it is approved the price cannot go to the client." })) : null, status === 'approved' && !visited ? (_jsx(Alert, { tone: "warn", children: "No completed site visit is on record. The send will be refused until there is one." })) : null, quote.valid_until < today() && (status === 'sent' || status === 'viewed' || status === 'approved') ? (_jsxs(Alert, { tone: "error", children: ["This quote passed its validity date on ", formatDate(quote.valid_until), "."] })) : null, _jsxs("div", { class: "ncc-grid ncc-grid--kpi", children: [_jsx(KpiCard, { label: "Status", value: _jsx(StatusBadge, { status: status, tone: QUOTE_TONE[status] ?? 'muted' }), hint: `Raised by ${quote.created_by_name ?? 'unknown'}` }), _jsx(KpiCard, { label: "Total", value: _jsx(Money, { paise: Number(quote.total_paise), hidden: !value }), hint: `Inclusive of ${Number(quote.gst_pct)}% GST` }), _jsx(KpiCard, { label: "Discount", value: `${Number(quote.discount_pct)}%`, hint: quote.approved_by_name ? `Approved by ${quote.approved_by_name}` : 'Within the limit or not yet approved' }), _jsx(KpiCard, { label: "Valid until", value: _jsx(DateText, { value: quote.valid_until }), hint: `Quoted ${formatDate(quote.quote_date)}` })] }), _jsx(Panel, { title: "Pricing", children: _jsx(DefinitionList, { rows: [
                        ['Basis', quote.pricing_basis.replace(/_/g, ' ')],
                        ['Package', quote.package_name ?? 'none'],
                        ['Built-up area', quote.built_up_area_sqft ? _jsx(Qty, { value: Number(quote.built_up_area_sqft), unit: "sqft" }) : '-'],
                        ['Rate', _jsx(Money, { paise: numOrNull(quote.rate_per_sqft_paise), hidden: !value })],
                        ['Base amount', _jsx(Money, { paise: Number(quote.base_amount_paise), hidden: !value })],
                        ['Add-ons and extras', _jsx(Money, { paise: Number(quote.extras_amount_paise), hidden: !value })],
                        ['Discount', _jsx(Money, { paise: Number(quote.discount_amount_paise), hidden: !value })],
                        ['Subtotal', _jsx(Money, { paise: Number(quote.subtotal_paise), hidden: !value })],
                        [`GST at ${Number(quote.gst_pct)}%`, _jsx(Money, { paise: Number(quote.gst_paise), hidden: !value })],
                        ['Total', _jsx(Money, { paise: Number(quote.total_paise), hidden: !value })],
                        ['Sent', quote.sent_at ? _jsx(DateText, { value: quote.sent_at, withTime: true }) : 'not sent'],
                        ['Accepted', quote.accepted_at ? _jsx(DateText, { value: quote.accepted_at, withTime: true }) : '-'],
                        ['Rejected because', quote.rejected_reason ?? '-'],
                    ] }) }), _jsx(Panel, { title: "Lines", children: _jsx(DataTable, { columns: [
                        { header: 'Type', cell: (l) => l.line_type.replace(/_/g, ' ') },
                        { header: 'Description', cell: (l) => l.description },
                        { header: 'Qty', numeric: true, cell: (l) => (l.qty === null ? '-' : _jsx(Qty, { value: Number(l.qty), unit: l.unit_code ?? undefined })) },
                        { header: 'Rate', numeric: true, cell: (l) => _jsx(Money, { paise: numOrNull(l.rate_paise), hidden: !value }) },
                        { header: 'Amount', numeric: true, cell: (l) => _jsx(Money, { paise: numOrNull(l.amount_paise), hidden: !value }) },
                    ], rows: lines, empty: "No lines.", caption: "The package line, the discount line and the exclusion notes are written by the service, not typed." }) }), _jsx(Panel, { title: "Payment schedule", children: _jsx(DataTable, { columns: [
                        { header: 'Milestone', cell: (m) => m.name },
                        { header: 'Percent', numeric: true, cell: (m) => `${m.percent}%` },
                        { header: 'Of the total', numeric: true, cell: (m) => _jsx(Money, { paise: Math.round((Number(quote.total_paise) * m.percent) / 100), hidden: !value }) },
                        { header: 'Trigger stage', numeric: true, cell: (m) => (m.triggerStageSeq === null ? '-' : String(m.triggerStageSeq)) },
                    ], rows: schedule, empty: "No payment schedule on this quote.", caption: "Conversion turns these into the project's payment milestones." }) }), _jsx(Panel, { title: "Exclusions", children: quote.exclusions ? _jsx("pre", { style: "white-space:pre-wrap;margin:0", children: quote.exclusions }) : _jsx("p", { class: "ncc-muted", children: "None recorded." }) }), canCreate && status === 'draft' ? (_jsx(Panel, { title: "Submit for approval", children: _jsxs("form", { method: "post", action: `/api/crm/quotes/${quoteId}/submit`, children: [_jsx(CsrfInput, { token: csrf }), _jsx("p", { class: "ncc-muted", children: "A discount within your approval limit is applied straight away. Above it, the quote escalates and the price is frozen until somebody with the limit decides." }), _jsx("button", { class: "ncc-btn ncc-btn-primary", type: "submit", children: "Submit" })] }) })) : null, status === 'pending_approval' ? (_jsx(Panel, { title: "Discount approval", children: _jsx(ApprovalBar, { action: `/api/crm/quotes/${quoteId}/approve`, csrfToken: csrf, canApprove: canApprove && !mine, blockedReason: mine
                        ? 'You raised this quote, so you cannot approve its own discount. That is what the escalation is for.'
                        : 'You do not hold the discount approval permission.' }) })) : null, canCreate && status === 'approved' ? (_jsx(Panel, { title: "Send it", children: _jsxs("form", { method: "post", action: `/api/crm/quotes/${quoteId}/send`, children: [_jsx(CsrfInput, { token: csrf }), _jsxs("p", { class: "ncc-muted", children: ["Emails the quote to ", quote.email ?? 'the client, if an address is on the lead', " and moves the lead to quote sent. A failed email does not undo the send; it is reported and the quote still counts as issued."] }), _jsx("button", { class: "ncc-btn ncc-btn-primary", type: "submit", children: "Send to the client" })] }) })) : null, canCreate && (status === 'sent' || status === 'viewed') ? (_jsxs(Panel, { title: "What did the client say", children: [_jsxs("div", { class: "ncc-row", style: "gap:1.5rem;align-items:flex-start", children: [_jsxs("form", { class: "ncc-stack", method: "post", action: `/api/crm/quotes/${quoteId}/accept`, children: [_jsx(CsrfInput, { token: csrf }), _jsx(FormField, { label: "Note", name: "note", placeholder: "Confirmed on the phone" }), _jsx("button", { class: "ncc-btn ncc-btn-primary", type: "submit", children: "Accepted" })] }), _jsxs("form", { class: "ncc-stack", method: "post", action: `/api/crm/quotes/${quoteId}/reject`, children: [_jsx(CsrfInput, { token: csrf }), _jsx(FormField, { label: "Reason", name: "reason", required: true, placeholder: "Went with a lower rate elsewhere" }), _jsx("button", { class: "ncc-btn ncc-btn-danger", type: "submit", children: "Rejected" })] })] }), _jsx("p", { class: "ncc-muted", children: "Accepting moves the lead to verbal agreement and is what makes conversion possible. Rejecting does not lose the lead: record the loss on the lead itself, with a reason the loss report can count." })] })) : null, _jsx(Panel, { title: "Revisions", children: _jsx(DataTable, { columns: [
                        { header: 'Revision', cell: (r) => (r.id === quoteId ? _jsx("strong", { children: `r${r.revision}` }) : _jsx("a", { href: `/app/crm/quotes/${r.id}`, children: `r${r.revision}` })) },
                        { header: 'Date', cell: (r) => _jsx(DateText, { value: r.quote_date }) },
                        { header: 'Status', cell: (r) => _jsx(StatusBadge, { status: r.status, tone: QUOTE_TONE[r.status] ?? 'muted' }) },
                        { header: 'Discount', numeric: true, cell: (r) => `${Number(r.discount_pct)}%` },
                        { header: 'Total', numeric: true, cell: (r) => _jsx(Money, { paise: Number(r.total_paise), hidden: !value }) },
                        { header: 'Sent', cell: (r) => _jsx(DateText, { value: r.sent_at, withTime: true }) },
                    ], rows: revisions, empty: "No revisions.", caption: "Every revision keeps the same quote number, so the client sees one document that changed rather than two documents." }) })] }));
});
/* Quote writes ------------------------------------------------------------ */
crm.post('/api/crm/quotes/:id/submit', requirePermission(PERMISSIONS.CRM_QUOTE_CREATE), async (c) => {
    const quoteId = idParam(c, 'id');
    const quote = await q.findQuote(c.get('db'), quoteId);
    if (!quote)
        throw new NotFoundError('That quote does not exist.');
    await requireVisibleLead(c, quote.lead_id);
    const back = `/app/crm/quotes/${quoteId}`;
    return guard(c, back, async () => {
        const out = await svc.submitQuote(c.get('db'), actorOf(c), quoteId, c.get('roleKeys'));
        if (out.status === 'approved')
            return `${out.quoteNo} approved at ${formatPaiseAsRupeesWithRs(out.totalPaise)}.`;
        return out.limitBps === null
            ? `${out.quoteNo} escalated: no discount limit is configured for your roles, so every discount needs a decision.`
            : `${out.quoteNo} escalated: ${out.discountPct}% is above your ${out.limitBps / 100}% limit.`;
    });
});
/**
 * Approve or decline a discount (spec 6.7).
 *
 * One route for both, because the shared ApprovalBar posts a `decision` field
 * to a single action and the spec's table has one row. Either permission gets
 * in: crm.quote_approve is the ordinary approver and
 * crm.quote_discount_override is the one who can go past the configured limit.
 * The service refuses the raiser approving their own discount, so that check is
 * not repeated here.
 */
crm.post('/api/crm/quotes/:id/approve', requirePermission(...QUOTE_APPROVE), async (c) => {
    const quoteId = idParam(c, 'id');
    const quote = await q.findQuote(c.get('db'), quoteId);
    if (!quote)
        throw new NotFoundError('That quote does not exist.');
    await requireVisibleLead(c, quote.lead_id);
    const back = `/app/crm/quotes/${quoteId}`;
    const body = (await readBody(c));
    const decision = String(body.decision ?? 'approve');
    if (decision === 'reject') {
        const parsed = reasonSchema.safeParse({ reason: body.note });
        if (!parsed.success)
            return errRedirect(c, back, firstError(parsed.error));
        return guard(c, back, async () => {
            const out = await svc.declineQuote(c.get('db'), actorOf(c), quoteId, parsed.data.reason);
            return `${out.quoteNo} r${out.revision} declined and returned to draft.`;
        });
    }
    return guard(c, back, async () => {
        const out = await svc.approveQuote(c.get('db'), actorOf(c), quoteId);
        return `${out.quoteNo} r${out.revision} approved at ${formatPaiseAsRupeesWithRs(out.totalPaise)}.`;
    });
});
crm.post('/api/crm/quotes/:id/send', requirePermission(PERMISSIONS.CRM_QUOTE_CREATE), async (c) => {
    const quoteId = idParam(c, 'id');
    const quote = await q.findQuote(c.get('db'), quoteId);
    if (!quote)
        throw new NotFoundError('That quote does not exist.');
    await requireVisibleLead(c, quote.lead_id);
    const back = `/app/crm/quotes/${quoteId}`;
    return guard(c, back, async () => {
        const out = await svc.sendQuote(c.get('db'), actorOf(c), quoteId);
        const moved = out.stageMoved ? ' The lead moved to quote sent.' : '';
        if (out.emailed)
            return `${out.quoteNo} sent to ${out.recipient ?? 'the client'}.${moved}`;
        return `${out.quoteNo} recorded as sent, but the email did not go: ${out.emailError ?? 'no address on the lead'}.${moved}`;
    });
});
crm.post('/api/crm/quotes/:id/accept', requirePermission(PERMISSIONS.CRM_QUOTE_CREATE), async (c) => {
    const quoteId = idParam(c, 'id');
    const quote = await q.findQuote(c.get('db'), quoteId);
    if (!quote)
        throw new NotFoundError('That quote does not exist.');
    await requireVisibleLead(c, quote.lead_id);
    const back = `/app/crm/quotes/${quoteId}`;
    const parsed = noteSchema.safeParse(await readBody(c));
    if (!parsed.success)
        return errRedirect(c, back, firstError(parsed.error));
    return guard(c, back, async () => {
        const out = await svc.acceptQuote(c.get('db'), actorOf(c), quoteId, parsed.data.note);
        return { to: `/app/crm/leads/${out.leadId}`, message: `${out.quoteNo} r${out.revision} accepted. The lead can now be converted.` };
    });
});
crm.post('/api/crm/quotes/:id/reject', requirePermission(PERMISSIONS.CRM_QUOTE_CREATE), async (c) => {
    const quoteId = idParam(c, 'id');
    const quote = await q.findQuote(c.get('db'), quoteId);
    if (!quote)
        throw new NotFoundError('That quote does not exist.');
    await requireVisibleLead(c, quote.lead_id);
    const back = `/app/crm/quotes/${quoteId}`;
    const parsed = reasonSchema.safeParse(await readBody(c));
    if (!parsed.success)
        return errRedirect(c, back, firstError(parsed.error));
    return guard(c, back, async () => {
        const out = await svc.rejectQuote(c.get('db'), actorOf(c), quoteId, parsed.data.reason);
        return `${out.quoteNo} r${out.revision} rejected. Record the loss on the lead if it is over.`;
    });
});
crm.post('/api/crm/quotes/:id/revise', requirePermission(PERMISSIONS.CRM_QUOTE_CREATE), async (c) => {
    const quoteId = idParam(c, 'id');
    const quote = await q.findQuote(c.get('db'), quoteId);
    if (!quote)
        throw new NotFoundError('That quote does not exist.');
    await requireVisibleLead(c, quote.lead_id);
    const back = `/app/crm/quotes/${quoteId}/revise`;
    const parsed = quoteSchema.safeParse(await readBody(c));
    if (!parsed.success)
        return errRedirect(c, back, firstError(parsed.error));
    return guard(c, back, async () => {
        const out = await svc.reviseQuote(c.get('db'), actorOf(c), quoteId, parsed.data);
        return {
            to: `/app/crm/quotes/${out.quoteId}`,
            message: `${out.quoteNo} revision ${out.revision} drafted at ${formatPaiseAsRupeesWithRs(out.totals.totalPaise)}.`,
        };
    });
});
/* Print ------------------------------------------------------------------- */
/*
 * A4 quote sheet. Same approach as inventory's GRN print (routes.tsx 1727):
 * this route renders its own document rather than the AppShell, because a page
 * with a sidebar and a topbar wastes the left third of a sheet of paper and the
 * client is being sent a quotation, not a screenshot of a dashboard.
 *
 * hono/jsx escapes the text inside <style>, so the selectors below use no ">"
 * and no quotes. That is a constraint of the renderer, not a style choice.
 */
const QUOTE_PRINT_CSS = `
  @page { size: A4; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body { font: 11pt/1.45 'DM Sans', system-ui, 'Segoe UI', sans-serif; color: #20262f; margin: 0; }
  h1 { font-size: 15pt; margin: 0 0 2mm; }
  h2 { font-size: 11pt; margin: 6mm 0 2mm; text-transform: uppercase; letter-spacing: .04em; }
  .muted { color: #5b6472; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .head { display: flex; justify-content: space-between; gap: 8mm; border-bottom: 1.5pt solid #e8650a; padding-bottom: 3mm; }
  .head .co { font-size: 10pt; }
  .ref { text-align: right; font-size: 10pt; }
  .two { display: flex; gap: 8mm; margin-top: 5mm; }
  .box { flex: 1; border: .5pt solid #cfd3d9; padding: 3mm 4mm; }
  .box dl { display: grid; grid-template-columns: auto 1fr; gap: 1mm 4mm; margin: 0; font-size: 10pt; }
  .box dt { color: #5b6472; }
  .box dd { margin: 0; }
  table { width: 100%; border-collapse: collapse; font-size: 10pt; }
  th, td { border-bottom: .5pt solid #cfd3d9; padding: 1.8mm 2mm; text-align: left; vertical-align: top; }
  th { background: #f6f6f4; font-size: 9pt; text-transform: uppercase; letter-spacing: .03em; }
  .totals { margin-top: 4mm; margin-left: auto; width: 82mm; }
  .totals td { border: none; padding: 1mm 2mm; }
  .totals tr.grand td { border-top: 1pt solid #20262f; font-weight: 700; font-size: 11.5pt; }
  ol.terms { font-size: 9.5pt; padding-left: 5mm; margin: 0; }
  ol.terms li { margin-bottom: 1mm; }
  .sign { display: flex; justify-content: space-between; gap: 10mm; margin-top: 14mm; font-size: 10pt; }
  .sign div { flex: 1; border-top: .5pt solid #20262f; padding-top: 2mm; }
  .draft { border: 1pt solid #b3261e; color: #b3261e; padding: 2mm 3mm; margin-top: 4mm; font-size: 10pt; }
  @media screen { body { max-width: 210mm; margin: 8mm auto; padding: 0 6mm; } }
`;
crm.get('/api/crm/quotes/:id/print', requirePermission(...QUOTE_READ), async (c) => {
    const db = c.get('db');
    const quoteId = idParam(c, 'id');
    const quote = await q.findQuote(db, quoteId);
    if (!quote)
        throw new NotFoundError('That quote does not exist.');
    await requireVisibleLead(c, quote.lead_id);
    const value = canValue(c);
    const [lines, legalName, address, gstin, phone, email] = await Promise.all([
        q.quoteLines(db, quoteId),
        getSetting(db, 'company.legal_name', 'Neelachandra Construction and Interiors'),
        getSetting(db, 'company.address_line', ''),
        getSetting(db, 'company.gstin', ''),
        getSetting(db, 'company.phone_primary', ''),
        getSetting(db, 'company.email_enquiry', ''),
    ]);
    /*
     * The inclusion list is read live from package_spec_lines at print time, not
     * copied onto the quote, so the printed sheet says what the public site
     * advertises today. Rule 4 at NCC_BUILD_SPEC.md:1930 requires the property --
     * the list "cannot drift from what the site advertises" -- and reading it here
     * rather than snapshotting it is this module's mechanism for that, the same
     * choice createQuote's docstring records. The consequence is recorded in
     * DECISIONS.md under uq_packages_slug — a spec edit changes the wording on a
     * quote already sent. The money cannot move that way: every priced figure is
     * snapshotted on the quotes row and read from there.
     */
    const spec = quote.package_id === null ? [] : await q.packageSpec(db, Number(quote.package_id));
    const specGroups = [];
    for (const line of spec) {
        const last = specGroups[specGroups.length - 1];
        if (last && last.name === line.group_name)
            last.lines.push(line);
        else
            specGroups.push({ name: line.group_name, lines: [line] });
    }
    const schedule = readSchedule(quote.payment_schedule_json);
    const exclusions = String(quote.exclusions ?? '')
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s !== '');
    const money = (paise) => (value ? formatPaiseAsRupeesWithRs(Number(paise)) : 'restricted');
    const site = [quote.site_locality, quote.site_city].filter(Boolean).join(', ');
    const issued = quote.status === 'sent' || quote.status === 'viewed' || quote.status === 'accepted';
    const doc = (_jsxs("html", { lang: "en", children: [_jsxs("head", { children: [_jsx("meta", { charset: "utf-8" }), _jsx("meta", { name: "viewport", content: "width=device-width, initial-scale=1" }), _jsxs("title", { children: [quote.quote_no, " r", quote.revision] }), _jsx("style", { children: QUOTE_PRINT_CSS })] }), _jsxs("body", { children: [_jsxs("div", { class: "head", children: [_jsxs("div", { class: "co", children: [_jsx("h1", { children: legalName }), address ? _jsx("div", { class: "muted", children: address }) : null, _jsx("div", { class: "muted", children: [gstin ? `GSTIN ${gstin}` : '', phone, email].filter(Boolean).join(' | ') })] }), _jsxs("div", { class: "ref", children: [_jsx("strong", { children: "QUOTATION" }), _jsxs("div", { children: [quote.quote_no, " r", quote.revision] }), _jsxs("div", { class: "muted", children: ["Dated ", formatDate(quote.quote_date)] }), _jsxs("div", { class: "muted", children: ["Valid until ", formatDate(quote.valid_until)] })] })] }), issued ? null : (_jsxs("p", { class: "draft", children: ["Not issued. This quote is ", String(quote.status).replace(/_/g, ' '), " and the price on it is not yet offered to the client."] })), _jsxs("div", { class: "two", children: [_jsxs("div", { class: "box", children: [_jsx("h2", { style: "margin-top:0", children: "To" }), _jsxs("dl", { children: [_jsx("dt", { children: "Name" }), _jsx("dd", { children: quote.contact_name }), _jsx("dt", { children: "Phone" }), _jsx("dd", { children: quote.phone }), quote.email ? (_jsxs(_Fragment, { children: [_jsx("dt", { children: "Email" }), _jsx("dd", { children: quote.email })] })) : null, _jsx("dt", { children: "Lead" }), _jsx("dd", { children: quote.lead_no })] })] }), _jsxs("div", { class: "box", children: [_jsx("h2", { style: "margin-top:0", children: "Site" }), _jsxs("dl", { children: [_jsx("dt", { children: "Location" }), _jsx("dd", { children: site || '-' }), quote.survey_number ? (_jsxs(_Fragment, { children: [_jsx("dt", { children: "Survey no" }), _jsx("dd", { children: quote.survey_number })] })) : null, _jsx("dt", { children: "Package" }), _jsx("dd", { children: quote.package_name ?? 'As specified below' }), _jsx("dt", { children: "Basis" }), _jsx("dd", { children: String(quote.pricing_basis).replace(/_/g, ' ') })] })] })] }), _jsx("h2", { children: "Scope and price" }), _jsxs("table", { children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Description" }), _jsx("th", { class: "num", children: "Qty" }), _jsx("th", { class: "num", children: "Rate" }), _jsx("th", { class: "num", children: "Amount" })] }) }), _jsx("tbody", { children: lines.map((l) => (_jsxs("tr", { children: [_jsx("td", { children: l.description }), _jsxs("td", { class: "num", children: [l.qty === null || l.qty === undefined ? '' : String(Number(l.qty)), l.unit_code ? ` ${l.unit_code}` : ''] }), _jsx("td", { class: "num", children: l.rate_paise === null || l.rate_paise === undefined ? '' : money(l.rate_paise) }), _jsx("td", { class: "num", children: l.amount_paise === null || l.amount_paise === undefined ? '' : money(l.amount_paise) })] }))) })] }), _jsx("table", { class: "totals", children: _jsxs("tbody", { children: [_jsxs("tr", { children: [_jsx("td", { children: "Base amount" }), _jsx("td", { class: "num", children: money(quote.base_amount_paise) })] }), _jsxs("tr", { children: [_jsx("td", { children: "Add-ons and extra work" }), _jsx("td", { class: "num", children: money(quote.extras_amount_paise) })] }), Number(quote.discount_amount_paise) > 0 ? (_jsxs("tr", { children: [_jsxs("td", { children: ["Less discount at ", Number(quote.discount_pct), "%"] }), _jsxs("td", { class: "num", children: ["- ", money(quote.discount_amount_paise)] })] })) : null, _jsxs("tr", { children: [_jsx("td", { children: "Subtotal" }), _jsx("td", { class: "num", children: money(quote.subtotal_paise) })] }), _jsxs("tr", { children: [_jsxs("td", { children: ["GST at ", Number(quote.gst_pct), "%"] }), _jsx("td", { class: "num", children: money(quote.gst_paise) })] }), _jsxs("tr", { class: "grand", children: [_jsx("td", { children: "Total payable" }), _jsx("td", { class: "num", children: money(quote.total_paise) })] })] }) }), schedule.length > 0 ? (_jsxs(_Fragment, { children: [_jsx("h2", { children: "Payment schedule" }), _jsxs("table", { children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Milestone" }), _jsx("th", { class: "num", children: "Percent" }), _jsx("th", { class: "num", children: "Amount" })] }) }), _jsx("tbody", { children: schedule.map((m) => (_jsxs("tr", { children: [_jsx("td", { children: m.name }), _jsxs("td", { class: "num", children: [m.percent, "%"] }), _jsx("td", { class: "num", children: money(Math.round((Number(quote.total_paise) * m.percent) / 100)) })] }))) })] })] })) : null, specGroups.length > 0 ? (_jsxs(_Fragment, { children: [_jsx("h2", { children: "Included in this price" }), _jsxs("table", { children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Group" }), _jsx("th", { children: "Item" }), _jsx("th", { children: "Specification" }), _jsx("th", { children: "Brands" })] }) }), _jsx("tbody", { children: specGroups.map((group) => group.lines.map((line, i) => (_jsxs("tr", { children: [_jsx("td", { children: i === 0 ? group.name : '' }), _jsx("td", { children: line.label }), _jsx("td", { children: line.spec_value ?? '-' }), _jsx("td", { class: "muted", children: line.brand_options ?? '-' })] })))) })] }), _jsxs("p", { class: "muted", style: "font-size:9pt;margin-top:1mm", children: ["The published specification for ", quote.package_name, " as it stands on ", formatDate(today()), "."] })] })) : null, exclusions.length > 0 ? (_jsxs(_Fragment, { children: [_jsx("h2", { children: "Not included in this price" }), _jsx("ol", { class: "terms", children: exclusions.map((line) => (_jsx("li", { children: line }))) })] })) : null, _jsx("h2", { children: "Terms" }), _jsxs("ol", { class: "terms", children: [_jsxs("li", { children: ["This quotation is valid until ", formatDate(quote.valid_until), ". Rates are subject to revision after that date."] }), _jsx("li", { children: "Anything not listed under the scope above is excluded and will be quoted separately before it is executed." }), _jsx("li", { children: "Statutory deposits, sanction and approval charges payable to any authority are to the client's account." }), _jsx("li", { children: "Payments fall due on the milestones above and work continues on receipt." }), _jsx("li", { children: "Prices are exclusive of any change in the rate of GST or of any new levy notified after the date of this quotation." })] }), _jsxs("div", { class: "sign", children: [_jsxs("div", { children: ["For ", legalName, _jsx("br", {}), _jsx("br", {}), "Authorised signatory"] }), _jsxs("div", { children: ["Accepted by ", quote.contact_name, _jsx("br", {}), _jsx("br", {}), "Signature and date"] })] })] })] }));
    return c.html(html `<!DOCTYPE html>${doc}`);
});
/* Reports ----------------------------------------------------------------- */
/**
 * The date window every report shares. Defaults to the current financial year
 * to date, because that is the window the numbers are reported in.
 */
function reportRange(c) {
    const to = queryParam(c, 'to') ?? today();
    const from = queryParam(c, 'from') ?? financialYearBounds(financialYear(to)).start;
    return { from, to };
}
function RangeForm(props) {
    return (_jsxs("form", { method: "get", action: props.action, class: "ncc-toolbar", children: [_jsx(FormField, { label: "From", name: "from", type: "date", value: props.from }), _jsx(FormField, { label: "To", name: "to", type: "date", value: props.to }), _jsx("button", { class: "ncc-btn", type: "submit", children: "Show" })] }));
}
/**
 * The funnel (spec 6.7 rule 8), plus the first-response breach list.
 *
 * The breach threshold comes from the crm.first_response_target_hours setting.
 * Nothing else in the tree reads it: the followup cron does not, and
 * firstResponseBreaches takes it as an argument, so before this report the
 * seeded row was a number with no consumer.
 */
crm.get('/app/crm/reports/funnel', requirePermission(PERMISSIONS.CRM_VIEW_PIPELINE_VALUE), async (c) => {
    const db = c.get('db');
    const { from, to } = reportRange(c);
    const scope = scopeOf(c);
    const targetHours = await getSetting(db, 'crm.first_response_target_hours', 4);
    const [rows, totals, breaches, dormant] = await Promise.all([
        q.funnelReport(db, from, to),
        q.pipelineTotals(db, scope),
        q.firstResponseBreaches(db, targetHours, scope),
        q.dormantCandidates(db),
    ]);
    const entered = new Map(rows.map((r) => [r.to_stage, r]));
    const top = Number(entered.get('contacted')?.leads ?? 0);
    return page(c, {
        title: 'Funnel',
        path: '/app/crm/reports/funnel',
        subtitle: `Stages entered between ${formatDate(from)} and ${formatDate(to)}`,
    }, _jsxs(_Fragment, { children: [banner(c), _jsxs(Panel, { title: "Window", children: [_jsx(RangeForm, { action: "/app/crm/reports/funnel", from: from, to: to }), _jsx("p", { class: "ncc-hint", children: "A lead counts in a row on the date it entered that stage, not on the date it was created, so a lead created in March and quoted in April appears in both years' funnels at the stage it reached in each." }), _jsxs("div", { class: "ncc-row", children: [_jsx("a", { class: "ncc-btn", href: `/app/crm/reports/sources?from=${from}&to=${to}`, children: "Sources" }), _jsx("a", { class: "ncc-btn", href: `/app/crm/reports/losses?from=${from}&to=${to}`, children: "Losses" })] })] }), _jsx(Panel, { title: "Stages entered", children: _jsx(DataTable, { columns: [
                        { header: 'Stage', cell: (r) => _jsx(StatusBadge, { status: r.to_stage, tone: STAGE_TONE[r.to_stage] ?? 'muted' }) },
                        { header: 'Leads', numeric: true, cell: (r) => String(r.leads) },
                        {
                            header: 'Of contacted',
                            numeric: true,
                            cell: (r) => (top === 0 ? '-' : `${Math.round((Number(r.leads) / top) * 1000) / 10}%`),
                        },
                        {
                            header: 'Days in the stage before',
                            numeric: true,
                            cell: (r) => (r.avg_days_in_previous === null ? '-' : String(Math.round(Number(r.avg_days_in_previous) * 10) / 10)),
                        },
                    ], rows: rows, empty: "No stage was entered in that window.", caption: "Counted from lead_stage_history, so a lead that went forward, back and forward again is counted at each entry." }) }), _jsx(Panel, { title: "Open pipeline now", children: _jsx(DataTable, { columns: [
                        { header: 'Stage', cell: (r) => _jsx(StatusBadge, { status: r.stage, tone: STAGE_TONE[r.stage] ?? 'muted' }) },
                        { header: 'Leads', numeric: true, cell: (r) => String(r.n) },
                        { header: 'Value', numeric: true, cell: (r) => _jsx(Money, { paise: Number(r.value_paise) }) },
                        { header: 'Weighted', numeric: true, cell: (r) => _jsx(Money, { paise: Number(r.weighted_paise) }) },
                    ], rows: totals, empty: "No open leads.", caption: "Weighted by the stage probability, or by the override where one was set. This is a forecast, not a commitment." }) }), _jsx(Panel, { title: `No first response after ${targetHours} hours`, children: _jsx(DataTable, { columns: [
                        { header: 'Lead', cell: (r) => _jsx("a", { href: `/app/crm/leads/${r.id}`, children: r.lead_no }) },
                        { header: 'Contact', cell: (r) => r.contact_name },
                        { header: 'Phone', cell: (r) => r.phone },
                        { header: 'Came in', cell: (r) => _jsx(DateText, { value: r.created_at, withTime: true }) },
                        { header: 'Owner', cell: (r) => r.assignee_name ?? 'unassigned' },
                    ], rows: breaches, empty: "Nothing breached the target.", caption: "Open leads with first_response_at still null. A lead answered late is not here: the query lists the ones nobody has answered at all, which is the list worth acting on." }) }), _jsx(Panel, { title: "Going quiet", children: _jsx(DataTable, { columns: [
                        { header: 'Lead', cell: (r) => _jsx("a", { href: `/app/crm/leads/${r.id}`, children: r.lead_no }) },
                        { header: 'Stage', cell: (r) => _jsx(StatusBadge, { status: r.stage, tone: STAGE_TONE[r.stage] ?? 'muted' }) },
                    ], rows: dormant, empty: "Nothing is dormant.", caption: `Untouched for ${q.DORMANT_DAYS} days. The nightly cron moves these to dormant; this is the list before it runs. Unscoped, because the cron that acts on it is.` }) })] }));
});
crm.get('/app/crm/reports/sources', requirePermission(PERMISSIONS.CRM_VIEW_PIPELINE_VALUE), async (c) => {
    const db = c.get('db');
    const { from, to } = reportRange(c);
    const rows = await q.sourceReport(db, from, to);
    return page(c, {
        title: 'Sources',
        // Highlights Funnel in the sidebar. Sources is a page you reach from the
        // funnel, so pointing activeHref at its own unlisted href would leave the
        // sidebar with nothing lit at all.
        path: '/app/crm/reports/funnel',
        subtitle: `Leads created between ${formatDate(from)} and ${formatDate(to)}`,
        actions: (_jsx("a", { class: "ncc-btn", href: `/app/crm/reports/funnel?from=${from}&to=${to}`, children: "Back to the funnel" })),
    }, _jsxs(_Fragment, { children: [banner(c), _jsx(Panel, { title: "Window", children: _jsx(RangeForm, { action: "/app/crm/reports/sources", from: from, to: to }) }), _jsx(Panel, { title: "Where the work came from", children: _jsx(DataTable, { columns: [
                        { header: 'Source', cell: (r) => r.source_name ?? 'not recorded' },
                        { header: 'Leads', numeric: true, cell: (r) => String(r.leads) },
                        { header: 'Won', numeric: true, cell: (r) => String(r.won) },
                        { header: 'Lost', numeric: true, cell: (r) => String(r.lost) },
                        {
                            header: 'Win rate',
                            numeric: true,
                            cell: (r) => {
                                const decided = Number(r.won) + Number(r.lost);
                                return decided === 0 ? '-' : `${Math.round((Number(r.won) / decided) * 1000) / 10}%`;
                            },
                        },
                        { header: 'Won value', numeric: true, cell: (r) => _jsx(Money, { paise: Number(r.won_value_paise) }) },
                    ], rows: rows, empty: "No lead was created in that window.", caption: "Win rate is of the decided leads only. A source whose leads are all still open has no rate yet, which is different from a rate of zero." }) })] }));
});
crm.get('/app/crm/reports/losses', requirePermission(PERMISSIONS.CRM_LEAD_VIEW), async (c) => {
    const db = c.get('db');
    const { from, to } = reportRange(c);
    const [rows, competitors] = await Promise.all([q.lossReport(db, from, to), q.listCompetitors(db)]);
    const total = rows.reduce((n, r) => n + Number(r.leads), 0);
    return page(c, {
        title: 'Losses',
        // Guarded on crm.lead_view, not on the pipeline-value permission: a loss
        // reason is not a number, and a sales executive who cannot see the
        // forecast still needs to know what the company keeps losing on.
        path: '/app/crm',
        subtitle: `Leads lost between ${formatDate(from)} and ${formatDate(to)}`,
        actions: can(c, PERMISSIONS.CRM_VIEW_PIPELINE_VALUE) ? (_jsx("a", { class: "ncc-btn", href: `/app/crm/reports/funnel?from=${from}&to=${to}`, children: "Back to the funnel" })) : undefined,
    }, _jsxs(_Fragment, { children: [banner(c), _jsxs(Panel, { title: "Window", children: [_jsx(RangeForm, { action: "/app/crm/reports/losses", from: from, to: to }), _jsx("p", { class: "ncc-hint", children: "The reason is always one of the fixed choices on the lose form, so this table can be counted and compared month to month. That is the whole point of refusing a free-text reason there." })] }), _jsx(Panel, { title: "Why work was lost", children: _jsx(DataTable, { columns: [
                        { header: 'Reason', cell: (r) => String(r.lost_reason ?? 'not recorded').replace(/_/g, ' ') },
                        { header: 'To', cell: (r) => r.lost_to_competitor ?? '-' },
                        { header: 'Leads', numeric: true, cell: (r) => String(r.leads) },
                        { header: 'Share', numeric: true, cell: (r) => (total === 0 ? '-' : `${Math.round((Number(r.leads) / total) * 1000) / 10}%`) },
                    ], rows: rows, empty: "Nothing was lost in that window." }) }), _jsx(Panel, { title: "Competitors on record", children: _jsx(DataTable, { columns: [
                        { header: 'Name', cell: (r) => r.name },
                        { header: 'Typical rate', numeric: true, cell: (r) => _jsx(Money, { paise: numOrNull(r.typical_rate_per_sqft_paise) }) },
                        { header: 'Notes', cell: (r) => r.notes ?? '-' },
                        { header: 'Updated', cell: (r) => _jsx(DateText, { value: r.updated_at, withTime: true }) },
                    ], rows: competitors, empty: "No competitor has been named on a loss yet.", caption: "Created by the lose form, which matches on the name it is given rather than asking for a competitor to be set up first. The rate is the last one a lost lead reported, so it is hearsay from the client, not a quote we have seen." }) })] }));
});
export default crm;
