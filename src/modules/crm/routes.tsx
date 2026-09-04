import { Hono } from 'hono'
import type { Context } from 'hono'
import { html } from 'hono/html'
import type { Child } from 'hono/jsx'
import type { AppEnv } from '../../types.js'
import type { Db } from '../../db/kysely.js'
import { currentUser, currentSession } from '../../types.js'
import { page, banner, okRedirect, errRedirect, pageParam, queryParam } from '../../dashboard/render.js'
import {
  Alert,
  ApprovalBar,
  CsrfInput,
  DataTable,
  DateText,
  DefinitionList,
  FormField,
  KpiCard,
  Money,
  Pager,
  Panel,
  Progress,
  Qty,
  StatusBadge,
  Timeline,
  type Column,
} from '../../dashboard/components/index.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { PERMISSIONS } from '../../lib/permissions.js'
import { readBody } from '../../middleware/csrf.js'
import { NotFoundError, isAppError } from '../../lib/errors.js'
import { formatRupees, paiseToRupees } from '../../lib/money.js'
import { addDays, financialYear, financialYearBounds, formatDate, nowSqlDateTime, today } from '../../lib/dates.js'
import { getSetting } from '../../lib/settings.js'
import * as q from './queries.js'
import * as svc from './service.js'
import {
  ACTIVITY_OUTCOMES,
  ACTIVITY_TYPES,
  ENQUIRY_TYPES,
  EXPECTED_STARTS,
  FEASIBILITIES,
  FUNDING_MODES,
  JURISDICTIONS,
  LOST_REASONS,
  PLOT_OWNERSHIPS,
  POSTABLE_STAGES,
  PRICING_BASES,
  QUOTE_LINE_TYPES,
  QUOTE_STATUSES,
  ROAD_ACCESS,
  VISIT_STATUSES,
  WATER_AVAILABILITY,
  activitySchema,
  assignSchema,
  convertOverridesSchema,
  firstError,
  leadFromEnquirySchema,
  leadSchema,
  loseSchema,
  noteSchema,
  probabilitySchema,
  quoteSchema,
  reasonSchema,
  stageSchema,
  visitCompleteSchema,
  visitScheduleSchema,
  visitStatusSchema,
} from './schemas.js'

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

const crm = new Hono<AppEnv>()

type Ctx = Context<AppEnv>

/** StatusBadge's tone union, which components/index.tsx does not export. */
type Tone = 'muted' | 'ok' | 'warn' | 'danger'

function actorOf(c: Ctx): svc.Actor {
  return { userId: currentUser(c).id, ip: c.get('clientIp') }
}

function can(c: Ctx, key: string): boolean {
  return c.get('perms').has(key)
}

/**
 * Who this caller may see.
 *
 * Derived from crm.lead_assign, for the reason set out at the top of
 * queries.ts: that is the grant the seeded roles actually differ on, so a new
 * role gets the visibility its permissions imply with no list to maintain here.
 */
function scopeOf(c: Ctx): q.LeadScope {
  return { all: can(c, PERMISSIONS.CRM_LEAD_ASSIGN), userId: currentUser(c).id }
}

/** Forecast visibility (spec 6.7: pipeline value behind crm.view_pipeline_value). */
function canValue(c: Ctx): boolean {
  return can(c, PERMISSIONS.CRM_VIEW_PIPELINE_VALUE)
}

function idParam(c: Ctx, name: string): number {
  const n = Number(c.req.param(name))
  if (!Number.isInteger(n) || n < 1) throw new NotFoundError('Not found')
  return n
}

const PAGE_SIZE = 25

const QUOTE_READ = [PERMISSIONS.CRM_QUOTE_CREATE, PERMISSIONS.CRM_QUOTE_APPROVE] as const
const QUOTE_APPROVE = [PERMISSIONS.CRM_QUOTE_APPROVE, PERMISSIONS.CRM_QUOTE_DISCOUNT_OVERRIDE] as const

/**
 * Runs a write and reports the outcome as a flash on the page the form came
 * from. Departure 3 above is the whole reason it exists.
 *
 * Anything that is not an AppError is rethrown untouched, so a programming
 * mistake still becomes a logged 500 rather than a friendly banner over a
 * broken transaction.
 */
async function guard(
  c: Ctx,
  back: string,
  run: () => Promise<string | { to: string; message: string }>
) {
  try {
    const out = await run()
    if (typeof out === 'string') return okRedirect(c, back, out)
    return okRedirect(c, out.to, out.message)
  } catch (err) {
    if (!isAppError(err)) throw err
    return errRedirect(c, back, err.message)
  }
}

/** Every lead route answers 404, not 403, for a lead outside the caller's scope. */
async function requireVisibleLead(c: Ctx, leadId: number): Promise<void> {
  const visible = await q.leadVisible(c.get('db'), scopeOf(c), leadId)
  if (!visible) throw new NotFoundError('That lead does not exist.')
}

function selectOptions(
  rows: readonly { id: number; code?: string | null; name: string }[],
  selected?: number | null,
  blank = 'Choose one'
): Array<{ value: string; label: string; selected?: boolean }> {
  return [
    { value: '', label: blank },
    ...rows.map((r) => ({
      value: String(r.id),
      label: r.code ? `${r.code} - ${r.name}` : r.name,
      selected: selected === r.id,
    })),
  ]
}

function userOptions(
  rows: readonly { id: number; full_name: string }[],
  selected?: number | null,
  blank = 'Unassigned'
): Array<{ value: string; label: string; selected?: boolean }> {
  return [
    { value: '', label: blank },
    ...rows.map((r) => ({ value: String(r.id), label: r.full_name, selected: selected === r.id })),
  ]
}

function enumOptions(values: readonly string[], selected?: string | null, blank?: string) {
  const opts = values.map((v) => ({ value: v, label: v.replace(/_/g, ' '), selected: selected === v }))
  return blank ? [{ value: '', label: blank }, ...opts] : opts
}

/**
 * The three-valued qualifier select.
 *
 * "Nobody has asked yet" is a different sales position from "no", which is why
 * the columns are TINYINT(1) NULL and why yesNoNull exists in schemas.ts. A
 * two-option select here would quietly answer the question on the lead's behalf.
 */
const YES_NO_NULL = (selected: number | null) => [
  { value: '', label: 'Not asked', selected: selected === null },
  { value: '1', label: 'Yes', selected: selected === 1 },
  { value: '0', label: 'No', selected: selected === 0 },
]

/** Paise columns the queries only select when the caller holds view_pipeline_value. */
function paiseOf(row: object, key: 'expected_value_paise'): number | null {
  const v = (row as Record<string, unknown>)[key]
  return v === null || v === undefined ? null : Number(v)
}

function pctOf(row: object, key: 'probability_pct'): number | null {
  const v = (row as Record<string, unknown>)[key]
  return v === null || v === undefined ? null : Number(v)
}

const TEMPERATURE_TONE: Record<string, Tone> = { hot: 'danger', warm: 'warn', cold: 'muted' }

/**
 * Stage colour. Not in components/index.tsx's TONES, and deliberately not added
 * to it: thirteen lead stages are a CRM vocabulary, not an app-wide one, and
 * "new" or "qualified" would collide with other modules' meanings.
 */
const STAGE_TONE: Record<string, Tone> = {
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
}

const QUOTE_TONE: Record<string, Tone> = {
  draft: 'muted',
  pending_approval: 'warn',
  approved: 'ok',
  sent: 'warn',
  viewed: 'warn',
  accepted: 'ok',
  rejected: 'danger',
  expired: 'danger',
  superseded: 'muted',
}

const VISIT_TONE: Record<string, Tone> = {
  scheduled: 'warn',
  completed: 'ok',
  client_no_show: 'danger',
  rescheduled: 'warn',
  cancelled: 'danger',
}

const FEASIBILITY_TONE: Record<string, Tone> = {
  feasible: 'ok',
  feasible_with_conditions: 'warn',
  not_feasible: 'danger',
}

/** datetime-local wants YYYY-MM-DDTHH:MM; MariaDB hands back a space. */
function dtLocal(value: string | null | undefined): string {
  if (!value) return ''
  return String(value).replace(' ', 'T').slice(0, 16)
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
  const db = c.get('db')
  const scope = scopeOf(c)
  const value = canValue(c)
  const csrf = currentSession(c).csrfToken
  const manage = can(c, PERMISSIONS.CRM_LEAD_MANAGE)

  const [cards, totals, kpis] = await Promise.all([
    q.boardCards(db, scope, { canViewValue: value }),
    q.pipelineTotals(db, scope),
    q.crmKpis(db, scope, { canViewValue: value }),
  ])

  const byStage = new Map<string, q.BoardCard[]>()
  for (const stage of q.OPEN_STAGES) byStage.set(stage, [])
  for (const card of cards) byStage.get(card.stage)?.push(card)
  const totalByStage = new Map(totals.map((t) => [t.stage, t]))

  return page(
    c,
    {
      title: 'Pipeline',
      path: '/app/crm',
      subtitle: scope.all ? 'Every open lead' : 'Your leads and the unassigned pool',
      actions: (
        <>
          <a class="ncc-btn" href="/app/crm/leads">
            Table view
          </a>
          {manage ? (
            <a class="ncc-btn ncc-btn-primary" href="/app/crm/leads/new">
              New lead
            </a>
          ) : null}
        </>
      ),
    },
    <>
      {banner(c)}
      <div class="ncc-grid ncc-grid--kpi">
        <KpiCard label="Open leads" value={String(kpis.openLeads)} hint={`${q.DORMANT_DAYS}-day dormancy applied`} />
        <KpiCard
          label="Weighted pipeline"
          value={<Money paise={kpis.weightedPaise} compact hidden={!value} />}
          hint="Expected value times probability"
        />
        <KpiCard
          label="Follow-ups due"
          value={String(kpis.followupsDue)}
          hint="Next action today or overdue"
          href="/app/crm/leads?due=1"
        />
        <KpiCard
          label="Unassigned"
          value={String(kpis.unassigned)}
          hint="The pool everyone can see"
          href="/app/crm/leads?unassigned=1"
        />
        <KpiCard label="Visits upcoming" value={String(kpis.visitsUpcoming)} hint="Scheduled from today" href="/app/crm/visits?status=scheduled" />
        <KpiCard
          label="Quotes to approve"
          value={String(kpis.quotesPending)}
          hint="Discount above the limit"
          href="/app/crm/quotes?status=pending_approval"
        />
      </div>

      <div style="overflow-x:auto">
        <div class="ncc-row" style="align-items:flex-start;gap:.75rem;padding-bottom:.5rem">
          {q.OPEN_STAGES.map((stage, i) => {
            const column = byStage.get(stage) ?? []
            const totalsRow = totalByStage.get(stage)
            const nextStage = q.OPEN_STAGES[i + 1] ?? null
            return (
              <section class="ncc-card" style="min-width:15rem;flex:1 0 15rem">
                <h3 style="margin:0 0 .2rem;font-size:.95rem">{stage.replace(/_/g, ' ')}</h3>
                <p class="ncc-hint" style="margin:0 0 .6rem">
                  {Number(totalsRow?.n ?? 0)} lead{Number(totalsRow?.n ?? 0) === 1 ? '' : 's'}
                  {value ? ' - ' : ''}
                  {value ? <Money paise={Number(totalsRow?.weighted_paise ?? 0)} compact /> : null}
                  {value ? ' weighted' : ''}
                </p>
                {column.length === 0 ? <p class="ncc-muted">Empty.</p> : null}
                {column.map((card) => (
                  <article class="ncc-stack" style="border-top:1px solid var(--ncc-border);padding:.5rem 0;gap:.25rem">
                    <a href={`/app/crm/leads/${card.id}`}>
                      <strong>{card.contact_name}</strong>
                    </a>
                    <div class="ncc-hint">
                      {card.lead_no}
                      {card.site_locality ? ` - ${card.site_locality}` : ''}
                    </div>
                    <div class="ncc-row" style="gap:.35rem;flex-wrap:wrap">
                      <StatusBadge status={card.temperature} tone={TEMPERATURE_TONE[card.temperature] ?? 'muted'} />
                      <span class="ncc-hint">score {Number(card.score)}</span>
                      {value ? <Money paise={paiseOf(card, 'expected_value_paise')} compact /> : null}
                    </div>
                    <div class="ncc-hint">
                      {card.assignee_name ?? 'Unassigned'}
                      {card.next_action_date ? ` - due ${formatDate(card.next_action_date)}` : ''}
                    </div>
                    {manage && nextStage ? (
                      <form method="post" action={`/api/crm/leads/${card.id}/stage`}>
                        <CsrfInput token={csrf} />
                        <input type="hidden" name="stage" value={nextStage} />
                        <input type="hidden" name="note" value="Advanced from the pipeline board." />
                        <button class="ncc-btn" type="submit">
                          To {nextStage.replace(/_/g, ' ')}
                        </button>
                      </form>
                    ) : null}
                  </article>
                ))}
              </section>
            )
          })}
        </div>
      </div>

      <Panel title="Reading this board">
        <p class="ncc-muted">
          A lead with no activity for {q.DORMANT_DAYS} days drops out of these columns and out of the weighted total,
          because a forecast that counts leads nobody has called since March is the spreadsheet problem with extra
          steps. The cron moves it to dormant; it is still on the table view.
        </p>
      </Panel>
    </>
  )
})

/* Leads ------------------------------------------------------------------- */

crm.get('/app/crm/leads', requirePermission(PERMISSIONS.CRM_LEAD_VIEW), async (c) => {
  const db = c.get('db')
  const scope = scopeOf(c)
  const value = canValue(c)
  const { page: pageNo, offset, pageSize } = pageParam(c, PAGE_SIZE)
  const search = queryParam(c, 'q') ?? null
  const stage = queryParam(c, 'stage') ?? null
  const temperature = queryParam(c, 'temperature') ?? null
  const source = Number(queryParam(c, 'source') ?? '') || null
  const assignedTo = Number(queryParam(c, 'assignedTo') ?? '') || null
  const unassigned = queryParam(c, 'unassigned') === '1'
  const due = queryParam(c, 'due') === '1'
  const filters = { q: search, stage, temperature, source, assignedTo, unassigned }

  const [rows, total, sources, users, followups] = await Promise.all([
    q.listLeads(db, scope, { ...filters, canViewValue: value, limit: pageSize, offset }),
    q.countLeads(db, scope, filters),
    q.leadSourceOptions(db),
    q.assignableUsers(db),
    due ? q.dueFollowups(db, scope) : Promise.resolve([]),
  ])

  const columns: Column<q.LeadListRow>[] = [
    {
      header: 'Lead',
      cell: (r) => (
        <>
          <a href={`/app/crm/leads/${r.id}`}>
            <strong>{r.contact_name}</strong>
          </a>
          <div class="ncc-muted">
            {r.lead_no} - {r.phone}
          </div>
        </>
      ),
    },
    { header: 'Stage', cell: (r) => <StatusBadge status={r.stage} tone={STAGE_TONE[r.stage] ?? 'muted'} /> },
    {
      header: 'Temp',
      cell: (r) => <StatusBadge status={r.temperature} tone={TEMPERATURE_TONE[r.temperature] ?? 'muted'} />,
    },
    { header: 'Score', numeric: true, cell: (r) => <Progress pct={Number(r.score)} /> },
    {
      header: 'Site',
      cell: (r) =>
        [r.site_locality, r.site_city].filter((p) => p !== null && p !== '').join(', ') || <span class="ncc-muted">-</span>,
    },
    { header: 'Source', cell: (r) => r.source_name ?? <span class="ncc-muted">untagged</span> },
    { header: 'Owner', cell: (r) => r.assignee_name ?? <span class="ncc-muted">pool</span> },
    {
      header: 'Next action',
      cell: (r) =>
        r.next_action_date === null ? (
          <span class="ncc-muted">none set</span>
        ) : (
          <>
            <DateText value={r.next_action_date} />
            <div class="ncc-muted">{r.next_action ?? ''}</div>
          </>
        ),
    },
    {
      header: 'Value',
      numeric: true,
      cell: (r) => <Money paise={paiseOf(r, 'expected_value_paise')} compact hidden={!value} />,
    },
    {
      header: 'Odds',
      numeric: true,
      cell: (r) => {
        if (!value) return <span class="ncc-muted">restricted</span>
        const pct = pctOf(r, 'probability_pct')
        return pct === null ? <span class="ncc-muted">-</span> : `${pct}%`
      },
    },
  ]

  const qs = new URLSearchParams()
  if (search) qs.set('q', search)
  if (stage) qs.set('stage', stage)
  if (temperature) qs.set('temperature', temperature)
  if (source) qs.set('source', String(source))
  if (assignedTo) qs.set('assignedTo', String(assignedTo))
  if (unassigned) qs.set('unassigned', '1')
  if (due) qs.set('due', '1')

  return page(
    c,
    {
      title: 'Leads',
      path: '/app/crm/leads',
      subtitle: scope.all ? undefined : 'Your leads and the unassigned pool',
      actions: (
        <>
          <a class="ncc-btn" href="/app/crm">
            Pipeline
          </a>
          {can(c, PERMISSIONS.CRM_LEAD_MANAGE) ? (
            <a class="ncc-btn ncc-btn-primary" href="/app/crm/leads/new">
              New lead
            </a>
          ) : null}
        </>
      ),
    },
    <>
      {banner(c)}
      {due ? (
        <Panel title="Due and overdue">
          <DataTable
            columns={[
              {
                header: 'Lead',
                cell: (r) => <a href={`/app/crm/leads/${r.id}`}>{r.contact_name}</a>,
              },
              { header: 'Phone', cell: (r) => r.phone },
              { header: 'Stage', cell: (r) => <StatusBadge status={r.stage} tone={STAGE_TONE[r.stage] ?? 'muted'} /> },
              { header: 'Due', cell: (r) => <DateText value={r.next_action_date} /> },
              { header: 'Action', cell: (r) => r.next_action ?? '-' },
              { header: 'Owner', cell: (r) => r.assignee_name ?? 'pool' },
            ]}
            rows={followups}
            empty="Nothing is due."
            caption="Oldest first. Rule 7: the first response is the one controllable conversion lever."
          />
        </Panel>
      ) : null}

      <Panel title="Leads">
        <form method="get" action="/app/crm/leads" class="ncc-row" style="flex-wrap:wrap;gap:.75rem">
          <FormField label="Search" name="q" value={search} placeholder="Name, phone, lead no, locality" />
          <FormField label="Stage" name="stage" options={enumOptions(POSTABLE_STAGES, stage, 'All')} />
          <FormField
            label="Temperature"
            name="temperature"
            options={enumOptions(['hot', 'warm', 'cold'], temperature, 'All')}
          />
          <FormField label="Source" name="source" options={selectOptions(sources, source, 'All')} />
          <FormField label="Owner" name="assignedTo" options={userOptions(users, assignedTo, 'Anyone')} />
          <FormField
            label="Pool only"
            name="unassigned"
            options={[
              { value: '', label: 'No', selected: !unassigned },
              { value: '1', label: 'Yes', selected: unassigned },
            ]}
          />
          <button class="ncc-btn" type="submit">
            Filter
          </button>
        </form>
        <DataTable
          columns={columns}
          rows={rows}
          empty="No lead matches that filter."
          caption="Highest score first, then the longest untouched: the order a sales executive works in."
        />
        <Pager
          page={pageNo}
          pageSize={pageSize}
          total={total}
          baseHref={qs.toString() === '' ? '/app/crm/leads' : `/app/crm/leads?${qs.toString()}`}
        />
      </Panel>
    </>
  )
})

/* Lead form -------------------------------------------------------------- */

/**
 * The lead form is rendered for both create and edit, so it reads a row that
 * may not exist. findLead's row type is inferred from Kysely and its shape
 * depends on canViewValue, so the accessors below take an index signature
 * rather than that type: this is a template filling inputs, and every value
 * ends up a string in the HTML either way.
 */
type Row = Record<string, unknown>

function val(row: Row | null, key: string): string | number | null {
  const v = row?.[key]
  if (v === null || v === undefined) return null
  return typeof v === 'number' ? v : String(v)
}

/** Paise column, rupee input. The inverse of rupeesToPaiseField in schemas.ts. */
function rupeeVal(row: Row | null, key: string): string | null {
  const v = row?.[key]
  if (v === null || v === undefined) return null
  return String(paiseToRupees(Number(v)))
}

/** A TINYINT(1) NULL qualifier, for the three-valued select. */
function flag(row: Row | null, key: string): number | null {
  const v = row?.[key]
  if (v === null || v === undefined) return null
  return Number(v) === 1 ? 1 : 0
}

interface LeadFormLookups {
  sources: Array<{ id: number; code: string | null; name: string }>
  campaigns: Array<{ id: number; name: string }>
  clients: Array<{ id: number; code: string | null; name: string }>
  packages: Array<{ id: number; name: string }>
}

function LeadFormFields(props: { row: Row | null; lookups: LeadFormLookups }) {
  const { row, lookups } = props
  return (
    <>
      <fieldset class="ncc-fieldset">
        <legend>Contact</legend>
        <div class="ncc-grid ncc-grid--form">
          <FormField label="Contact name" name="contactName" value={val(row, 'contact_name')} required />
          <FormField label="Phone" name="phone" value={val(row, 'phone')} required autocomplete="tel" />
          <FormField label="Alternate phone" name="altPhone" value={val(row, 'alt_phone')} />
          <FormField label="Email" name="email" type="email" value={val(row, 'email')} />
          <FormField
            label="Existing client"
            name="clientId"
            options={selectOptions(lookups.clients, Number(val(row, 'client_id')) || null, 'Not an existing client')}
            hint="Set only for repeat business. Conversion creates the client otherwise."
          />
        </div>
      </fieldset>

      <fieldset class="ncc-fieldset">
        <legend>Where it came from</legend>
        <div class="ncc-grid ncc-grid--form">
          <FormField
            label="Source"
            name="leadSourceId"
            options={selectOptions(lookups.sources, Number(val(row, 'lead_source_id')) || null, 'Untagged')}
            hint="Untagged leads show as their own row on the source report."
          />
          <FormField
            label="Campaign"
            name="campaignId"
            options={selectOptions(lookups.campaigns, Number(val(row, 'campaign_id')) || null, 'None')}
          />
          <FormField
            label="Referred by"
            name="referredByClientId"
            options={selectOptions(lookups.clients, Number(val(row, 'referred_by_client_id')) || null, 'Nobody')}
          />
          <FormField
            label="Enquiry type"
            name="enquiryType"
            options={enumOptions(ENQUIRY_TYPES, (val(row, 'enquiry_type') as string) ?? 'residential_construction')}
            required
          />
        </div>
      </fieldset>

      <fieldset class="ncc-fieldset">
        <legend>Plot</legend>
        <div class="ncc-grid ncc-grid--form">
          <FormField label="City" name="siteCity" value={val(row, 'site_city')} hint="Bengaluru, Nelamangala, Tumakuru and Doddaballapura score as served." />
          <FormField label="Locality" name="siteLocality" value={val(row, 'site_locality')} />
          <FormField label="Survey number" name="surveyNumber" value={val(row, 'survey_number')} />
          <FormField label="Plot area (sqft)" name="plotAreaSqft" type="number" step="0.01" min="0" value={val(row, 'plot_area_sqft')} />
          <FormField label="Dimensions" name="plotDimensions" value={val(row, 'plot_dimensions')} placeholder="30x40" />
          <FormField label="Target built-up (sqft)" name="targetBuiltUpSqft" type="number" step="0.01" min="0" value={val(row, 'target_built_up_sqft')} />
          <FormField label="Floors wanted" name="floorsWanted" type="number" step="1" min="0" value={val(row, 'floors_wanted')} />
          <FormField
            label="Jurisdiction"
            name="jurisdiction"
            options={enumOptions(JURISDICTIONS, val(row, 'jurisdiction') as string | null, 'Not known')}
          />
        </div>
      </fieldset>

      <fieldset class="ncc-fieldset">
        <legend>Qualifiers</legend>
        <div class="ncc-grid ncc-grid--form">
          <FormField
            label="Plot ownership"
            name="plotOwnership"
            options={enumOptions(PLOT_OWNERSHIPS, val(row, 'plot_ownership') as string | null, 'Not asked')}
          />
          <FormField
            label="Sanctioned plan"
            name="hasSanctionedPlan"
            options={YES_NO_NULL(flag(row, 'has_sanctioned_plan'))}
            hint="Not asked is a different answer from no, and scores differently."
          />
          <FormField label="Has an architect" name="hasArchitect" options={YES_NO_NULL(flag(row, 'has_architect'))} />
          <FormField label="Architect name" name="architectName" value={val(row, 'architect_name')} />
          <FormField
            label="Funding"
            name="fundingMode"
            options={enumOptions(FUNDING_MODES, val(row, 'funding_mode') as string | null, 'Not asked')}
          />
          <FormField
            label="Expected start"
            name="expectedStart"
            options={enumOptions(EXPECTED_STARTS, val(row, 'expected_start') as string | null, 'Not asked')}
          />
        </div>
      </fieldset>

      <fieldset class="ncc-fieldset">
        <legend>Budget and package</legend>
        <div class="ncc-grid ncc-grid--form">
          <FormField label="Budget floor (Rs)" name="budgetMinPaise" type="number" step="0.01" min="0" value={rupeeVal(row, 'budget_min_paise')} />
          <FormField label="Budget ceiling (Rs)" name="budgetMaxPaise" type="number" step="0.01" min="0" value={rupeeVal(row, 'budget_max_paise')} />
          <FormField
            label="Preferred package"
            name="preferredPackageId"
            options={selectOptions(lookups.packages, Number(val(row, 'preferred_package_id')) || null, 'None chosen')}
            hint="Feeds the score and the first estimate. The quote prices off the live rate, not this."
          />
        </div>
      </fieldset>

      <fieldset class="ncc-fieldset">
        <legend>Next action</legend>
        <div class="ncc-grid ncc-grid--form">
          <FormField label="Next action" name="nextAction" value={val(row, 'next_action')} placeholder="Call back after the plan is approved" />
          <FormField label="Due" name="nextActionDate" type="date" value={val(row, 'next_action_date')} />
        </div>
      </fieldset>
    </>
  )
}

async function leadFormLookups(db: Db): Promise<LeadFormLookups> {
  const [sources, campaigns, clients, packages] = await Promise.all([
    q.leadSourceOptions(db),
    q.campaignOptions(db),
    q.clientOptions(db),
    q.packageOptions(db),
  ])
  return { sources, campaigns, clients, packages }
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
  const db = c.get('db')
  const csrf = currentSession(c).csrfToken
  const enquiryId = Number(queryParam(c, 'enquiry') ?? '') || null

  const [lookups, users, enquiry] = await Promise.all([
    leadFormLookups(db),
    q.assignableUsers(db),
    enquiryId ? q.findEnquiry(db, enquiryId) : Promise.resolve(undefined),
  ])

  if (enquiryId && enquiry) {
    return page(
      c,
      { title: 'Promote enquiry', path: '/app/crm/leads', subtitle: `Enquiry ${enquiry.id}` },
      <>
        {banner(c)}
        <Panel title={enquiry.name}>
          <DefinitionList
            rows={[
              ['Phone', enquiry.phone],
              ['Email', enquiry.email ?? '-'],
              ['City', enquiry.city ?? '-'],
              ['Interested in', enquiry.service_interest ?? '-'],
              ['Received', <DateText value={enquiry.created_at} withTime />],
              ['Campaign', enquiry.utm_campaign ?? enquiry.utm_source ?? 'direct'],
              ['Message', enquiry.message ?? '-'],
            ]}
          />
        </Panel>
        <Panel title="Create the lead">
          <form class="ncc-stack" method="post" action={`/api/crm/leads/from-enquiry/${enquiry.id}`}>
            <CsrfInput token={csrf} />
            <FormField
              label="Assign to"
              name="assignedTo"
              options={userOptions(users, currentUser(c).id, 'Leave in the pool')}
              hint="An unassigned lead sits in the pool everyone can see, and the cron chases it."
            />
            <p class="ncc-muted">
              The contact details, city and campaign tags are copied from the enquiry. Qualifiers are added on the
              lead once someone has spoken to them.
            </p>
            <div class="ncc-row">
              <button class="ncc-btn ncc-btn-primary" type="submit">
                Create lead
              </button>
              <a class="ncc-btn" href="/app/admin/enquiries">
                Cancel
              </a>
            </div>
          </form>
        </Panel>
      </>
    )
  }

  return page(
    c,
    {
      title: 'New lead',
      path: '/app/crm/leads',
      subtitle: enquiryId ? 'That enquiry is already a lead, or does not exist. Entering by hand instead.' : undefined,
    },
    <>
      {banner(c)}
      <Panel title="Lead">
        <form class="ncc-stack" method="post" action="/app/crm/leads">
          <CsrfInput token={csrf} />
          <LeadFormFields row={null} lookups={lookups} />
          <fieldset class="ncc-fieldset">
            <legend>Ownership</legend>
            <FormField
              label="Assign to"
              name="assignedTo"
              options={userOptions(users, currentUser(c).id, 'Leave in the pool')}
            />
          </fieldset>
          <div class="ncc-row">
            <button class="ncc-btn ncc-btn-primary" type="submit">
              Create lead
            </button>
            <a class="ncc-btn" href="/app/crm/leads">
              Cancel
            </a>
          </div>
        </form>
      </Panel>
      <Panel title="What the score reads">
        <p class="ncc-muted">
          Only the name, phone and enquiry type are required, because a lead is usually typed while the caller is
          still on the line. Every qualifier above is a scoring signal and every one left blank scores zero, so the
          score says how much is known about the lead, not how good it is.
        </p>
      </Panel>
    </>
  )
})

crm.post('/app/crm/leads', requirePermission(PERMISSIONS.CRM_LEAD_MANAGE), async (c) => {
  const body = await readBody(c)
  const parsed = leadSchema.safeParse(body)
  if (!parsed.success) return errRedirect(c, '/app/crm/leads/new', firstError(parsed.error))
  const assignedTo = Number((body as Record<string, unknown>).assignedTo ?? '') || null
  return guard(c, '/app/crm/leads/new', async () => {
    const created = await svc.createLead(c.get('db'), actorOf(c), parsed.data, assignedTo)
    return {
      to: `/app/crm/leads/${created.leadId}`,
      message: `${created.leadNo} created. Score ${created.score}.`,
    }
  })
})

crm.post(
  '/api/crm/leads/from-enquiry/:enquiryId',
  requirePermission(PERMISSIONS.CRM_LEAD_MANAGE),
  async (c) => {
    const enquiryId = idParam(c, 'enquiryId')
    const body = (await readBody(c)) as Record<string, unknown>
    const parsed = leadFromEnquirySchema.safeParse({ enquiryId, assignedTo: body.assignedTo })
    if (!parsed.success) return errRedirect(c, '/app/admin/enquiries', firstError(parsed.error))
    return guard(c, '/app/admin/enquiries', async () => {
      const created = await svc.leadFromEnquiry(
        c.get('db'),
        actorOf(c),
        parsed.data.enquiryId,
        parsed.data.assignedTo
      )
      return { to: `/app/crm/leads/${created.leadId}`, message: `${created.leadNo} created from the enquiry.` }
    })
  }
)

crm.get('/app/crm/leads/:id/edit', requirePermission(PERMISSIONS.CRM_LEAD_MANAGE), async (c) => {
  const db = c.get('db')
  const leadId = idParam(c, 'id')
  await requireVisibleLead(c, leadId)
  const [lead, lookups] = await Promise.all([q.findLead(db, leadId, canValue(c)), leadFormLookups(db)])
  if (!lead) throw new NotFoundError('That lead does not exist.')

  return page(
    c,
    { title: `Edit ${lead.lead_no}`, path: '/app/crm/leads', subtitle: lead.contact_name },
    <>
      {banner(c)}
      <Panel title="Lead">
        <form class="ncc-stack" method="post" action={`/app/crm/leads/${leadId}/edit`}>
          <CsrfInput token={currentSession(c).csrfToken} />
          <LeadFormFields row={lead as unknown as Row} lookups={lookups} />
          <div class="ncc-row">
            <button class="ncc-btn ncc-btn-primary" type="submit">
              Save
            </button>
            <a class="ncc-btn" href={`/app/crm/leads/${leadId}`}>
              Cancel
            </a>
          </div>
        </form>
      </Panel>
    </>
  )
})

crm.post('/app/crm/leads/:id/edit', requirePermission(PERMISSIONS.CRM_LEAD_MANAGE), async (c) => {
  const leadId = idParam(c, 'id')
  await requireVisibleLead(c, leadId)
  const back = `/app/crm/leads/${leadId}/edit`
  const parsed = leadSchema.safeParse(await readBody(c))
  if (!parsed.success) return errRedirect(c, back, firstError(parsed.error))
  return guard(c, back, async () => {
    const out = await svc.updateLead(c.get('db'), actorOf(c), leadId, parsed.data)
    return { to: `/app/crm/leads/${leadId}`, message: `Saved. Score is now ${out.score}.` }
  })
})

/* Lead detail ------------------------------------------------------------- */

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

crm.get('/app/crm/leads/:id', requirePermission(PERMISSIONS.CRM_LEAD_VIEW), async (c) => {
  const db = c.get('db')
  const leadId = idParam(c, 'id')
  await requireVisibleLead(c, leadId)

  const value = canValue(c)
  const csrf = currentSession(c).csrfToken
  const manage = can(c, PERMISSIONS.CRM_LEAD_MANAGE)

  const lead = await q.findLead(db, leadId, value)
  if (!lead) throw new NotFoundError('That lead does not exist.')

  const [activities, history, visits, quotes, visited, users, duplicates] = await Promise.all([
    q.leadActivities(db, leadId),
    q.leadStageHistory(db, leadId),
    q.leadVisits(db, leadId),
    q.leadQuotes(db, leadId),
    q.hasCompletedVisit(db, leadId),
    can(c, PERMISSIONS.CRM_LEAD_ASSIGN) ? q.assignableUsers(db) : Promise.resolve([]),
    svc.duplicatesByPhone(db, lead.phone, leadId),
  ])

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
  })

  const terminal = lead.stage === 'won' || lead.stage === 'lost'
  const accepted = quotes.filter((quote) => quote.status === 'accepted')
  const stageOptions = POSTABLE_STAGES.filter((s) => s !== lead.stage)

  return page(
    c,
    {
      title: lead.contact_name,
      path: '/app/crm/leads',
      subtitle: `${lead.lead_no} - ${lead.phone}`,
      actions: (
        <>
          {manage && !terminal ? (
            <a class="ncc-btn" href={`/app/crm/leads/${leadId}/edit`}>
              Edit
            </a>
          ) : null}
          {can(c, PERMISSIONS.CRM_QUOTE_CREATE) && !terminal ? (
            <a class="ncc-btn ncc-btn-primary" href={`/app/crm/quotes/new?lead=${leadId}`}>
              New quote
            </a>
          ) : null}
        </>
      ),
    },
    <>
      {banner(c)}

      {duplicates.length > 0 ? (
        <Alert tone="warn">
          {duplicates.length} other lead{duplicates.length === 1 ? '' : 's'} carr
          {duplicates.length === 1 ? 'ies' : 'y'} this phone number:{' '}
          {duplicates.map((d, i) => (
            <>
              {i > 0 ? ', ' : ''}
              <a href={`/app/crm/leads/${d.id}`}>{d.lead_no}</a> ({d.stage.replace(/_/g, ' ')})
            </>
          ))}
          . Two executives chasing one client is how a discount gets quoted twice.
        </Alert>
      ) : null}

      {lead.converted_project_id ? (
        <Alert tone="ok">
          Won and converted to project <a href={`/app/projects/${lead.converted_project_id}`}>{lead.project_code}</a>.
        </Alert>
      ) : null}

      {lead.stage === 'lost' ? (
        <Alert tone="error">
          Lost: {(lead.lost_reason ?? 'no reason recorded').replace(/_/g, ' ')}
          {lead.lost_to_competitor ? ` to ${lead.lost_to_competitor}` : ''}. {lead.lost_notes ?? ''}
        </Alert>
      ) : null}

      {!terminal && lead.next_action_date === null && svc.STAGE_RANK[lead.stage] >= 1 ? (
        <Alert tone="warn">
          No next action is set. A lead past first contact with nothing scheduled is the one that goes dormant at{' '}
          {q.DORMANT_DAYS} days without anybody deciding to drop it. Log an activity below and set the next action.
        </Alert>
      ) : null}

      <div class="ncc-grid ncc-grid--kpi">
        <KpiCard label="Stage" value={<StatusBadge status={lead.stage} tone={STAGE_TONE[lead.stage] ?? 'muted'} />} hint={`Since ${formatDate(lead.stage_changed_at.slice(0, 10))}`} />
        <KpiCard
          label="Temperature"
          value={<StatusBadge status={lead.temperature} tone={TEMPERATURE_TONE[lead.temperature] ?? 'muted'} />}
          hint="Score and how recently anyone touched it"
        />
        <KpiCard label="Score" value={<Progress pct={Number(lead.score)} />} hint="How much is known, not how good it is" />
        <KpiCard
          label="Expected value"
          value={<Money paise={paiseOf(lead as unknown as Row, 'expected_value_paise')} compact hidden={!value} />}
          hint="Built-up area times package rate, or the budget midpoint"
        />
        <KpiCard
          label="Probability"
          value={value ? `${pctOf(lead as unknown as Row, 'probability_pct') ?? '-'}%` : <span class="ncc-muted">restricted</span>}
          hint="Stage default unless overridden"
        />
        <KpiCard
          label="Site visit"
          value={visited ? 'On record' : 'None'}
          hint={visited ? 'A quote may go out' : 'A quote cannot be sent without one'}
        />
      </div>

      <Panel title="Lead">
        <DefinitionList
          rows={[
            ['Owner', lead.assignee_name ?? 'Unassigned (in the pool)'],
            ['Source', lead.source_name ?? 'Untagged'],
            ['Campaign', lead.campaign_name ?? '-'],
            ['Enquiry type', lead.enquiry_type.replace(/_/g, ' ')],
            ['Contact', `${lead.phone}${lead.alt_phone ? ` / ${lead.alt_phone}` : ''}${lead.email ? ` - ${lead.email}` : ''}`],
            ['Client', lead.client_name ? `${lead.client_code ?? ''} ${lead.client_name}`.trim() : 'New client on conversion'],
            ['Site', [lead.site_locality, lead.site_city].filter((p) => p).join(', ') || '-'],
            ['Survey number', lead.survey_number ?? '-'],
            ['Plot', lead.plot_area_sqft ? <Qty value={Number(lead.plot_area_sqft)} unit="sqft" /> : '-'],
            ['Dimensions', lead.plot_dimensions ?? '-'],
            ['Target built-up', lead.target_built_up_sqft ? <Qty value={Number(lead.target_built_up_sqft)} unit="sqft" /> : '-'],
            ['Floors', lead.floors_wanted === null ? '-' : String(lead.floors_wanted)],
            ['Jurisdiction', lead.jurisdiction ?? '-'],
            ['Plot ownership', lead.plot_ownership?.replace(/_/g, ' ') ?? 'not asked'],
            ['Sanctioned plan', lead.has_sanctioned_plan === null ? 'not asked' : Number(lead.has_sanctioned_plan) === 1 ? 'yes' : 'no'],
            ['Architect', lead.has_architect === null ? 'not asked' : Number(lead.has_architect) === 1 ? lead.architect_name ?? 'yes' : 'no'],
            ['Funding', lead.funding_mode?.replace(/_/g, ' ') ?? 'not asked'],
            ['Expected start', lead.expected_start?.replace(/_/g, ' ') ?? 'not asked'],
            ['Budget', <Money paise={numOrNull(lead.budget_min_paise)} hidden={!value} />],
            ['Budget ceiling', <Money paise={numOrNull(lead.budget_max_paise)} hidden={!value} />],
            ['Preferred package', lead.package_name ?? '-'],
            ['First response', lead.first_response_at ? <DateText value={lead.first_response_at} withTime /> : 'not yet'],
            ['Next action', lead.next_action ? `${lead.next_action} (${formatDate(lead.next_action_date)})` : 'none set'],
          ]}
        />
      </Panel>

      <Panel title={`Score: ${scored.score}`}>
        <DataTable
          columns={[
            { header: 'Signal', cell: (s: svc.ScoreSignal) => s.label },
            { header: 'Points', numeric: true, cell: (s: svc.ScoreSignal) => `${s.points} / ${s.max}` },
          ]}
          rows={scored.signals}
          caption="Recomputed here from the stored facts. It should equal the stored score; a difference means the weights changed since the lead was last saved."
        />
        {scored.score !== Number(lead.score) ? (
          <Alert tone="warn">
            The stored score is {Number(lead.score)}. Saving the lead recomputes it.
          </Alert>
        ) : null}
      </Panel>

      {manage && !terminal ? (
        <Panel title="Move the lead">
          <form class="ncc-stack" method="post" action={`/api/crm/leads/${leadId}/stage`}>
            <CsrfInput token={csrf} />
            <div class="ncc-grid ncc-grid--form">
              <FormField label="Stage" name="stage" options={enumOptions(stageOptions, null, 'Choose one')} required />
              <FormField label="Note" name="note" placeholder="Why it moved" />
            </div>
            <p class="ncc-muted">
              Won is not on this list: a lead is won by converting it, which is what creates the client and the
              contract. Lost is not either, because it needs a reason. Quote sent needs a completed site visit
              first{visited ? ' — there is one on record' : ' — there is none on record'}.
            </p>
            <button class="ncc-btn ncc-btn-primary" type="submit">
              Move
            </button>
          </form>
        </Panel>
      ) : null}

      {can(c, PERMISSIONS.CRM_LEAD_ASSIGN) && !terminal ? (
        <Panel title="Assign">
          <form class="ncc-stack" method="post" action={`/api/crm/leads/${leadId}/assign`}>
            <CsrfInput token={csrf} />
            <div class="ncc-grid ncc-grid--form">
              <FormField label="Owner" name="assignedTo" options={userOptions(users, lead.assigned_to, 'Return to the pool')} />
              <FormField label="Note" name="note" />
            </div>
            <button class="ncc-btn" type="submit">
              Save owner
            </button>
          </form>
        </Panel>
      ) : null}

      {manage && !terminal ? (
        <Panel title="Log an activity">
          <form class="ncc-stack" method="post" action={`/api/crm/leads/${leadId}/activities`}>
            <CsrfInput token={csrf} />
            <div class="ncc-grid ncc-grid--form">
              <FormField label="Type" name="activityType" options={enumOptions(ACTIVITY_TYPES, 'call_out')} required />
              <FormField label="When" name="occurredAt" type="datetime-local" value={dtLocal(nowSqlDateTime())} required />
              <FormField label="Minutes" name="durationMinutes" type="number" step="1" min="0" />
              <FormField label="Outcome" name="outcome" options={enumOptions(ACTIVITY_OUTCOMES, null, 'Not recorded')} />
              <FormField label="Next action" name="nextAction" placeholder="Send the package comparison" />
              <FormField label="Next action due" name="nextActionDate" type="date" />
            </div>
            <FormField label="What happened" name="summary" rows={3} required />
            <button class="ncc-btn ncc-btn-primary" type="submit">
              Log it
            </button>
          </form>
        </Panel>
      ) : null}

      <Panel title="Activity">
        <Timeline
          entries={activities.map((a) => ({
            when: a.occurred_at,
            who: a.by_name,
            what: (
              <>
                <strong>{a.activity_type.replace(/_/g, ' ')}</strong>
                {a.outcome ? ` - ${a.outcome.replace(/_/g, ' ')}` : ''}
                {a.duration_minutes ? ` - ${a.duration_minutes} min` : ''}
                <div>{a.summary}</div>
                {a.next_action ? (
                  <div class="ncc-hint">
                    Next: {a.next_action}
                    {a.next_action_date ? ` by ${formatDate(a.next_action_date)}` : ''}
                  </div>
                ) : null}
              </>
            ),
          }))}
        />
      </Panel>

      <Panel
        title="Site visits"
        actions={
          manage && !terminal ? (
            <a class="ncc-btn" href="/app/crm/visits">
              All visits
            </a>
          ) : null
        }
      >
        <DataTable
          columns={[
            { header: 'Scheduled', cell: (v) => <DateText value={v.scheduled_at} withTime /> },
            { header: 'Status', cell: (v) => <StatusBadge status={v.status} tone={VISIT_TONE[v.status] ?? 'muted'} /> },
            { header: 'Visited', cell: (v) => <DateText value={v.visited_at} withTime /> },
            { header: 'By', cell: (v) => v.visited_by_name ?? '-' },
            {
              header: 'Verdict',
              cell: (v) =>
                v.feasibility ? (
                  <StatusBadge status={v.feasibility} tone={FEASIBILITY_TONE[v.feasibility] ?? 'muted'} />
                ) : (
                  <span class="ncc-muted">-</span>
                ),
            },
            { header: 'Extra cost', numeric: true, cell: (v) => <Money paise={numOrNull(v.estimated_extra_cost_paise)} hidden={!value} /> },
            { header: '', cell: (v) => <a class="ncc-btn" href={`/app/crm/visits/${v.id}`}>Open</a> },
          ]}
          rows={visits}
          empty="No visit has been booked."
        />
        {manage && !terminal ? (
          <form class="ncc-row" method="post" action={`/api/crm/leads/${leadId}/site-visits`} style="margin-top:.9rem;align-items:flex-end;gap:.75rem">
            <CsrfInput token={csrf} />
            <FormField label="Schedule a visit" name="scheduledAt" type="datetime-local" required />
            <FormField label="Who is going" name="visitedBy" options={userOptions(users.length ? users : [], lead.assigned_to, 'Decide later')} />
            <button class="ncc-btn" type="submit">
              Book it
            </button>
          </form>
        ) : null}
      </Panel>

      <Panel
        title="Quotes"
        actions={
          can(c, PERMISSIONS.CRM_QUOTE_CREATE) && !terminal ? (
            <a class="ncc-btn" href={`/app/crm/quotes/new?lead=${leadId}`}>
              New quote
            </a>
          ) : null
        }
      >
        <DataTable
          columns={[
            { header: 'Quote', cell: (quote) => <a href={`/app/crm/quotes/${quote.id}`}>{`${quote.quote_no} r${quote.revision}`}</a> },
            { header: 'Date', cell: (quote) => <DateText value={quote.quote_date} /> },
            { header: 'Valid until', cell: (quote) => <DateText value={quote.valid_until} /> },
            { header: 'Status', cell: (quote) => <StatusBadge status={quote.status} tone={QUOTE_TONE[quote.status] ?? 'muted'} /> },
            { header: 'Discount', numeric: true, cell: (quote) => `${Number(quote.discount_pct)}%` },
            { header: 'Total', numeric: true, cell: (quote) => <Money paise={Number(quote.total_paise)} hidden={!value} /> },
          ]}
          rows={quotes}
          empty="No quote has been raised."
        />
      </Panel>

      {can(c, PERMISSIONS.CRM_CONVERT_TO_PROJECT) && !terminal ? (
        <Panel title="Convert to a project">
          {accepted.length === 0 ? (
            <Alert tone="warn">
              Conversion needs an accepted quote. Without one there is no agreed contract value, and the project
              would start with a number somebody typed rather than a number the client signed.
            </Alert>
          ) : (
            <form class="ncc-stack" method="post" action={`/api/crm/leads/${leadId}/convert`}>
              <CsrfInput token={csrf} />
              <div class="ncc-grid ncc-grid--form">
                <FormField label="Planned start" name="plannedStart" type="date" hint="Defaults to today." />
                <FormField label="Contract signed on" name="contractSignedOn" type="date" />
              </div>
              <p class="ncc-muted">
                Everything else comes from the lead and quote {accepted[0]?.quote_no}: the client, the site address,
                the contract value ({<Money paise={Number(accepted[0]?.total_paise ?? 0)} compact hidden={!value} />}{' '}
                inclusive of GST, of which the contract takes the pre-GST subtotal), the stages and the payment
                milestones. Nothing here is retyped, so nothing here can drift from what was agreed.
              </p>
              <button class="ncc-btn ncc-btn-primary" type="submit">
                Convert
              </button>
            </form>
          )}
        </Panel>
      ) : null}

      {manage && !terminal ? (
        <>
          <Panel title="Override the odds">
            <form class="ncc-row" method="post" action={`/api/crm/leads/${leadId}/probability`} style="align-items:flex-end;gap:.75rem">
              <CsrfInput token={csrf} />
              <FormField label="Probability %" name="probabilityPct" type="number" step="1" min="0" max="100" required />
              <FormField label="Why" name="note" required placeholder="Client confirmed budget approval" />
              <button class="ncc-btn" type="submit">
                Set
              </button>
            </form>
            <p class="ncc-muted">
              Every stage carries a default probability. Overriding it is audited, because the pipeline forecast is
              built from this number and an unexplained 90% is how a forecast stops being believed.
            </p>
          </Panel>

          <Panel title="Mark it lost">
            <form class="ncc-stack" method="post" action={`/api/crm/leads/${leadId}/lose`}>
              <CsrfInput token={csrf} />
              <div class="ncc-grid ncc-grid--form">
                <FormField label="Reason" name="lostReason" options={enumOptions(LOST_REASONS, null, 'Choose one')} required />
                <FormField label="Lost to" name="lostToCompetitor" placeholder="Competitor name, if known" />
                <FormField label="Their rate (Rs/sqft)" name="competitorRatePerSqft" type="number" step="0.01" min="0" />
              </div>
              <FormField label="Notes" name="lostNotes" rows={2} />
              <p class="ncc-muted">
                The reason is a fixed list because the loss report is built from it, and free text produces ten
                spellings of "price". A named competitor and their rate go on the competitor record.
              </p>
              <button class="ncc-btn ncc-btn-danger" type="submit">
                Record the loss
              </button>
            </form>
          </Panel>
        </>
      ) : null}

      <Panel title="Stage history">
        <DataTable
          columns={[
            { header: 'When', cell: (h) => <DateText value={h.changed_at} withTime /> },
            { header: 'From', cell: (h) => (h.from_stage ?? '-').replace(/_/g, ' ') },
            { header: 'To', cell: (h) => h.to_stage.replace(/_/g, ' ') },
            { header: 'Days in previous', numeric: true, cell: (h) => (h.days_in_previous_stage === null ? '-' : String(h.days_in_previous_stage)) },
            { header: 'By', cell: (h) => h.by_name },
            { header: 'Note', cell: (h) => h.note ?? '-' },
          ]}
          rows={history}
          empty="No stage change yet."
          caption="The funnel report is built from these rows, not from the current stage."
        />
      </Panel>
    </>
  )
})

/* Lead writes ------------------------------------------------------------- */

/**
 * Spec 6.7 lists this as PATCH. A browser form cannot send PATCH, so both verbs
 * are registered on the same handler: the documented verb works for an API
 * client and POST works for the form above. requiresCsrf() in
 * src/middleware/csrf.ts covers every method except GET, HEAD and OPTIONS, so
 * neither registration escapes the token check.
 */
crm.on(['POST', 'PATCH'], '/api/crm/leads/:id/stage', requirePermission(PERMISSIONS.CRM_LEAD_MANAGE), async (c) => {
  const leadId = idParam(c, 'id')
  await requireVisibleLead(c, leadId)
  const back = `/app/crm/leads/${leadId}`
  const parsed = stageSchema.safeParse(await readBody(c))
  if (!parsed.success) return errRedirect(c, back, firstError(parsed.error))
  return guard(c, back, async () => {
    const moved = await svc.changeStage(c.get('db'), actorOf(c), leadId, parsed.data)
    return `Moved from ${moved.from.replace(/_/g, ' ')} to ${moved.to.replace(/_/g, ' ')}${
      moved.days === null ? '.' : ` after ${moved.days} day${moved.days === 1 ? '' : 's'}.`
    }`
  })
})

crm.on(['POST', 'PATCH'], '/api/crm/leads/:id/assign', requirePermission(PERMISSIONS.CRM_LEAD_ASSIGN), async (c) => {
  const leadId = idParam(c, 'id')
  const back = `/app/crm/leads/${leadId}`
  const parsed = assignSchema.safeParse(await readBody(c))
  if (!parsed.success) return errRedirect(c, back, firstError(parsed.error))
  return guard(c, back, async () => {
    await svc.assignLead(c.get('db'), actorOf(c), leadId, parsed.data)
    return parsed.data.assignedTo === null ? 'Returned to the pool.' : 'Owner saved.'
  })
})

crm.post('/api/crm/leads/:id/activities', requirePermission(PERMISSIONS.CRM_LEAD_MANAGE), async (c) => {
  const leadId = idParam(c, 'id')
  await requireVisibleLead(c, leadId)
  const back = `/app/crm/leads/${leadId}`
  const parsed = activitySchema.safeParse(await readBody(c))
  if (!parsed.success) return errRedirect(c, back, firstError(parsed.error))
  return guard(c, back, async () => {
    const logged = await svc.logActivity(c.get('db'), actorOf(c), leadId, parsed.data)
    return logged.firstResponse ? 'Logged, and recorded as the first response.' : 'Logged.'
  })
})

crm.post('/api/crm/leads/:id/site-visits', requirePermission(PERMISSIONS.CRM_LEAD_MANAGE), async (c) => {
  const leadId = idParam(c, 'id')
  await requireVisibleLead(c, leadId)
  const back = `/app/crm/leads/${leadId}`
  const body = (await readBody(c)) as Record<string, unknown>
  const parsed = visitScheduleSchema.safeParse({ ...body, leadId })
  if (!parsed.success) return errRedirect(c, back, firstError(parsed.error))
  return guard(c, back, async () => {
    const booked = await svc.scheduleVisit(c.get('db'), actorOf(c), parsed.data)
    return { to: `/app/crm/visits/${booked.visitId}`, message: 'Visit booked.' }
  })
})

crm.post('/api/crm/leads/:id/probability', requirePermission(PERMISSIONS.CRM_LEAD_MANAGE), async (c) => {
  const leadId = idParam(c, 'id')
  await requireVisibleLead(c, leadId)
  const back = `/app/crm/leads/${leadId}`
  const parsed = probabilitySchema.safeParse(await readBody(c))
  if (!parsed.success) return errRedirect(c, back, firstError(parsed.error))
  return guard(c, back, async () => {
    const set = await svc.setProbability(c.get('db'), actorOf(c), leadId, parsed.data)
    return `${set.leadNo} is now at ${parsed.data.probabilityPct}%, from ${set.previousPct ?? 'no figure'}.`
  })
})

crm.post('/api/crm/leads/:id/lose', requirePermission(PERMISSIONS.CRM_LEAD_MANAGE), async (c) => {
  const leadId = idParam(c, 'id')
  await requireVisibleLead(c, leadId)
  const back = `/app/crm/leads/${leadId}`
  const parsed = loseSchema.safeParse(await readBody(c))
  if (!parsed.success) return errRedirect(c, back, firstError(parsed.error))
  return guard(c, back, async () => {
    const lost = await svc.loseLead(c.get('db'), actorOf(c), leadId, {
      lostReason: parsed.data.lostReason,
      lostToCompetitor: parsed.data.lostToCompetitor,
      lostNotes: parsed.data.lostNotes,
      competitorRatePerSqftPaise: parsed.data.competitorRatePerSqft,
    })
    return `${lost.leadNo} recorded as lost.`
  })
})

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
  const leadId = idParam(c, 'id')
  await requireVisibleLead(c, leadId)
  const back = `/app/crm/leads/${leadId}`
  const parsed = convertOverridesSchema.safeParse(await readBody(c))
  if (!parsed.success) return errRedirect(c, back, firstError(parsed.error))
  return guard(c, back, async () => {
    const out = await svc.convertLeadToProject(c.get('db'), actorOf(c), leadId, parsed.data)
    return {
      to: `/app/projects/${out.projectId}`,
      message: `${out.projectCode} created${out.clientCreated ? ' with a new client' : ''}: ${out.stageCount} stages, ${out.milestoneCount} payment milestones.`,
    }
  })
})

/* Site visits ------------------------------------------------------------- */

crm.get('/app/crm/visits', requirePermission(PERMISSIONS.CRM_LEAD_VIEW), async (c) => {
  const db = c.get('db')
  const scope = scopeOf(c)
  const { page: pageNo, offset, pageSize } = pageParam(c, PAGE_SIZE)
  const status = queryParam(c, 'status') ?? null
  const from = queryParam(c, 'from') ?? null
  const to = queryParam(c, 'to') ?? null
  const filters = { status, from, to }

  const [rows, total] = await Promise.all([
    q.listVisits(db, scope, { ...filters, limit: pageSize, offset }),
    q.countVisits(db, scope, filters),
  ])

  const qs = new URLSearchParams()
  if (status) qs.set('status', status)
  if (from) qs.set('from', from)
  if (to) qs.set('to', to)

  return page(
    c,
    { title: 'Site visits', path: '/app/crm/visits', subtitle: scope.all ? undefined : 'Visits on your leads and the pool' },
    <>
      {banner(c)}
      <Panel title="Visits">
        <form method="get" action="/app/crm/visits" class="ncc-row" style="flex-wrap:wrap;gap:.75rem">
          <FormField label="Status" name="status" options={enumOptions(VISIT_STATUSES, status, 'All')} />
          <FormField label="From" name="from" type="date" value={from} />
          <FormField label="To" name="to" type="date" value={to} />
          <button class="ncc-btn" type="submit">
            Filter
          </button>
        </form>
        <DataTable
          columns={[
            { header: 'Scheduled', cell: (v) => <DateText value={v.scheduled_at} withTime /> },
            {
              header: 'Lead',
              cell: (v) => (
                <>
                  <a href={`/app/crm/leads/${v.lead_id}`}>{v.contact_name}</a>
                  <div class="ncc-muted">
                    {v.lead_no} - {v.phone}
                  </div>
                </>
              ),
            },
            {
              header: 'Site',
              cell: (v) => [v.site_locality, v.site_city].filter((p) => p).join(', ') || <span class="ncc-muted">-</span>,
            },
            { header: 'Status', cell: (v) => <StatusBadge status={v.status} tone={VISIT_TONE[v.status] ?? 'muted'} /> },
            { header: 'By', cell: (v) => v.visited_by_name ?? <span class="ncc-muted">unassigned</span> },
            {
              header: 'Verdict',
              cell: (v) =>
                v.feasibility ? (
                  <StatusBadge status={v.feasibility} tone={FEASIBILITY_TONE[v.feasibility] ?? 'muted'} />
                ) : (
                  <span class="ncc-muted">-</span>
                ),
            },
            { header: '', cell: (v) => <a class="ncc-btn" href={`/app/crm/visits/${v.id}`}>Open</a> },
          ]}
          rows={rows}
          empty="No visit matches that filter."
          caption="A completed visit with a verdict is what rule 3 requires before a quote can be sent."
        />
        <Pager
          page={pageNo}
          pageSize={pageSize}
          total={total}
          baseHref={qs.toString() === '' ? '/app/crm/visits' : `/app/crm/visits?${qs.toString()}`}
        />
      </Panel>
    </>
  )
})

crm.get('/app/crm/visits/:id', requirePermission(PERMISSIONS.CRM_LEAD_VIEW), async (c) => {
  const db = c.get('db')
  const visitId = idParam(c, 'id')
  const visit = await q.findVisit(db, visitId)
  if (!visit) throw new NotFoundError('That visit does not exist.')
  await requireVisibleLead(c, visit.lead_id)

  const value = canValue(c)
  const csrf = currentSession(c).csrfToken
  const manage = can(c, PERMISSIONS.CRM_LEAD_MANAGE)
  const users = manage ? await q.assignableUsers(db) : []
  const done = visit.status === 'completed'

  return page(
    c,
    {
      title: `Site visit - ${visit.contact_name}`,
      path: '/app/crm/visits',
      subtitle: `${visit.lead_no} - ${[visit.site_locality, visit.site_city].filter((p) => p).join(', ') || 'no address recorded'}`,
      actions: (
        <a class="ncc-btn" href={`/app/crm/leads/${visit.lead_id}`}>
          Open the lead
        </a>
      ),
    },
    <>
      {banner(c)}

      <Panel title="Visit">
        <DefinitionList
          rows={[
            ['Status', <StatusBadge status={visit.status} tone={VISIT_TONE[visit.status] ?? 'muted'} />],
            ['Scheduled', <DateText value={visit.scheduled_at} withTime />],
            ['Visited', visit.visited_at ? <DateText value={visit.visited_at} withTime /> : 'not yet'],
            ['By', visit.visited_by_name ?? 'not assigned'],
            [
              'Verdict',
              visit.feasibility ? (
                <StatusBadge status={visit.feasibility} tone={FEASIBILITY_TONE[visit.feasibility] ?? 'muted'} />
              ) : (
                'none recorded'
              ),
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
            ['Estimated extra cost', <Money paise={numOrNull(visit.estimated_extra_cost_paise)} hidden={!value} />],
          ]}
        />
      </Panel>

      {manage && !done ? (
        <Panel title="Record the findings">
          <form class="ncc-stack" method="post" action={`/api/crm/site-visits/${visitId}/complete`}>
            <CsrfInput token={csrf} />
            <div class="ncc-grid ncc-grid--form">
              <FormField label="Visited at" name="visitedAt" type="datetime-local" value={dtLocal(visit.scheduled_at)} required />
              <FormField label="Visited by" name="visitedBy" options={userOptions(users, visit.visited_by, 'Not recorded')} />
              <FormField label="Feasibility" name="feasibility" options={enumOptions(FEASIBILITIES, null, 'Choose one')} required />
              <FormField label="Soil type" name="soilType" placeholder="Red soil, hard rock at 4 ft" />
              <FormField label="Road access" name="roadAccess" options={enumOptions(ROAD_ACCESS, null, 'Not recorded')} hint="Narrow means no transit mixer." />
              <FormField label="Water" name="waterAvailability" options={enumOptions(WATER_AVAILABILITY, null, 'Not recorded')} />
              <FormField label="Power on site" name="powerAvailability" options={YES_NO_NULL(null)} />
              <FormField label="Level difference (ft)" name="levelDifferenceFt" type="number" step="0.01" />
              <FormField label="Demolition required" name="demolitionRequired" options={YES_NO_NULL(null)} />
              <FormField label="Tree cutting permission" name="treeCuttingPermissionNeeded" options={YES_NO_NULL(null)} />
              <FormField label="Estimated extra cost (Rs)" name="estimatedExtraCostPaise" type="number" step="0.01" min="0" hint="Levelling, demolition, a longer pump run." />
            </div>
            <FormField label="Neighbouring structures" name="neighbouringStructures" rows={2} />
            <FormField label="Access constraints" name="accessConstraints" rows={2} />
            <FormField label="Conditions" name="conditionsNotes" rows={2} hint="What a feasible-with-conditions verdict depends on." />
            <p class="ncc-muted">
              The verdict is required. A visit recorded with no verdict is the same as no visit as far as the quote
              gate is concerned, because the gate exists to make somebody stand on the plot before a rate is quoted
              against it.
            </p>
            <button class="ncc-btn ncc-btn-primary" type="submit">
              Complete the visit
            </button>
          </form>
        </Panel>
      ) : null}

      {manage && !done ? (
        <Panel title="Reschedule or close it">
          <form class="ncc-row" method="post" action={`/api/crm/site-visits/${visitId}/status`} style="align-items:flex-end;gap:.75rem">
            <CsrfInput token={csrf} />
            <FormField
              label="Status"
              name="status"
              options={enumOptions(VISIT_STATUSES.filter((s) => s !== 'completed'), null, 'Choose one')}
              required
            />
            <FormField label="New time" name="scheduledAt" type="datetime-local" hint="Required when rescheduling." />
            <button class="ncc-btn" type="submit">
              Save
            </button>
          </form>
          <p class="ncc-muted">
            Completed is not on this list. A visit is completed through the findings form above, so the facts a
            quote depends on are on the record rather than a status word saying somebody went.
          </p>
        </Panel>
      ) : null}
    </>
  )
})

/** Spec 6.7 lists this as PUT. Same reasoning as the PATCH routes above. */
crm.on(['POST', 'PUT'], '/api/crm/site-visits/:id/complete', requirePermission(PERMISSIONS.CRM_LEAD_MANAGE), async (c) => {
  const visitId = idParam(c, 'id')
  const visit = await q.findVisit(c.get('db'), visitId)
  if (!visit) throw new NotFoundError('That visit does not exist.')
  await requireVisibleLead(c, visit.lead_id)

  const back = `/app/crm/visits/${visitId}`
  const parsed = visitCompleteSchema.safeParse(await readBody(c))
  if (!parsed.success) return errRedirect(c, back, firstError(parsed.error))
  return guard(c, back, async () => {
    const out = await svc.completeVisit(c.get('db'), actorOf(c), visitId, parsed.data)
    return { to: `/app/crm/leads/${out.leadId}`, message: `Visit recorded as ${parsed.data.feasibility.replace(/_/g, ' ')}.` }
  })
})

crm.post('/api/crm/site-visits/:id/status', requirePermission(PERMISSIONS.CRM_LEAD_MANAGE), async (c) => {
  const visitId = idParam(c, 'id')
  const visit = await q.findVisit(c.get('db'), visitId)
  if (!visit) throw new NotFoundError('That visit does not exist.')
  await requireVisibleLead(c, visit.lead_id)

  const back = `/app/crm/visits/${visitId}`
  const parsed = visitStatusSchema.safeParse(await readBody(c))
  if (!parsed.success) return errRedirect(c, back, firstError(parsed.error))
  return guard(c, back, async () => {
    await svc.setVisitStatus(c.get('db'), actorOf(c), visitId, parsed.data)
    return `Visit marked ${parsed.data.status.replace(/_/g, ' ')}.`
  })
})

/* Quotes ------------------------------------------------------------------ */

/** How many blank grid rows to render. ?rows= so a long quote is one page. */
function rowCount(c: Ctx, dflt = 6): number {
  const raw = Number(queryParam(c, 'rows') ?? '')
  if (!Number.isInteger(raw)) return dflt
  return Math.max(1, Math.min(40, raw))
}

function blankRows(n: number): null[] {
  return Array.from({ length: Math.max(0, n) }, () => null)
}

interface ScheduleRow {
  name: string
  percent: number
  triggerStageSeq: number | null
}

/**
 * Reads payment_schedule_json for display and for prefilling a revision.
 *
 * The column arrives already parsed — MariaDB reports it as JSON and mysql2
 * builds the Array — so the string branch here is the fallback for a row
 * written by hand, not the main path. Taking it the other way round is what
 * made this return an empty schedule for every quote: the print view showed no
 * payment terms and a revision silently dropped the milestones it was meant to
 * carry forward.
 *
 * service.ts keeps its own parser for the same column. It is not shared,
 * because that one guards a transaction that creates project milestones and
 * this one fills in a form: the service's must stay strict about what it will
 * act on, and coupling them would make a change to the display loosen the
 * conversion. Both treat a malformed value as an empty schedule.
 */
function readSchedule(raw: unknown): ScheduleRow[] {
  if (raw === null || raw === undefined || raw === '') return []
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return []
    }
  }
  if (!Array.isArray(parsed)) return []
  const out: ScheduleRow[] = []
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue
    const row = item as Record<string, unknown>
    const name = typeof row.name === 'string' ? row.name.trim() : ''
    const percent = Number(row.percent)
    if (name === '' || !Number.isFinite(percent) || percent <= 0) continue
    const seq = Number(row.triggerStageSeq)
    out.push({ name, percent, triggerStageSeq: Number.isFinite(seq) && seq > 0 ? seq : null })
  }
  return out
}

interface QuoteFormProps {
  action: string
  csrf: string
  leadId: number
  leadLabel: string
  submitLabel: string
  cancelHref: string
  packages: ReadonlyArray<{ id: number; name: string }>
  units: ReadonlyArray<{ id: number; code: string }>
  costHeads: ReadonlyArray<{ id: number; code: string }>
  quote: Row | null
  lines: ReadonlyArray<{ line_type: string; description: string; qty: unknown; rate_paise: unknown; unit_code?: string | null }>
  schedule: ScheduleRow[]
  extraRows: number
}

/**
 * The quote builder (spec 6.7 rule 4).
 *
 * There is no total on this form. The base amount, the discount amount, GST and
 * the total are computed in the service from the package rate and the lines, so
 * what is posted here is the inputs to the arithmetic and never its result — a
 * hand-edited total is not a number the system can be made to believe.
 */
function QuoteForm(props: QuoteFormProps) {
  const { quote } = props
  const basis = (val(quote, 'pricing_basis') as string | null) ?? 'per_sqft'
  const editable = props.lines.filter((l) => l.line_type === 'addon' || l.line_type === 'extra_work')

  return (
    <form class="ncc-stack" method="post" action={props.action}>
      <CsrfInput token={props.csrf} />
      <input type="hidden" name="leadId" value={String(props.leadId)} />

      <fieldset class="ncc-fieldset">
        <legend>Quote for {props.leadLabel}</legend>
        <div class="ncc-grid ncc-grid--form">
          <FormField
            label="Package"
            name="packageId"
            options={selectOptions(props.packages, Number(val(quote, 'package_id')) || null, 'No package (item rate or lumpsum)')}
            hint="Priced off the package rate live at the quote date, not off whatever was quoted last time."
          />
          <FormField label="Quote date" name="quoteDate" type="date" value={(val(quote, 'quote_date') as string | null) ?? today()} required />
          <FormField
            label="Valid until"
            name="validUntil"
            type="date"
            value={(val(quote, 'valid_until') as string | null) ?? addDays(today(), 30)}
            required
            hint="The cron expires the quote after this date and warns before it."
          />
          <FormField label="Pricing basis" name="pricingBasis" options={enumOptions(PRICING_BASES, basis)} required />
          <FormField label="Built-up area (sqft)" name="builtUpAreaSqft" type="number" step="0.01" min="0" value={val(quote, 'built_up_area_sqft')} hint="Required for a per-square-foot quote." />
          <FormField label="Rate (Rs/sqft)" name="ratePerSqft" type="number" step="0.01" min="0" value={rupeeVal(quote, 'rate_per_sqft_paise')} hint="Leave blank to take the package rate." />
          <FormField label="Discount %" name="discountPct" type="number" step="0.01" min="0" max="100" value={val(quote, 'discount_pct') ?? '0'} hint="Above the approval limit this escalates instead of being applied." />
          <FormField label="GST %" name="gstPct" type="number" step="0.01" min="0" max="28" value={val(quote, 'gst_pct') ?? '18'} />
        </div>
      </fieldset>

      <fieldset class="ncc-fieldset">
        <legend>Add-ons and extra work</legend>
        <div style="overflow-x:auto">
          <table class="ncc-table">
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col">Description</th>
                <th scope="col" class="ncc-num">Qty</th>
                <th scope="col">Unit</th>
                <th scope="col" class="ncc-num">Rate or amount (Rs)</th>
                <th scope="col">Cost head</th>
              </tr>
            </thead>
            <tbody>
              {editable.map((line) => (
                <tr>
                  <td>
                    <select name="lineType">
                      {QUOTE_LINE_TYPES.map((t) => (
                        <option value={t} selected={t === line.line_type}>
                          {t.replace(/_/g, ' ')}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input name="lineDescription" value={line.description} />
                  </td>
                  <td class="ncc-num">
                    <input name="lineQty" type="number" step="0.001" min="0" value={line.qty === null || line.qty === undefined ? '' : String(Number(line.qty))} />
                  </td>
                  <td>
                    <select name="lineUnitId">
                      <option value="">-</option>
                      {props.units.map((u) => (
                        <option value={String(u.id)} selected={u.code === line.unit_code}>
                          {u.code}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td class="ncc-num">
                    <input name="lineRate" type="number" step="0.01" value={line.rate_paise === null || line.rate_paise === undefined ? '' : String(paiseToRupees(Number(line.rate_paise)))} />
                  </td>
                  <td>
                    <select name="lineCostHeadId">
                      <option value="">-</option>
                      {props.costHeads.map((h) => (
                        <option value={String(h.id)}>{h.code}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
              {blankRows(props.extraRows).map(() => (
                <tr>
                  <td>
                    <select name="lineType">
                      {QUOTE_LINE_TYPES.map((t) => (
                        <option value={t}>{t.replace(/_/g, ' ')}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input name="lineDescription" />
                  </td>
                  <td class="ncc-num">
                    <input name="lineQty" type="number" step="0.001" min="0" />
                  </td>
                  <td>
                    <select name="lineUnitId">
                      <option value="">-</option>
                      {props.units.map((u) => (
                        <option value={String(u.id)}>{u.code}</option>
                      ))}
                    </select>
                  </td>
                  <td class="ncc-num">
                    <input name="lineRate" type="number" step="0.01" />
                  </td>
                  <td>
                    <select name="lineCostHeadId">
                      <option value="">-</option>
                      {props.costHeads.map((h) => (
                        <option value={String(h.id)}>{h.code}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p class="ncc-hint">
          A line with no quantity is a lump sum and its rate cell is the whole amount. Rows with no description are
          ignored. Add more rows with ?rows= in the address bar.
        </p>
      </fieldset>

      <fieldset class="ncc-fieldset">
        <legend>Payment schedule</legend>
        <div style="overflow-x:auto">
          <table class="ncc-table">
            <thead>
              <tr>
                <th scope="col">Milestone</th>
                <th scope="col" class="ncc-num">Percent</th>
                <th scope="col" class="ncc-num">Trigger stage seq</th>
              </tr>
            </thead>
            <tbody>
              {props.schedule.map((m) => (
                <tr>
                  <td>
                    <input name="scheduleName" value={m.name} />
                  </td>
                  <td class="ncc-num">
                    <input name="schedulePercent" type="number" step="0.01" min="0" max="100" value={String(m.percent)} />
                  </td>
                  <td class="ncc-num">
                    <input name="scheduleStageSeq" type="number" step="1" min="1" value={m.triggerStageSeq === null ? '' : String(m.triggerStageSeq)} />
                  </td>
                </tr>
              ))}
              {blankRows(props.schedule.length === 0 ? 6 : 3).map(() => (
                <tr>
                  <td>
                    <input name="scheduleName" placeholder="On completion of the plinth" />
                  </td>
                  <td class="ncc-num">
                    <input name="schedulePercent" type="number" step="0.01" min="0" max="100" />
                  </td>
                  <td class="ncc-num">
                    <input name="scheduleStageSeq" type="number" step="1" min="1" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p class="ncc-hint">
          The percentages must sum to exactly 100. Conversion turns this schedule into the project's payment
          milestones, so this is the last screen where a bad split is something a sales executive can fix.
        </p>
      </fieldset>

      <fieldset class="ncc-fieldset">
        <legend>Exclusions</legend>
        <FormField
          label="What this quote does not cover"
          name="exclusions"
          rows={8}
          required
          value={val(quote, 'exclusions')}
          placeholder={'One per line, for example:\nCompound wall and gate\nBorewell and sump\nBESCOM and BWSSB deposits and sanction charges\nSoil filling and levelling beyond 1 ft\nInterior furniture and loose fittings'}
          hint="These print on the quote as a numbered list. Rule 4 will not let a quote go out without them."
        />
      </fieldset>

      <div class="ncc-row">
        <button class="ncc-btn ncc-btn-primary" type="submit">
          {props.submitLabel}
        </button>
        <a class="ncc-btn" href={props.cancelHref}>
          Cancel
        </a>
      </div>
    </form>
  )
}

crm.get('/app/crm/quotes', requirePermission(...QUOTE_READ), async (c) => {
  const db = c.get('db')
  const scope = scopeOf(c)
  const value = canValue(c)
  const { page: pageNo, offset, pageSize } = pageParam(c, PAGE_SIZE)
  const status = queryParam(c, 'status') ?? null
  const search = queryParam(c, 'q') ?? null
  const leadId = Number(queryParam(c, 'lead') ?? '') || null
  const filters = { status, q: search, leadId }

  const [rows, total] = await Promise.all([
    q.listQuotes(db, scope, { ...filters, limit: pageSize, offset }),
    q.countQuotes(db, scope, filters),
  ])

  const qs = new URLSearchParams()
  if (status) qs.set('status', status)
  if (search) qs.set('q', search)
  if (leadId) qs.set('lead', String(leadId))

  return page(
    c,
    { title: 'Quotes', path: '/app/crm/quotes', subtitle: scope.all ? undefined : 'Quotes on your leads and the pool' },
    <>
      {banner(c)}
      <Panel title="Quotes">
        <form method="get" action="/app/crm/quotes" class="ncc-row" style="flex-wrap:wrap;gap:.75rem">
          <FormField label="Search" name="q" value={search} placeholder="Quote no or client" />
          <FormField label="Status" name="status" options={enumOptions(QUOTE_STATUSES, status, 'All')} />
          <button class="ncc-btn" type="submit">
            Filter
          </button>
        </form>
        <DataTable
          columns={[
            {
              header: 'Quote',
              cell: (r) => (
                <>
                  <a href={`/app/crm/quotes/${r.id}`}>
                    <strong>{r.quote_no}</strong>
                  </a>
                  <div class="ncc-muted">revision {r.revision}</div>
                </>
              ),
            },
            {
              header: 'Lead',
              cell: (r) => (
                <>
                  <a href={`/app/crm/leads/${r.lead_id}`}>{r.contact_name}</a>
                  <div class="ncc-muted">{r.lead_no}</div>
                </>
              ),
            },
            { header: 'Date', cell: (r) => <DateText value={r.quote_date} /> },
            { header: 'Valid until', cell: (r) => <DateText value={r.valid_until} /> },
            { header: 'Status', cell: (r) => <StatusBadge status={r.status} tone={QUOTE_TONE[r.status] ?? 'muted'} /> },
            { header: 'Discount', numeric: true, cell: (r) => `${Number(r.discount_pct)}%` },
            { header: 'Total', numeric: true, cell: (r) => <Money paise={Number(r.total_paise)} hidden={!value} /> },
            { header: 'Raised by', cell: (r) => r.created_by_name ?? '-' },
          ]}
          rows={rows}
          empty="No quote matches that filter."
        />
        <Pager
          page={pageNo}
          pageSize={pageSize}
          total={total}
          baseHref={qs.toString() === '' ? '/app/crm/quotes' : `/app/crm/quotes?${qs.toString()}`}
        />
      </Panel>
    </>
  )
})

crm.get('/app/crm/quotes/new', requirePermission(PERMISSIONS.CRM_QUOTE_CREATE), async (c) => {
  const db = c.get('db')
  const leadId = Number(queryParam(c, 'lead') ?? '') || 0
  if (!leadId) throw new NotFoundError('Open a quote from the lead it belongs to.')
  await requireVisibleLead(c, leadId)

  const [lead, packages, units, costHeads, visited] = await Promise.all([
    q.findLead(db, leadId, canValue(c)),
    q.packageOptions(db),
    q.unitOptions(db),
    q.costHeadOptions(db),
    q.hasCompletedVisit(db, leadId),
  ])
  if (!lead) throw new NotFoundError('That lead does not exist.')

  return page(
    c,
    { title: 'New quote', path: '/app/crm/quotes', subtitle: `${lead.lead_no} - ${lead.contact_name}` },
    <>
      {banner(c)}
      {visited ? null : (
        <Alert tone="warn">
          No completed site visit is on record for this lead. A quote can be drafted, but it cannot be sent: rule 3
          holds the send until somebody has stood on the plot and recorded a verdict.
        </Alert>
      )}
      <Panel title="Quote">
        <QuoteForm
          action="/app/crm/quotes"
          csrf={currentSession(c).csrfToken}
          leadId={leadId}
          leadLabel={`${lead.lead_no} ${lead.contact_name}`}
          submitLabel="Create the draft"
          cancelHref={`/app/crm/leads/${leadId}`}
          packages={packages}
          units={units}
          costHeads={costHeads}
          quote={{ built_up_area_sqft: lead.target_built_up_sqft, package_id: lead.preferred_package_id }}
          lines={[]}
          schedule={[]}
          extraRows={rowCount(c)}
        />
      </Panel>
    </>
  )
})

crm.post('/app/crm/quotes', requirePermission(PERMISSIONS.CRM_QUOTE_CREATE), async (c) => {
  const body = (await readBody(c)) as Record<string, unknown>
  const leadId = Number(body.leadId ?? '') || 0
  if (leadId) await requireVisibleLead(c, leadId)
  const back = `/app/crm/quotes/new?lead=${leadId}`
  const parsed = quoteSchema.safeParse(body)
  if (!parsed.success) return errRedirect(c, back, firstError(parsed.error))
  return guard(c, back, async () => {
    const created = await svc.createQuote(c.get('db'), actorOf(c), parsed.data)
    return {
      to: `/app/crm/quotes/${created.quoteId}`,
      message: `${created.quoteNo} drafted at ${formatRupees(created.totals.totalPaise)}.`,
    }
  })
})

crm.get('/app/crm/quotes/:id/revise', requirePermission(PERMISSIONS.CRM_QUOTE_CREATE), async (c) => {
  const db = c.get('db')
  const quoteId = idParam(c, 'id')
  const quote = await q.findQuote(db, quoteId)
  if (!quote) throw new NotFoundError('That quote does not exist.')
  await requireVisibleLead(c, quote.lead_id)

  const [lines, packages, units, costHeads] = await Promise.all([
    q.quoteLines(db, quoteId),
    q.packageOptions(db),
    q.unitOptions(db),
    q.costHeadOptions(db),
  ])

  return page(
    c,
    {
      title: `Revise ${quote.quote_no}`,
      path: '/app/crm/quotes',
      subtitle: `Revision ${quote.revision} becomes revision ${quote.revision + 1}`,
    },
    <>
      {banner(c)}
      <Alert tone="warn">
        An approved price is immutable (rule 5). Saving this supersedes revision {quote.revision} and starts the
        approval again, so the client and the audit trail both see that the price changed rather than finding a
        different number under the same quote.
      </Alert>
      <Panel title="Quote">
        <QuoteForm
          action={`/api/crm/quotes/${quoteId}/revise`}
          csrf={currentSession(c).csrfToken}
          leadId={quote.lead_id}
          leadLabel={`${quote.lead_no} ${quote.contact_name}`}
          submitLabel="Save as a new revision"
          cancelHref={`/app/crm/quotes/${quoteId}`}
          packages={packages}
          units={units}
          costHeads={costHeads}
          quote={quote as unknown as Row}
          lines={lines}
          schedule={readSchedule(quote.payment_schedule_json)}
          extraRows={rowCount(c, 3)}
        />
      </Panel>
    </>
  )
})

crm.get('/app/crm/quotes/:id', requirePermission(...QUOTE_READ), async (c) => {
  const db = c.get('db')
  const quoteId = idParam(c, 'id')
  const quote = await q.findQuote(db, quoteId)
  if (!quote) throw new NotFoundError('That quote does not exist.')
  await requireVisibleLead(c, quote.lead_id)

  const value = canValue(c)
  const csrf = currentSession(c).csrfToken
  const [lines, revisions, visited] = await Promise.all([
    q.quoteLines(db, quoteId),
    q.quoteRevisions(db, quote.quote_no),
    q.hasCompletedVisit(db, quote.lead_id),
  ])
  const schedule = readSchedule(quote.payment_schedule_json)

  const status = quote.status
  const mine = Number(quote.created_by) === currentUser(c).id
  const canCreate = can(c, PERMISSIONS.CRM_QUOTE_CREATE)
  const canApprove = can(c, PERMISSIONS.CRM_QUOTE_APPROVE) || can(c, PERMISSIONS.CRM_QUOTE_DISCOUNT_OVERRIDE)

  return page(
    c,
    {
      title: `${quote.quote_no} r${quote.revision}`,
      path: '/app/crm/quotes',
      subtitle: `${quote.lead_no} - ${quote.contact_name}`,
      actions: (
        <>
          <a class="ncc-btn" href={`/api/crm/quotes/${quoteId}/print`} target="_blank" rel="noopener">
            Print
          </a>
          <a class="ncc-btn" href={`/app/crm/leads/${quote.lead_id}`}>
            Open the lead
          </a>
          {canCreate && status !== 'superseded' && status !== 'accepted' ? (
            <a class="ncc-btn" href={`/app/crm/quotes/${quoteId}/revise`}>
              Revise
            </a>
          ) : null}
        </>
      ),
    },
    <>
      {banner(c)}

      {status === 'pending_approval' ? (
        <Alert tone="warn">
          The discount on this quote is above the approver's limit, so it is waiting for a decision. Until it is
          approved the price cannot go to the client.
        </Alert>
      ) : null}
      {status === 'approved' && !visited ? (
        <Alert tone="warn">
          No completed site visit is on record. The send will be refused until there is one.
        </Alert>
      ) : null}
      {quote.valid_until < today() && (status === 'sent' || status === 'viewed' || status === 'approved') ? (
        <Alert tone="error">This quote passed its validity date on {formatDate(quote.valid_until)}.</Alert>
      ) : null}

      <div class="ncc-grid ncc-grid--kpi">
        <KpiCard label="Status" value={<StatusBadge status={status} tone={QUOTE_TONE[status] ?? 'muted'} />} hint={`Raised by ${quote.created_by_name ?? 'unknown'}`} />
        <KpiCard label="Total" value={<Money paise={Number(quote.total_paise)} hidden={!value} />} hint={`Inclusive of ${Number(quote.gst_pct)}% GST`} />
        <KpiCard label="Discount" value={`${Number(quote.discount_pct)}%`} hint={quote.approved_by_name ? `Approved by ${quote.approved_by_name}` : 'Within the limit or not yet approved'} />
        <KpiCard label="Valid until" value={<DateText value={quote.valid_until} />} hint={`Quoted ${formatDate(quote.quote_date)}`} />
      </div>

      <Panel title="Pricing">
        <DefinitionList
          rows={[
            ['Basis', quote.pricing_basis.replace(/_/g, ' ')],
            ['Package', quote.package_name ?? 'none'],
            ['Built-up area', quote.built_up_area_sqft ? <Qty value={Number(quote.built_up_area_sqft)} unit="sqft" /> : '-'],
            ['Rate', <Money paise={numOrNull(quote.rate_per_sqft_paise)} hidden={!value} />],
            ['Base amount', <Money paise={Number(quote.base_amount_paise)} hidden={!value} />],
            ['Add-ons and extras', <Money paise={Number(quote.extras_amount_paise)} hidden={!value} />],
            ['Discount', <Money paise={Number(quote.discount_amount_paise)} hidden={!value} />],
            ['Subtotal', <Money paise={Number(quote.subtotal_paise)} hidden={!value} />],
            [`GST at ${Number(quote.gst_pct)}%`, <Money paise={Number(quote.gst_paise)} hidden={!value} />],
            ['Total', <Money paise={Number(quote.total_paise)} hidden={!value} />],
            ['Sent', quote.sent_at ? <DateText value={quote.sent_at} withTime /> : 'not sent'],
            ['Accepted', quote.accepted_at ? <DateText value={quote.accepted_at} withTime /> : '-'],
            ['Rejected because', quote.rejected_reason ?? '-'],
          ]}
        />
      </Panel>

      <Panel title="Lines">
        <DataTable
          columns={[
            { header: 'Type', cell: (l) => l.line_type.replace(/_/g, ' ') },
            { header: 'Description', cell: (l) => l.description },
            { header: 'Qty', numeric: true, cell: (l) => (l.qty === null ? '-' : <Qty value={Number(l.qty)} unit={l.unit_code ?? undefined} />) },
            { header: 'Rate', numeric: true, cell: (l) => <Money paise={numOrNull(l.rate_paise)} hidden={!value} /> },
            { header: 'Amount', numeric: true, cell: (l) => <Money paise={numOrNull(l.amount_paise)} hidden={!value} /> },
          ]}
          rows={lines}
          empty="No lines."
          caption="The package line, the discount line and the exclusion notes are written by the service, not typed."
        />
      </Panel>

      <Panel title="Payment schedule">
        <DataTable
          columns={[
            { header: 'Milestone', cell: (m: ScheduleRow) => m.name },
            { header: 'Percent', numeric: true, cell: (m: ScheduleRow) => `${m.percent}%` },
            { header: 'Of the total', numeric: true, cell: (m: ScheduleRow) => <Money paise={Math.round((Number(quote.total_paise) * m.percent) / 100)} hidden={!value} /> },
            { header: 'Trigger stage', numeric: true, cell: (m: ScheduleRow) => (m.triggerStageSeq === null ? '-' : String(m.triggerStageSeq)) },
          ]}
          rows={schedule}
          empty="No payment schedule on this quote."
          caption="Conversion turns these into the project's payment milestones."
        />
      </Panel>

      <Panel title="Exclusions">
        {quote.exclusions ? <pre style="white-space:pre-wrap;margin:0">{quote.exclusions}</pre> : <p class="ncc-muted">None recorded.</p>}
      </Panel>

      {canCreate && status === 'draft' ? (
        <Panel title="Submit for approval">
          <form method="post" action={`/api/crm/quotes/${quoteId}/submit`}>
            <CsrfInput token={csrf} />
            <p class="ncc-muted">
              A discount within your approval limit is applied straight away. Above it, the quote escalates and the
              price is frozen until somebody with the limit decides.
            </p>
            <button class="ncc-btn ncc-btn-primary" type="submit">
              Submit
            </button>
          </form>
        </Panel>
      ) : null}

      {status === 'pending_approval' ? (
        <Panel title="Discount approval">
          <ApprovalBar
            action={`/api/crm/quotes/${quoteId}/approve`}
            csrfToken={csrf}
            canApprove={canApprove && !mine}
            blockedReason={
              mine
                ? 'You raised this quote, so you cannot approve its own discount. That is what the escalation is for.'
                : 'You do not hold the discount approval permission.'
            }
          />
        </Panel>
      ) : null}

      {canCreate && status === 'approved' ? (
        <Panel title="Send it">
          <form method="post" action={`/api/crm/quotes/${quoteId}/send`}>
            <CsrfInput token={csrf} />
            <p class="ncc-muted">
              Emails the quote to {quote.email ?? 'the client, if an address is on the lead'} and moves the lead to
              quote sent. A failed email does not undo the send; it is reported and the quote still counts as issued.
            </p>
            <button class="ncc-btn ncc-btn-primary" type="submit">
              Send to the client
            </button>
          </form>
        </Panel>
      ) : null}

      {canCreate && (status === 'sent' || status === 'viewed') ? (
        <Panel title="What did the client say">
          <div class="ncc-row" style="gap:1.5rem;align-items:flex-start">
            <form class="ncc-stack" method="post" action={`/api/crm/quotes/${quoteId}/accept`}>
              <CsrfInput token={csrf} />
              <FormField label="Note" name="note" placeholder="Confirmed on the phone" />
              <button class="ncc-btn ncc-btn-primary" type="submit">
                Accepted
              </button>
            </form>
            <form class="ncc-stack" method="post" action={`/api/crm/quotes/${quoteId}/reject`}>
              <CsrfInput token={csrf} />
              <FormField label="Reason" name="reason" required placeholder="Went with a lower rate elsewhere" />
              <button class="ncc-btn ncc-btn-danger" type="submit">
                Rejected
              </button>
            </form>
          </div>
          <p class="ncc-muted">
            Accepting moves the lead to verbal agreement and is what makes conversion possible. Rejecting does not
            lose the lead: record the loss on the lead itself, with a reason the loss report can count.
          </p>
        </Panel>
      ) : null}

      <Panel title="Revisions">
        <DataTable
          columns={[
            { header: 'Revision', cell: (r) => (r.id === quoteId ? <strong>{`r${r.revision}`}</strong> : <a href={`/app/crm/quotes/${r.id}`}>{`r${r.revision}`}</a>) },
            { header: 'Date', cell: (r) => <DateText value={r.quote_date} /> },
            { header: 'Status', cell: (r) => <StatusBadge status={r.status} tone={QUOTE_TONE[r.status] ?? 'muted'} /> },
            { header: 'Discount', numeric: true, cell: (r) => `${Number(r.discount_pct)}%` },
            { header: 'Total', numeric: true, cell: (r) => <Money paise={Number(r.total_paise)} hidden={!value} /> },
            { header: 'Sent', cell: (r) => <DateText value={r.sent_at} withTime /> },
          ]}
          rows={revisions}
          empty="No revisions."
          caption="Every revision keeps the same quote number, so the client sees one document that changed rather than two documents."
        />
      </Panel>
    </>
  )
})

/* Quote writes ------------------------------------------------------------ */

crm.post('/api/crm/quotes/:id/submit', requirePermission(PERMISSIONS.CRM_QUOTE_CREATE), async (c) => {
  const quoteId = idParam(c, 'id')
  const quote = await q.findQuote(c.get('db'), quoteId)
  if (!quote) throw new NotFoundError('That quote does not exist.')
  await requireVisibleLead(c, quote.lead_id)

  const back = `/app/crm/quotes/${quoteId}`
  return guard(c, back, async () => {
    const out = await svc.submitQuote(c.get('db'), actorOf(c), quoteId, c.get('roleKeys'))
    if (out.status === 'approved') return `${out.quoteNo} approved at ${formatRupees(out.totalPaise)}.`
    return out.limitBps === null
      ? `${out.quoteNo} escalated: no discount limit is configured for your roles, so every discount needs a decision.`
      : `${out.quoteNo} escalated: ${out.discountPct}% is above your ${out.limitBps / 100}% limit.`
  })
})

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
  const quoteId = idParam(c, 'id')
  const quote = await q.findQuote(c.get('db'), quoteId)
  if (!quote) throw new NotFoundError('That quote does not exist.')
  await requireVisibleLead(c, quote.lead_id)

  const back = `/app/crm/quotes/${quoteId}`
  const body = (await readBody(c)) as Record<string, unknown>
  const decision = String(body.decision ?? 'approve')

  if (decision === 'reject') {
    const parsed = reasonSchema.safeParse({ reason: body.note })
    if (!parsed.success) return errRedirect(c, back, firstError(parsed.error))
    return guard(c, back, async () => {
      const out = await svc.declineQuote(c.get('db'), actorOf(c), quoteId, parsed.data.reason)
      return `${out.quoteNo} r${out.revision} declined and returned to draft.`
    })
  }

  return guard(c, back, async () => {
    const out = await svc.approveQuote(c.get('db'), actorOf(c), quoteId)
    return `${out.quoteNo} r${out.revision} approved at ${formatRupees(out.totalPaise)}.`
  })
})

crm.post('/api/crm/quotes/:id/send', requirePermission(PERMISSIONS.CRM_QUOTE_CREATE), async (c) => {
  const quoteId = idParam(c, 'id')
  const quote = await q.findQuote(c.get('db'), quoteId)
  if (!quote) throw new NotFoundError('That quote does not exist.')
  await requireVisibleLead(c, quote.lead_id)

  const back = `/app/crm/quotes/${quoteId}`
  return guard(c, back, async () => {
    const out = await svc.sendQuote(c.get('db'), actorOf(c), quoteId)
    const moved = out.stageMoved ? ' The lead moved to quote sent.' : ''
    if (out.emailed) return `${out.quoteNo} sent to ${out.recipient ?? 'the client'}.${moved}`
    return `${out.quoteNo} recorded as sent, but the email did not go: ${out.emailError ?? 'no address on the lead'}.${moved}`
  })
})

crm.post('/api/crm/quotes/:id/accept', requirePermission(PERMISSIONS.CRM_QUOTE_CREATE), async (c) => {
  const quoteId = idParam(c, 'id')
  const quote = await q.findQuote(c.get('db'), quoteId)
  if (!quote) throw new NotFoundError('That quote does not exist.')
  await requireVisibleLead(c, quote.lead_id)

  const back = `/app/crm/quotes/${quoteId}`
  const parsed = noteSchema.safeParse(await readBody(c))
  if (!parsed.success) return errRedirect(c, back, firstError(parsed.error))
  return guard(c, back, async () => {
    const out = await svc.acceptQuote(c.get('db'), actorOf(c), quoteId, parsed.data.note)
    return { to: `/app/crm/leads/${out.leadId}`, message: `${out.quoteNo} r${out.revision} accepted. The lead can now be converted.` }
  })
})

crm.post('/api/crm/quotes/:id/reject', requirePermission(PERMISSIONS.CRM_QUOTE_CREATE), async (c) => {
  const quoteId = idParam(c, 'id')
  const quote = await q.findQuote(c.get('db'), quoteId)
  if (!quote) throw new NotFoundError('That quote does not exist.')
  await requireVisibleLead(c, quote.lead_id)

  const back = `/app/crm/quotes/${quoteId}`
  const parsed = reasonSchema.safeParse(await readBody(c))
  if (!parsed.success) return errRedirect(c, back, firstError(parsed.error))
  return guard(c, back, async () => {
    const out = await svc.rejectQuote(c.get('db'), actorOf(c), quoteId, parsed.data.reason)
    return `${out.quoteNo} r${out.revision} rejected. Record the loss on the lead if it is over.`
  })
})

crm.post('/api/crm/quotes/:id/revise', requirePermission(PERMISSIONS.CRM_QUOTE_CREATE), async (c) => {
  const quoteId = idParam(c, 'id')
  const quote = await q.findQuote(c.get('db'), quoteId)
  if (!quote) throw new NotFoundError('That quote does not exist.')
  await requireVisibleLead(c, quote.lead_id)

  const back = `/app/crm/quotes/${quoteId}/revise`
  const parsed = quoteSchema.safeParse(await readBody(c))
  if (!parsed.success) return errRedirect(c, back, firstError(parsed.error))
  return guard(c, back, async () => {
    const out = await svc.reviseQuote(c.get('db'), actorOf(c), quoteId, parsed.data)
    return {
      to: `/app/crm/quotes/${out.quoteId}`,
      message: `${out.quoteNo} revision ${out.revision} drafted at ${formatRupees(out.totals.totalPaise)}.`,
    }
  })
})

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
`

crm.get('/api/crm/quotes/:id/print', requirePermission(...QUOTE_READ), async (c) => {
  const db = c.get('db')
  const quoteId = idParam(c, 'id')
  const quote = await q.findQuote(db, quoteId)
  if (!quote) throw new NotFoundError('That quote does not exist.')
  await requireVisibleLead(c, quote.lead_id)

  const value = canValue(c)
  const [lines, legalName, address, gstin, phone, email] = await Promise.all([
    q.quoteLines(db, quoteId),
    getSetting(db, 'company.legal_name', 'Neelachandra Construction and Interiors'),
    getSetting(db, 'company.address_line', ''),
    getSetting(db, 'company.gstin', ''),
    getSetting(db, 'company.phone_primary', ''),
    getSetting(db, 'company.email_enquiry', ''),
  ])
  /*
   * Rule 4: the inclusion list is read live from package_spec_lines at print
   * time, not copied onto the quote, so the printed sheet says what the public
   * site advertises today. The consequence is recorded in DECISIONS.md under
   * uq_packages_slug — a spec edit changes the wording on a quote already sent.
   * The money cannot move that way: every priced figure is snapshotted on the
   * quotes row and read from there.
   */
  const spec = quote.package_id === null ? [] : await q.packageSpec(db, Number(quote.package_id))
  const specGroups: Array<{ name: string; lines: typeof spec }> = []
  for (const line of spec) {
    const last = specGroups[specGroups.length - 1]
    if (last && last.name === line.group_name) last.lines.push(line)
    else specGroups.push({ name: line.group_name, lines: [line] })
  }
  const schedule = readSchedule(quote.payment_schedule_json)
  const exclusions = String(quote.exclusions ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  const money = (paise: unknown) => (value ? formatRupees(Number(paise)) : 'restricted')
  const site = [quote.site_locality, quote.site_city].filter(Boolean).join(', ')
  const issued = quote.status === 'sent' || quote.status === 'viewed' || quote.status === 'accepted'

  const doc = (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>
          {quote.quote_no} r{quote.revision}
        </title>
        <style>{QUOTE_PRINT_CSS}</style>
      </head>
      <body>
        <div class="head">
          <div class="co">
            <h1>{legalName}</h1>
            {address ? <div class="muted">{address}</div> : null}
            <div class="muted">
              {[gstin ? `GSTIN ${gstin}` : '', phone, email].filter(Boolean).join(' | ')}
            </div>
          </div>
          <div class="ref">
            <strong>QUOTATION</strong>
            <div>
              {quote.quote_no} r{quote.revision}
            </div>
            <div class="muted">Dated {formatDate(quote.quote_date)}</div>
            <div class="muted">Valid until {formatDate(quote.valid_until)}</div>
          </div>
        </div>

        {issued ? null : (
          <p class="draft">
            Not issued. This quote is {String(quote.status).replace(/_/g, ' ')} and the price on it is not yet
            offered to the client.
          </p>
        )}

        <div class="two">
          <div class="box">
            <h2 style="margin-top:0">To</h2>
            <dl>
              <dt>Name</dt>
              <dd>{quote.contact_name}</dd>
              <dt>Phone</dt>
              <dd>{quote.phone}</dd>
              {quote.email ? (
                <>
                  <dt>Email</dt>
                  <dd>{quote.email}</dd>
                </>
              ) : null}
              <dt>Lead</dt>
              <dd>{quote.lead_no}</dd>
            </dl>
          </div>
          <div class="box">
            <h2 style="margin-top:0">Site</h2>
            <dl>
              <dt>Location</dt>
              <dd>{site || '-'}</dd>
              {quote.survey_number ? (
                <>
                  <dt>Survey no</dt>
                  <dd>{quote.survey_number}</dd>
                </>
              ) : null}
              <dt>Package</dt>
              <dd>{quote.package_name ?? 'As specified below'}</dd>
              <dt>Basis</dt>
              <dd>{String(quote.pricing_basis).replace(/_/g, ' ')}</dd>
            </dl>
          </div>
        </div>

        <h2>Scope and price</h2>
        <table>
          <thead>
            <tr>
              <th>Description</th>
              <th class="num">Qty</th>
              <th class="num">Rate</th>
              <th class="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr>
                <td>{l.description}</td>
                <td class="num">
                  {l.qty === null || l.qty === undefined ? '' : String(Number(l.qty))}
                  {l.unit_code ? ` ${l.unit_code}` : ''}
                </td>
                <td class="num">{l.rate_paise === null || l.rate_paise === undefined ? '' : money(l.rate_paise)}</td>
                <td class="num">{l.amount_paise === null || l.amount_paise === undefined ? '' : money(l.amount_paise)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <table class="totals">
          <tbody>
            <tr>
              <td>Base amount</td>
              <td class="num">{money(quote.base_amount_paise)}</td>
            </tr>
            <tr>
              <td>Add-ons and extra work</td>
              <td class="num">{money(quote.extras_amount_paise)}</td>
            </tr>
            {Number(quote.discount_amount_paise) > 0 ? (
              <tr>
                <td>Less discount at {Number(quote.discount_pct)}%</td>
                <td class="num">- {money(quote.discount_amount_paise)}</td>
              </tr>
            ) : null}
            <tr>
              <td>Subtotal</td>
              <td class="num">{money(quote.subtotal_paise)}</td>
            </tr>
            <tr>
              <td>GST at {Number(quote.gst_pct)}%</td>
              <td class="num">{money(quote.gst_paise)}</td>
            </tr>
            <tr class="grand">
              <td>Total payable</td>
              <td class="num">{money(quote.total_paise)}</td>
            </tr>
          </tbody>
        </table>

        {schedule.length > 0 ? (
          <>
            <h2>Payment schedule</h2>
            <table>
              <thead>
                <tr>
                  <th>Milestone</th>
                  <th class="num">Percent</th>
                  <th class="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {schedule.map((m) => (
                  <tr>
                    <td>{m.name}</td>
                    <td class="num">{m.percent}%</td>
                    <td class="num">{money(Math.round((Number(quote.total_paise) * m.percent) / 100))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : null}

        {specGroups.length > 0 ? (
          <>
            <h2>Included in this price</h2>
            <table>
              <thead>
                <tr>
                  <th>Group</th>
                  <th>Item</th>
                  <th>Specification</th>
                  <th>Brands</th>
                </tr>
              </thead>
              <tbody>
                {specGroups.map((group) =>
                  group.lines.map((line, i) => (
                    <tr>
                      <td>{i === 0 ? group.name : ''}</td>
                      <td>{line.label}</td>
                      <td>{line.spec_value ?? '-'}</td>
                      <td class="muted">{line.brand_options ?? '-'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            <p class="muted" style="font-size:9pt;margin-top:1mm">
              The published specification for {quote.package_name} as it stands on {formatDate(today())}.
            </p>
          </>
        ) : null}

        {exclusions.length > 0 ? (
          <>
            <h2>Not included in this price</h2>
            <ol class="terms">
              {exclusions.map((line) => (
                <li>{line}</li>
              ))}
            </ol>
          </>
        ) : null}

        <h2>Terms</h2>
        <ol class="terms">
          <li>This quotation is valid until {formatDate(quote.valid_until)}. Rates are subject to revision after that date.</li>
          <li>Anything not listed under the scope above is excluded and will be quoted separately before it is executed.</li>
          <li>Statutory deposits, sanction and approval charges payable to any authority are to the client's account.</li>
          <li>Payments fall due on the milestones above and work continues on receipt.</li>
          <li>Prices are exclusive of any change in the rate of GST or of any new levy notified after the date of this quotation.</li>
        </ol>

        <div class="sign">
          <div>
            For {legalName}
            <br />
            <br />
            Authorised signatory
          </div>
          <div>
            Accepted by {quote.contact_name}
            <br />
            <br />
            Signature and date
          </div>
        </div>
      </body>
    </html>
  )

  return c.html(html`<!DOCTYPE html>${doc}`)
})

/* Reports ----------------------------------------------------------------- */

/**
 * The date window every report shares. Defaults to the current financial year
 * to date, because that is the window the numbers are reported in.
 */
function reportRange(c: Ctx): { from: string; to: string } {
  const to = queryParam(c, 'to') ?? today()
  const from = queryParam(c, 'from') ?? financialYearBounds(financialYear(to)).start
  return { from, to }
}

function RangeForm(props: { action: string; from: string; to: string }) {
  return (
    <form method="get" action={props.action} class="ncc-toolbar">
      <FormField label="From" name="from" type="date" value={props.from} />
      <FormField label="To" name="to" type="date" value={props.to} />
      <button class="ncc-btn" type="submit">
        Show
      </button>
    </form>
  )
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
  const db = c.get('db')
  const { from, to } = reportRange(c)
  const scope = scopeOf(c)
  const targetHours = await getSetting(db, 'crm.first_response_target_hours', 4)
  const [rows, totals, breaches, dormant] = await Promise.all([
    q.funnelReport(db, from, to),
    q.pipelineTotals(db, scope),
    q.firstResponseBreaches(db, targetHours, scope),
    q.dormantCandidates(db),
  ])

  const entered = new Map(rows.map((r) => [r.to_stage, r]))
  const top = Number(entered.get('contacted')?.leads ?? 0)

  return page(
    c,
    {
      title: 'Funnel',
      path: '/app/crm/reports/funnel',
      subtitle: `Stages entered between ${formatDate(from)} and ${formatDate(to)}`,
    },
    <>
      {banner(c)}
      <Panel title="Window">
        <RangeForm action="/app/crm/reports/funnel" from={from} to={to} />
        <p class="ncc-hint">
          A lead counts in a row on the date it entered that stage, not on the date it was created, so a lead created
          in March and quoted in April appears in both years' funnels at the stage it reached in each.
        </p>
        <div class="ncc-row">
          <a class="ncc-btn" href={`/app/crm/reports/sources?from=${from}&to=${to}`}>
            Sources
          </a>
          <a class="ncc-btn" href={`/app/crm/reports/losses?from=${from}&to=${to}`}>
            Losses
          </a>
        </div>
      </Panel>

      <Panel title="Stages entered">
        <DataTable
          columns={[
            { header: 'Stage', cell: (r) => <StatusBadge status={r.to_stage} tone={STAGE_TONE[r.to_stage] ?? 'muted'} /> },
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
          ]}
          rows={rows}
          empty="No stage was entered in that window."
          caption="Counted from lead_stage_history, so a lead that went forward, back and forward again is counted at each entry."
        />
      </Panel>

      <Panel title="Open pipeline now">
        <DataTable
          columns={[
            { header: 'Stage', cell: (r: q.StageTotal) => <StatusBadge status={r.stage} tone={STAGE_TONE[r.stage] ?? 'muted'} /> },
            { header: 'Leads', numeric: true, cell: (r: q.StageTotal) => String(r.n) },
            { header: 'Value', numeric: true, cell: (r: q.StageTotal) => <Money paise={Number(r.value_paise)} /> },
            { header: 'Weighted', numeric: true, cell: (r: q.StageTotal) => <Money paise={Number(r.weighted_paise)} /> },
          ]}
          rows={totals}
          empty="No open leads."
          caption="Weighted by the stage probability, or by the override where one was set. This is a forecast, not a commitment."
        />
      </Panel>

      <Panel title={`No first response after ${targetHours} hours`}>
        <DataTable
          columns={[
            { header: 'Lead', cell: (r) => <a href={`/app/crm/leads/${r.id}`}>{r.lead_no}</a> },
            { header: 'Contact', cell: (r) => r.contact_name },
            { header: 'Phone', cell: (r) => r.phone },
            { header: 'Came in', cell: (r) => <DateText value={r.created_at} withTime /> },
            { header: 'Owner', cell: (r) => r.assignee_name ?? 'unassigned' },
          ]}
          rows={breaches}
          empty="Nothing breached the target."
          caption="Open leads with first_response_at still null. A lead answered late is not here: the query lists the ones nobody has answered at all, which is the list worth acting on."
        />
      </Panel>

      <Panel title="Going quiet">
        <DataTable
          columns={[
            { header: 'Lead', cell: (r) => <a href={`/app/crm/leads/${r.id}`}>{r.lead_no}</a> },
            { header: 'Stage', cell: (r) => <StatusBadge status={r.stage} tone={STAGE_TONE[r.stage] ?? 'muted'} /> },
          ]}
          rows={dormant}
          empty="Nothing is dormant."
          caption={`Untouched for ${q.DORMANT_DAYS} days. The nightly cron moves these to dormant; this is the list before it runs. Unscoped, because the cron that acts on it is.`}
        />
      </Panel>
    </>
  )
})

crm.get('/app/crm/reports/sources', requirePermission(PERMISSIONS.CRM_VIEW_PIPELINE_VALUE), async (c) => {
  const db = c.get('db')
  const { from, to } = reportRange(c)
  const rows = await q.sourceReport(db, from, to)

  return page(
    c,
    {
      title: 'Sources',
      // Highlights Funnel in the sidebar. Sources is a page you reach from the
      // funnel, so pointing activeHref at its own unlisted href would leave the
      // sidebar with nothing lit at all.
      path: '/app/crm/reports/funnel',
      subtitle: `Leads created between ${formatDate(from)} and ${formatDate(to)}`,
      actions: (
        <a class="ncc-btn" href={`/app/crm/reports/funnel?from=${from}&to=${to}`}>
          Back to the funnel
        </a>
      ),
    },
    <>
      {banner(c)}
      <Panel title="Window">
        <RangeForm action="/app/crm/reports/sources" from={from} to={to} />
      </Panel>
      <Panel title="Where the work came from">
        <DataTable
          columns={[
            { header: 'Source', cell: (r) => r.source_name ?? 'not recorded' },
            { header: 'Leads', numeric: true, cell: (r) => String(r.leads) },
            { header: 'Won', numeric: true, cell: (r) => String(r.won) },
            { header: 'Lost', numeric: true, cell: (r) => String(r.lost) },
            {
              header: 'Win rate',
              numeric: true,
              cell: (r) => {
                const decided = Number(r.won) + Number(r.lost)
                return decided === 0 ? '-' : `${Math.round((Number(r.won) / decided) * 1000) / 10}%`
              },
            },
            { header: 'Won value', numeric: true, cell: (r) => <Money paise={Number(r.won_value_paise)} /> },
          ]}
          rows={rows}
          empty="No lead was created in that window."
          caption="Win rate is of the decided leads only. A source whose leads are all still open has no rate yet, which is different from a rate of zero."
        />
      </Panel>
    </>
  )
})

crm.get('/app/crm/reports/losses', requirePermission(PERMISSIONS.CRM_LEAD_VIEW), async (c) => {
  const db = c.get('db')
  const { from, to } = reportRange(c)
  const [rows, competitors] = await Promise.all([q.lossReport(db, from, to), q.listCompetitors(db)])
  const total = rows.reduce((n, r) => n + Number(r.leads), 0)

  return page(
    c,
    {
      title: 'Losses',
      // Guarded on crm.lead_view, not on the pipeline-value permission: a loss
      // reason is not a number, and a sales executive who cannot see the
      // forecast still needs to know what the company keeps losing on.
      path: '/app/crm',
      subtitle: `Leads lost between ${formatDate(from)} and ${formatDate(to)}`,
      actions: can(c, PERMISSIONS.CRM_VIEW_PIPELINE_VALUE) ? (
        <a class="ncc-btn" href={`/app/crm/reports/funnel?from=${from}&to=${to}`}>
          Back to the funnel
        </a>
      ) : undefined,
    },
    <>
      {banner(c)}
      <Panel title="Window">
        <RangeForm action="/app/crm/reports/losses" from={from} to={to} />
        <p class="ncc-hint">
          Rule 8 requires the reason to be one of the enumerated ones, so this table is countable. That is the whole
          point of refusing a free-text reason on the lose form.
        </p>
      </Panel>
      <Panel title="Why work was lost">
        <DataTable
          columns={[
            { header: 'Reason', cell: (r) => String(r.lost_reason ?? 'not recorded').replace(/_/g, ' ') },
            { header: 'To', cell: (r) => r.lost_to_competitor ?? '-' },
            { header: 'Leads', numeric: true, cell: (r) => String(r.leads) },
            { header: 'Share', numeric: true, cell: (r) => (total === 0 ? '-' : `${Math.round((Number(r.leads) / total) * 1000) / 10}%`) },
          ]}
          rows={rows}
          empty="Nothing was lost in that window."
        />
      </Panel>
      <Panel title="Competitors on record">
        <DataTable
          columns={[
            { header: 'Name', cell: (r) => r.name },
            { header: 'Typical rate', numeric: true, cell: (r) => <Money paise={numOrNull(r.typical_rate_per_sqft_paise)} /> },
            { header: 'Notes', cell: (r) => r.notes ?? '-' },
            { header: 'Updated', cell: (r) => <DateText value={r.updated_at} withTime /> },
          ]}
          rows={competitors}
          empty="No competitor has been named on a loss yet."
          caption="Created by the lose form, which matches on the name it is given rather than asking for a competitor to be set up first. The rate is the last one a lost lead reported, so it is hearsay from the client, not a quote we have seen."
        />
      </Panel>
    </>
  )
})

export default crm
