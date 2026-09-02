import type { Child } from 'hono/jsx'
import { formatRupees, formatPaiseCompact } from '../../lib/money.js'
import { formatDate, formatDateTime } from '../../lib/dates.js'

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
export function Money(props: { paise: number | null | undefined; compact?: boolean; hidden?: boolean }) {
  if (props.hidden) return <span class="ncc-muted">restricted</span>
  if (props.paise === null || props.paise === undefined) return <span class="ncc-muted">-</span>
  return (
    <span class="ncc-num">{props.compact ? formatPaiseCompact(props.paise) : formatRupees(props.paise)}</span>
  )
}

export function Qty(props: { value: number | null | undefined; unit?: string | null }) {
  if (props.value === null || props.value === undefined) return <span class="ncc-muted">-</span>
  // Trailing zeros on a quantity are noise: 12.000 bags reads worse than 12.
  const n = Number(props.value)
  const text = Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)))
  return (
    <span class="ncc-num">
      {text}
      {props.unit ? ` ${props.unit}` : ''}
    </span>
  )
}

export function DateText(props: { value: string | null | undefined; withTime?: boolean }) {
  const text = props.withTime ? formatDateTime(props.value) : formatDate(props.value)
  if (!text) return <span class="ncc-muted">-</span>
  return <span>{text}</span>
}

/* Status ----------------------------------------------------------------- */

type Tone = 'muted' | 'ok' | 'warn' | 'danger'

/**
 * One status vocabulary for the whole app. A status word means the same
 * colour on every screen, so "on_hold" is never amber in projects and grey in
 * inventory.
 */
const TONES: Record<string, Tone> = {
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
}

export function StatusBadge(props: { status: string | null | undefined; tone?: Tone }) {
  if (!props.status) return <span class="ncc-muted">-</span>
  const tone = props.tone ?? TONES[props.status] ?? 'muted'
  return (
    <span class={`ncc-badge ncc-badge-${tone}`}>{props.status.replace(/_/g, ' ')}</span>
  )
}

/* Forms ------------------------------------------------------------------ */

export interface FormFieldProps {
  label: string
  name: string
  type?: string
  value?: string | number | null
  required?: boolean
  error?: string | null
  hint?: string
  placeholder?: string
  step?: string
  min?: string
  max?: string
  autocomplete?: string
  disabled?: boolean
  options?: Array<{ value: string; label: string; selected?: boolean }>
  rows?: number
}

export function FormField(props: FormFieldProps) {
  const value = props.value === null || props.value === undefined ? '' : String(props.value)
  return (
    <label class="ncc-field">
      <span>
        {props.label}
        {props.required ? <abbr title="required"> *</abbr> : null}
      </span>
      {props.options ? (
        <select name={props.name} required={props.required} disabled={props.disabled}>
          {props.options.map((o) => (
            <option value={o.value} selected={o.selected}>
              {o.label}
            </option>
          ))}
        </select>
      ) : props.rows ? (
        <textarea
          name={props.name}
          rows={props.rows}
          required={props.required}
          placeholder={props.placeholder}
          disabled={props.disabled}
        >
          {value}
        </textarea>
      ) : (
        <input
          name={props.name}
          type={props.type ?? 'text'}
          value={value}
          required={props.required}
          placeholder={props.placeholder}
          step={props.step}
          min={props.min}
          max={props.max}
          autocomplete={props.autocomplete}
          disabled={props.disabled}
        />
      )}
      {props.hint ? <span class="ncc-hint">{props.hint}</span> : null}
      {props.error ? <strong class="ncc-field-error">{props.error}</strong> : null}
    </label>
  )
}

export function CsrfInput(props: { token: string }) {
  return <input type="hidden" name="nc_csrf" value={props.token} />
}

/* Tables ----------------------------------------------------------------- */

export interface Column<T> {
  header: string
  cell: (row: T) => Child
  numeric?: boolean
}

export function DataTable<T>(props: {
  columns: Column<T>[]
  rows: T[]
  empty?: string
  caption?: string
}) {
  if (props.rows.length === 0) {
    return <div class="ncc-empty">{props.empty ?? 'Nothing to show yet.'}</div>
  }
  return (
    <div style="overflow-x:auto">
      <table class="ncc-table">
        {props.caption ? <caption class="ncc-hint">{props.caption}</caption> : null}
        <thead>
          <tr>
            {props.columns.map((col) => (
              <th scope="col" class={col.numeric ? 'ncc-num' : undefined}>
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row) => (
            <tr>
              {props.columns.map((col) => (
                <td class={col.numeric ? 'ncc-num' : undefined}>{col.cell(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* Widgets ---------------------------------------------------------------- */

export function KpiCard(props: { label: string; value: Child; hint?: string; href?: string }) {
  const body = (
    <div class="ncc-card">
      <p class="ncc-kpi__label">{props.label}</p>
      <div class="ncc-kpi__value">{props.value}</div>
      {props.hint ? <div class="ncc-kpi__hint">{props.hint}</div> : null}
    </div>
  )
  return props.href ? <a href={props.href} style="text-decoration:none;color:inherit">{body}</a> : body
}

export function Panel(props: { title: string; actions?: Child; children?: Child }) {
  return (
    <section class="ncc-card">
      <div class="ncc-page-head" style="margin-bottom:.75rem">
        <h2 style="margin:0">{props.title}</h2>
        {props.actions ? <div class="ncc-row">{props.actions}</div> : null}
      </div>
      {props.children}
    </section>
  )
}

export function Progress(props: { pct: number | null | undefined }) {
  const pct = Math.max(0, Math.min(100, Number(props.pct ?? 0)))
  return (
    <span class="ncc-row" style="gap:.5rem">
      <span class="ncc-progress" role="img" aria-label={`${pct.toFixed(1)} percent complete`}>
        <span style={`width:${pct}%`}></span>
      </span>
      <span class="ncc-num" style="min-width:3.5rem">
        {pct.toFixed(1)}%
      </span>
    </span>
  )
}

export function Alert(props: { tone?: 'error' | 'ok' | 'warn'; children?: Child }) {
  const tone = props.tone ? ` ncc-alert--${props.tone}` : ''
  return (
    <div class={`ncc-alert${tone}`} role={props.tone === 'error' ? 'alert' : undefined}>
      {props.children}
    </div>
  )
}

export function DefinitionList(props: { rows: Array<[string, Child]> }) {
  return (
    <dl class="ncc-dl">
      {props.rows.map(([k, v]) => (
        <>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </>
      ))}
    </dl>
  )
}

export function Tabs(props: { tabs: Array<{ label: string; href: string }>; active: string }) {
  return (
    <nav class="ncc-tabs" aria-label="Sections">
      {props.tabs.map((t) => (
        <a href={t.href} aria-current={t.href === props.active ? 'page' : undefined}>
          {t.label}
        </a>
      ))}
    </nav>
  )
}

/**
 * Approve / reject with a reason (spec 3).
 *
 * The reject reason is required, not optional. A rejection with no reason
 * sends the raiser back to guess what was wrong, and the audit row then says
 * nothing useful a year later.
 */
export function ApprovalBar(props: {
  action: string
  csrfToken: string
  canApprove: boolean
  blockedReason?: string
}) {
  if (!props.canApprove) {
    return <Alert tone="warn">{props.blockedReason ?? 'You cannot approve this document.'}</Alert>
  }
  return (
    <form class="ncc-card ncc-stack" method="post" action={props.action}>
      <CsrfInput token={props.csrfToken} />
      <FormField
        label="Note or reason"
        name="note"
        rows={2}
        hint="Required when rejecting. Recorded in the audit log either way."
      />
      <div class="ncc-row">
        <button class="ncc-btn ncc-btn-primary" type="submit" name="decision" value="approve">
          Approve
        </button>
        <button class="ncc-btn ncc-btn-danger" type="submit" name="decision" value="reject">
          Reject
        </button>
      </div>
    </form>
  )
}

export function Timeline(props: {
  entries: Array<{ when: string; who?: string | null; what: Child }>
}) {
  if (props.entries.length === 0) return <div class="ncc-empty">No history yet.</div>
  return (
    <ol class="ncc-stack" style="list-style:none;padding:0;margin:0">
      {props.entries.map((e) => (
        <li style="border-left:2px solid var(--ncc-border);padding-left:.85rem">
          <div class="ncc-hint">
            {formatDateTime(e.when)}
            {e.who ? ` by ${e.who}` : ''}
          </div>
          <div>{e.what}</div>
        </li>
      ))}
    </ol>
  )
}

export function Pager(props: { page: number; pageSize: number; total: number; baseHref: string }) {
  const pages = Math.max(1, Math.ceil(props.total / props.pageSize))
  if (pages <= 1) return null
  const sep = props.baseHref.includes('?') ? '&' : '?'
  return (
    <nav class="ncc-row" aria-label="Pagination" style="margin-top:.9rem">
      {props.page > 1 ? (
        <a class="ncc-btn" href={`${props.baseHref}${sep}page=${props.page - 1}`}>
          Previous
        </a>
      ) : null}
      <span class="ncc-hint">
        Page {props.page} of {pages}, {props.total} record{props.total === 1 ? '' : 's'}
      </span>
      {props.page < pages ? (
        <a class="ncc-btn" href={`${props.baseHref}${sep}page=${props.page + 1}`}>
          Next
        </a>
      ) : null}
    </nav>
  )
}
