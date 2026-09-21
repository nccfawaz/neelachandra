import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "hono/jsx/jsx-runtime";
import { Hono } from 'hono';
import { currentUser, currentScope } from '../../types.js';
import { page, banner, okRedirect, errRedirect, queryParam } from '../../dashboard/render.js';
import { Alert, DataTable, DateText, DefinitionList, FormField, Money, Panel, Progress, Qty, StatusBadge, Tabs, } from '../../dashboard/components/index.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { requireProjectAccess } from '../../middleware/requireProjectAccess.js';
import { PERMISSIONS } from '../../lib/permissions.js';
import { readBody } from '../../middleware/csrf.js';
import { NotFoundError } from '../../lib/errors.js';
import { formatDate } from '../../lib/dates.js';
import { today } from '../../lib/dates.js';
import * as q from './queries.js';
import * as svc from './service.js';
import { approvalSchema, createProjectSchema, dprSchema, firstError, projectStatusSchema, qualityCheckSchema, snagSchema, snagStatusSchema, stageProgressSchema, DELIVERY_MODELS, JURISDICTIONS, PROJECT_TYPES, } from './schemas.js';
/**
 * Projects routes (spec 6.3).
 *
 * Every detail route sits behind requireProjectAccess, which 404s rather
 * than 403s an unassigned project. Cost visibility is passed into the
 * queries as canViewCost so the money columns are absent from the SELECT for
 * a supervisor, not merely hidden in the template.
 */
const projects = new Hono();
function actorOf(c) {
    return { userId: currentUser(c).id, ip: c.get('clientIp') };
}
function canCost(c) {
    return c.get('perms').has(PERMISSIONS.PROJECTS_VIEW_COST);
}
function idParam(c, name = 'projectId') {
    const n = Number(c.req.param(name));
    if (!Number.isInteger(n) || n < 1)
        throw new NotFoundError('Not found');
    return n;
}
const TABS = [
    'overview',
    'stages',
    'dpr',
    'quality',
    'milestones',
    'snags',
    'approvals',
    'materials',
    'cost',
    'documents',
    'team',
];
function tabsFor(projectId, perms) {
    const base = TABS.filter((t) => {
        // The cost tab is omitted for a user without the permission, and the
        // route that renders it is guarded separately, so hiding the link is
        // convenience rather than the control (spec 4.2).
        if (t === 'cost')
            return perms.has(PERMISSIONS.PROJECTS_VIEW_COST);
        return true;
    });
    return base.map((t) => ({
        label: t === 'dpr' ? 'Daily reports' : t.charAt(0).toUpperCase() + t.slice(1),
        href: `/app/projects/${projectId}?tab=${t}`,
    }));
}
/* List ------------------------------------------------------------------- */
projects.get('/app/projects', requirePermission(PERMISSIONS.PROJECTS_VIEW), async (c) => {
    const db = c.get('db');
    const cost = canCost(c);
    const status = queryParam(c, 'status');
    const rows = await q.listProjects(db, currentScope(c), { canViewCost: cost, status });
    const columns = [
        {
            header: 'Project',
            cell: (r) => (_jsxs(_Fragment, { children: [_jsx("a", { href: `/app/projects/${r.id}`, children: _jsx("strong", { children: r.name }) }), _jsx("div", { class: "ncc-muted", children: r.code })] })),
        },
        { header: 'Client', cell: (r) => r.client_name },
        { header: 'Type', cell: (r) => r.project_type.replace(/_/g, ' ') },
        { header: 'City', cell: (r) => r.city },
        { header: 'Status', cell: (r) => _jsx(StatusBadge, { status: r.status }) },
        { header: 'Progress', cell: (r) => _jsx(Progress, { pct: Number(r.physical_progress_pct) }) },
        {
            header: 'Planned end',
            cell: (r) => (_jsxs(_Fragment, { children: [_jsx(DateText, { value: r.planned_end }), r.planned_end && r.planned_end < today() && r.status === 'in_progress' ? (_jsx("div", { class: "ncc-badge ncc-badge-danger", children: "overdue" })) : null] })),
        },
        {
            header: 'Contract value',
            numeric: true,
            cell: (r) => _jsx(Money, { paise: r.contract_value_paise ?? null, hidden: !cost, compact: true }),
        },
    ];
    const statuses = ['', 'mobilising', 'in_progress', 'on_hold', 'snagging', 'handed_over', 'defect_liability', 'closed'];
    return page(c, {
        title: 'Projects',
        path: '/app/projects',
        subtitle: `${rows.length} project${rows.length === 1 ? '' : 's'} you can see`,
        actions: c.get('perms').has(PERMISSIONS.PROJECTS_MANAGE) ? (_jsx("a", { class: "ncc-btn ncc-btn-primary", href: "/app/projects/new", children: "New project" })) : null,
    }, _jsxs(_Fragment, { children: [banner(c), _jsxs("form", { class: "ncc-card ncc-row", method: "get", action: "/app/projects", children: [_jsx(FormField, { label: "Status", name: "status", options: statuses.map((s) => ({
                            value: s,
                            label: s === '' ? 'All statuses' : s.replace(/_/g, ' '),
                            selected: s === (status ?? ''),
                        })) }), _jsx("button", { class: "ncc-btn", type: "submit", children: "Filter" })] }), _jsx(Panel, { title: "Project list", children: _jsx(DataTable, { columns: columns, rows: rows, empty: "No projects match. A project you are not assigned to will not appear here." }) })] }));
});
/* Cross-project queues --------------------------------------------------- */
projects.get('/app/projects/dprs', requirePermission(PERMISSIONS.PROJECTS_VIEW), async (c) => {
    const db = c.get('db');
    const scope = currentScope(c);
    const missing = await q.todayDprMissing(db, scope);
    const options = await q.activeProjectOptions(db, scope);
    return page(c, { title: 'Daily reports', path: '/app/projects/dprs', subtitle: `${missing} active project(s) have no report for today` }, _jsxs(_Fragment, { children: [banner(c), _jsxs(Panel, { title: "File a report", children: [_jsx("p", { class: "ncc-hint", children: "A tracker nobody fills in is worse than a spreadsheet, because it looks authoritative while being stale. The nightly job notifies the PM for any active project missing yesterday's report." }), _jsx("ul", { children: options.map((p) => (_jsx("li", { children: _jsxs("a", { href: `/app/projects/${p.id}/dpr/new`, children: [p.code, " ", p.name] }) }))) }), options.length === 0 ? _jsx("div", { class: "ncc-empty", children: "No active projects assigned to you." }) : null] })] }));
});
projects.get('/app/projects/snags', requirePermission(PERMISSIONS.PROJECTS_VIEW), async (c) => {
    const db = c.get('db');
    const scope = currentScope(c);
    const { projectScopeFilter } = await import('../../lib/scope.js');
    const scoped = await projectScopeFilter(db, scope);
    let query = db
        .selectFrom('snags')
        .innerJoin('projects', 'projects.id', 'snags.project_id')
        .leftJoin('users', 'users.id', 'snags.assigned_to')
        .select([
        'snags.id',
        'snags.location',
        'snags.trade',
        'snags.severity',
        'snags.status',
        'snags.target_date',
        'snags.description',
        'projects.id as project_id',
        'projects.code as project_code',
        'projects.name as project_name',
        'users.full_name as assigned_to_name',
    ])
        .where('snags.status', 'in', ['open', 'in_progress', 'resolved'])
        .orderBy('snags.severity', 'desc')
        .orderBy('snags.target_date')
        .limit(300);
    if (scoped)
        query = query.where('snags.project_id', 'in', scoped.length ? scoped : [0]);
    const rows = await query.execute();
    const columns = [
        {
            header: 'Project',
            cell: (r) => (_jsxs("a", { href: `/app/projects/${r.project_id}?tab=snags`, children: [r.project_code, " ", r.project_name] })),
        },
        { header: 'Location', cell: (r) => r.location },
        { header: 'Trade', cell: (r) => r.trade },
        { header: 'Defect', cell: (r) => r.description },
        { header: 'Severity', cell: (r) => r.severity },
        { header: 'Assigned', cell: (r) => r.assigned_to_name ?? _jsx("span", { class: "ncc-muted", children: "Unassigned" }) },
        {
            header: 'Target',
            cell: (r) => (_jsxs(_Fragment, { children: [_jsx(DateText, { value: r.target_date }), r.target_date && r.target_date < today() ? _jsx("div", { class: "ncc-badge ncc-badge-danger", children: "overdue" }) : null] })),
        },
        { header: 'Status', cell: (r) => _jsx(StatusBadge, { status: r.status }) },
    ];
    return page(c, { title: 'Open snags', path: '/app/projects/snags', subtitle: `${rows.length} defect(s) across your projects` }, _jsxs(_Fragment, { children: [banner(c), _jsx(Panel, { title: "Snag queue", children: _jsx(DataTable, { columns: columns, rows: rows, empty: "No open defects." }) })] }));
});
/* Create ----------------------------------------------------------------- */
projects.get('/app/projects/new', requirePermission(PERMISSIONS.PROJECTS_MANAGE), async (c) => {
    const db = c.get('db');
    const [clients, templates] = await Promise.all([q.clientOptions(db), q.stageTemplateOptions(db)]);
    const session = c.get('session');
    return page(c, { title: 'New project', path: '/app/projects', subtitle: 'Stages are created from the template in the same transaction' }, _jsxs(_Fragment, { children: [banner(c), clients.length === 0 ? (_jsx(Alert, { tone: "warn", children: "There are no active clients yet. A project needs a client, so create one through a CRM conversion or add a client record first." })) : null, _jsxs("form", { class: "ncc-card ncc-stack", method: "post", action: "/app/projects", children: [_jsx("input", { type: "hidden", name: "nc_csrf", value: session.csrfToken }), _jsx(FormField, { label: "Project name", name: "name", required: true }), _jsx(FormField, { label: "Client", name: "clientId", required: true, options: clients.map((cl) => ({ value: String(cl.id), label: `${cl.name} (${cl.code ?? '-'})` })) }), _jsx(FormField, { label: "Project type", name: "projectType", required: true, options: PROJECT_TYPES.map((t) => ({ value: t, label: t.replace(/_/g, ' ') })) }), _jsx(FormField, { label: "Delivery model", name: "deliveryModel", required: true, hint: "Drives which costing view the project shows.", options: DELIVERY_MODELS.map((t) => ({ value: t, label: t.replace(/_/g, ' ') })) }), _jsx(FormField, { label: "Stage template", name: "stageTemplateId", hint: "Leave blank to use the default for this project type. Weightages must sum to 100.", options: [
                            { value: '', label: 'Automatic' },
                            ...templates.map((t) => ({
                                value: String(t.id),
                                label: `${t.name}${t.is_default ? ' (default)' : ''}`,
                            })),
                        ] }), _jsx(FormField, { label: "Site address", name: "siteAddress", required: true, rows: 3 }), _jsx(FormField, { label: "City", name: "city", required: true, value: "Bengaluru" }), _jsx(FormField, { label: "Planning authority", name: "jurisdiction", options: [{ value: '', label: 'Not known yet' }, ...JURISDICTIONS.map((j) => ({ value: j, label: j }))] }), _jsx(FormField, { label: "Built up area (sqft)", name: "builtUpAreaSqft", type: "number", step: "0.01" }), _jsx(FormField, { label: "Plot area (sqft)", name: "plotAreaSqft", type: "number", step: "0.01" }), _jsx(FormField, { label: "Scope of work", name: "scopeOfWork", rows: 3 }), _jsx(FormField, { label: "Contract value (rupees)", name: "contractValuePaise", type: "number", step: "0.01" }), _jsx(FormField, { label: "Rate per sqft (rupees)", name: "ratePerSqftPaise", type: "number", step: "0.01" }), _jsx(FormField, { label: "Contract signed on", name: "contractSignedOn", type: "date", hint: "Structural warranty runs 10 years from this date." }), _jsx(FormField, { label: "Planned start", name: "plannedStart", type: "date" }), _jsx(FormField, { label: "Planned end", name: "plannedEnd", type: "date" }), _jsxs("div", { class: "ncc-row", children: [_jsx("button", { class: "ncc-btn ncc-btn-primary", type: "submit", children: "Create project" }), _jsx("a", { class: "ncc-btn", href: "/app/projects", children: "Cancel" })] })] })] }));
});
projects.post('/app/projects', requirePermission(PERMISSIONS.PROJECTS_MANAGE), async (c) => {
    const parsed = createProjectSchema.safeParse(await readBody(c));
    if (!parsed.success)
        return errRedirect(c, '/app/projects/new', firstError(parsed.error));
    const { projectId, code } = await svc.createProject(c.get('db'), actorOf(c), parsed.data);
    return okRedirect(c, `/app/projects/${projectId}`, `Project ${code} created.`);
});
/* Detail ----------------------------------------------------------------- */
projects.get('/app/projects/:projectId', requirePermission(PERMISSIONS.PROJECTS_VIEW), requireProjectAccess(), async (c) => {
    const db = c.get('db');
    const projectId = idParam(c);
    const cost = canCost(c);
    const project = await q.findProject(db, projectId, cost);
    if (!project)
        throw new NotFoundError('Project not found');
    const requested = (queryParam(c, 'tab') ?? 'overview');
    const tab = TABS.includes(requested) ? requested : 'overview';
    if (tab === 'cost' && !cost)
        throw new NotFoundError('Not found');
    const body = await renderTab(c, tab, projectId, project, cost);
    return page(c, {
        title: project.name,
        path: '/app/projects',
        subtitle: `${project.code} for ${project.client_name}`,
        actions: _jsx(StatusBadge, { status: project.status }),
    }, _jsxs(_Fragment, { children: [banner(c), _jsx(Tabs, { tabs: tabsFor(projectId, c.get('perms')), active: `/app/projects/${projectId}?tab=${tab}` }), body] }));
});
/** The tab fragment endpoint, so a slow tab can be lazy loaded without a route change. */
projects.get('/api/projects/:projectId/tab/:tab', requirePermission(PERMISSIONS.PROJECTS_VIEW), requireProjectAccess(), async (c) => {
    const db = c.get('db');
    const projectId = idParam(c);
    const cost = canCost(c);
    const raw = c.req.param('tab');
    if (!TABS.includes(raw))
        throw new NotFoundError('Not found');
    if (raw === 'cost' && !cost)
        throw new NotFoundError('Not found');
    const project = await q.findProject(db, projectId, cost);
    if (!project)
        throw new NotFoundError('Project not found');
    return c.html(await renderTab(c, raw, projectId, project, cost));
});
async function renderTab(c, tab, projectId, project, cost) {
    const db = c.get('db');
    const perms = c.get('perms');
    const csrf = c.get('session').csrfToken;
    switch (tab) {
        case 'overview': {
            const [snagCount, stages] = await Promise.all([
                q.openSnagCount(db, projectId),
                q.projectStages(db, projectId),
            ]);
            const contractValue = 'contract_value_paise' in project ? project.contract_value_paise : null;
            return (_jsxs("div", { class: "ncc-stack", children: [_jsxs(Panel, { title: "Overview", children: [_jsx(DefinitionList, { rows: [
                                    ['Code', project.code],
                                    ['Client', project.client_name],
                                    ['Type', project.project_type.replace(/_/g, ' ')],
                                    ['Delivery model', project.delivery_model.replace(/_/g, ' ')],
                                    ['Site', `${project.site_address}, ${project.city}`],
                                    ['Planning authority', project.jurisdiction ?? 'Not recorded'],
                                    ['Built up area', project.built_up_area_sqft ? `${Number(project.built_up_area_sqft)} sqft` : 'Not recorded'],
                                    ['Progress', _jsx(Progress, { pct: Number(project.physical_progress_pct) })],
                                    ['Planned', `${formatDate(project.planned_start) || '-'} to ${formatDate(project.planned_end) || '-'}`],
                                    ['Actual', `${formatDate(project.actual_start) || '-'} to ${formatDate(project.actual_end) || '-'}`],
                                    ['Contract value', _jsx(Money, { paise: contractValue, hidden: !cost })],
                                    ['Open snags', String(snagCount)],
                                    ['Structural warranty', _jsx(DateText, { value: project.warranty_structural_until })],
                                    ['General warranty', _jsx(DateText, { value: project.warranty_general_until })],
                                ] }), project.hold_reason ? _jsxs(Alert, { tone: "warn", children: ["On hold: ", project.hold_reason] }) : null] }), perms.has(PERMISSIONS.PROJECTS_MANAGE) ? (_jsx(Panel, { title: "Change status", children: _jsxs("form", { class: "ncc-stack", method: "post", action: `/app/projects/${projectId}/status`, children: [_jsx("input", { type: "hidden", name: "nc_csrf", value: csrf }), _jsx(FormField, { label: "New status", name: "status", required: true, hint: `From ${project.status.replace(/_/g, ' ')} you can move to: ${svc.ALLOWED_TRANSITIONS[project.status]
                                        .map((s) => s.replace(/_/g, ' '))
                                        .join(', ') || 'nothing further'}.`, options: svc.ALLOWED_TRANSITIONS[project.status].map((s) => ({
                                        value: s,
                                        label: s.replace(/_/g, ' '),
                                    })) }), _jsx(FormField, { label: "Reason", name: "reason", rows: 2, hint: "Required for a hold." }), _jsx("button", { class: "ncc-btn ncc-btn-primary", type: "submit", disabled: stages.length === 0 && false, children: "Update status" })] }) })) : null] }));
        }
        case 'stages': {
            const stages = await q.projectStages(db, projectId);
            const canUpdate = perms.has(PERMISSIONS.PROJECTS_UPDATE_PROGRESS);
            const columns = [
                { header: '#', cell: (r) => String(r.seq), numeric: true },
                {
                    header: 'Stage',
                    cell: (r) => (_jsxs(_Fragment, { children: [_jsx("strong", { children: r.name }), r.predecessor_name ? _jsxs("div", { class: "ncc-muted", children: ["after ", r.predecessor_name] }) : null, Number(r.requires_quality_check) === 1 ? (_jsx("div", { class: "ncc-badge ncc-badge-warn", children: "quality gate" })) : null] })),
                },
                { header: 'Weight', cell: (r) => `${Number(r.weightage_pct)}%`, numeric: true },
                { header: 'Progress', cell: (r) => _jsx(Progress, { pct: Number(r.progress_pct) }) },
                { header: 'Status', cell: (r) => _jsx(StatusBadge, { status: r.status }) },
                { header: 'Planned end', cell: (r) => _jsx(DateText, { value: r.planned_end }) },
                {
                    header: 'Update',
                    cell: (r) => canUpdate ? (_jsxs("form", { class: "ncc-row", method: "post", action: `/app/projects/${projectId}/stages/${r.id}/progress`, children: [_jsx("input", { type: "hidden", name: "nc_csrf", value: csrf }), _jsx("input", { name: "progressPct", type: "number", min: "0", max: "100", step: "0.01", value: String(Number(r.progress_pct)), style: "width:5.5rem" }), _jsx("input", { name: "override", type: "text", placeholder: "Override reason", style: "width:11rem" }), _jsx("button", { class: "ncc-btn", type: "submit", children: "Save" })] })) : (_jsx("span", { class: "ncc-muted", children: "-" })),
                },
            ];
            return (_jsxs(Panel, { title: "Stages", children: [_jsx("p", { class: "ncc-hint", children: "Project progress is the weighted sum of these rows and cannot be typed directly. A stage will not start while its predecessor is incomplete unless an override reason is given." }), _jsx(DataTable, { columns: columns, rows: stages, empty: "This project has no stages. It was created without a template." })] }));
        }
        case 'dpr': {
            const [dprs, stoppages] = await Promise.all([q.projectDprs(db, projectId), q.stoppageSummary(db, projectId)]);
            const columns = [
                { header: 'Date', cell: (r) => _jsx(DateText, { value: r.report_date }) },
                { header: 'Weather', cell: (r) => r.weather.replace(/_/g, ' ') },
                {
                    header: 'Stopped',
                    numeric: true,
                    cell: (r) => Number(r.work_stopped_hours) > 0 ? (_jsxs(_Fragment, { children: [Number(r.work_stopped_hours), " h", _jsx("div", { class: "ncc-muted", children: r.stoppage_reason.replace(/_/g, ' ') })] })) : (_jsx("span", { class: "ncc-muted", children: "-" })),
                },
                {
                    header: 'Labour',
                    numeric: true,
                    cell: (r) => `${Number(r.labour_skilled)} + ${Number(r.labour_unskilled)}`,
                },
                { header: 'Work done', cell: (r) => _jsx("span", { children: r.work_done }) },
                { header: 'Filed by', cell: (r) => r.submitted_by_name ?? '-' },
                {
                    header: 'Review',
                    cell: (r) => r.reviewed_at ? (_jsx("span", { class: "ncc-badge ncc-badge-ok", children: "reviewed" })) : perms.has(PERMISSIONS.PROJECTS_MANAGE) ? (_jsxs("form", { method: "post", action: `/app/projects/${projectId}/dprs/${r.id}/review`, children: [_jsx("input", { type: "hidden", name: "nc_csrf", value: csrf }), _jsx("button", { class: "ncc-btn", type: "submit", children: "Mark reviewed" })] })) : (_jsx("span", { class: "ncc-muted", children: "pending" })),
                },
            ];
            return (_jsxs("div", { class: "ncc-stack", children: [stoppages.length > 0 ? (_jsxs(Panel, { title: "Stoppage summary", children: [_jsx("p", { class: "ncc-hint", children: "This is the record a delay notice reads. Monsoon delay is the most common schedule dispute and a dated trail is the only defence against a liquidated damages claim." }), _jsx(DataTable, { columns: [
                                    { header: 'Reason', cell: (r) => String(r.reason).replace(/_/g, ' ') },
                                    { header: 'Days', cell: (r) => String(Number(r.days)), numeric: true },
                                    { header: 'Hours lost', cell: (r) => String(Number(r.hours)), numeric: true },
                                ], rows: stoppages })] })) : null, _jsx(Panel, { title: "Daily progress reports", actions: perms.has(PERMISSIONS.PROJECTS_DPR_SUBMIT) ? (_jsx("a", { class: "ncc-btn ncc-btn-primary", href: `/app/projects/${projectId}/dpr/new`, children: "File today" })) : null, children: _jsx(DataTable, { columns: columns, rows: dprs, empty: "No daily reports filed yet." }) })] }));
        }
        case 'quality': {
            const [checks, stages] = await Promise.all([
                q.projectQualityChecks(db, projectId),
                q.projectStages(db, projectId),
            ]);
            const columns = [
                { header: 'Check', cell: (r) => r.check_type.replace(/_/g, ' ') },
                { header: 'Stage', cell: (r) => r.stage_name ?? _jsx("span", { class: "ncc-muted", children: "Project level" }) },
                { header: 'Tested', cell: (r) => _jsx(DateText, { value: r.tested_on }) },
                {
                    header: 'Target vs actual',
                    numeric: true,
                    cell: (r) => r.actual_value === null && r.target_value === null ? (_jsx("span", { class: "ncc-muted", children: "-" })) : (`${r.target_value === null ? '-' : Number(r.target_value)} / ${r.actual_value === null ? '-' : Number(r.actual_value)} ${r.unit ?? ''}`),
                },
                { header: 'Result', cell: (r) => _jsx(StatusBadge, { status: r.result === 'pass' ? 'passed' : r.result === 'fail' ? 'failed' : r.result }) },
                { header: 'Lab', cell: (r) => r.lab_name ?? '-' },
                {
                    header: 'Sign off',
                    cell: (r) => r.signed_off_by_name ? (_jsx("span", { children: r.signed_off_by_name })) : perms.has(PERMISSIONS.PROJECTS_QUALITY_SIGNOFF) ? (_jsxs("form", { method: "post", action: `/app/projects/${projectId}/quality-checks/${r.id}/signoff`, children: [_jsx("input", { type: "hidden", name: "nc_csrf", value: csrf }), _jsx("button", { class: "ncc-btn", type: "submit", children: "Sign off" })] })) : (_jsx("span", { class: "ncc-muted", children: "unsigned" })),
                },
            ];
            return (_jsxs("div", { class: "ncc-stack", children: [_jsx(Panel, { title: "Quality checks", children: _jsx(DataTable, { columns: columns, rows: checks, empty: "No quality checks recorded. Milestones on quality-gated stages cannot be certified until one exists." }) }), perms.has(PERMISSIONS.PROJECTS_DPR_SUBMIT) ? (_jsx(Panel, { title: "Record a check", children: _jsxs("form", { class: "ncc-stack", method: "post", action: `/app/projects/${projectId}/quality-checks`, children: [_jsx("input", { type: "hidden", name: "nc_csrf", value: csrf }), _jsx(FormField, { label: "Stage", name: "projectStageId", options: [
                                        { value: '', label: 'Project level' },
                                        ...stages.map((s) => ({ value: String(s.id), label: `${s.seq}. ${s.name}` })),
                                    ] }), _jsx(FormField, { label: "Check type", name: "checkType", required: true, options: [
                                        'concrete_slump',
                                        'cube_test_7day',
                                        'cube_test_28day',
                                        'steel_test',
                                        'plumb_level',
                                        'waterproofing_ponding',
                                        'electrical_insulation',
                                        'plumbing_pressure',
                                        'soil_compaction',
                                        'other',
                                    ].map((t) => ({ value: t, label: t.replace(/_/g, ' ') })) }), _jsx(FormField, { label: "Lab report number", name: "referenceNo" }), _jsx(FormField, { label: "Sample taken on", name: "sampleTakenOn", type: "date" }), _jsx(FormField, { label: "Tested on", name: "testedOn", type: "date" }), _jsx(FormField, { label: "Target value", name: "targetValue", type: "number", step: "0.01" }), _jsx(FormField, { label: "Actual value", name: "actualValue", type: "number", step: "0.01" }), _jsx(FormField, { label: "Unit", name: "unit", placeholder: "mm or N/mm2" }), _jsx(FormField, { label: "Result", name: "result", required: true, options: ['pending', 'pass', 'fail', 'retest'].map((r) => ({ value: r, label: r })) }), _jsx(FormField, { label: "Lab name", name: "labName" }), _jsx("button", { class: "ncc-btn ncc-btn-primary", type: "submit", children: "Record check" })] }) })) : null] }));
        }
        case 'milestones': {
            const milestones = await q.projectMilestones(db, projectId, cost);
            const columns = [
                { header: '#', cell: (r) => String(r.seq), numeric: true },
                { header: 'Milestone', cell: (r) => _jsx("strong", { children: r.name }) },
                { header: 'Trigger stage', cell: (r) => r.trigger_stage ?? _jsx("span", { class: "ncc-muted", children: "None" }) },
                {
                    header: 'Stage progress',
                    cell: (r) => r.trigger_stage_progress === null || r.trigger_stage_progress === undefined ? (_jsx("span", { class: "ncc-muted", children: "-" })) : (_jsx(Progress, { pct: Number(r.trigger_stage_progress) })),
                },
                { header: 'Percent', cell: (r) => (r.percent_of_contract === null ? '-' : `${Number(r.percent_of_contract)}%`), numeric: true },
                {
                    header: 'Amount',
                    numeric: true,
                    cell: (r) => _jsx(Money, { paise: 'amount_paise' in r ? r.amount_paise : null, hidden: !cost }),
                },
                { header: 'Due', cell: (r) => _jsx(DateText, { value: r.due_date }) },
                { header: 'Status', cell: (r) => _jsx(StatusBadge, { status: r.status }) },
                {
                    header: 'Certify',
                    cell: (r) => r.status === 'pending' || r.status === 'ready_to_certify' ? (perms.has(PERMISSIONS.PROJECTS_MILESTONE_CERTIFY) ? (_jsxs("form", { method: "post", action: `/app/projects/${projectId}/milestones/${r.id}/certify`, children: [_jsx("input", { type: "hidden", name: "nc_csrf", value: csrf }), _jsx("button", { class: "ncc-btn", type: "submit", children: "Certify" })] })) : (_jsx("span", { class: "ncc-muted", children: "-" }))) : (_jsx(DateText, { value: r.certified_on })),
                },
            ];
            return (_jsxs(Panel, { title: "Payment milestones", children: [_jsx("p", { class: "ncc-hint", children: "Certification requires the trigger stage complete and its quality checks passed, including the 28 day cube test. That chain is what makes an invoice defensible." }), _jsx(DataTable, { columns: columns, rows: milestones, empty: "No payment milestones defined for this project." })] }));
        }
        case 'snags': {
            const [snags, users] = await Promise.all([q.projectSnags(db, projectId), q.assignableUsers(db)]);
            const canManage = perms.has(PERMISSIONS.PROJECTS_SNAG_MANAGE);
            const columns = [
                { header: 'Location', cell: (r) => _jsx("strong", { children: r.location }) },
                { header: 'Trade', cell: (r) => r.trade },
                { header: 'Defect', cell: (r) => r.description },
                { header: 'Severity', cell: (r) => _jsx(StatusBadge, { status: r.severity === 'structural' || r.severity === 'safety' ? 'overdue' : 'open', tone: r.severity === 'structural' || r.severity === 'safety' ? 'danger' : 'warn' }) },
                { header: 'Assigned', cell: (r) => r.assigned_to_name ?? _jsx("span", { class: "ncc-muted", children: "Unassigned" }) },
                { header: 'Target', cell: (r) => _jsx(DateText, { value: r.target_date }) },
                { header: 'Status', cell: (r) => _jsx(StatusBadge, { status: r.status }) },
                {
                    header: 'Move to',
                    cell: (r) => {
                        const allowed = svc.SNAG_TRANSITIONS[r.status] ?? [];
                        if (!canManage || allowed.length === 0)
                            return _jsx("span", { class: "ncc-muted", children: "-" });
                        return (_jsxs("form", { class: "ncc-row", method: "post", action: `/app/projects/${projectId}/snags/${r.id}/status`, children: [_jsx("input", { type: "hidden", name: "nc_csrf", value: csrf }), _jsx("select", { name: "status", children: allowed.map((s) => (_jsx("option", { value: s, children: s.replace(/_/g, ' ') }))) }), _jsx("button", { class: "ncc-btn", type: "submit", children: "Go" })] }));
                    },
                },
            ];
            return (_jsxs("div", { class: "ncc-stack", children: [_jsxs(Panel, { title: "Snag list", children: [_jsx("p", { class: "ncc-hint", children: "Handover is refused while a structural or safety snag is open, because that would transfer a live hazard to the client." }), _jsx(DataTable, { columns: columns, rows: snags, empty: "No defects recorded." })] }), canManage ? (_jsx(Panel, { title: "Raise a snag", children: _jsxs("form", { class: "ncc-stack", method: "post", action: `/app/projects/${projectId}/snags`, children: [_jsx("input", { type: "hidden", name: "nc_csrf", value: csrf }), _jsx(FormField, { label: "Location", name: "location", required: true, placeholder: "First floor, master bedroom" }), _jsx(FormField, { label: "Trade", name: "trade", required: true, options: ['civil', 'plaster', 'painting', 'electrical', 'plumbing', 'carpentry', 'flooring', 'waterproofing', 'fabrication', 'other'].map((t) => ({ value: t, label: t })) }), _jsx(FormField, { label: "Description", name: "description", required: true, rows: 2 }), _jsx(FormField, { label: "Severity", name: "severity", required: true, options: ['cosmetic', 'functional', 'structural', 'safety'].map((s) => ({ value: s, label: s })) }), _jsx(FormField, { label: "Raised by", name: "raisedSource", required: true, options: ['internal', 'client', 'consultant'].map((s) => ({ value: s, label: s })) }), _jsx(FormField, { label: "Assign to", name: "assignedTo", options: [{ value: '', label: 'Unassigned' }, ...users.map((u) => ({ value: String(u.id), label: u.full_name }))] }), _jsx(FormField, { label: "Target date", name: "targetDate", type: "date" }), _jsx("button", { class: "ncc-btn ncc-btn-primary", type: "submit", children: "Raise snag" })] }) })) : null] }));
        }
        case 'approvals': {
            const [approvals, stages] = await Promise.all([
                q.projectApprovals(db, projectId, cost),
                q.projectStages(db, projectId),
            ]);
            const columns = [
                { header: 'Authority', cell: (r) => _jsx("strong", { children: r.authority }) },
                { header: 'Approval', cell: (r) => r.approval_type },
                { header: 'Reference', cell: (r) => r.reference_no ?? '-' },
                { header: 'Applied', cell: (r) => _jsx(DateText, { value: r.applied_on }) },
                { header: 'Received', cell: (r) => _jsx(DateText, { value: r.received_on }) },
                {
                    header: 'Valid until',
                    cell: (r) => (_jsxs(_Fragment, { children: [_jsx(DateText, { value: r.valid_until }), r.valid_until && r.valid_until < today() ? _jsx("div", { class: "ncc-badge ncc-badge-danger", children: "expired" }) : null] })),
                },
                { header: 'Fee', numeric: true, cell: (r) => _jsx(Money, { paise: 'fee_paise' in r ? r.fee_paise : null, hidden: !cost }) },
                { header: 'Status', cell: (r) => _jsx(StatusBadge, { status: r.status }) },
                { header: 'Blocks', cell: (r) => r.blocks_stage ?? '-' },
            ];
            return (_jsxs("div", { class: "ncc-stack", children: [_jsx(Panel, { title: "Statutory approvals", children: _jsx(DataTable, { columns: columns, rows: approvals, empty: "No approvals recorded." }) }), perms.has(PERMISSIONS.PROJECTS_MANAGE) ? (_jsx(Panel, { title: "Add an approval", children: _jsxs("form", { class: "ncc-stack", method: "post", action: `/app/projects/${projectId}/approvals`, children: [_jsx("input", { type: "hidden", name: "nc_csrf", value: csrf }), _jsx(FormField, { label: "Authority", name: "authority", required: true, options: ['BBMP', 'BMRDA', 'BDA', 'Gram Panchayat', 'TUDA', 'KIADB', 'BESCOM', 'BWSSB', 'KSPCB', 'Fire', 'Lift Inspectorate', 'Other'].map((a) => ({ value: a, label: a })) }), _jsx(FormField, { label: "Approval type", name: "approvalType", required: true, placeholder: "Plan sanction" }), _jsx(FormField, { label: "Reference number", name: "referenceNo" }), _jsx(FormField, { label: "Applied on", name: "appliedOn", type: "date" }), _jsx(FormField, { label: "Received on", name: "receivedOn", type: "date" }), _jsx(FormField, { label: "Valid until", name: "validUntil", type: "date" }), _jsx(FormField, { label: "Fee (rupees)", name: "feePaise", type: "number", step: "0.01" }), _jsx(FormField, { label: "Status", name: "status", required: true, options: ['not_started', 'applied', 'queried', 'received', 'rejected', 'expired'].map((s) => ({
                                        value: s,
                                        label: s.replace(/_/g, ' '),
                                    })) }), _jsx(FormField, { label: "Blocks stage", name: "blocksStageId", options: [{ value: '', label: 'None' }, ...stages.map((s) => ({ value: String(s.id), label: s.name }))] }), _jsx("button", { class: "ncc-btn ncc-btn-primary", type: "submit", children: "Add approval" })] }) })) : null] }));
        }
        case 'materials': {
            const materials = await q.projectMaterials(db, projectId, cost);
            const columns = [
                {
                    header: 'Item',
                    cell: (r) => (_jsxs(_Fragment, { children: [_jsx("strong", { children: r.item_name }), _jsx("div", { class: "ncc-muted", children: r.item_code })] })),
                },
                { header: 'Issued', numeric: true, cell: (r) => _jsx(Qty, { value: Number(r.qty_issued), unit: r.unit }) },
                { header: 'Returned', numeric: true, cell: (r) => _jsx(Qty, { value: Number(r.qty_returned), unit: r.unit }) },
                {
                    header: 'Net consumed',
                    numeric: true,
                    cell: (r) => _jsx(Qty, { value: Number(r.qty_issued) - Number(r.qty_returned), unit: r.unit }),
                },
                {
                    header: 'Value',
                    numeric: true,
                    cell: (r) => _jsx(Money, { paise: 'value_paise' in r ? Number(r.value_paise ?? 0) : null, hidden: !cost, compact: true }),
                },
            ];
            return (_jsx(Panel, { title: "Material issued to this site", children: _jsx(DataTable, { columns: columns, rows: materials, empty: "No material issued to this project yet." }) }));
        }
        case 'cost': {
            const data = await q.projectBudgetVsActual(db, projectId);
            const columns = [
                { header: 'Cost head', cell: (r) => _jsx("strong", { children: r.cost_head }) },
                { header: 'Description', cell: (r) => r.description ?? '-' },
                { header: 'Budget', numeric: true, cell: (r) => _jsx(Money, { paise: Number(r.amount_paise), compact: true }) },
                { header: 'Actual', numeric: true, cell: (r) => _jsx(Money, { paise: Number(r.spent), compact: true }) },
                {
                    header: 'Variance',
                    numeric: true,
                    cell: (r) => {
                        const v = Number(r.amount_paise) - Number(r.spent);
                        return (_jsx("span", { class: v < 0 ? 'ncc-badge ncc-badge-danger' : undefined, children: _jsx(Money, { paise: v, compact: true }) }));
                    },
                },
            ];
            return (_jsxs("div", { class: "ncc-stack", children: [data.budget ? (_jsx(Panel, { title: `Approved budget version ${data.budget.version}`, children: _jsx(DefinitionList, { rows: [
                                ['Type', String(data.budget.budget_type).replace(/_/g, ' ')],
                                ['Total', _jsx(Money, { paise: Number(data.budget.total_paise) })],
                                ['Contingency', `${Number(data.budget.contingency_pct)}%`],
                                ['Approved', _jsx(DateText, { value: data.budget.approved_at, withTime: true })],
                            ] }) })) : (_jsx(Alert, { tone: "warn", children: "This project has no approved budget, so overrun blocking on expense approval has nothing to check against. Set one under Money, Budgets." })), _jsxs(Panel, { title: "Budget against actual by cost head", children: [_jsx(DataTable, { columns: columns, rows: data.lines, empty: "No budget lines." }), data.uncategorised > 0 ? (_jsxs(Alert, { tone: "warn", children: [_jsx(Money, { paise: data.uncategorised }), " of spend sits on cost heads with no budget line. Either the budget is incomplete or the expense was coded to the wrong head."] })) : null] })] }));
        }
        case 'documents': {
            const docs = await q.projectDocuments(db, projectId);
            const columns = [
                { header: 'Type', cell: (r) => r.doc_type },
                { header: 'Title', cell: (r) => _jsx("strong", { children: r.title }) },
                { header: 'Revision', cell: (r) => r.revision ?? '-' },
                { header: 'Current', cell: (r) => (Number(r.is_current) === 1 ? _jsx("span", { class: "ncc-badge ncc-badge-ok", children: "current" }) : _jsx("span", { class: "ncc-muted", children: "superseded" })) },
                { header: 'File', cell: (r) => (r.original_name ? _jsx("a", { href: `/api/files/${r.id}`, children: r.original_name }) : '-') },
                { header: 'Added', cell: (r) => _jsx(DateText, { value: r.created_at, withTime: true }) },
            ];
            return (_jsxs(Panel, { title: "Documents", children: [_jsx("p", { class: "ncc-hint", children: "A superseded revision is kept, not deleted. When a wall is built to the wrong revision the only useful question is which revision was on site." }), _jsx(DataTable, { columns: columns, rows: docs, empty: "No documents uploaded." })] }));
        }
        case 'team': {
            const [team, users] = await Promise.all([q.projectAssignments(db, projectId), q.assignableUsers(db)]);
            const columns = [
                {
                    header: 'Person',
                    cell: (r) => (_jsxs(_Fragment, { children: [_jsx("strong", { children: r.full_name }), _jsx("div", { class: "ncc-muted", children: r.email })] })),
                },
                { header: 'Role on project', cell: (r) => r.assignment_role },
                { header: 'From', cell: (r) => _jsx(DateText, { value: r.from_date }) },
                { header: 'To', cell: (r) => _jsx(DateText, { value: r.to_date }) },
            ];
            return (_jsxs("div", { class: "ncc-stack", children: [_jsxs(Panel, { title: "Project team", children: [_jsx("p", { class: "ncc-hint", children: "This list is what row-level scoping reads. Removing someone here removes their access to the project." }), _jsx(DataTable, { columns: columns, rows: team, empty: "Nobody assigned. Only unscoped roles can see this project." })] }), perms.has(PERMISSIONS.PROJECTS_ASSIGN_STAFF) ? (_jsx(Panel, { title: "Replace the team", children: _jsxs("form", { class: "ncc-stack", method: "post", action: `/app/projects/${projectId}/team`, children: [_jsx("input", { type: "hidden", name: "nc_csrf", value: csrf }), _jsx("p", { class: "ncc-hint", children: "Tick everyone who should have access and choose their role. Submitting replaces the whole list, so a person left unticked loses access." }), users.map((u) => {
                                    const existing = team.find((t) => Number(t.user_id) === u.id);
                                    return (_jsxs("div", { class: "ncc-row", children: [_jsxs("label", { children: [_jsx("input", { type: "checkbox", name: "userIds", value: String(u.id), checked: Boolean(existing) }), " ", u.full_name] }), _jsx("select", { name: `role_${u.id}`, children: ['pm', 'supervisor', 'qs', 'accounts', 'observer'].map((r) => (_jsx("option", { value: r, selected: existing?.assignment_role === r, children: r }))) })] }));
                                }), _jsx("button", { class: "ncc-btn ncc-btn-primary", type: "submit", children: "Save team" })] }) })) : null] }));
        }
    }
}
/* Mutations -------------------------------------------------------------- */
projects.post('/app/projects/:projectId/status', requirePermission(PERMISSIONS.PROJECTS_MANAGE), requireProjectAccess(), async (c) => {
    const projectId = idParam(c);
    const parsed = projectStatusSchema.safeParse(await readBody(c));
    if (!parsed.success)
        return errRedirect(c, `/app/projects/${projectId}`, firstError(parsed.error));
    await svc.setProjectStatus(c.get('db'), actorOf(c), projectId, parsed.data.status, parsed.data.reason);
    return okRedirect(c, `/app/projects/${projectId}`, `Status set to ${parsed.data.status.replace(/_/g, ' ')}.`);
});
projects.post('/app/projects/:projectId/stages/:stageId/progress', requirePermission(PERMISSIONS.PROJECTS_UPDATE_PROGRESS), requireProjectAccess(), async (c) => {
    const projectId = idParam(c);
    const stageId = idParam(c, 'stageId');
    const parsed = stageProgressSchema.safeParse(await readBody(c));
    if (!parsed.success)
        return errRedirect(c, `/app/projects/${projectId}?tab=stages`, firstError(parsed.error));
    const result = await svc.setStageProgress(c.get('db'), actorOf(c), {
        projectId,
        stageId,
        progressPct: parsed.data.progressPct,
        override: parsed.data.override,
        canOverride: c.get('perms').has(PERMISSIONS.PROJECTS_MANAGE),
    });
    return okRedirect(c, `/app/projects/${projectId}?tab=stages`, `Stage set to ${result.stageProgress}%. Project now ${result.projectProgress}%.`);
});
projects.get('/app/projects/:projectId/dpr/new', requirePermission(PERMISSIONS.PROJECTS_DPR_SUBMIT), requireProjectAccess(), async (c) => {
    const db = c.get('db');
    const projectId = idParam(c);
    const project = await q.findProject(db, projectId, false);
    if (!project)
        throw new NotFoundError('Project not found');
    const stages = await q.projectStages(db, projectId);
    const csrf = c.get('session').csrfToken;
    const filed = await q.dprExists(db, projectId, today());
    /*
     * Deliberately a plain form post, single column, native date input.
     * A supervisor fills this standing on a slab on a phone with two bars of
     * signal, so it must work with no JavaScript at all.
     */
    return page(c, {
        title: 'Daily progress report',
        path: '/app/projects',
        subtitle: `${project.code}, ${formatDate(today())}`,
    }, _jsxs(_Fragment, { children: [banner(c), filed ? _jsx(Alert, { tone: "warn", children: "A report is already filed for today. Submitting again replaces it." }) : null, _jsxs("form", { class: "ncc-card ncc-stack", method: "post", action: `/app/projects/${projectId}/dpr`, children: [_jsx("input", { type: "hidden", name: "nc_csrf", value: csrf }), _jsx(FormField, { label: "Report date", name: "reportDate", type: "date", required: true, value: today(), max: today() }), _jsx(FormField, { label: "Weather", name: "weather", required: true, options: ['clear', 'cloudy', 'light_rain', 'heavy_rain', 'unworkable'].map((w) => ({
                            value: w,
                            label: w.replace(/_/g, ' '),
                        })) }), _jsx(FormField, { label: "Hours work was stopped", name: "workStoppedHours", type: "number", step: "0.5", min: "0", max: "24", value: "0" }), _jsx(FormField, { label: "Reason for stoppage", name: "stoppageReason", required: true, hint: "Rain hours are contractual. Record them even when the day was partly worked.", options: ['none', 'rain', 'material_shortage', 'labour_shortage', 'power_failure', 'client_instruction', 'statutory', 'equipment_breakdown', 'safety_incident'].map((r) => ({ value: r, label: r.replace(/_/g, ' ') })) }), _jsx(FormField, { label: "Skilled labour on site", name: "labourSkilled", type: "number", min: "0", value: "0" }), _jsx(FormField, { label: "Unskilled labour on site", name: "labourUnskilled", type: "number", min: "0", value: "0" }), _jsx(FormField, { label: "Work done today", name: "workDone", required: true, rows: 4 }), _jsx(FormField, { label: "Issues", name: "issues", rows: 2 }), _jsx(FormField, { label: "Instructions received", name: "instructionsReceived", rows: 2 }), stages.map((s) => (_jsx(FormField, { label: `${s.name} progress at end of day`, name: `stage_${s.id}`, type: "number", step: "0.01", min: String(Number(s.progress_pct)), max: "100", value: String(Number(s.progress_pct)), hint: `Currently ${Number(s.progress_pct)}%. Leave as is if it did not move.` }))), _jsx("button", { class: "ncc-btn ncc-btn-primary", type: "submit", children: "File report" })] })] }));
});
projects.post('/app/projects/:projectId/dpr', requirePermission(PERMISSIONS.PROJECTS_DPR_SUBMIT), requireProjectAccess(), async (c) => {
    const projectId = idParam(c);
    const body = await readBody(c);
    const parsed = dprSchema.safeParse(body);
    if (!parsed.success)
        return errRedirect(c, `/app/projects/${projectId}/dpr/new`, firstError(parsed.error));
    // Stage fields arrive as stage_<id>. Collected here rather than in the
    // schema because the field names are data driven.
    const stageProgress = [];
    for (const [key, value] of Object.entries(body)) {
        if (!key.startsWith('stage_'))
            continue;
        const stageId = Number(key.slice(6));
        const pct = Number(value);
        if (Number.isInteger(stageId) && stageId > 0 && Number.isFinite(pct)) {
            stageProgress.push({ stageId, pct });
        }
    }
    const result = await svc.submitDpr(c.get('db'), actorOf(c), projectId, { ...parsed.data, stageProgress });
    return okRedirect(c, `/app/projects/${projectId}?tab=dpr`, result.replaced ? 'Report for that date replaced.' : 'Report filed.');
});
projects.post('/app/projects/:projectId/dprs/:dprId/review', requirePermission(PERMISSIONS.PROJECTS_MANAGE), requireProjectAccess(), async (c) => {
    const projectId = idParam(c);
    await svc.reviewDpr(c.get('db'), actorOf(c), idParam(c, 'dprId'));
    return okRedirect(c, `/app/projects/${projectId}?tab=dpr`, 'Report marked reviewed.');
});
projects.post('/app/projects/:projectId/quality-checks', requirePermission(PERMISSIONS.PROJECTS_DPR_SUBMIT), requireProjectAccess(), async (c) => {
    const projectId = idParam(c);
    const parsed = qualityCheckSchema.safeParse(await readBody(c));
    if (!parsed.success)
        return errRedirect(c, `/app/projects/${projectId}?tab=quality`, firstError(parsed.error));
    await svc.createQualityCheck(c.get('db'), actorOf(c), projectId, parsed.data);
    return okRedirect(c, `/app/projects/${projectId}?tab=quality`, 'Quality check recorded.');
});
projects.post('/app/projects/:projectId/quality-checks/:checkId/signoff', requirePermission(PERMISSIONS.PROJECTS_QUALITY_SIGNOFF), requireProjectAccess(), async (c) => {
    const projectId = idParam(c);
    await svc.signOffQualityCheck(c.get('db'), actorOf(c), idParam(c, 'checkId'));
    return okRedirect(c, `/app/projects/${projectId}?tab=quality`, 'Check signed off.');
});
projects.post('/app/projects/:projectId/milestones/:msId/certify', requirePermission(PERMISSIONS.PROJECTS_MILESTONE_CERTIFY), requireProjectAccess(), async (c) => {
    const projectId = idParam(c);
    await svc.certifyMilestone(c.get('db'), actorOf(c), projectId, idParam(c, 'msId'));
    return okRedirect(c, `/app/projects/${projectId}?tab=milestones`, 'Milestone certified and ready to invoice.');
});
projects.post('/app/projects/:projectId/snags', requirePermission(PERMISSIONS.PROJECTS_SNAG_MANAGE), requireProjectAccess(), async (c) => {
    const projectId = idParam(c);
    const parsed = snagSchema.safeParse(await readBody(c));
    if (!parsed.success)
        return errRedirect(c, `/app/projects/${projectId}?tab=snags`, firstError(parsed.error));
    await svc.createSnag(c.get('db'), actorOf(c), projectId, parsed.data);
    return okRedirect(c, `/app/projects/${projectId}?tab=snags`, 'Snag raised.');
});
projects.post('/app/projects/:projectId/snags/:snagId/status', requirePermission(PERMISSIONS.PROJECTS_SNAG_MANAGE), requireProjectAccess(), async (c) => {
    const projectId = idParam(c);
    const parsed = snagStatusSchema.safeParse(await readBody(c));
    if (!parsed.success)
        return errRedirect(c, `/app/projects/${projectId}?tab=snags`, firstError(parsed.error));
    await svc.setSnagStatus(c.get('db'), actorOf(c), idParam(c, 'snagId'), parsed.data.status);
    return okRedirect(c, `/app/projects/${projectId}?tab=snags`, 'Snag updated.');
});
projects.post('/app/projects/:projectId/approvals', requirePermission(PERMISSIONS.PROJECTS_MANAGE), requireProjectAccess(), async (c) => {
    const projectId = idParam(c);
    const parsed = approvalSchema.safeParse(await readBody(c));
    if (!parsed.success)
        return errRedirect(c, `/app/projects/${projectId}?tab=approvals`, firstError(parsed.error));
    await svc.createApproval(c.get('db'), actorOf(c), projectId, parsed.data);
    return okRedirect(c, `/app/projects/${projectId}?tab=approvals`, 'Approval recorded.');
});
projects.post('/app/projects/:projectId/team', requirePermission(PERMISSIONS.PROJECTS_ASSIGN_STAFF), requireProjectAccess(), async (c) => {
    const projectId = idParam(c);
    const body = await readBody(c);
    const raw = body.userIds;
    const ids = (raw === undefined ? [] : Array.isArray(raw) ? raw : [raw])
        .map((v) => Number(v))
        .filter((n) => Number.isInteger(n) && n > 0);
    const members = ids.map((userId) => {
        const role = body[`role_${userId}`];
        return { userId, assignmentRole: typeof role === 'string' ? role : 'observer' };
    });
    await svc.replaceTeam(c.get('db'), actorOf(c), projectId, members);
    return okRedirect(c, `/app/projects/${projectId}?tab=team`, `Team set to ${members.length} member(s).`);
});
export default projects;
