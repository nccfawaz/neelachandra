import { Hono } from 'hono'
import type { Context } from 'hono'
import { html } from 'hono/html'
import type { Child } from 'hono/jsx'
import type { AppEnv } from '../../types.js'
import { currentUser, currentScope, currentSession } from '../../types.js'
import { page, banner, okRedirect, errRedirect, pageParam, queryParam } from '../../dashboard/render.js'
import {
  Alert,
  CsrfInput,
  DataTable,
  DateText,
  DefinitionList,
  FormField,
  KpiCard,
  Money,
  Pager,
  Panel,
  Qty,
  StatusBadge,
  type Column,
} from '../../dashboard/components/index.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { PERMISSIONS } from '../../lib/permissions.js'
import { readBody } from '../../middleware/csrf.js'
import { NotFoundError } from '../../lib/errors.js'
import { formatRupees } from '../../lib/money.js'
import { addDays, daysBetween, formatDate, today } from '../../lib/dates.js'
import { getSetting } from '../../lib/settings.js'
import * as q from './queries.js'
import * as svc from './service.js'
import {
  ADJUSTMENT_REASONS,
  ISSUED_TO_TYPES,
  PO_STATUSES,
  REQUISITION_STATUSES,
  VENDOR_STATUSES,
  VENDOR_TYPES,
  adjustmentSchema,
  brandApprovalSchema,
  equipmentDeploySchema,
  equipmentReturnSchema,
  firstError,
  grnSchema,
  issueReturnSchema,
  issueSchema,
  itemBrandSchema,
  itemSchema,
  openingStockSchema,
  poSchema,
  poShortCloseSchema,
  rejectSchema,
  requisitionApproveSchema,
  requisitionSchema,
  transferReceiveSchema,
  transferSchema,
  vendorRateSchema,
  vendorRatingSchema,
  vendorSchema,
  vendorStatusSchema,
} from './schemas.js'

/**
 * Inventory routes (spec 6.4).
 *
 * Replicates the projects module's shape: queries.ts reads, service.ts writes,
 * schemas.ts validates at the boundary, and this file only wires them to URLs
 * and renders. Rate visibility is passed into the queries as canViewRates so
 * money columns are absent from the SELECT for a storekeeper rather than
 * blanked in the template (spec 4.2).
 *
 * Three places where this file departs from the letter of the spec, recorded
 * here rather than resolved silently:
 *
 * 1. Spec 6.4 guards GET /app/inventory/items with `inventory.item_manage`,
 *    but nav.ts shows that link to `inventory.view` holders. Guarding it as
 *    the spec says would break the navigation invariant that a link a user can
 *    see is a link that neither 404s nor 403s. Reads here take either
 *    permission; every write takes item_manage alone. Same reasoning for
 *    /app/inventory/po, which nav.ts already lists for po_create *or*
 *    approve_po, and which an approver has to be able to open.
 *
 * 2. Spec 6.4's table has no permission for writing equipment deployment, and
 *    there is no `inventory.equipment_*` key in lib/permissions.ts. Deploy and
 *    return take `inventory.transfer`, on the grounds that both move company
 *    property between sites. Flagged rather than invented as a new key.
 *
 * 3. Spec 6.4 names src/modules/inventory/pages/*.tsx. The projects module,
 *    which is the pattern this replicates, keeps its JSX in routes.tsx and has
 *    no pages/ directory. Following the pattern wins here.
 */

const inventory = new Hono<AppEnv>()

type Ctx = Context<AppEnv>

function actorOf(c: Ctx): svc.Actor {
  return { userId: currentUser(c).id, ip: c.get('clientIp') }
}

/** Rate and value visibility (spec 6.4: "rates hidden without view_rates"). */
function canRates(c: Ctx): boolean {
  return c.get('perms').has(PERMISSIONS.INVENTORY_VIEW_RATES)
}

function can(c: Ctx, key: string): boolean {
  return c.get('perms').has(key)
}

function idParam(c: Ctx, name: string): number {
  const n = Number(c.req.param(name))
  if (!Number.isInteger(n) || n < 1) throw new NotFoundError('Not found')
  return n
}

const PAGE_SIZE = 25

/**
 * How many blank grid rows a document form renders.
 *
 * The spec's LineItemGrid is an Alpine component that adds rows on demand.
 * Nothing in src/ uses Alpine yet, so the grid here is N server-rendered rows
 * and ?rows= grows it. That keeps the form usable with scripting off, which is
 * the state a site office on a bad connection is often in, and the server is
 * the authority for the arithmetic either way (spec 6.4 pages note).
 */
function rowCount(c: Ctx, dflt = 8): number {
  const n = Number(queryParam(c, 'rows') ?? dflt)
  return Number.isInteger(n) && n > 0 && n <= 60 ? n : dflt
}

const blankRows = (n: number): number[] => Array.from({ length: n }, (_, i) => i)

type ItemOption = Awaited<ReturnType<typeof q.itemOptions>>[number]

/**
 * The item column of a line grid.
 *
 * A plain select rather than a typeahead: every grid column has to post on
 * every row so the columns stay index-aligned, and a select does that with no
 * script. An empty value makes the row a no-op, which is how a partly filled
 * grid is submitted.
 */
function ItemCell(props: { items: readonly ItemOption[]; selected?: number | null }) {
  return (
    <select name="itemId">
      <option value="">-</option>
      {props.items.map((i) => (
        <option value={String(i.id)} selected={props.selected === i.id}>
          {i.code} - {i.name} ({i.unit_code})
        </option>
      ))}
    </select>
  )
}

/**
 * The editable line grid.
 *
 * DataTable renders read-only cells from data; this renders N input rows, so it
 * takes headers and the rows as children. Six document forms use it, which is
 * the whole reason it exists rather than each form spelling out the table.
 */
function LineGrid(props: { headers: readonly string[]; hint?: string; children?: Child }) {
  return (
    <div style="overflow-x:auto">
      <table class="ncc-table">
        {props.hint ? <caption class="ncc-hint">{props.hint}</caption> : null}
        <thead>
          <tr>
            {props.headers.map((h) => (
              <th scope="col">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{props.children}</tbody>
      </table>
    </div>
  )
}

/** A quantity cell. step 0.001 matches DECIMAL(14,3) on every quantity column. */
function QtyCell(props: { name: string; value?: number | string | null; max?: number | null }) {
  return (
    <input
      type="number"
      name={props.name}
      step="0.001"
      min="0"
      max={props.max === null || props.max === undefined ? undefined : String(props.max)}
      value={props.value === null || props.value === undefined ? '' : String(props.value)}
    />
  )
}

/** A rupee cell. The schema converts to paise once, on the way in. */
function RupeeCell(props: { name: string; value?: number | string | null }) {
  return (
    <input
      type="number"
      name={props.name}
      step="0.01"
      min="0"
      value={props.value === null || props.value === undefined ? '' : String(props.value)}
    />
  )
}

function selectOptions(
  rows: readonly { id: number; code?: string | null; name: string }[],
  selected?: number | null,
  blank = 'Choose one'
): Array<{ value: string; label: string; selected?: boolean }> {  return [
    { value: '', label: blank },
    ...rows.map((r) => ({
      value: String(r.id),
      label: r.code ? `${r.code} - ${r.name}` : r.name,
      selected: selected === r.id,
    })),
  ]
}

function enumOptions(values: readonly string[], selected?: string | null, blank?: string) {
  const opts = values.map((v) => ({ value: v, label: v.replace(/_/g, ' '), selected: selected === v }))
  return blank ? [{ value: '', label: blank }, ...opts] : opts
}

const YES_NO = (selected: boolean) => [
  { value: '1', label: 'Yes', selected },
  { value: '0', label: 'No', selected: !selected },
]

/**
 * Reads a money column that the query only selected when the caller holds
 * inventory.view_rates.
 *
 * Only stockRows() has an explicit row interface with an optional value_paise;
 * the rest add the money columns with a conditional .select(), so the compiler
 * sees the narrow shape and the property is genuinely absent at runtime for a
 * caller without the permission. The key union keeps a typo from turning into
 * a silent null.
 */
type PaiseColumn =
  | 'rate_paise'
  | 'value_paise'
  | 'line_total_paise'
  | 'subtotal_paise'
  | 'gst_paise'
  | 'freight_paise'
  | 'total_paise'
  | 'invoice_amount_paise'
  | 'hire_rate_per_day_paise'

function paiseOf(row: object, key: PaiseColumn): number | null {
  const v = (row as Record<string, unknown>)[key]
  return v === null || v === undefined ? null : Number(v)
}

/* Stock ------------------------------------------------------------------- */

type StockListRow = Awaited<ReturnType<typeof q.stockRows>>[number]

inventory.get('/app/inventory', requirePermission(PERMISSIONS.INVENTORY_VIEW), async (c) => {
  const db = c.get('db')
  const scope = currentScope(c)
  const rates = canRates(c)
  const { page: pageNo, offset, pageSize } = pageParam(c, PAGE_SIZE)
  const search = queryParam(c, 'q') ?? null
  const categoryId = Number(queryParam(c, 'categoryId') ?? '') || null
  const locationId = Number(queryParam(c, 'locationId') ?? '') || null
  const belowReorder = queryParam(c, 'belowReorder') === '1'
  const filters = { q: search, categoryId, locationId, belowReorder }

  const [rows, total, summary, counts, alerts, categories, locations] = await Promise.all([
    q.stockRows(db, scope, { ...filters, canViewRates: rates, limit: pageSize, offset }),
    q.stockRowCount(db, scope, filters),
    q.stockSummary(db, scope, rates),
    q.inventoryCounts(db, scope),
    svc.stockAlerts(db, scope, { limit: 12 }),
    q.categoryOptions(db),
    q.locationOptions(db, scope),
  ])

  const columns: Column<StockListRow>[] = [
    {
      header: 'Item',
      cell: (r) => (
        <>
          <a href={`/app/inventory/items/${r.item_id}`}>
            <strong>{r.item_name}</strong>
          </a>
          <div class="ncc-muted">
            {r.item_code} - {r.category_name}
          </div>
        </>
      ),
    },
    { header: 'Store', cell: (r) => r.location_name },
    { header: 'On hand', numeric: true, cell: (r) => <Qty value={Number(r.qty_on_hand)} unit={r.unit_code} /> },
    {
      header: 'Reorder at',
      numeric: true,
      cell: (r) => (r.reorder_level === null ? <span class="ncc-muted">not set</span> : <Qty value={Number(r.reorder_level)} />),
    },
    { header: 'Value', numeric: true, cell: (r) => <Money paise={r.value_paise ?? null} hidden={!rates} /> },
    {
      header: '',
      cell: (r) => <a href={`/app/inventory/items/${r.item_id}/ledger?locationId=${r.location_id}`}>Ledger</a>,
    },
  ]

  const qs = new URLSearchParams()
  if (search) qs.set('q', search)
  if (categoryId) qs.set('categoryId', String(categoryId))
  if (locationId) qs.set('locationId', String(locationId))
  if (belowReorder) qs.set('belowReorder', '1')
  const baseHref = qs.size ? `/app/inventory?${qs.toString()}` : '/app/inventory'

  return page(
    c,
    { title: 'Stock', path: '/app/inventory', subtitle: 'Balances by item and store' },
    <>
      {banner(c)}
      <div class="ncc-grid ncc-grid--kpi">
        <KpiCard label="Items held" value={String(summary.items)} hint={`across ${summary.locations} stores`} />
        <KpiCard
          label="Stock value"
          value={<Money paise={summary.valuePaise} compact hidden={!rates} />}
          hint="Weighted average cost"
        />
        <KpiCard
          label="Below reorder"
          value={String(alerts.lowStock.length)}
          hint="Reorder level reached"
          href="/app/inventory?belowReorder=1"
        />
        <KpiCard
          label="Awaiting you"
          value={String(counts.requisitionsToApprove + counts.posToApprove + counts.grnsDraft + counts.transfersInTransit)}
          hint={`${counts.requisitionsToApprove} requisitions, ${counts.posToApprove} POs, ${counts.grnsDraft} draft GRNs, ${counts.transfersInTransit} in transit`}
        />
      </div>

      {alerts.negative.length > 0 ? (
        <Alert tone="error">
          <strong>{alerts.negative.length} negative balance(s).</strong> Either item_stock has drifted from
          stock_ledger, or something wrote it outside postStockMovement. Run scripts/reconcile-stock.mjs before
          trusting any figure on this page.
          <ul>
            {alerts.negative.map((n) => (
              <li>
                {n.itemCode} at {n.locationName}: <Qty value={n.qtyOnHand} unit={n.unit} />
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <Panel title="Stock">
        <form method="get" action="/app/inventory" class="ncc-row" style="flex-wrap:wrap;gap:.75rem">
          <FormField label="Search" name="q" value={search} placeholder="Item code or name" />
          <FormField label="Category" name="categoryId" options={selectOptions(categories, categoryId, 'All')} />
          <FormField label="Store" name="locationId" options={selectOptions(locations, locationId, 'All')} />
          <FormField
            label="Below reorder only"
            name="belowReorder"
            options={[
              { value: '', label: 'No', selected: !belowReorder },
              { value: '1', label: 'Yes', selected: belowReorder },
            ]}
          />
          <button class="ncc-btn" type="submit">
            Filter
          </button>
        </form>
        <DataTable columns={columns} rows={rows} empty="No stock matches that filter." />
        <Pager page={pageNo} pageSize={pageSize} total={total} baseHref={baseHref} />
      </Panel>

      <Panel title="Reorder level reached">
        <DataTable
          columns={[
            { header: 'Item', cell: (r) => `${r.item_code} - ${r.item_name}` },
            { header: 'Store', cell: (r) => r.location_name },
            { header: 'On hand', numeric: true, cell: (r) => <Qty value={Number(r.qty_on_hand)} unit={r.unit_code} /> },
            { header: 'Reorder at', numeric: true, cell: (r) => <Qty value={Number(r.reorder_level)} /> },
          ]}
          rows={alerts.lowStock}
          empty="Nothing is below its reorder level."
        />
      </Panel>

      <Panel title="Batches at or near expiry">
        <DataTable
          columns={[
            { header: 'Item', cell: (r) => `${r.itemCode} - ${r.itemName}` },
            { header: 'Batch', cell: (r) => r.batchNo },
            { header: 'Store', cell: (r) => r.locationName },
            { header: 'Expires', cell: (r) => <DateText value={r.expiryDate} /> },
            { header: 'Held', numeric: true, cell: (r) => <Qty value={r.qty} /> },
          ]}
          rows={alerts.expiring}
          empty="No batch expires in the next 30 days."
        />
      </Panel>
    </>
  )
})

/** The movement history behind one balance: the audit answer to "why is it 12". */
inventory.get('/app/inventory/items/:itemId/ledger', requirePermission(PERMISSIONS.INVENTORY_VIEW), async (c) => {
  const db = c.get('db')
  const itemId = idParam(c, 'itemId')
  const rates = canRates(c)
  const locationId = Number(queryParam(c, 'locationId') ?? '') || null

  const [item, rows, locations] = await Promise.all([
    q.findItem(db, itemId),
    q.itemLedger(db, { itemId, locationId, canViewRates: rates, limit: 200 }),
    q.locationOptions(db, currentScope(c)),
  ])
  if (!item) throw new NotFoundError('Item not found')

  return page(
    c,
    { title: `${item.code} ledger`, path: '/app/inventory', subtitle: item.name },
    <>
      {banner(c)}
      <Panel
        title="Movements"
        actions={<a class="ncc-btn" href={`/app/inventory/items/${itemId}`}>Item</a>}
      >
        <form method="get" action={`/app/inventory/items/${itemId}/ledger`} class="ncc-row">
          <FormField label="Store" name="locationId" options={selectOptions(locations, locationId, 'All stores')} />
          <button class="ncc-btn" type="submit">
            Filter
          </button>
        </form>

        <DataTable
          columns={[
            { header: 'Date', cell: (r) => <DateText value={String(r.txn_date)} /> },
            { header: 'Type', cell: (r) => <StatusBadge status={r.txn_type} /> },
            {
              header: 'Document',
              cell: (r) => (
                <span class="ncc-muted">
                  {r.ref_table} #{r.ref_id}
                </span>
              ),
            },
            { header: 'Store', cell: (r) => r.location_name },
            { header: 'Project', cell: (r) => r.project_code ?? '-' },
            { header: 'Batch', cell: (r) => r.batch_no ?? '-' },
            { header: 'In', numeric: true, cell: (r) => <Qty value={Number(r.qty_in)} /> },
            { header: 'Out', numeric: true, cell: (r) => <Qty value={Number(r.qty_out)} /> },
            { header: 'Balance', numeric: true, cell: (r) => <Qty value={Number(r.balance_after)} /> },
            { header: 'Rate', numeric: true, cell: (r) => <Money paise={paiseOf(r, 'rate_paise')} hidden={!rates} /> },
            { header: 'By', cell: (r) => r.created_by_name ?? '-' },
          ]}
          rows={rows}
          empty="This item has never moved."
          caption="Newest first. The ledger is append-only, so a correction appears as another row."
        />
      </Panel>
    </>
  )
})

/* Item master ------------------------------------------------------------- */

type ItemListRow = Awaited<ReturnType<typeof q.listItems>>[number]

const ITEM_READ = [PERMISSIONS.INVENTORY_VIEW, PERMISSIONS.INVENTORY_ITEM_MANAGE] as const

inventory.get('/app/inventory/items', requirePermission(...ITEM_READ), async (c) => {
  const db = c.get('db')
  const { page: pageNo, offset, pageSize } = pageParam(c, PAGE_SIZE)
  const search = queryParam(c, 'q') ?? null
  const categoryId = Number(queryParam(c, 'categoryId') ?? '') || null
  const activeOnly = queryParam(c, 'all') !== '1'
  const filters = { q: search, categoryId, activeOnly }

  const [rows, total, categories] = await Promise.all([
    q.listItems(db, { ...filters, limit: pageSize, offset }),
    q.countItems(db, filters),
    q.categoryOptions(db),
  ])

  const columns: Column<ItemListRow>[] = [
    {
      header: 'Item',
      cell: (r) => (
        <>
          <a href={`/app/inventory/items/${r.id}`}>
            <strong>{r.name}</strong>
          </a>
          <div class="ncc-muted">{r.code}</div>
        </>
      ),
    },
    { header: 'Category', cell: (r) => r.category_name },
    { header: 'Unit', cell: (r) => r.unit_code },
    { header: 'HSN', cell: (r) => r.hsn_code ?? '-' },
    { header: 'GST', numeric: true, cell: (r) => `${Number(r.gst_pct)}%` },
    {
      header: 'Reorder at',
      numeric: true,
      cell: (r) => (r.reorder_level === null ? <span class="ncc-muted">-</span> : <Qty value={Number(r.reorder_level)} />),
    },
    { header: 'Wastage', numeric: true, cell: (r) => `${Number(r.wastage_allowance_pct)}%` },
    { header: 'Batches', cell: (r) => (r.is_batch_tracked === 1 ? 'Tracked' : '-') },
    { header: 'Status', cell: (r) => <StatusBadge status={r.is_active === 1 ? 'active' : 'inactive'} /> },
  ]

  const qs = new URLSearchParams()
  if (search) qs.set('q', search)
  if (categoryId) qs.set('categoryId', String(categoryId))
  if (!activeOnly) qs.set('all', '1')

  return page(
    c,
    {
      title: 'Item master',
      path: '/app/inventory/items',
      actions: can(c, PERMISSIONS.INVENTORY_ITEM_MANAGE) ? (
        <a class="ncc-btn ncc-btn-primary" href="/app/inventory/items/new">
          New item
        </a>
      ) : undefined,
    },
    <>
      {banner(c)}
      <Panel title="Items">
        <form method="get" action="/app/inventory/items" class="ncc-row" style="flex-wrap:wrap;gap:.75rem">
          <FormField label="Search" name="q" value={search} placeholder="Code or name" />
          <FormField label="Category" name="categoryId" options={selectOptions(categories, categoryId, 'All')} />
          <FormField
            label="Include inactive"
            name="all"
            options={[
              { value: '', label: 'No', selected: activeOnly },
              { value: '1', label: 'Yes', selected: !activeOnly },
            ]}
          />
          <button class="ncc-btn" type="submit">
            Filter
          </button>
        </form>
        <DataTable columns={columns} rows={rows} empty="No item matches that filter." />
        <Pager
          page={pageNo}
          pageSize={pageSize}
          total={total}
          baseHref={qs.size ? `/app/inventory/items?${qs.toString()}` : '/app/inventory/items'}
        />
      </Panel>
    </>
  )
})

type ItemRow = NonNullable<Awaited<ReturnType<typeof q.findItem>>>

function ItemForm(props: {
  csrf: string
  action: string
  item: ItemRow | null
  categories: Awaited<ReturnType<typeof q.categoryOptions>>
  units: Awaited<ReturnType<typeof q.unitOptions>>
  costHeads: Awaited<ReturnType<typeof q.costHeadOptions>>
}) {
  const it = props.item
  return (
    <form class="ncc-stack" method="post" action={props.action}>
      <CsrfInput token={props.csrf} />
      <div class="ncc-grid ncc-grid--2">
        <FormField label="Code" name="code" value={it?.code} required hint="Letters, digits, dot, dash, slash." />
        <FormField label="Name" name="name" value={it?.name} required />
        <FormField
          label="Category"
          name="categoryId"
          required
          options={selectOptions(props.categories, it ? Number(it.category_id) : null)}
        />
        <FormField label="Unit" name="unitId" required options={selectOptions(props.units, it ? Number(it.unit_id) : null)} />
        <FormField
          label="Cost head"
          name="costHeadId"
          options={selectOptions(props.costHeads, it?.cost_head_id === null || it === null ? null : Number(it.cost_head_id), 'None')}
        />
        <FormField label="HSN code" name="hsnCode" value={it?.hsn_code} />
        <FormField label="GST %" name="gstPct" type="number" step="0.01" min="0" max="28" value={it ? Number(it.gst_pct) : 18} />
        <FormField
          label="Reorder level"
          name="reorderLevel"
          type="number"
          step="0.001"
          min="0"
          value={it?.reorder_level === null || it === null ? '' : Number(it.reorder_level)}
          hint="Leave blank for no alert."
        />
        <FormField
          label="Wastage allowance %"
          name="wastageAllowancePct"
          type="number"
          step="0.01"
          min="0"
          max="100"
          value={it ? Number(it.wastage_allowance_pct) : 0}
          hint="Used by the consumption variance report."
        />
        <FormField
          label="Shelf life (days)"
          name="shelfLifeDays"
          type="number"
          min="1"
          value={it?.shelf_life_days === null || it === null ? '' : Number(it.shelf_life_days)}
          hint="Set it and issues go oldest batch first."
        />
        <FormField label="Batch tracked" name="isBatchTracked" options={YES_NO(it ? it.is_batch_tracked === 1 : false)} />
        <FormField label="Active" name="isActive" options={YES_NO(it ? it.is_active === 1 : true)} />
      </div>
      <FormField label="Specification" name="specification" rows={3} value={it?.specification} />
      <div class="ncc-row">
        <button class="ncc-btn ncc-btn-primary" type="submit">
          {it ? 'Save item' : 'Create item'}
        </button>
        <a class="ncc-btn" href={it ? `/app/inventory/items/${it.id}` : '/app/inventory/items'}>
          Cancel
        </a>
      </div>
    </form>
  )
}

inventory.get('/app/inventory/items/new', requirePermission(PERMISSIONS.INVENTORY_ITEM_MANAGE), async (c) => {
  const db = c.get('db')
  const [categories, units, costHeads] = await Promise.all([
    q.categoryOptions(db),
    q.unitOptions(db),
    q.costHeadOptions(db),
  ])
  return page(
    c,
    { title: 'New item', path: '/app/inventory/items', subtitle: 'Item master' },
    <>
      {banner(c)}
      <Panel title="Item details">
        <ItemForm
          csrf={currentSession(c).csrfToken}
          action="/app/inventory/items"
          item={null}
          categories={categories}
          units={units}
          costHeads={costHeads}
        />
      </Panel>
    </>
  )
})

inventory.post('/app/inventory/items', requirePermission(PERMISSIONS.INVENTORY_ITEM_MANAGE), async (c) => {
  const parsed = itemSchema.safeParse(await readBody(c))
  if (!parsed.success) return errRedirect(c, '/app/inventory/items/new', firstError(parsed.error))
  const itemId = await svc.createItem(c.get('db'), actorOf(c), parsed.data)
  return okRedirect(c, `/app/inventory/items/${itemId}`, 'Item created.')
})

inventory.get('/app/inventory/items/:itemId/edit', requirePermission(PERMISSIONS.INVENTORY_ITEM_MANAGE), async (c) => {
  const db = c.get('db')
  const itemId = idParam(c, 'itemId')
  const [item, categories, units, costHeads] = await Promise.all([
    q.findItem(db, itemId),
    q.categoryOptions(db),
    q.unitOptions(db),
    q.costHeadOptions(db),
  ])
  if (!item) throw new NotFoundError('Item not found')

  return page(
    c,
    { title: item.name, path: '/app/inventory/items', subtitle: `Editing ${item.code}` },
    <>
      {banner(c)}
      <Panel title="Item details">
        <ItemForm
          csrf={currentSession(c).csrfToken}
          action={`/app/inventory/items/${itemId}`}
          item={item}
          categories={categories}
          units={units}
          costHeads={costHeads}
        />
      </Panel>
    </>
  )
})

inventory.post('/app/inventory/items/:itemId', requirePermission(PERMISSIONS.INVENTORY_ITEM_MANAGE), async (c) => {
  const itemId = idParam(c, 'itemId')
  const parsed = itemSchema.safeParse(await readBody(c))
  if (!parsed.success) return errRedirect(c, `/app/inventory/items/${itemId}/edit`, firstError(parsed.error))
  await svc.updateItem(c.get('db'), actorOf(c), itemId, parsed.data)
  return okRedirect(c, `/app/inventory/items/${itemId}`, 'Item saved.')
})

type BrandRow = Awaited<ReturnType<typeof q.itemBrandRows>>[number]

inventory.get('/app/inventory/items/:itemId', requirePermission(...ITEM_READ), async (c) => {
  const db = c.get('db')
  const scope = currentScope(c)
  const rates = canRates(c)
  const itemId = idParam(c, 'itemId')
  const item = await q.findItem(db, itemId)
  if (!item) throw new NotFoundError('Item not found')

  const [brands, stock] = await Promise.all([
    q.itemBrandRows(db, itemId),
    // stockRows has no itemId filter, so the item code goes in as the search
    // term and the exact rows are picked out below. The location scoping stays
    // in SQL, which is the part that matters; this is a display filter.
    q.stockRows(db, scope, { canViewRates: rates, q: item.code, limit: 200 }),
  ])
  const mine = stock.filter((r) => Number(r.item_id) === itemId)
  const batchLists =
    item.is_batch_tracked === 1
      ? await Promise.all(mine.map((r) => q.batchBalances(db, itemId, Number(r.location_id))))
      : []

  const canManage = can(c, PERMISSIONS.INVENTORY_ITEM_MANAGE)
  const canApproveBrand = can(c, PERMISSIONS.INVENTORY_APPROVE_PO)
  const csrf = currentSession(c).csrfToken
  const totalQty = mine.reduce((s, r) => s + Number(r.qty_on_hand), 0)

  const brandColumns: Column<BrandRow>[] = [
    { header: 'Brand', cell: (r) => r.brand },
    {
      header: 'Status',
      cell: (r) => <StatusBadge status={r.is_approved === 1 ? 'approved' : 'pending'} />,
    },
    { header: 'Approved by', cell: (r) => r.approved_by_name ?? '-' },
    { header: 'Note', cell: (r) => r.note ?? '-' },
    {
      header: '',
      cell: (r) =>
        canApproveBrand ? (
          <form method="post" action={`/app/inventory/brands/${r.id}/approval`}>
            <CsrfInput token={csrf} />
            <input type="hidden" name="approved" value={r.is_approved === 1 ? '0' : '1'} />
            <button class="ncc-btn" type="submit">
              {r.is_approved === 1 ? 'Withdraw' : 'Approve'}
            </button>
          </form>
        ) : (
          <span class="ncc-muted">-</span>
        ),
    },
  ]

  return page(
    c,
    {
      title: item.name,
      path: '/app/inventory/items',
      subtitle: `${item.code} - ${item.category_name}`,
      actions: canManage ? (
        <a class="ncc-btn" href={`/app/inventory/items/${itemId}/edit`}>
          Edit
        </a>
      ) : undefined,
    },
    <>
      {banner(c)}
      {item.is_active === 1 ? null : <Alert tone="warn">This item is inactive. It cannot be added to a new document.</Alert>}
      <div class="ncc-grid ncc-grid--2">
        <Panel title="Specification">
          <DefinitionList
            rows={[
              ['Unit', item.unit_code],
              ['HSN', item.hsn_code ?? '-'],
              ['GST', `${Number(item.gst_pct)}%`],
              ['Reorder level', item.reorder_level === null ? '-' : <Qty value={Number(item.reorder_level)} unit={item.unit_code} />],
              ['Wastage allowance', `${Number(item.wastage_allowance_pct)}%`],
              ['Shelf life', item.shelf_life_days === null ? '-' : `${Number(item.shelf_life_days)} days`],
              ['Batch tracked', item.is_batch_tracked === 1 ? 'Yes' : 'No'],
              ['On hand (your stores)', <Qty value={totalQty} unit={item.unit_code} />],
              ['Notes', item.specification ?? '-'],
            ]}
          />
        </Panel>
        <Panel
          title="Stock by store"
          actions={
            <a class="ncc-btn" href={`/app/inventory/items/${itemId}/ledger`}>
              Ledger
            </a>
          }
        >
          <DataTable
            columns={[
              { header: 'Store', cell: (r: StockListRow) => `${r.location_code} - ${r.location_name}` },
              { header: 'On hand', numeric: true, cell: (r: StockListRow) => <Qty value={Number(r.qty_on_hand)} unit={r.unit_code} /> },
              { header: 'Value', numeric: true, cell: (r: StockListRow) => <Money paise={paiseOf(r, 'value_paise')} hidden={!rates} /> },
            ]}
            rows={mine}
            empty="No store holds this item."
          />
        </Panel>
      </div>

      {item.is_batch_tracked === 1 ? (
        <Panel title="Batches">
          {mine.length === 0 ? (
            <p class="ncc-muted">No store holds this item.</p>
          ) : (
            mine.map((r, i) => (
              <>
                <h4>
                  {r.location_code} - {r.location_name}
                </h4>
                <DataTable
                  columns={[
                    { header: 'Batch', cell: (b: { batchNo: string }) => b.batchNo },
                    { header: 'Expiry', cell: (b: { expiryDate: string | null }) => <DateText value={b.expiryDate} /> },
                    { header: 'Qty', numeric: true, cell: (b: { qty: number }) => <Qty value={b.qty} unit={item.unit_code} /> },
                  ]}
                  rows={batchLists[i] ?? []}
                  empty="Held without a batch number."
                  caption="Oldest expiry first, which is the order an issue picks."
                />
              </>
            ))
          )}
        </Panel>
      ) : null}

      <Panel title="Approved brands">
        <DataTable
          columns={brandColumns}
          rows={brands}
          empty="No brand recorded. Any brand may be supplied."
          caption="A GRN of an unapproved brand needs the approve_po permission to post."
        />
        {canManage ? (
          <form class="ncc-row" method="post" action={`/app/inventory/items/${itemId}/brands`} style="flex-wrap:wrap;gap:.75rem">
            <CsrfInput token={csrf} />
            <FormField label="Brand" name="brand" required placeholder="Maker or trade name" />
            <FormField label="Note" name="note" placeholder="Why this brand" />
            <FormField
              label="Approved"
              name="isApproved"
              options={YES_NO(false)}
              hint={canApproveBrand ? undefined : 'You may record it, not approve it.'}
            />
            <button class="ncc-btn" type="submit">
              Add brand
            </button>
          </form>
        ) : null}
      </Panel>
    </>
  )
})

inventory.post('/app/inventory/items/:itemId/brands', requirePermission(PERMISSIONS.INVENTORY_ITEM_MANAGE), async (c) => {
  const itemId = idParam(c, 'itemId')
  const back = `/app/inventory/items/${itemId}`
  const parsed = itemBrandSchema.safeParse(await readBody(c))
  if (!parsed.success) return errRedirect(c, back, firstError(parsed.error))
  await svc.addItemBrand(c.get('db'), actorOf(c), itemId, parsed.data, can(c, PERMISSIONS.INVENTORY_APPROVE_PO))
  return okRedirect(c, back, `${parsed.data.brand} added.`)
})

inventory.post('/app/inventory/brands/:brandId/approval', requirePermission(PERMISSIONS.INVENTORY_APPROVE_PO), async (c) => {
  const brandId = idParam(c, 'brandId')
  const parsed = brandApprovalSchema.safeParse(await readBody(c))
  const back = parsed.success && parsed.data.itemId ? `/app/inventory/items/${parsed.data.itemId}` : '/app/inventory/items'
  if (!parsed.success) return errRedirect(c, back, firstError(parsed.error))
  await svc.setItemBrandApproval(c.get('db'), actorOf(c), brandId, parsed.data.approved)
  return okRedirect(c, back, parsed.data.approved ? 'Brand approved.' : 'Approval withdrawn.')
})

/* Requisitions ------------------------------------------------------------ */

/**
 * Spec 6.4 gives requisition creation to `inventory.grn_create` rather than to
 * a key of its own. Kept as written: the storekeeper who receives material is
 * the person who knows the site is short of it.
 */
const REQ_CREATE = PERMISSIONS.INVENTORY_GRN_CREATE

type ReqListRow = Awaited<ReturnType<typeof q.listRequisitions>>[number]

inventory.get('/app/inventory/requisitions', requirePermission(PERMISSIONS.INVENTORY_VIEW), async (c) => {
  const db = c.get('db')
  const scope = currentScope(c)
  const { page: pageNo, offset, pageSize } = pageParam(c, PAGE_SIZE)
  const status = queryParam(c, 'status') ?? null
  const projectId = Number(queryParam(c, 'projectId') ?? '') || null
  const filters = { status, projectId }

  const [rows, total, projects] = await Promise.all([
    q.listRequisitions(db, scope, { ...filters, limit: pageSize, offset }),
    q.countRequisitions(db, scope, filters),
    q.projectOptions(db, scope),
  ])

  const columns: Column<ReqListRow>[] = [
    {
      header: 'Number',
      cell: (r) => <a href={`/app/inventory/requisitions/${r.id}`}>{r.req_no}</a>,
    },
    {
      header: 'Project',
      cell: (r) => (
        <>
          <div>{r.project_name}</div>
          <div class="ncc-muted">{r.project_code}</div>
        </>
      ),
    },
    { header: 'Raised by', cell: (r) => r.requested_by_name },
    { header: 'Required by', cell: (r) => <DateText value={r.required_by_date} /> },
    { header: 'Lines', numeric: true, cell: (r) => Number(r.line_count ?? 0) },
    { header: 'Raised', cell: (r) => <DateText value={r.created_at} /> },
    { header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
  ]

  const qs = new URLSearchParams()
  if (status) qs.set('status', status)
  if (projectId) qs.set('projectId', String(projectId))

  return page(
    c,
    {
      title: 'Requisitions',
      path: '/app/inventory/requisitions',
      actions: can(c, REQ_CREATE) ? (
        <a class="ncc-btn ncc-btn-primary" href="/app/inventory/requisitions/new">
          Raise requisition
        </a>
      ) : undefined,
    },
    <>
      {banner(c)}
      <Panel title="Material requisitions">
        <form method="get" action="/app/inventory/requisitions" class="ncc-row" style="flex-wrap:wrap;gap:.75rem">
          <FormField label="Status" name="status" options={enumOptions(REQUISITION_STATUSES, status, 'Any')} />
          <FormField label="Project" name="projectId" options={selectOptions(projects, projectId, 'All')} />
          <button class="ncc-btn" type="submit">
            Filter
          </button>
        </form>
        <DataTable columns={columns} rows={rows} empty="No requisition matches that filter." />
        <Pager
          page={pageNo}
          pageSize={pageSize}
          total={total}
          baseHref={qs.size ? `/app/inventory/requisitions?${qs.toString()}` : '/app/inventory/requisitions'}
        />
      </Panel>
    </>
  )
})

/**
 * Document forms that need a project's stages take the project in the query
 * string first.
 *
 * Without Alpine there is no way to refill a dependent select in place, so the
 * form is in two passes: a GET that picks the project and reloads, then the
 * real POST form with that project's stages. It costs one extra click and works
 * with scripting off, which the alternative — one flat form with every stage of
 * every project in one select — does not, because stage names repeat across
 * projects and the wrong one is silently valid.
 */
function ProjectPicker(props: {
  action: string
  projects: Awaited<ReturnType<typeof q.projectOptions>>
  projectId: number | null
  rows: number
}) {
  return (
    <form method="get" action={props.action} class="ncc-row" style="flex-wrap:wrap;gap:.75rem">
      <FormField label="Project" name="projectId" required options={selectOptions(props.projects, props.projectId)} />
      <FormField label="Line rows" name="rows" type="number" min="1" max="60" value={props.rows} />
      <button class="ncc-btn" type="submit">
        {props.projectId ? 'Change' : 'Continue'}
      </button>
    </form>
  )
}

inventory.get('/app/inventory/requisitions/new', requirePermission(REQ_CREATE), async (c) => {
  const db = c.get('db')
  const scope = currentScope(c)
  const rows = rowCount(c)
  const projectId = Number(queryParam(c, 'projectId') ?? '') || null
  const [projects, items, stages] = await Promise.all([
    q.projectOptions(db, scope),
    q.itemOptions(db),
    projectId ? q.projectStageOptions(db, projectId) : Promise.resolve([]),
  ])

  return page(
    c,
    { title: 'Raise requisition', path: '/app/inventory/requisitions', subtitle: 'Site asks, procurement orders' },
    <>
      {banner(c)}
      <Panel title="Project">
        <ProjectPicker action="/app/inventory/requisitions/new" projects={projects} projectId={projectId} rows={rows} />
      </Panel>

      {projectId === null ? (
        <Alert tone="warn">Choose a project to continue. Its stages load with it.</Alert>
      ) : (
        <Panel title="Lines">
          <form class="ncc-stack" method="post" action="/app/inventory/requisitions">
            <CsrfInput token={currentSession(c).csrfToken} />
            <input type="hidden" name="projectId" value={String(projectId)} />
            <div class="ncc-grid ncc-grid--2">
              <FormField
                label="Stage"
                name="projectStageId"
                options={selectOptions(
                  stages.map((s) => ({ id: s.id, code: String(s.seq), name: s.name })),
                  null,
                  'Not stage specific'
                )}
              />
              <FormField label="Required by" name="requiredByDate" type="date" value={today()} />
            </div>
            <FormField label="Remarks" name="remarks" rows={2} placeholder="Why it is needed, or where it goes" />
            <LineGrid
              headers={['Item', 'Quantity', 'Line note']}
              hint="Leave an item blank to skip the row. Add ?rows=20 to the URL for a longer grid."
            >
              {blankRows(rows).map(() => (
                <tr>
                  <td>
                    <ItemCell items={items} />
                  </td>
                  <td class="ncc-num">
                    <QtyCell name="qtyRequested" />
                  </td>
                  <td>
                    <input type="text" name="lineRemarks" />
                  </td>
                </tr>
              ))}
            </LineGrid>
            <div class="ncc-row">
              <button class="ncc-btn ncc-btn-primary" type="submit">
                Save draft
              </button>
              <a class="ncc-btn" href="/app/inventory/requisitions">
                Cancel
              </a>
            </div>
          </form>
        </Panel>
      )}
    </>
  )
})

inventory.post('/app/inventory/requisitions', requirePermission(REQ_CREATE), async (c) => {
  const body = await readBody(c)
  const parsed = requisitionSchema.safeParse(body)
  const back = `/app/inventory/requisitions/new?projectId=${Number(body.projectId) || ''}`
  if (!parsed.success) return errRedirect(c, back, firstError(parsed.error))
  const reqId = await svc.createRequisition(c.get('db'), actorOf(c), parsed.data)
  return okRedirect(c, `/app/inventory/requisitions/${reqId}`, 'Requisition saved as a draft.')
})

type ReqLineRow = Awaited<ReturnType<typeof q.requisitionLineRows>>[number]

inventory.get('/app/inventory/requisitions/:reqId', requirePermission(PERMISSIONS.INVENTORY_VIEW), async (c) => {
  const db = c.get('db')
  const reqId = idParam(c, 'reqId')
  const req = await q.findRequisition(db, reqId)
  if (!req) throw new NotFoundError('Requisition not found')
  const lines = await q.requisitionLineRows(db, reqId)

  const me = currentUser(c).id
  const csrf = currentSession(c).csrfToken
  const isMine = Number(req.requested_by) === me
  const canSubmit = req.status === 'draft' && can(c, REQ_CREATE)
  const canDecide = req.status === 'submitted' && can(c, PERMISSIONS.INVENTORY_APPROVE_PO)
  const canOrder =
    (req.status === 'approved' || req.status === 'partially_ordered') && can(c, PERMISSIONS.INVENTORY_PO_CREATE)

  const lineColumns: Column<ReqLineRow>[] = [
    {
      header: 'Item',
      cell: (r) => (
        <>
          <a href={`/app/inventory/items/${r.item_id}`}>{r.item_name}</a>
          <div class="ncc-muted">{r.item_code}</div>
        </>
      ),
    },
    { header: 'Requested', numeric: true, cell: (r) => <Qty value={Number(r.qty_requested)} unit={r.unit_code} /> },
    {
      header: 'Approved',
      numeric: true,
      cell: (r) => (r.qty_approved === null ? <span class="ncc-muted">-</span> : <Qty value={Number(r.qty_approved)} unit={r.unit_code} />),
    },
    { header: 'Ordered', numeric: true, cell: (r) => <Qty value={Number(r.qty_ordered)} unit={r.unit_code} /> },
    { header: 'Note', cell: (r) => r.remarks ?? '-' },
  ]

  return page(
    c,
    {
      title: req.req_no,
      path: '/app/inventory/requisitions',
      subtitle: `${req.project_code} - ${req.project_name}`,
      actions: canOrder ? (
        <a class="ncc-btn ncc-btn-primary" href={`/app/inventory/po/new?requisitionId=${reqId}`}>
          Raise PO
        </a>
      ) : undefined,
    },
    <>
      {banner(c)}
      {req.status === 'rejected' && req.reject_reason ? <Alert tone="error">Rejected: {req.reject_reason}</Alert> : null}
      <Panel title="Requisition">
        <DefinitionList
          rows={[
            ['Status', <StatusBadge status={req.status} />],
            ['Project', `${req.project_code} - ${req.project_name}`],
            ['Stage', req.stage_name ?? 'Not stage specific'],
            ['Required by', <DateText value={req.required_by_date} />],
            ['Raised by', req.requested_by_name],
            ['Raised', <DateText value={req.created_at} withTime />],
            ['Approved by', req.approved_by_name ?? '-'],
            ['Approved at', <DateText value={req.approved_at} withTime />],
            ['Remarks', req.remarks ?? '-'],
          ]}
        />
      </Panel>
      <Panel title="Lines">
        <DataTable columns={lineColumns} rows={lines} empty="This requisition has no lines." />
      </Panel>
      {canSubmit ? (
        <Panel title="Send to procurement">
          <form method="post" action={`/app/inventory/requisitions/${reqId}/submit`}>
            <CsrfInput token={csrf} />
            <p class="ncc-muted">Once submitted the lines are fixed. Approval can cut a quantity but not raise it.</p>
            <button class="ncc-btn ncc-btn-primary" type="submit">
              Submit for approval
            </button>
          </form>
        </Panel>
      ) : null}

      {req.status === 'submitted' && isMine ? (
        <Alert tone="warn">
          You raised this requisition, so you cannot approve it. Someone else with the approve permission has to.
        </Alert>
      ) : null}
      {canDecide && !isMine ? (
        <div class="ncc-grid ncc-grid--2">
          <Panel title="Approve">
            <form class="ncc-stack" method="post" action={`/api/requisitions/${reqId}/approve`}>
              <CsrfInput token={csrf} />
              <LineGrid headers={['Item', 'Requested', 'Approve']} hint="Cut a quantity to zero to refuse that line.">
                {lines.map((l) => (
                  <tr>
                    <td>
                      {l.item_code}
                      <div class="ncc-muted">{l.item_name}</div>
                    </td>
                    <td class="ncc-num">
                      <Qty value={Number(l.qty_requested)} unit={l.unit_code} />
                    </td>
                    <td class="ncc-num">
                      <input type="hidden" name="lineId" value={String(l.id)} />
                      <QtyCell name="qtyApproved" value={Number(l.qty_requested)} max={Number(l.qty_requested)} />
                    </td>
                  </tr>
                ))}
              </LineGrid>
              <FormField label="Remarks" name="remarks" rows={2} />
              <button class="ncc-btn ncc-btn-primary" type="submit">
                Approve requisition
              </button>
            </form>
          </Panel>
          <Panel title="Reject">
            <form class="ncc-stack" method="post" action={`/api/requisitions/${reqId}/reject`}>
              <CsrfInput token={csrf} />
              <FormField label="Reason" name="reason" rows={3} required hint="Goes back to the site, and into the audit log." />
              <button class="ncc-btn ncc-btn-danger" type="submit">
                Reject requisition
              </button>
            </form>
          </Panel>
        </div>
      ) : null}
    </>
  )
})

inventory.post('/app/inventory/requisitions/:reqId/submit', requirePermission(REQ_CREATE), async (c) => {
  const reqId = idParam(c, 'reqId')
  await svc.submitRequisition(c.get('db'), actorOf(c), reqId)
  return okRedirect(c, `/app/inventory/requisitions/${reqId}`, 'Sent to procurement.')
})

inventory.post('/api/requisitions/:reqId/approve', requirePermission(PERMISSIONS.INVENTORY_APPROVE_PO), async (c) => {
  const reqId = idParam(c, 'reqId')
  const back = `/app/inventory/requisitions/${reqId}`
  const parsed = requisitionApproveSchema.safeParse(await readBody(c))
  if (!parsed.success) return errRedirect(c, back, firstError(parsed.error))
  await svc.approveRequisition(c.get('db'), actorOf(c), reqId, parsed.data)
  return okRedirect(c, back, 'Requisition approved.')
})

inventory.post('/api/requisitions/:reqId/reject', requirePermission(PERMISSIONS.INVENTORY_APPROVE_PO), async (c) => {
  const reqId = idParam(c, 'reqId')
  const back = `/app/inventory/requisitions/${reqId}`
  const parsed = rejectSchema.safeParse(await readBody(c))
  if (!parsed.success) return errRedirect(c, back, firstError(parsed.error))
  await svc.rejectRequisition(c.get('db'), actorOf(c), reqId, parsed.data.reason)
  return okRedirect(c, back, 'Requisition rejected.')
})

/* Purchase orders --------------------------------------------------------- */

/**
 * Reads take po_create or approve_po. Spec 6.4 lists only po_create, but an
 * approver who cannot open the list cannot approve anything, and nav.ts already
 * shows the link to either key.
 */
const PO_READ = [PERMISSIONS.INVENTORY_PO_CREATE, PERMISSIONS.INVENTORY_APPROVE_PO] as const

type PoListRow = Awaited<ReturnType<typeof q.listPurchaseOrders>>[number]

inventory.get('/app/inventory/po', requirePermission(...PO_READ), async (c) => {
  const db = c.get('db')
  const scope = currentScope(c)
  const rates = canRates(c)
  const { page: pageNo, offset, pageSize } = pageParam(c, PAGE_SIZE)
  const status = queryParam(c, 'status') ?? null
  const vendorId = Number(queryParam(c, 'vendorId') ?? '') || null

  const [rows, total, vendors] = await Promise.all([
    q.listPurchaseOrders(db, scope, { status, vendorId, canViewRates: rates, limit: pageSize, offset }),
    q.countPurchaseOrders(db, scope, { status, vendorId }),
    q.vendorOptions(db),
  ])

  const columns: Column<PoListRow>[] = [
    { header: 'Number', cell: (r) => <a href={`/app/inventory/po/${r.id}`}>{r.po_no}</a> },
    { header: 'Date', cell: (r) => <DateText value={r.po_date} /> },
    { header: 'Vendor', cell: (r) => r.vendor_name },
    { header: 'Project', cell: (r) => r.project_code ?? <span class="ncc-muted">Central</span> },
    { header: 'Expected', cell: (r) => <DateText value={r.expected_delivery} /> },
    { header: 'Value', numeric: true, cell: (r) => <Money paise={paiseOf(r, 'total_paise')} hidden={!rates} /> },
    { header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
  ]

  const qs = new URLSearchParams()
  if (status) qs.set('status', status)
  if (vendorId) qs.set('vendorId', String(vendorId))

  return page(
    c,
    {
      title: 'Purchase orders',
      path: '/app/inventory/po',
      actions: can(c, PERMISSIONS.INVENTORY_PO_CREATE) ? (
        <a class="ncc-btn ncc-btn-primary" href="/app/inventory/po/new">
          New order
        </a>
      ) : undefined,
    },
    <>
      {banner(c)}
      <Panel title="Orders">
        <form method="get" action="/app/inventory/po" class="ncc-row" style="flex-wrap:wrap;gap:.75rem">
          <FormField label="Status" name="status" options={enumOptions(PO_STATUSES, status, 'Any')} />
          <FormField label="Vendor" name="vendorId" options={selectOptions(vendors, vendorId, 'All')} />
          <button class="ncc-btn" type="submit">
            Filter
          </button>
        </form>
        <DataTable columns={columns} rows={rows} empty="No purchase order matches that filter." />
        <Pager
          page={pageNo}
          pageSize={pageSize}
          total={total}
          baseHref={qs.size ? `/app/inventory/po?${qs.toString()}` : '/app/inventory/po'}
        />
      </Panel>
    </>
  )
})

/** "Last purchased at X on date Y from vendor Z" (spec 6.4 rule 7). */
function RateReferenceCell(props: { reference: Awaited<ReturnType<typeof q.rateReference>> }) {
  const r = props.reference
  const last = r.lastPurchases[0]
  return (
    <>
      {r.vendorRatePaise === null ? null : (
        <div>
          Contract <Money paise={r.vendorRatePaise} />
        </div>
      )}
      {last ? (
        <div class="ncc-muted">
          <Money paise={last.ratePaise} /> on {formatDate(last.receivedOn)}, {last.vendorName}
        </div>
      ) : (
        <span class="ncc-muted">First purchase</span>
      )}
    </>
  )
}

inventory.get('/app/inventory/po/new', requirePermission(PERMISSIONS.INVENTORY_PO_CREATE), async (c) => {
  const db = c.get('db')
  const scope = currentScope(c)
  const rows = rowCount(c)
  const requisitionId = Number(queryParam(c, 'requisitionId') ?? '') || null
  const vendorId = Number(queryParam(c, 'vendorId') ?? '') || null

  const [vendors, items, costHeads, locations, projects, req, prefill] = await Promise.all([
    q.vendorOptions(db),
    q.itemOptions(db),
    q.costHeadOptions(db),
    q.locationOptions(db, scope),
    q.projectOptions(db, scope),
    requisitionId ? q.findRequisition(db, requisitionId) : Promise.resolve(undefined),
    requisitionId ? q.orderableRequisitionLines(db, requisitionId) : Promise.resolve([]),
  ])

  if (requisitionId && !req) throw new NotFoundError('Requisition not found')

  // The reference rate per prefilled item, so the buyer sees what the last
  // receipt cost before typing this one (spec 6.4 rule 7). Only for a caller
  // who may see rates at all; for anyone else the column is not rendered.
  const rates = canRates(c)
  const references = rates
    ? await Promise.all(prefill.map((l) => q.rateReference(db, Number(l.item_id), vendorId)))
    : []

  const csrf = currentSession(c).csrfToken

  // One row shape whether the grid came from a requisition or is blank, so the
  // markup below is written once. A prefilled row is still fully editable: the
  // buyer negotiates, the requisition only asked.
  type PoSeed = {
    itemId: number | null
    qty: number | null
    gstPct: number | null
    reference: Awaited<ReturnType<typeof q.rateReference>> | null
  }
  const seeds: PoSeed[] =
    prefill.length > 0
      ? prefill.map((l, i) => ({
          itemId: Number(l.item_id),
          qty: l.qty_pending,
          gstPct: Number(l.gst_pct),
          reference: references[i] ?? null,
        }))
      : blankRows(rows).map(() => ({ itemId: null, qty: null, gstPct: null, reference: null }))

  return page(
    c,
    {
      title: 'New purchase order',
      path: '/app/inventory/po',
      subtitle: req ? `From requisition ${req.req_no}` : 'Direct order',
    },
    <>
      {banner(c)}
      {prefill.length === 0 && requisitionId ? (
        <Alert tone="warn">Every approved line on that requisition is already ordered.</Alert>
      ) : null}
      <Panel title="Vendor and delivery">
        <form method="get" action="/app/inventory/po/new" class="ncc-row" style="flex-wrap:wrap;gap:.75rem">
          {requisitionId ? <input type="hidden" name="requisitionId" value={String(requisitionId)} /> : null}
          <FormField label="Vendor" name="vendorId" options={selectOptions(vendors, vendorId)} />
          <FormField label="Line rows" name="rows" type="number" min="1" max="60" value={rows} />
          <button class="ncc-btn" type="submit">
            {vendorId ? 'Change' : 'Continue'}
          </button>
        </form>
        <p class="ncc-hint">
          Picking the vendor first loads their contract rate against each line. A blacklisted or on-hold vendor is not
          listed.
        </p>
      </Panel>
      {vendorId === null ? (
        <Alert tone="warn">Choose a vendor to continue.</Alert>
      ) : (
        <Panel title="Order">
          <form class="ncc-stack" method="post" action="/app/inventory/po">
            <CsrfInput token={csrf} />
            <input type="hidden" name="vendorId" value={String(vendorId)} />
            {requisitionId ? <input type="hidden" name="requisitionId" value={String(requisitionId)} /> : null}
            <div class="ncc-grid ncc-grid--2">
              <FormField label="PO date" name="poDate" type="date" required value={today()} />
              <FormField label="Expected delivery" name="expectedDelivery" type="date" />
              <FormField
                label="Deliver to"
                name="deliveryLocationId"
                required
                options={selectOptions(locations, null)}
              />
              <FormField
                label="Project"
                name="projectId"
                options={selectOptions(projects, req ? Number(req.project_id) : null, 'Central purchase')}
              />
              <FormField label="Freight (Rs)" name="freight" type="number" step="0.01" min="0" value={0} />
              <FormField label="Payment terms (days)" name="paymentTermsDays" type="number" min="0" max="365" />
              <FormField label="Advance %" name="advancePct" type="number" step="0.01" min="0" max="100" value={0} />
            </div>
            <FormField label="Terms" name="terms" rows={3} placeholder="Delivery, unloading, retention, penalty" />

            <LineGrid
              headers={
                rates
                  ? ['Item', 'Brand', 'Qty', 'Rate (Rs)', 'GST %', 'Cost head', 'Note', 'Last purchased']
                  : ['Item', 'Brand', 'Qty', 'Rate (Rs)', 'GST %', 'Cost head', 'Note']
              }
              hint="Totals are computed on the server from these figures. Leave an item blank to skip the row."
            >
              {seeds.map((s) => (
                <tr>
                  <td>
                    <ItemCell items={items} selected={s.itemId} />
                  </td>
                  <td>
                    <input type="text" name="brand" />
                  </td>
                  <td class="ncc-num">
                    <QtyCell name="qtyOrdered" value={s.qty} />
                  </td>
                  <td class="ncc-num">
                    <RupeeCell name="rate" />
                  </td>
                  <td class="ncc-num">
                    <input type="number" name="gstPct" step="0.01" min="0" max="28" value={s.gstPct ?? 18} />
                  </td>
                  <td>
                    <select name="costHeadId">
                      <option value="">-</option>
                      {costHeads.map((h) => (
                        <option value={String(h.id)}>
                          {h.code} - {h.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input type="text" name="lineRemarks" />
                  </td>
                  {rates ? (
                    <td>
                      {s.reference === null ? (
                        <span class="ncc-muted">-</span>
                      ) : (
                        <RateReferenceCell reference={s.reference} />
                      )}
                    </td>
                  ) : null}
                </tr>
              ))}
            </LineGrid>
            <div class="ncc-row">
              <button class="ncc-btn ncc-btn-primary" type="submit">
                Save draft order
              </button>
              <a class="ncc-btn" href="/app/inventory/po">
                Cancel
              </a>
            </div>
          </form>
        </Panel>
      )}
    </>
  )
})

inventory.post('/app/inventory/po', requirePermission(PERMISSIONS.INVENTORY_PO_CREATE), async (c) => {
  const body = await readBody(c)
  const parsed = poSchema.safeParse(body)
  const qs = new URLSearchParams()
  if (Number(body.vendorId)) qs.set('vendorId', String(Number(body.vendorId)))
  if (Number(body.requisitionId)) qs.set('requisitionId', String(Number(body.requisitionId)))
  const back = `/app/inventory/po/new?${qs.toString()}`
  if (!parsed.success) return errRedirect(c, back, firstError(parsed.error))

  const { poId, poNo, warnings } = await svc.createPo(c.get('db'), actorOf(c), parsed.data)
  const note =
    warnings.length === 0
      ? `${poNo} saved as a draft.`
      : `${poNo} saved as a draft. ${warnings.length} line${warnings.length === 1 ? '' : 's'} more than ${svc.RATE_VARIANCE_THRESHOLD_PCT}% off the last purchase - check the rate panel.`
  return okRedirect(c, `/app/inventory/po/${poId}`, note)
})

type PoLine = Awaited<ReturnType<typeof q.poLineRows>>[number]

inventory.get('/app/inventory/po/:poId', requirePermission(...PO_READ), async (c) => {
  const db = c.get('db')
  const rates = canRates(c)
  const poId = idParam(c, 'poId')
  const po = await q.findPurchaseOrder(db, poId, rates)
  if (!po) throw new NotFoundError('Purchase order not found')
  const lines = await q.poLineRows(db, poId, rates)

  // Recomputed on view rather than stored: the comparison is against the last
  // receipt, which moves after the order was raised, so a figure frozen at
  // creation would go stale. Rate-gated, because a rate variance is a rate.
  const warnings = rates
    ? await svc.poRateWarnings(
        db,
        lines.map((l) => ({ itemId: Number(l.item_id), ratePaise: paiseOf(l, 'rate_paise') ?? 0 }))
      )
    : []

  const me = currentUser(c).id
  const csrf = currentSession(c).csrfToken
  const isMine = Number(po.created_by) === me
  const canSubmit = po.status === 'draft' && can(c, PERMISSIONS.INVENTORY_PO_CREATE)
  const canApprove = po.status === 'pending_approval' && can(c, PERMISSIONS.INVENTORY_APPROVE_PO)
  const canShortClose =
    (po.status === 'approved' || po.status === 'partially_received') && can(c, PERMISSIONS.INVENTORY_PO_CREATE)
  const canReceive =
    (po.status === 'approved' || po.status === 'partially_received') && can(c, PERMISSIONS.INVENTORY_GRN_CREATE)

  const lineColumns: Column<PoLine>[] = [
    {
      header: 'Item',
      cell: (r) => (
        <>
          <a href={`/app/inventory/items/${r.item_id}`}>{r.item_name}</a>
          <div class="ncc-muted">
            {r.item_code}
            {r.brand ? ` - ${r.brand}` : ''}
          </div>
        </>
      ),
    },
    { header: 'HSN', cell: (r) => r.hsn_code ?? '-' },
    { header: 'Ordered', numeric: true, cell: (r) => <Qty value={Number(r.qty_ordered)} unit={r.unit_code} /> },
    { header: 'Received', numeric: true, cell: (r) => <Qty value={Number(r.qty_received)} unit={r.unit_code} /> },
    { header: 'Rate', numeric: true, cell: (r) => <Money paise={paiseOf(r, 'rate_paise')} hidden={!rates} /> },
    { header: 'GST', numeric: true, cell: (r) => `${Number(r.gst_pct)}%` },
    { header: 'Line total', numeric: true, cell: (r) => <Money paise={paiseOf(r, 'line_total_paise')} hidden={!rates} /> },
    { header: 'Cost head', cell: (r) => r.cost_head_name ?? '-' },
  ]

  return page(
    c,
    {
      title: po.po_no,
      path: '/app/inventory/po',
      subtitle: `${po.vendor_code} - ${po.vendor_name}`,
      actions: (
        <>
          <a class="ncc-btn" href={`/api/po/${poId}/print`} target="_blank" rel="noopener">
            Print
          </a>
          {canReceive ? (
            <a class="ncc-btn ncc-btn-primary" href={`/app/inventory/grn/new?poId=${poId}`}>
              Receive
            </a>
          ) : null}
        </>
      ),
    },
    <>
      {banner(c)}
      {po.status === 'short_closed' && po.short_close_reason ? (
        <Alert tone="warn">Short closed: {po.short_close_reason}</Alert>
      ) : null}
      {warnings.length > 0 ? (
        <Alert tone="warn">
          {warnings.length} line{warnings.length === 1 ? '' : 's'} more than {svc.RATE_VARIANCE_THRESHOLD_PCT}% off the
          last purchase. Nothing is blocked; the figures are in the rate panel below.
        </Alert>
      ) : null}
      <div class="ncc-grid ncc-grid--2">
        <Panel title="Order">
          <DefinitionList
            rows={[
              ['Status', <StatusBadge status={po.status} />],
              ['Date', <DateText value={po.po_date} />],
              ['Expected', <DateText value={po.expected_delivery} />],
              ['Deliver to', po.delivery_location_name],
              ['Project', po.project_code ? `${po.project_code} - ${po.project_name}` : 'Central purchase'],
              ['From requisition', po.req_no ?? '-'],
              ['Payment terms', po.payment_terms_days === null ? '-' : `${Number(po.payment_terms_days)} days`],
              ['Advance', `${Number(po.advance_pct)}%`],
              ['Raised by', po.created_by_name ?? '-'],
              ['Approved by', po.approved_by_name ?? '-'],
              ['Second approval', po.second_approved_by_name ?? '-'],
              ['Terms', po.terms ?? '-'],
            ]}
          />
        </Panel>
        <Panel title="Value">
          <DefinitionList
            rows={[
              ['Subtotal', <Money paise={paiseOf(po, 'subtotal_paise')} hidden={!rates} />],
              ['GST', <Money paise={paiseOf(po, 'gst_paise')} hidden={!rates} />],
              ['Freight', <Money paise={paiseOf(po, 'freight_paise')} hidden={!rates} />],
              ['Total', <Money paise={paiseOf(po, 'total_paise')} hidden={!rates} />],
              ['Vendor GSTIN', po.vendor_gstin ?? '-'],
              ['Vendor phone', po.vendor_phone ?? '-'],
            ]}
          />
        </Panel>
      </div>
      <Panel title="Lines">
        <DataTable columns={lineColumns} rows={lines} empty="This order has no lines." />
      </Panel>

      {warnings.length > 0 ? (
        <Panel title="Rate variance">
          <DataTable
            columns={[
              { header: 'Item', cell: (w: svc.RateWarning) => `${w.itemCode} - ${w.itemName}` },
              { header: 'This order', numeric: true, cell: (w: svc.RateWarning) => <Money paise={w.ratePaise} /> },
              { header: 'Last paid', numeric: true, cell: (w: svc.RateWarning) => <Money paise={w.lastRatePaise} /> },
              { header: 'When', cell: (w: svc.RateWarning) => <DateText value={w.lastPurchasedOn} /> },
              { header: 'Vendor', cell: (w: svc.RateWarning) => w.lastVendorName },
              {
                header: 'Variance',
                numeric: true,
                cell: (w: svc.RateWarning) => `${w.variancePct > 0 ? '+' : ''}${w.variancePct}%`,
              },
            ]}
            rows={warnings}
            caption={`Lines more than ${svc.RATE_VARIANCE_THRESHOLD_PCT}% from the last posted receipt of the same item, any vendor.`}
          />
        </Panel>
      ) : null}
      {canSubmit ? (
        <Panel title="Send for approval">
          <form method="post" action={`/api/po/${poId}/submit`}>
            <CsrfInput token={csrf} />
            <p class="ncc-muted">A submitted order cannot be edited. Short-close it or raise a new one.</p>
            <button class="ncc-btn ncc-btn-primary" type="submit">
              Submit for approval
            </button>
          </form>
        </Panel>
      ) : null}
      {po.status === 'pending_approval' && isMine ? (
        <Alert tone="warn">You raised this order, so you cannot approve it. Self-approval is refused whatever you hold.</Alert>
      ) : null}
      {canApprove && !isMine ? (
        <Panel title="Approve">
          <form method="post" action={`/api/po/${poId}/approve`}>
            <CsrfInput token={csrf} />
            <p class="ncc-muted">
              Checked against your approval limit. Above the second-approval threshold this records the first signature
              and leaves the order pending.
            </p>
            <button class="ncc-btn ncc-btn-primary" type="submit">
              Approve order
            </button>
          </form>
        </Panel>
      ) : null}
      {canShortClose ? (
        <Panel title="Short close">
          <form class="ncc-stack" method="post" action={`/api/po/${poId}/short-close`}>
            <CsrfInput token={csrf} />
            <FormField
              label="Reason"
              name="reason"
              rows={2}
              required
              hint="At least 10 characters. It is the only record of why the balance was abandoned."
            />
            <button class="ncc-btn ncc-btn-danger" type="submit">
              Short close the balance
            </button>
          </form>
        </Panel>
      ) : null}
    </>
  )
})

inventory.post('/api/po/:poId/submit', requirePermission(PERMISSIONS.INVENTORY_PO_CREATE), async (c) => {
  const poId = idParam(c, 'poId')
  await svc.submitPo(c.get('db'), actorOf(c), poId)
  return okRedirect(c, `/app/inventory/po/${poId}`, 'Sent for approval.')
})

inventory.post('/api/po/:poId/approve', requirePermission(PERMISSIONS.INVENTORY_APPROVE_PO), async (c) => {
  const poId = idParam(c, 'poId')
  const result = await svc.approvePo(c.get('db'), actorOf(c), poId, c.get('roleKeys'))
  const message =
    result.status === 'approved'
      ? `${result.poNo} approved at ${formatRupees(result.totalPaise)}.`
      : `${result.poNo} needs a second approval at ${formatRupees(result.totalPaise)}. Your signature is recorded.`
  return okRedirect(c, `/app/inventory/po/${poId}`, message)
})

inventory.post('/api/po/:poId/short-close', requirePermission(PERMISSIONS.INVENTORY_PO_CREATE), async (c) => {
  const poId = idParam(c, 'poId')
  const back = `/app/inventory/po/${poId}`
  const parsed = poShortCloseSchema.safeParse(await readBody(c))
  if (!parsed.success) return errRedirect(c, back, firstError(parsed.error))
  await svc.shortClosePo(c.get('db'), actorOf(c), poId, parsed.data.reason)
  return okRedirect(c, back, 'Balance short closed.')
})

/**
 * Print stylesheet for the PO.
 *
 * Deliberately free of child and sibling selectors: hono/jsx escapes the text
 * of a <style> element, so a ">" in a selector would reach the browser as
 * "&gt;" and silently stop matching.
 */
const PRINT_CSS = `
  @page { size: A4; margin: 14mm 12mm; }
  * { box-sizing: border-box; }
  body { font: 11pt/1.45 "DM Sans", Arial, sans-serif; color: #111; margin: 0; }
  h1 { font-size: 15pt; margin: 0 0 2pt; }
  h2 { font-size: 13pt; margin: 0 0 2pt; text-transform: uppercase; letter-spacing: .06em; }
  h3 { font-size: 10pt; margin: 0 0 4pt; text-transform: uppercase; letter-spacing: .06em; color: #555; }
  p { margin: 0 0 2pt; }
  .muted { color: #666; font-size: 9.5pt; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .right { text-align: right; }
  .head { display: flex; justify-content: space-between; align-items: flex-start;
          border-bottom: 1.5pt solid #111; padding-bottom: 6pt; margin-bottom: 10pt; }
  .two { display: flex; gap: 8mm; margin-bottom: 8pt; }
  .box { flex: 1; border: .5pt solid #bbb; padding: 6pt 8pt; }
  table { width: 100%; border-collapse: collapse; }
  .lines { margin-bottom: 8pt; }
  .lines th, .lines td { border: .5pt solid #bbb; padding: 4pt 6pt; vertical-align: top; }
  .lines thead th { background: #f2f2f2; font-size: 9.5pt; text-transform: uppercase; letter-spacing: .04em; }
  .lines tr { page-break-inside: avoid; }
  .totals { width: 60mm; margin-left: auto; margin-bottom: 10pt; }
  .totals th, .totals td { padding: 3pt 6pt; border-bottom: .5pt solid #ddd; text-align: left; }
  .totals .grand th, .totals .grand td { border-top: 1pt solid #111; border-bottom: none; font-weight: 700; }
  .terms { margin-bottom: 14pt; page-break-inside: avoid; }
  .sign { display: flex; gap: 6mm; page-break-inside: avoid; }
  .sign div { flex: 1; border-top: .5pt solid #111; padding-top: 4pt; font-size: 9.5pt; min-height: 18mm; }
  @media screen { body { max-width: 210mm; margin: 8mm auto; padding: 0 6mm; } }
`

/**
 * The printable order (spec 6.4 routes: "server-rendered A4 HTML, printed to
 * PDF by the browser. No PDF library on the server").
 *
 * Styles are inline rather than in dashboard.css: this document has to print
 * identically whether or not the stylesheet loaded, and a print layout that
 * depends on a cached asset is a document that comes out wrong at a vendor's
 * office. It renders its own <html>, so it does not go through page().
 *
 * Rates follow the same gate as every other screen. A caller without
 * inventory.view_rates gets the document without money columns and a line
 * saying so, rather than a PO that looks complete and is not.
 */
inventory.get('/api/po/:poId/print', requirePermission(PERMISSIONS.INVENTORY_VIEW), async (c) => {
  const db = c.get('db')
  const rates = canRates(c)
  const poId = idParam(c, 'poId')
  const po = await q.findPurchaseOrder(db, poId, rates)
  if (!po) throw new NotFoundError('Purchase order not found')
  const lines = await q.poLineRows(db, poId, rates)

  const [legalName, address, gstin, phone, email] = await Promise.all([
    getSetting(db, 'company.legal_name', 'Neelachandra Construction and Interiors'),
    getSetting(db, 'company.address_line', ''),
    getSetting(db, 'company.gstin', ''),
    getSetting(db, 'company.phone_primary', ''),
    getSetting(db, 'company.email_enquiry', ''),
  ])

  const doc = (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <title>{po.po_no}</title>
        <meta name="robots" content="noindex, nofollow" />
        <style>{PRINT_CSS}</style>
      </head>
      <body>
        <header class="head">
          <div>
            <h1>{legalName}</h1>
            <p>{address}</p>
            <p>
              {gstin ? `GSTIN ${gstin}` : ''}
              {gstin && phone ? ' | ' : ''}
              {phone}
              {email ? ` | ${email}` : ''}
            </p>
          </div>
          <div class="right">
            <h2>Purchase order</h2>
            <p>
              <strong>{po.po_no}</strong>
            </p>
            <p>{formatDate(po.po_date)}</p>
            <p>{po.status === 'approved' || po.status === 'received' ? '' : `Status: ${po.status.replace(/_/g, ' ')}`}</p>
          </div>
        </header>

        <section class="two">
          <div class="box">
            <h3>Vendor</h3>
            <p>
              <strong>{po.vendor_name}</strong>
            </p>
            <p>{po.vendor_address ?? ''}</p>
            <p>{po.vendor_city ?? ''}</p>
            <p>{po.vendor_gstin ? `GSTIN ${po.vendor_gstin}` : ''}</p>
            <p>{po.vendor_phone ?? ''}</p>
          </div>
          <div class="box">
            <h3>Deliver to</h3>
            <p>
              <strong>{po.delivery_location_name}</strong>
            </p>
            <p>{po.delivery_address ?? ''}</p>
            <p>{po.project_code ? `${po.project_code} - ${po.project_name}` : 'Central store'}</p>
            <p>{po.expected_delivery ? `Expected ${formatDate(po.expected_delivery)}` : ''}</p>
          </div>
        </section>
        <table class="lines">
          <thead>
            <tr>
              <th>#</th>
              <th>Description</th>
              <th>HSN</th>
              <th class="num">Qty</th>
              <th>Unit</th>
              {rates ? <th class="num">Rate</th> : null}
              <th class="num">GST %</th>
              {rates ? <th class="num">Amount</th> : null}
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr>
                <td>{i + 1}</td>
                <td>
                  <strong>{l.item_name}</strong>
                  <div class="muted">
                    {l.item_code}
                    {l.brand ? ` - ${l.brand}` : ''}
                    {l.remarks ? ` - ${l.remarks}` : ''}
                  </div>
                </td>
                <td>{l.hsn_code ?? ''}</td>
                <td class="num">{Number(l.qty_ordered)}</td>
                <td>{l.unit_code}</td>
                {rates ? <td class="num">{formatRupees(paiseOf(l, 'rate_paise') ?? 0)}</td> : null}
                <td class="num">{Number(l.gst_pct)}</td>
                {rates ? <td class="num">{formatRupees(paiseOf(l, 'line_total_paise') ?? 0)}</td> : null}
              </tr>
            ))}
          </tbody>
        </table>

        {rates ? (
          <table class="totals">
            <tbody>
              <tr>
                <th>Subtotal</th>
                <td class="num">{formatRupees(paiseOf(po, 'subtotal_paise') ?? 0)}</td>
              </tr>
              <tr>
                <th>GST</th>
                <td class="num">{formatRupees(paiseOf(po, 'gst_paise') ?? 0)}</td>
              </tr>
              <tr>
                <th>Freight</th>
                <td class="num">{formatRupees(paiseOf(po, 'freight_paise') ?? 0)}</td>
              </tr>
              <tr class="grand">
                <th>Total</th>
                <td class="num">{formatRupees(paiseOf(po, 'total_paise') ?? 0)}</td>
              </tr>
            </tbody>
          </table>
        ) : (
          <p class="muted">
            Rates and totals are withheld: printing them needs the inventory.view_rates permission. This copy is not the
            order sent to the vendor.
          </p>
        )}
        <section class="terms">
          <h3>Terms</h3>
          <p>
            Payment {po.payment_terms_days === null ? 'as agreed' : `${Number(po.payment_terms_days)} days from invoice`}
            {Number(po.advance_pct) > 0 ? `, advance ${Number(po.advance_pct)}%` : ''}.
          </p>
          {po.terms ? <p>{po.terms}</p> : null}
          <p>
            Quantities are as ordered. Short or damaged supply is recorded on receipt and the invoice queried before
            payment.
          </p>
        </section>
        <footer class="sign">
          <div>
            <p>Raised by</p>
            <p>{po.created_by_name ?? ''}</p>
          </div>
          <div>
            <p>Approved by</p>
            <p>{po.approved_by_name ?? ''}</p>
          </div>
          <div>
            <p>Second approval</p>
            <p>{po.second_approved_by_name ?? ''}</p>
          </div>
          <div>
            <p>For {legalName}</p>
            <p class="muted">Authorised signatory</p>
          </div>
        </footer>
      </body>
    </html>
  )

  return c.html(html`<!DOCTYPE html>${doc}`)
})

/* Goods receipts ---------------------------------------------------------- */

type GrnListRow = Awaited<ReturnType<typeof q.listGrns>>[number]

inventory.get('/app/inventory/grn', requirePermission(PERMISSIONS.INVENTORY_VIEW), async (c) => {
  const db = c.get('db')
  const scope = currentScope(c)
  const { page: pageNo, offset, pageSize } = pageParam(c, PAGE_SIZE)
  const status = queryParam(c, 'status') ?? null
  const locationId = Number(queryParam(c, 'locationId') ?? '') || null

  const [rows, total, locations] = await Promise.all([
    q.listGrns(db, scope, { status, locationId, limit: pageSize, offset }),
    q.countGrns(db, scope, { status, locationId }),
    q.locationOptions(db, scope),
  ])

  const columns: Column<GrnListRow>[] = [
    { header: 'Number', cell: (r) => <a href={`/app/inventory/grn/${r.id}`}>{r.grn_no}</a> },
    { header: 'Received', cell: (r) => <DateText value={r.received_on} /> },
    { header: 'Vendor', cell: (r) => r.vendor_name },
    { header: 'Store', cell: (r) => r.location_name },
    { header: 'Order', cell: (r) => r.po_no ?? <span class="ncc-muted">Direct</span> },
    { header: 'Invoice', cell: (r) => r.invoice_no ?? '-' },
    { header: 'Lines', numeric: true, cell: (r) => Number(r.line_count ?? 0) },
    {
      header: 'Match',
      // The three-way match in one column: a receipt whose challan and counted
      // quantity disagree is the one someone has to chase, because rule 3 at
      // NCC_BUILD_SPEC.md:1337 wants it so "the vendor invoice is queried before
      // payment rather than after", so the list says so rather than leaving it to
      // be found on the detail page.
      cell: (r) =>
        Number(r.mismatch_count ?? 0) > 0 ? (
          <strong>{Number(r.mismatch_count)} short</strong>
        ) : (
          <span class="ncc-muted">Agrees</span>
        ),
    },
    { header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
  ]

  const qs = new URLSearchParams()
  if (status) qs.set('status', status)
  if (locationId) qs.set('locationId', String(locationId))

  return page(
    c,
    {
      title: 'Goods receipts',
      path: '/app/inventory/grn',
      subtitle: 'Draft at the gate, posted when counted',
      actions: can(c, PERMISSIONS.INVENTORY_GRN_CREATE) ? (
        <a class="ncc-btn ncc-btn-primary" href="/app/inventory/grn/new">
          New receipt
        </a>
      ) : undefined,
    },
    <>
      {banner(c)}
      <Panel title="Receipts">
        <form method="get" action="/app/inventory/grn" class="ncc-row" style="flex-wrap:wrap;gap:.75rem">
          <FormField
            label="Status"
            name="status"
            options={enumOptions(['draft', 'posted', 'cancelled'], status, 'Any')}
          />
          <FormField label="Store" name="locationId" options={selectOptions(locations, locationId, 'All')} />
          <button class="ncc-btn" type="submit">
            Filter
          </button>
        </form>
        <DataTable columns={columns} rows={rows} empty="No goods receipt matches that filter." />
        <Pager
          page={pageNo}
          pageSize={pageSize}
          total={total}
          baseHref={qs.size ? `/app/inventory/grn?${qs.toString()}` : '/app/inventory/grn'}
        />
      </Panel>
    </>
  )
})

/**
 * A receipt is reached two ways: from an approved order's Receive button, which
 * arrives with ?poId and seeds the pending balance, or straight from the list
 * as a direct receipt against a vendor with no order behind it. Both end in the
 * same POST; the order id is simply null in the second case, which is what
 * createGrn() expects.
 */
inventory.get('/app/inventory/grn/new', requirePermission(PERMISSIONS.INVENTORY_GRN_CREATE), async (c) => {
  const db = c.get('db')
  const scope = currentScope(c)
  const rows = rowCount(c)
  const poId = Number(queryParam(c, 'poId') ?? '') || null
  let vendorId = Number(queryParam(c, 'vendorId') ?? '') || null

  const [vendors, items, locations, projects, inspectors, po, prefill] = await Promise.all([
    q.vendorOptions(db, 'material'),
    q.itemOptions(db),
    q.locationOptions(db, scope),
    q.projectOptions(db, scope),
    q.inspectorOptions(db),
    poId ? q.findPurchaseOrder(db, poId, canRates(c)) : Promise.resolve(undefined),
    poId ? q.receivablePoLines(db, poId) : Promise.resolve([]),
  ])

  if (poId && !po) throw new NotFoundError('Purchase order not found')
  // The order fixes the vendor. createGrn() refuses a receipt whose vendor is
  // not the one ordered from, so offering the choice here would only produce a
  // rejection after the whole grid was typed.
  if (po) vendorId = Number(po.vendor_id)

  const csrf = currentSession(c).csrfToken
  const ready = vendorId !== null

  type GrnSeed = { poLineId: number | null; itemId: number | null; qty: number | null; ratePaise: number | null }
  const seeds: GrnSeed[] =
    prefill.length > 0
      ? prefill.map((l) => ({
          poLineId: Number(l.id),
          itemId: Number(l.item_id),
          qty: l.qty_pending,
          ratePaise: Number(l.rate_paise),
        }))
      : blankRows(rows).map(() => ({ poLineId: null, itemId: null, qty: null, ratePaise: null }))

  return page(
    c,
    {
      title: po ? `Receive against ${po.po_no}` : 'Direct receipt',
      path: '/app/inventory/grn',
      subtitle: 'Saved as a draft. Posting is the step that moves stock.',
    },
    <>
      {banner(c)}
      {po ? (
        <Alert>
          Quantities are seeded with the pending balance of {po.po_no}. Correct them to what the lorry actually
          brought; the challan and the counted figure are separate columns on purpose.
        </Alert>
      ) : (
        <Panel title="Vendor">
          <form method="get" action="/app/inventory/grn/new" class="ncc-row" style="flex-wrap:wrap;gap:.75rem">
            <FormField
              label="Vendor"
              name="vendorId"
              required
              options={selectOptions(vendors, vendorId)}
              hint="A receipt with no order behind it. To receive against an order, open the order and use Receive."
            />
            <FormField label="Line rows" name="rows" type="number" min="1" max="60" value={rows} />
            <button class="ncc-btn" type="submit">
              {vendorId ? 'Change' : 'Continue'}
            </button>
          </form>
        </Panel>
      )}

      {!ready ? (
        <Alert tone="warn">Choose the vendor to continue.</Alert>
      ) : (
        <form class="ncc-stack" method="post" action="/app/inventory/grn">
          <CsrfInput token={csrf} />
          <input type="hidden" name="vendorId" value={String(vendorId)} />
          {poId ? <input type="hidden" name="poId" value={String(poId)} /> : null}

          <Panel title="Receipt">
            <div class="ncc-grid ncc-grid--2">
              <FormField
                label="Receiving store"
                name="locationId"
                required
                options={selectOptions(locations, po ? Number(po.delivery_location_id) : null)}
              />
              <FormField label="Received on" name="receivedOn" type="date" required value={today()} />
              <FormField
                label="Project"
                name="projectId"
                options={selectOptions(projects, po && po.project_id ? Number(po.project_id) : null, 'Central store')}
                hint="Only for material received straight to a site."
              />
              <FormField label="Vehicle" name="vehicleNo" placeholder="KA 01 AB 1234" />
              <FormField label="Gate entry" name="gateEntryNo" />
              <FormField
                label="Weighbridge slip"
                name="weighbridgeSlipNo"
                hint="Sand, aggregate and steel arrive by weight. The slip is the only independent record of it."
              />
              <FormField label="Invoice number" name="invoiceNo" />
              <FormField label="Invoice date" name="invoiceDate" type="date" />
              <FormField label="Invoice amount" name="invoiceAmount" type="number" step="0.01" min="0" hint="Rupees" />
              <FormField
                label="Inspected by"
                name="inspectedBy"
                options={selectOptions(
                  inspectors.map((u) => ({ id: u.id, name: u.full_name })),
                  null,
                  'Not inspected'
                )}
              />
            </div>
          </Panel>

          <Panel title="Lines">
            <LineGrid
              headers={[
                'Item',
                'Brand',
                'Challan',
                'Received',
                'Accepted',
                'Rejection reason',
                'Batch',
                'Manufactured',
                'Expiry',
                'Rate',
              ]}
              hint="Challan is what the paper says, Received is what was counted, Accepted is what passed inspection. A gap between the first two needs a reason before this can post."
            >
              {seeds.map((s) => (
                <tr>
                  <td>
                    <input type="hidden" name="poLineId" value={s.poLineId === null ? '' : String(s.poLineId)} />
                    <ItemCell items={items} selected={s.itemId} />
                  </td>
                  <td>
                    <input type="text" name="brand" />
                  </td>
                  <td class="ncc-num">
                    <QtyCell name="qtyChallan" value={s.qty} />
                  </td>
                  <td class="ncc-num">
                    <QtyCell name="qtyReceived" value={s.qty} />
                  </td>
                  <td class="ncc-num">
                    <QtyCell name="qtyAccepted" value={s.qty} />
                  </td>
                  <td>
                    <input type="text" name="rejectionReason" />
                  </td>
                  <td>
                    <input type="text" name="batchNo" />
                  </td>
                  <td>
                    <input type="date" name="manufactureDate" />
                  </td>
                  <td>
                    <input type="date" name="expiryDate" />
                  </td>
                  <td class="ncc-num">
                    <RupeeCell name="rate" value={s.ratePaise === null ? null : s.ratePaise / 100} />
                  </td>
                </tr>
              ))}
            </LineGrid>
          </Panel>

          <div class="ncc-row">
            <button class="ncc-btn ncc-btn-primary" type="submit">
              Save draft
            </button>
            <a class="ncc-btn" href="/app/inventory/grn">
              Cancel
            </a>
          </div>
        </form>
      )}
    </>
  )
})

inventory.post('/app/inventory/grn', requirePermission(PERMISSIONS.INVENTORY_GRN_CREATE), async (c) => {
  const body = await readBody(c)
  const parsed = grnSchema.safeParse(body)
  const qs = new URLSearchParams()
  if (Number(body.poId)) qs.set('poId', String(Number(body.poId)))
  else if (Number(body.vendorId)) qs.set('vendorId', String(Number(body.vendorId)))
  const back = `/app/inventory/grn/new${qs.size ? `?${qs.toString()}` : ''}`
  if (!parsed.success) return errRedirect(c, back, firstError(parsed.error))
  const { grnId, grnNo } = await svc.createGrn(c.get('db'), actorOf(c), parsed.data)
  return okRedirect(c, `/app/inventory/grn/${grnId}`, `${grnNo} saved as a draft. Nothing has moved into stock yet.`)
})

type GrnLine = Awaited<ReturnType<typeof q.grnLineRows>>[number]

inventory.get('/app/inventory/grn/:grnId', requirePermission(PERMISSIONS.INVENTORY_VIEW), async (c) => {
  const db = c.get('db')
  const rates = canRates(c)
  const grnId = idParam(c, 'grnId')
  const grn = await q.findGrn(db, grnId)
  if (!grn) throw new NotFoundError('Goods receipt not found')
  const lines = await q.grnLineRows(db, grnId, rates)

  const csrf = currentSession(c).csrfToken
  const isDraft = grn.status === 'draft'
  const canPost = isDraft && can(c, PERMISSIONS.INVENTORY_GRN_CREATE)

  // Rule 3, restated for the reader: a challan quantity that disagrees with the
  // counted quantity needs a reason. postGrn() is the gate; this only shows
  // which lines will stop it, so the store fills them in before trying.
  const mismatches = lines.filter((l) => Number(l.qty_challan) !== Number(l.qty_received))
  const unexplained = mismatches.filter((l) => (l.rejection_reason ?? '').trim().length === 0)

  const lineColumns: Column<GrnLine>[] = [
    {
      header: 'Item',
      cell: (r) => (
        <>
          <a href={`/app/inventory/items/${r.item_id}`}>{r.item_name}</a>
          <div class="ncc-muted">
            {r.item_code}
            {r.brand ? ` - ${r.brand}` : ''}
          </div>
        </>
      ),
    },
    { header: 'Challan', numeric: true, cell: (r) => <Qty value={Number(r.qty_challan)} unit={r.unit_code} /> },
    { header: 'Received', numeric: true, cell: (r) => <Qty value={Number(r.qty_received)} unit={r.unit_code} /> },
    { header: 'Accepted', numeric: true, cell: (r) => <Qty value={Number(r.qty_accepted)} unit={r.unit_code} /> },
    {
      header: 'Rejected',
      numeric: true,
      cell: (r) =>
        Number(r.qty_rejected) > 0 ? <Qty value={Number(r.qty_rejected)} unit={r.unit_code} /> : <span class="ncc-muted">-</span>,
    },
    { header: 'Reason', cell: (r) => r.rejection_reason ?? '-' },
    { header: 'Batch', cell: (r) => r.batch_no ?? '-' },
    { header: 'Expiry', cell: (r) => (r.expiry_date ? <DateText value={r.expiry_date} /> : '-') },
    { header: 'Rate', numeric: true, cell: (r) => <Money paise={paiseOf(r, 'rate_paise')} hidden={!rates} /> },
  ]

  return page(
    c,
    {
      title: grn.grn_no,
      path: '/app/inventory/grn',
      subtitle: `${grn.vendor_code} - ${grn.vendor_name}`,
    },
    <>
      {banner(c)}
      {mismatches.length > 0 ? (
        <Alert tone="warn">
          {mismatches.length} line{mismatches.length === 1 ? '' : 's'} where the challan and the counted quantity
          disagree.{' '}
          {unexplained.length > 0
            ? `${unexplained.length} of them has no reason recorded, so this receipt cannot post yet.`
            : 'Each has a reason recorded. Posting notifies procurement and accounts so the invoice is queried before it is paid.'}
        </Alert>
      ) : null}
      <div class="ncc-grid ncc-grid--2">
        <Panel title="Receipt">
          <DefinitionList
            rows={[
              ['Status', <StatusBadge status={grn.status} />],
              ['Received on', <DateText value={grn.received_on} />],
              ['Store', grn.location_name],
              ['Project', grn.project_code ?? 'Central store'],
              ['Order', grn.po_no ? <a href={`/app/inventory/po/${grn.po_id}`}>{grn.po_no}</a> : 'Direct receipt'],
              ['Vehicle', grn.vehicle_no ?? '-'],
              ['Gate entry', grn.gate_entry_no ?? '-'],
              ['Weighbridge slip', grn.weighbridge_slip_no ?? '-'],
              ['Received by', grn.received_by_name ?? '-'],
              ['Inspected by', grn.inspected_by_name ?? '-'],
              ['Posted at', grn.posted_at ? <DateText value={grn.posted_at} /> : 'Not posted'],
            ]}
          />
        </Panel>
        <Panel title="Invoice">
          <DefinitionList
            rows={[
              ['Number', grn.invoice_no ?? '-'],
              ['Date', grn.invoice_date ? <DateText value={grn.invoice_date} /> : '-'],
              ['Amount', <Money paise={paiseOf(grn, 'invoice_amount_paise')} hidden={!rates} />],
            ]}
          />
        </Panel>
      </div>
      <Panel title="Lines">
        <DataTable columns={lineColumns} rows={lines} empty="This receipt has no lines." />
      </Panel>

      {canPost ? (
        <Panel title="Post to stock">
          <form class="ncc-stack" method="post" action={`/api/grn/${grnId}/post`}>
            <CsrfInput token={csrf} />
            <p class="ncc-muted">
              Posting moves the accepted quantity into {grn.location_name} and cannot be undone. A mistake found later
              is corrected by a reversing stock adjustment, which leaves both entries on the record.
            </p>
            <p class="ncc-muted">
              A line whose brand is not an approved brand for the item needs inventory.approve_po to post, and is
              recorded as a substitution against your name.
            </p>
            <button class="ncc-btn ncc-btn-primary" type="submit">
              Post receipt
            </button>
          </form>
        </Panel>
      ) : null}
      {isDraft && !canPost ? (
        <Alert>This receipt is a draft. Posting it to stock needs inventory.grn_create.</Alert>
      ) : null}
    </>
  )
})

/**
 * Posts the receipt. The permission set is read here and passed in, so the
 * service never reaches back for permissions (see postGrn's note).
 */
inventory.post('/api/grn/:grnId/post', requirePermission(PERMISSIONS.INVENTORY_GRN_CREATE), async (c) => {
  const grnId = idParam(c, 'grnId')
  const result = await svc.postGrn(c.get('db'), actorOf(c), grnId, can(c, PERMISSIONS.INVENTORY_APPROVE_PO))

  const parts = [`${result.grnNo} posted. ${result.ledgerIds.length} stock entries written.`]
  if (result.shortages.length > 0) {
    parts.push(
      `${result.shortages.length} line${result.shortages.length === 1 ? '' : 's'} short against the challan; ` +
        'procurement and accounts have been notified to query the invoice.'
    )
  }
  if (result.brandExceptions.length > 0) {
    parts.push(
      `${result.brandExceptions.length} line${result.brandExceptions.length === 1 ? '' : 's'} on an unapproved brand, ` +
        'recorded as a substitution.'
    )
  }
  if (result.poStatus) parts.push(`Order is now ${result.poStatus.replace(/_/g, ' ')}.`)
  return okRedirect(c, `/app/inventory/grn/${grnId}`, parts.join(' '))
})

/* Issues ------------------------------------------------------------------ */

type IssueListRow = Awaited<ReturnType<typeof q.listIssues>>[number]

inventory.get('/app/inventory/issues', requirePermission(PERMISSIONS.INVENTORY_VIEW), async (c) => {
  const db = c.get('db')
  const scope = currentScope(c)
  const { page: pageNo, offset, pageSize } = pageParam(c, PAGE_SIZE)
  const projectId = Number(queryParam(c, 'projectId') ?? '') || null
  const locationId = Number(queryParam(c, 'locationId') ?? '') || null

  const [rows, total, projects, locations] = await Promise.all([
    q.listIssues(db, scope, { projectId, locationId, limit: pageSize, offset }),
    q.countIssues(db, scope, { projectId, locationId }),
    q.projectOptions(db, scope),
    q.locationOptions(db, scope),
  ])

  const columns: Column<IssueListRow>[] = [
    { header: 'Number', cell: (r) => <a href={`/app/inventory/issues/${r.id}`}>{r.issue_no}</a> },
    { header: 'Issued', cell: (r) => <DateText value={r.issued_on} /> },
    { header: 'Project', cell: (r) => r.project_code },
    { header: 'Store', cell: (r) => r.location_name },
    { header: 'To', cell: (r) => String(r.issued_to_type).replace(/_/g, ' ') },
    { header: 'Received by', cell: (r) => r.received_by_name ?? '-' },
    { header: 'Lines', numeric: true, cell: (r) => Number(r.line_count ?? 0) },
    { header: 'Issued by', cell: (r) => r.issued_by_name ?? '-' },
    { header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
  ]

  const qs = new URLSearchParams()
  if (projectId) qs.set('projectId', String(projectId))
  if (locationId) qs.set('locationId', String(locationId))

  return page(
    c,
    {
      title: 'Material issues',
      path: '/app/inventory/issues',
      subtitle: 'Posted as written. Material has already left the store.',
      actions: can(c, PERMISSIONS.INVENTORY_ISSUE) ? (
        <a class="ncc-btn ncc-btn-primary" href="/app/inventory/issues/new">
          New issue
        </a>
      ) : undefined,
    },
    <>
      {banner(c)}
      <Panel title="Issues">
        <form method="get" action="/app/inventory/issues" class="ncc-row" style="flex-wrap:wrap;gap:.75rem">
          <FormField label="Project" name="projectId" options={selectOptions(projects, projectId, 'All')} />
          <FormField label="Store" name="locationId" options={selectOptions(locations, locationId, 'All')} />
          <button class="ncc-btn" type="submit">
            Filter
          </button>
        </form>
        <DataTable columns={columns} rows={rows} empty="No issue matches that filter." />
        <Pager
          page={pageNo}
          pageSize={pageSize}
          total={total}
          baseHref={qs.size ? `/app/inventory/issues?${qs.toString()}` : '/app/inventory/issues'}
        />
      </Panel>
    </>
  )
})

inventory.get('/app/inventory/issues/new', requirePermission(PERMISSIONS.INVENTORY_ISSUE), async (c) => {
  const db = c.get('db')
  const scope = currentScope(c)
  const rows = rowCount(c)
  const projectId = Number(queryParam(c, 'projectId') ?? '') || null
  const locationId = Number(queryParam(c, 'locationId') ?? '') || null

  const [projects, items, locations, stages, contractors, costHeads, stock] = await Promise.all([
    q.projectOptions(db, scope),
    q.itemOptions(db),
    q.locationOptions(db, scope),
    projectId ? q.projectStageOptions(db, projectId) : Promise.resolve([]),
    q.labourContractorOptions(db),
    q.costHeadOptions(db),
    // What that store actually holds, so the storekeeper is picking from real
    // balances rather than the whole item master. Rule 2 is still enforced by
    // postStockMovement against the locked row; this is only guidance.
    locationId ? q.stockRows(db, scope, { canViewRates: false, locationId, limit: 500 }) : Promise.resolve([]),
  ])

  const csrf = currentSession(c).csrfToken
  const ready = projectId !== null && locationId !== null

  // The item column is narrowed to what the chosen store actually holds. An
  // item the store has never held cannot be issued from it, so offering the
  // whole master would only produce a rule 2 refusal after the slip was typed.
  const onHand = new Map(stock.map((s) => [Number(s.item_id), Number(s.qty_on_hand)]))
  const issuable = locationId ? items.filter((i) => onHand.has(i.id)) : items

  return page(
    c,
    {
      title: 'Issue material',
      path: '/app/inventory/issues',
      subtitle: 'Posts immediately: the slip is written as the material leaves',
    },
    <>
      {banner(c)}
      <Panel title="Store and project">
        <form method="get" action="/app/inventory/issues/new" class="ncc-row" style="flex-wrap:wrap;gap:.75rem">
          <FormField label="Store" name="locationId" required options={selectOptions(locations, locationId)} />
          <FormField label="Project" name="projectId" required options={selectOptions(projects, projectId)} />
          <FormField label="Line rows" name="rows" type="number" min="1" max="60" value={rows} />
          <button class="ncc-btn" type="submit">
            {ready ? 'Change' : 'Continue'}
          </button>
        </form>
      </Panel>

      {!ready ? (
        <Alert tone="warn">Choose the store and the project. The stages and the stock list load with them.</Alert>
      ) : issuable.length === 0 ? (
        <Alert tone="warn">
          That store holds no stock. Receive material into it, transfer some in, or record opening stock first.
        </Alert>
      ) : (
        <form class="ncc-stack" method="post" action="/app/inventory/issues">
          <CsrfInput token={csrf} />
          <input type="hidden" name="locationId" value={String(locationId)} />
          <input type="hidden" name="projectId" value={String(projectId)} />

          <Panel title="Slip">
            <div class="ncc-grid ncc-grid--2">
              <FormField label="Issued on" name="issuedOn" type="date" required value={today()} />
              <FormField
                label="Stage"
                name="projectStageId"
                options={selectOptions(
                  stages.map((s) => ({ id: s.id, code: String(s.seq), name: s.name })),
                  null,
                  'Not stage specific'
                )}
              />
              <FormField label="Issued to" name="issuedToType" required options={enumOptions(ISSUED_TO_TYPES)} />
              <FormField
                label="Labour contractor"
                name="labourContractorId"
                options={selectOptions(contractors, null, 'Not a contractor')}
                hint="Required when the material goes to a labour contractor."
              />
              <FormField label="Received by" name="receivedByName" placeholder="Name on the slip" />
              <FormField label="Purpose" name="purpose" placeholder="Where it is going" />
            </div>
          </Panel>
          <Panel title="Lines">
            <LineGrid
              headers={['Item', 'Quantity', 'Batch', 'Cost head']}
              hint="Only items this store holds are listed. Leave the batch blank and the oldest expiry is taken first; anything already expired is reported back to you."
            >
              {blankRows(rows).map(() => (
                <tr>
                  <td>
                    <ItemCell items={issuable} />
                  </td>
                  <td class="ncc-num">
                    <QtyCell name="qtyIssued" />
                  </td>
                  <td>
                    <input type="text" name="batchNo" />
                  </td>
                  <td>
                    <select name="costHeadId">
                      <option value="">-</option>
                      {costHeads.map((h) => (
                        <option value={String(h.id)}>
                          {h.code} - {h.name}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </LineGrid>
          </Panel>

          <div class="ncc-row">
            <button class="ncc-btn ncc-btn-primary" type="submit">
              Issue material
            </button>
            <a class="ncc-btn" href="/app/inventory/issues">
              Cancel
            </a>
          </div>
        </form>
      )}
    </>
  )
})

inventory.post('/app/inventory/issues', requirePermission(PERMISSIONS.INVENTORY_ISSUE), async (c) => {
  const body = await readBody(c)
  const parsed = issueSchema.safeParse(body)
  const back = `/app/inventory/issues/new?locationId=${Number(body.locationId) || ''}&projectId=${Number(body.projectId) || ''}`
  if (!parsed.success) return errRedirect(c, back, firstError(parsed.error))

  const result = await svc.createIssue(c.get('db'), actorOf(c), parsed.data)

  // Expired batches are used, not refused (see allocateBatches). The slip is
  // posted either way; what the storekeeper gets is the list of what went out
  // past its date, so a bag of set cement is a decision rather than a surprise
  // in a wall.
  const message =
    result.expiredPicks.length === 0
      ? `${result.issueNo} issued.`
      : `${result.issueNo} issued. ` +
        result.expiredPicks
          .map((p) => `${p.itemCode} batch ${p.batchNo} expired ${formatDate(p.expiryDate)}`)
          .join('; ') +
        '. Check the material before it is used.'
  return okRedirect(c, `/app/inventory/issues/${result.issueId}`, message)
})

type IssueLine = Awaited<ReturnType<typeof q.issueLineRows>>[number]

inventory.get('/app/inventory/issues/:issueId', requirePermission(PERMISSIONS.INVENTORY_VIEW), async (c) => {
  const db = c.get('db')
  const rates = canRates(c)
  const issueId = idParam(c, 'issueId')
  const issue = await q.findIssue(db, issueId)
  if (!issue) throw new NotFoundError('Issue not found')
  const lines = await q.issueLineRows(db, issueId, rates)

  const csrf = currentSession(c).csrfToken
  const outstanding = lines.filter((l) => Number(l.qty_issued) - Number(l.qty_returned) > 0)
  const canReturn = issue.status !== 'cancelled' && outstanding.length > 0 && can(c, PERMISSIONS.INVENTORY_ISSUE)

  const lineColumns: Column<IssueLine>[] = [
    {
      header: 'Item',
      cell: (r) => (
        <>
          <a href={`/app/inventory/items/${r.item_id}`}>{r.item_name}</a>
          <div class="ncc-muted">
            {r.item_code}
            {r.batch_no ? ` - batch ${r.batch_no}` : ''}
          </div>
        </>
      ),
    },
    { header: 'Issued', numeric: true, cell: (r) => <Qty value={Number(r.qty_issued)} unit={r.unit_code} /> },
    {
      header: 'Returned',
      numeric: true,
      cell: (r) =>
        Number(r.qty_returned) > 0 ? <Qty value={Number(r.qty_returned)} unit={r.unit_code} /> : <span class="ncc-muted">-</span>,
    },
    {
      header: 'Consumed',
      numeric: true,
      cell: (r) => <Qty value={Number(r.qty_issued) - Number(r.qty_returned)} unit={r.unit_code} />,
    },
    { header: 'Cost head', cell: (r) => r.cost_head_name ?? '-' },
    { header: 'Rate', numeric: true, cell: (r) => <Money paise={paiseOf(r, 'rate_paise')} hidden={!rates} /> },
  ]

  return page(
    c,
    {
      title: issue.issue_no,
      path: '/app/inventory/issues',
      subtitle: `${issue.project_code} - ${issue.project_name}`,
    },
    <>
      {banner(c)}
      <div class="ncc-grid ncc-grid--2">
        <Panel title="Slip">
          <DefinitionList
            rows={[
              ['Status', <StatusBadge status={issue.status} />],
              ['Issued on', <DateText value={issue.issued_on} />],
              ['Store', issue.location_name],
              ['Stage', issue.stage_name ?? 'Not stage specific'],
              ['Issued to', String(issue.issued_to_type).replace(/_/g, ' ')],
              ['Contractor', issue.contractor_name ?? '-'],
              ['Received by', issue.received_by_name ?? '-'],
              ['Purpose', issue.purpose ?? '-'],
              ['Issued by', issue.issued_by_name ?? '-'],
            ]}
          />
        </Panel>
        <Panel title="Returns">
          <p class="ncc-muted">
            Material comes back into the store at the store's current weighted average, not at the rate it went out on.
            A month-old issue returning at its old rate would make the stock value disagree with a ledger replay.
          </p>
        </Panel>
      </div>
      <Panel title="Lines">
        <DataTable columns={lineColumns} rows={lines} empty="This issue has no lines." />
      </Panel>

      {canReturn ? (
        <Panel title="Record a return">
          <form class="ncc-stack" method="post" action={`/api/issues/${issueId}/return`}>
            <CsrfInput token={csrf} />
            <FormField label="Returned on" name="returnedOn" type="date" required value={today()} />
            <LineGrid
              headers={['Item', 'Still out', 'Coming back']}
              hint="Leave a line at zero to return nothing on it."
            >
              {outstanding.map((l) => (
                <tr>
                  <td>
                    <input type="hidden" name="issueLineId" value={String(l.id)} />
                    {l.item_code} - {l.item_name}
                  </td>
                  <td class="ncc-num">
                    <Qty value={Number(l.qty_issued) - Number(l.qty_returned)} unit={l.unit_code} />
                  </td>
                  <td class="ncc-num">
                    <QtyCell name="qtyReturned" value={0} max={Number(l.qty_issued) - Number(l.qty_returned)} />
                  </td>
                </tr>
              ))}
            </LineGrid>
            <button class="ncc-btn ncc-btn-primary" type="submit">
              Take it back into stock
            </button>
          </form>
        </Panel>
      ) : null}
    </>
  )
})

inventory.post('/api/issues/:issueId/return', requirePermission(PERMISSIONS.INVENTORY_ISSUE), async (c) => {
  const issueId = idParam(c, 'issueId')
  const back = `/app/inventory/issues/${issueId}`
  const parsed = issueReturnSchema.safeParse(await readBody(c))
  if (!parsed.success) return errRedirect(c, back, firstError(parsed.error))
  await svc.returnIssue(c.get('db'), actorOf(c), issueId, parsed.data.returnedOn, parsed.data.lines)
  const n = parsed.data.lines.length
  return okRedirect(c, back, `${n} line${n === 1 ? '' : 's'} returned into stock.`)
})

/* Transfers --------------------------------------------------------------- */

const TRANSFER_STATUSES = ['in_transit', 'received', 'cancelled'] as const

type TransferListRow = Awaited<ReturnType<typeof q.listTransfers>>[number]

inventory.get('/app/inventory/transfers', requirePermission(PERMISSIONS.INVENTORY_VIEW), async (c) => {
  const db = c.get('db')
  const scope = currentScope(c)
  const { page: pageNo, offset, pageSize } = pageParam(c, PAGE_SIZE)
  const status = queryParam(c, 'status') ?? null

  const [rows, total] = await Promise.all([
    q.listTransfers(db, scope, { status, limit: pageSize, offset }),
    q.countTransfers(db, scope, { status }),
  ])

  const columns: Column<TransferListRow>[] = [
    { header: 'Number', cell: (r) => <a href={`/app/inventory/transfers/${r.id}`}>{r.transfer_no}</a> },
    { header: 'Dispatched', cell: (r) => <DateText value={r.dispatched_on} /> },
    { header: 'From', cell: (r) => r.from_location_name },
    { header: 'To', cell: (r) => r.to_location_name },
    { header: 'Vehicle', cell: (r) => r.vehicle_no ?? '-' },
    { header: 'Lines', numeric: true, cell: (r) => Number(r.line_count ?? 0) },
    { header: 'Received', cell: (r) => (r.received_on ? <DateText value={r.received_on} /> : <span class="ncc-muted">In transit</span>) },
    { header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
  ]

  return page(
    c,
    {
      title: 'Stock transfers',
      path: '/app/inventory/transfers',
      subtitle: 'Two steps: out to transit, then into the receiving store',
      actions: can(c, PERMISSIONS.INVENTORY_TRANSFER) ? (
        <a class="ncc-btn ncc-btn-primary" href="/app/inventory/transfers/new">
          New transfer
        </a>
      ) : undefined,
    },
    <>
      {banner(c)}
      <Panel title="Transfers">
        <form method="get" action="/app/inventory/transfers" class="ncc-row" style="flex-wrap:wrap;gap:.75rem">
          <FormField label="Status" name="status" options={enumOptions(TRANSFER_STATUSES, status, 'Any')} />
          <button class="ncc-btn" type="submit">
            Filter
          </button>
        </form>
        <DataTable columns={columns} rows={rows} empty="No transfer matches that filter." />
        <Pager
          page={pageNo}
          pageSize={pageSize}
          total={total}
          baseHref={status ? `/app/inventory/transfers?status=${status}` : '/app/inventory/transfers'}
        />
      </Panel>
    </>
  )
})

inventory.get('/app/inventory/transfers/new', requirePermission(PERMISSIONS.INVENTORY_TRANSFER), async (c) => {
  const db = c.get('db')
  const scope = currentScope(c)
  const rows = rowCount(c)
  const fromLocationId = Number(queryParam(c, 'fromLocationId') ?? '') || null

  const [locations, items, stock] = await Promise.all([
    q.locationOptions(db, scope),
    q.itemOptions(db),
    fromLocationId
      ? q.stockRows(db, scope, { canViewRates: false, locationId: fromLocationId, limit: 500 })
      : Promise.resolve([]),
  ])

  const csrf = currentSession(c).csrfToken
  const onHand = new Map(stock.map((s) => [Number(s.item_id), Number(s.qty_on_hand)]))
  const sendable = fromLocationId ? items.filter((i) => onHand.has(i.id)) : items

  return page(
    c,
    {
      title: 'Dispatch a transfer',
      path: '/app/inventory/transfers',
      subtitle: 'Material leaves the sending store now and arrives when it is received',
    },
    <>
      {banner(c)}
      <Panel title="Sending store">
        <form method="get" action="/app/inventory/transfers/new" class="ncc-row" style="flex-wrap:wrap;gap:.75rem">
          <FormField
            label="From"
            name="fromLocationId"
            required
            options={selectOptions(locations, fromLocationId)}
            hint="Its stock list loads with it."
          />
          <FormField label="Line rows" name="rows" type="number" min="1" max="60" value={rows} />
          <button class="ncc-btn" type="submit">
            {fromLocationId ? 'Change' : 'Continue'}
          </button>
        </form>
      </Panel>

      {fromLocationId === null ? (
        <Alert tone="warn">Choose the sending store to continue.</Alert>
      ) : sendable.length === 0 ? (
        <Alert tone="warn">That store holds no stock, so there is nothing to send from it.</Alert>
      ) : (
        <form class="ncc-stack" method="post" action="/app/inventory/transfers">
          <CsrfInput token={csrf} />
          <input type="hidden" name="fromLocationId" value={String(fromLocationId)} />
          <Panel title="Dispatch">
            <div class="ncc-grid ncc-grid--2">
              <FormField
                label="To"
                name="toLocationId"
                required
                options={selectOptions(
                  locations.filter((l) => l.id !== fromLocationId),
                  null
                )}
              />
              <FormField label="Dispatched on" name="dispatchedOn" type="date" required value={today()} />
              <FormField label="Vehicle" name="vehicleNo" placeholder="KA 01 AB 1234" />
            </div>
          </Panel>
          <Panel title="Lines">
            <LineGrid
              headers={['Item', 'Quantity sent', 'Batch']}
              hint="Only items the sending store holds are listed. The quantity leaves that store now and sits in transit until the far end receives it."
            >
              {blankRows(rows).map(() => (
                <tr>
                  <td>
                    <ItemCell items={sendable} />
                  </td>
                  <td class="ncc-num">
                    <QtyCell name="qtySent" />
                  </td>
                  <td>
                    <input type="text" name="batchNo" />
                  </td>
                </tr>
              ))}
            </LineGrid>
          </Panel>
          <div class="ncc-row">
            <button class="ncc-btn ncc-btn-primary" type="submit">
              Dispatch
            </button>
            <a class="ncc-btn" href="/app/inventory/transfers">
              Cancel
            </a>
          </div>
        </form>
      )}
    </>
  )
})

inventory.post('/app/inventory/transfers', requirePermission(PERMISSIONS.INVENTORY_TRANSFER), async (c) => {
  const body = await readBody(c)
  const parsed = transferSchema.safeParse(body)
  const back = `/app/inventory/transfers/new?fromLocationId=${Number(body.fromLocationId) || ''}`
  if (!parsed.success) return errRedirect(c, back, firstError(parsed.error))
  const { transferId, transferNo } = await svc.dispatchTransfer(c.get('db'), actorOf(c), parsed.data)
  return okRedirect(
    c,
    `/app/inventory/transfers/${transferId}`,
    `${transferNo} dispatched. The material is in transit until the receiving store records it.`
  )
})

type TransferLine = Awaited<ReturnType<typeof q.transferLineRows>>[number]

inventory.get('/app/inventory/transfers/:transferId', requirePermission(PERMISSIONS.INVENTORY_VIEW), async (c) => {
  const db = c.get('db')
  const transferId = idParam(c, 'transferId')
  const transfer = await q.findTransfer(db, transferId)
  if (!transfer) throw new NotFoundError('Transfer not found')
  const lines = await q.transferLineRows(db, transferId)

  const csrf = currentSession(c).csrfToken
  const canReceive = transfer.status === 'in_transit' && can(c, PERMISSIONS.INVENTORY_TRANSFER)
  const shortages = lines.filter((l) => Number(l.shortage_qty ?? 0) > 0)

  const lineColumns: Column<TransferLine>[] = [
    {
      header: 'Item',
      cell: (r) => (
        <>
          <a href={`/app/inventory/items/${r.item_id}`}>{r.item_name}</a>
          <div class="ncc-muted">
            {r.item_code}
            {r.batch_no ? ` - batch ${r.batch_no}` : ''}
          </div>
        </>
      ),
    },
    { header: 'Sent', numeric: true, cell: (r) => <Qty value={Number(r.qty_sent)} unit={r.unit_code} /> },
    {
      header: 'Received',
      numeric: true,
      cell: (r) =>
        r.qty_received === null ? <span class="ncc-muted">-</span> : <Qty value={Number(r.qty_received)} unit={r.unit_code} />,
    },
    {
      header: 'Shortage',
      numeric: true,
      cell: (r) =>
        Number(r.shortage_qty ?? 0) > 0 ? <strong><Qty value={Number(r.shortage_qty)} unit={r.unit_code} /></strong> : <span class="ncc-muted">-</span>,
    },
  ]

  return page(
    c,
    {
      title: transfer.transfer_no,
      path: '/app/inventory/transfers',
      subtitle: `${transfer.from_location_name} to ${transfer.to_location_name}`,
    },
    <>
      {banner(c)}
      {shortages.length > 0 ? (
        <Alert tone="warn">
          {shortages.length} line{shortages.length === 1 ? '' : 's'} arrived short. The shortfall is still held in
          transit, not written off: post a stock adjustment against transit with a reason once someone has established
          what happened to it.
        </Alert>
      ) : null}
      <Panel title="Transfer">
        <DefinitionList
          rows={[
            ['Status', <StatusBadge status={transfer.status} />],
            ['Dispatched on', <DateText value={transfer.dispatched_on} />],
            ['Dispatched by', transfer.dispatched_by_name ?? '-'],
            ['Vehicle', transfer.vehicle_no ?? '-'],
            ['Received on', transfer.received_on ? <DateText value={transfer.received_on} /> : 'Not yet received'],
            ['Received by', transfer.received_by_name ?? '-'],
          ]}
        />
      </Panel>
      <Panel title="Lines">
        <DataTable columns={lineColumns} rows={lines} empty="This transfer has no lines." />
      </Panel>
      {canReceive ? (
        <Panel title="Receive into the store">
          <form class="ncc-stack" method="post" action={`/api/transfers/${transferId}/receive`}>
            <CsrfInput token={csrf} />
            <FormField label="Received on" name="receivedOn" type="date" required value={today()} />
            <LineGrid
              headers={['Item', 'Sent', 'Received']}
              hint="Count it at the gate. Anything less than what was sent is recorded as a shortage and stays in transit."
            >
              {lines.map((l) => (
                <tr>
                  <td>
                    <input type="hidden" name="lineId" value={String(l.id)} />
                    {l.item_code} - {l.item_name}
                  </td>
                  <td class="ncc-num">
                    <Qty value={Number(l.qty_sent)} unit={l.unit_code} />
                  </td>
                  <td class="ncc-num">
                    <QtyCell name="qtyReceived" value={Number(l.qty_sent)} max={Number(l.qty_sent)} />
                  </td>
                </tr>
              ))}
            </LineGrid>
            <button class="ncc-btn ncc-btn-primary" type="submit">
              Receive
            </button>
          </form>
        </Panel>
      ) : null}
    </>
  )
})

/**
 * Receives a transfer. A short arrival is not an error: the lines are accepted
 * at the counted quantity and the difference is left sitting in transit, so the
 * banner has to say where it went, otherwise the store assumes the system
 * swallowed it.
 */
inventory.post('/api/transfers/:transferId/receive', requirePermission(PERMISSIONS.INVENTORY_TRANSFER), async (c) => {
  const transferId = idParam(c, 'transferId')
  const back = `/app/inventory/transfers/${transferId}`
  const parsed = transferReceiveSchema.safeParse(await readBody(c))
  if (!parsed.success) return errRedirect(c, back, firstError(parsed.error))

  const result = await svc.receiveTransfer(c.get('db'), actorOf(c), transferId, parsed.data.receivedOn, parsed.data.lines)

  const parts = [`${result.transferNo} received.`]
  if (result.shortages.length > 0) {
    parts.push(
      'Short: ' +
        result.shortages.map((s) => `${s.itemCode} ${s.shortage} ${s.unit}`).join(', ') +
        '. That quantity is still in transit. Adjust it out against transit once you know what happened to it.'
    )
  }
  return okRedirect(c, back, parts.join(' '))
})

type AdjustmentListRow = Awaited<ReturnType<typeof q.listAdjustments>>[number]

/**
 * Adjustments are the ledger's confession column: every quantity in the system
 * that does not match the shelf ends up here with a reason and a name against
 * it. The list is therefore ordered newest first and shows who wrote it, which
 * is what makes a pattern of "damage" at one store visible.
 */
inventory.get('/app/inventory/adjustments', requirePermission(PERMISSIONS.INVENTORY_VIEW), async (c) => {
  const db = c.get('db')
  const scope = currentScope(c)
  const { page: pageNo, offset, pageSize } = pageParam(c, PAGE_SIZE)
  const reason = queryParam(c, 'reason') ?? null

  const [rows, total] = await Promise.all([
    q.listAdjustments(db, scope, { reason, limit: pageSize, offset }),
    q.countAdjustments(db, scope, { reason }),
  ])

  const columns: Column<AdjustmentListRow>[] = [
    { header: 'Date', cell: (r) => <a href={`/app/inventory/adjustments/${r.id}`}>{formatDate(r.adjustment_date)}</a> },
    { header: 'Store', cell: (r) => r.location_name },
    { header: 'Reason', cell: (r) => <StatusBadge status={r.reason} /> },
    { header: 'Lines', numeric: true, cell: (r) => Number(r.line_count ?? 0) },
    { header: 'Narration', cell: (r) => r.narration },
    { header: 'Entered by', cell: (r) => r.created_by_name ?? '-' },
  ]

  return page(
    c,
    {
      title: 'Stock adjustments',
      path: '/app/inventory/adjustments',
      subtitle: 'Physical counts, damage, theft and shortages, each with a reason',
      actions: can(c, PERMISSIONS.INVENTORY_STOCK_ADJUST) ? (
        <div class="ncc-row" style="gap:.5rem">
          <a class="ncc-btn" href="/app/inventory/adjustments/opening">
            Opening stock
          </a>
          <a class="ncc-btn ncc-btn-primary" href="/app/inventory/adjustments/new">
            New adjustment
          </a>
        </div>
      ) : undefined,
    },
    <>
      {banner(c)}
      <Panel title="Adjustments">
        <form method="get" action="/app/inventory/adjustments" class="ncc-row" style="flex-wrap:wrap;gap:.75rem">
          <FormField label="Reason" name="reason" options={enumOptions(ADJUSTMENT_REASONS, reason, 'Any')} />
          <button class="ncc-btn" type="submit">
            Filter
          </button>
        </form>
        <DataTable columns={columns} rows={rows} empty="No adjustment matches that filter." />
        <Pager
          page={pageNo}
          pageSize={pageSize}
          total={total}
          baseHref={reason ? `/app/inventory/adjustments?reason=${reason}` : '/app/inventory/adjustments'}
        />
      </Panel>
    </>
  )
})

/**
 * The count sheet.
 *
 * The system quantity is deliberately absent from this form, on screen as well
 * as in the POST: a counter who can see what the system expects tends to write
 * that number down. postAdjustment reads the system figure itself, inside the
 * transaction, from the row it is about to lock.
 *
 * The item column offers the whole master rather than only what the store holds,
 * because found stock is a real outcome of a count. postAdjustment treats an
 * item with no cache row as a system quantity of zero, so counting three bags of
 * something the system has never seen at that store works.
 */
inventory.get('/app/inventory/adjustments/new', requirePermission(PERMISSIONS.INVENTORY_STOCK_ADJUST), async (c) => {
  const db = c.get('db')
  const scope = currentScope(c)
  const rows = rowCount(c)

  const [locations, items] = await Promise.all([q.locationOptions(db, scope), q.itemOptions(db)])
  const csrf = currentSession(c).csrfToken

  return page(
    c,
    {
      title: 'New stock adjustment',
      path: '/app/inventory/adjustments',
      subtitle: 'Count what is there and say why it differs',
    },
    <>
      {banner(c)}
      <form class="ncc-stack" method="post" action="/app/inventory/adjustments">
        <CsrfInput token={csrf} />
        <Panel title="Adjustment">
          <div class="ncc-grid ncc-grid--2">
            <FormField label="Store" name="locationId" required options={selectOptions(locations)} />
            <FormField label="Count date" name="adjustmentDate" type="date" required value={today()} />
            <FormField label="Reason" name="reason" required options={enumOptions(ADJUSTMENT_REASONS, null, 'Choose one')} />
            <FormField
              label="Narration"
              name="narration"
              required
              rows={2}
              hint="At least 10 characters. Who counted, what you found, and what you think happened."
            />
          </div>
        </Panel>
        <Panel title="Counted quantities">
          <LineGrid
            headers={['Item', 'Counted quantity']}
            hint="Enter what is physically on the shelf. Leave a row blank to skip it; a line that agrees with the system writes no ledger entry."
          >
            {blankRows(rows).map(() => (
              <tr>
                <td>
                  <ItemCell items={items} />
                </td>
                <td class="ncc-num">
                  <QtyCell name="qtyPhysical" />
                </td>
              </tr>
            ))}
          </LineGrid>
          <div class="ncc-row" style="justify-content:space-between;margin-top:1rem">
            <a class="ncc-btn" href={`/app/inventory/adjustments/new?rows=${rows + 8}`}>
              More rows
            </a>
            <button class="ncc-btn ncc-btn-primary" type="submit">
              Post adjustment
            </button>
          </div>
        </Panel>
      </form>
    </>
  )
})

inventory.post('/app/inventory/adjustments', requirePermission(PERMISSIONS.INVENTORY_STOCK_ADJUST), async (c) => {
  const parsed = adjustmentSchema.safeParse(await readBody(c))
  if (!parsed.success) return errRedirect(c, '/app/inventory/adjustments/new', firstError(parsed.error))

  const result = await svc.postAdjustment(c.get('db'), actorOf(c), parsed.data)

  // The count is worth reporting even when nothing moved: "12 lines counted, all
  // agree" is the outcome a storekeeper wants to see, and it is not the same
  // message as a silent success.
  const changed = result.lines.filter((l) => Math.abs(l.qtyDiff) > 0.0005)
  const message =
    changed.length === 0
      ? `${result.lines.length} line${result.lines.length === 1 ? '' : 's'} counted. Everything agrees with the system, so no stock entry was written.`
      : `${changed.length} of ${result.lines.length} lines differed: ` +
        changed.map((l) => `${l.itemCode} ${l.qtyDiff > 0 ? '+' : ''}${l.qtyDiff} ${l.unit}`).join(', ') +
        `. Net effect ${formatRupees(result.netValuePaise)} at the store's average rate.`

  return okRedirect(c, `/app/inventory/adjustments/${result.adjustmentId}`, message)
})

/**
 * Opening stock, one item at a time.
 *
 * Not a grid, on purpose: each line carries its own rate and batch, and the rate
 * is the number the whole valuation of that item starts from. A grid invites a
 * copied rate down twenty rows. It is also a one-shot per item and store, which
 * postOpeningStock enforces by refusing once any ledger row exists.
 */
inventory.get('/app/inventory/adjustments/opening', requirePermission(PERMISSIONS.INVENTORY_STOCK_ADJUST), async (c) => {
  const db = c.get('db')
  const scope = currentScope(c)
  const [locations, items] = await Promise.all([q.locationOptions(db, scope), q.itemOptions(db)])
  const csrf = currentSession(c).csrfToken

  return page(
    c,
    {
      title: 'Opening stock',
      path: '/app/inventory/adjustments',
      subtitle: 'The starting balance for material already on the shelf',
    },
    <>
      {banner(c)}
      <Alert tone="warn">
        Opening stock can only be set before an item has moved at that store. Once a receipt, issue or transfer exists
        the balance is history, and the way to correct it is an adjustment with a reason. The rate entered here becomes
        the item's weighted average at that store, so it decides what every later issue is costed at.
      </Alert>
      <form class="ncc-stack" method="post" action="/app/inventory/adjustments/opening">
        <CsrfInput token={csrf} />
        <Panel title="Opening balance">
          <div class="ncc-grid ncc-grid--2">
            <FormField label="Store" name="locationId" required options={selectOptions(locations)} />
            <FormField label="As on" name="asOn" type="date" required value={today()} />
            <FormField label="Item" name="itemId" required options={selectOptions(items)} />
            <FormField label="Quantity" name="qty" type="number" step="0.001" min="0" required />
            <FormField label="Rate" name="rate" type="number" step="0.01" min="0" required hint="Rupees per unit" />
            <FormField
              label="Batch number"
              name="batchNo"
              hint="Required for a batch-tracked item such as cement."
            />
          </div>
        </Panel>
        <div>
          <button class="ncc-btn ncc-btn-primary" type="submit">
            Post opening stock
          </button>
        </div>
      </form>
    </>
  )
})

inventory.post('/app/inventory/adjustments/opening', requirePermission(PERMISSIONS.INVENTORY_STOCK_ADJUST), async (c) => {
  const back = '/app/inventory/adjustments/opening'
  const parsed = openingStockSchema.safeParse(await readBody(c))
  if (!parsed.success) return errRedirect(c, back, firstError(parsed.error))

  // The schema names its field `rate` because the form input is called rate and
  // the two have to agree; the service takes ratePaise. The conversion already
  // happened in the schema, so this is a rename, not a second multiplication.
  const { rate, ...rest } = parsed.data
  const result = await svc.postOpeningStock(c.get('db'), actorOf(c), { ...rest, ratePaise: rate })
  return okRedirect(c, back, `Opening stock recorded. The store now holds ${result.balanceAfter} of that item.`)
})
type AdjustmentLine = Awaited<ReturnType<typeof q.adjustmentLineRows>>[number]

inventory.get('/app/inventory/adjustments/:adjustmentId', requirePermission(PERMISSIONS.INVENTORY_VIEW), async (c) => {
  const db = c.get('db')
  const adjustmentId = idParam(c, 'adjustmentId')
  const rates = canRates(c)

  const adjustment = await q.findAdjustment(db, adjustmentId)
  if (!adjustment) throw new NotFoundError('Adjustment not found')
  const lines = await q.adjustmentLineRows(db, adjustmentId, rates)

  const columns: Column<AdjustmentLine>[] = [
    { header: 'Item', cell: (r) => `${r.item_code} - ${r.item_name}` },
    { header: 'System', numeric: true, cell: (r) => <Qty value={Number(r.qty_system)} unit={r.unit_code} /> },
    { header: 'Counted', numeric: true, cell: (r) => <Qty value={Number(r.qty_physical)} unit={r.unit_code} /> },
    {
      header: 'Difference',
      numeric: true,
      // The sign is the whole point of the row, so it is printed rather than
      // left to be inferred from two other columns.
      cell: (r) => {
        const d = Number(r.qty_diff)
        if (Math.abs(d) < 0.0005) return <span class="ncc-muted">-</span>
        return (
          <strong>
            {d > 0 ? '+' : ''}
            {d} {r.unit_code}
          </strong>
        )
      },
    },
    {
      header: 'Value effect',
      numeric: true,
      // rate_paise is the store's weighted average at the moment of the count,
      // frozen on the line by postAdjustment. Multiplying it by the difference
      // is what the loss or gain was worth, which is the number an owner reads.
      cell: (r) => {
        const rate = paiseOf(r, 'rate_paise')
        return <Money paise={rate === null ? null : Math.round(rate * Number(r.qty_diff))} hidden={!rates} />
      },
    },
  ]

  return page(
    c,
    {
      title: `Adjustment of ${formatDate(adjustment.adjustment_date)}`,
      path: '/app/inventory/adjustments',
      subtitle: `${adjustment.location_name} - ${adjustment.reason.replace(/_/g, ' ')}`,
    },
    <>
      {banner(c)}
      <Panel title="Adjustment">
        <DefinitionList
          rows={[
            ['Store', adjustment.location_name],
            ['Count date', <DateText value={adjustment.adjustment_date} />],
            ['Reason', <StatusBadge status={adjustment.reason} />],
            ['Narration', adjustment.narration],
            ['Entered by', adjustment.created_by_name ?? '-'],
            ['Entered at', <DateText value={adjustment.created_at} withTime />],
          ]}
        />
      </Panel>
      <Panel title="Lines">
        <DataTable columns={columns} rows={lines} empty="This adjustment has no lines." />
      </Panel>
      <Alert tone="ok">
        An adjustment cannot be edited or deleted. The stock ledger is append-only, so a mistake here is corrected by a
        second adjustment that says so, and both stay on the record.
      </Alert>
    </>
  )
})

/* Vendors ----------------------------------------------------------------- */

type VendorListRow = Awaited<ReturnType<typeof q.listVendors>>[number]

/**
 * Vendors, read and write, take inventory.vendor_manage. That is what spec 6.4
 * says and what nav.ts already shows the link under, so unlike items and orders
 * there is nothing to reconcile here. A buyer without the permission still picks
 * a vendor from the select on the order form; what they cannot do is browse the
 * bank details and rate card.
 */
inventory.get('/app/inventory/vendors', requirePermission(PERMISSIONS.INVENTORY_VENDOR_MANAGE), async (c) => {
  const db = c.get('db')
  const { page: pageNo, offset, pageSize } = pageParam(c, PAGE_SIZE)
  const search = queryParam(c, 'q') ?? null
  const vendorType = queryParam(c, 'vendorType') ?? null
  const status = queryParam(c, 'status') ?? null
  const filters = { q: search, vendorType, status }

  const [rows, total] = await Promise.all([
    q.listVendors(db, { ...filters, limit: pageSize, offset }),
    q.countVendors(db, filters),
  ])

  const columns: Column<VendorListRow>[] = [
    {
      header: 'Vendor',
      cell: (r) => (
        <>
          <a href={`/app/inventory/vendors/${r.id}`}>
            <strong>{r.name}</strong>
          </a>
          <div class="ncc-muted">
            {r.code} - {r.vendor_type.replace(/_/g, ' ')}
          </div>
        </>
      ),
    },
    { header: 'City', cell: (r) => r.city ?? '-' },
    {
      header: 'Contact',
      cell: (r) => (r.phone ? <>{r.contact_name ? `${r.contact_name}, ` : ''}{r.phone}</> : <span class="ncc-muted">-</span>),
    },
    { header: 'GSTIN', cell: (r) => r.gstin ?? <span class="ncc-muted">not registered</span> },
    { header: 'Terms', numeric: true, cell: (r) => `${Number(r.payment_terms_days)} days` },
    {
      header: 'Rating',
      // Two numbers, not an average: a vendor whose material is good and who is
      // always late is a different problem from one who is prompt with rubbish.
      cell: (r) =>
        r.rating_quality === null && r.rating_timeliness === null ? (
          <span class="ncc-muted">not rated</span>
        ) : (
          <>
            Q {r.rating_quality === null ? '-' : Number(r.rating_quality)} / T{' '}
            {r.rating_timeliness === null ? '-' : Number(r.rating_timeliness)}
          </>
        ),
    },
    { header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
  ]

  const qs = new URLSearchParams()
  if (search) qs.set('q', search)
  if (vendorType) qs.set('vendorType', vendorType)
  if (status) qs.set('status', status)

  return page(
    c,
    {
      title: 'Vendors',
      path: '/app/inventory/vendors',
      subtitle: 'Suppliers, hire firms, subcontractors and transporters',
      actions: (
        <a class="ncc-btn ncc-btn-primary" href="/app/inventory/vendors/new">
          New vendor
        </a>
      ),
    },
    <>
      {banner(c)}
      <Panel title="Vendors">
        <form method="get" action="/app/inventory/vendors" class="ncc-row" style="flex-wrap:wrap;gap:.75rem">
          <FormField label="Search" name="q" value={search} placeholder="Name, code or GSTIN" />
          <FormField label="Type" name="vendorType" options={enumOptions(VENDOR_TYPES, vendorType, 'Any')} />
          <FormField label="Status" name="status" options={enumOptions(VENDOR_STATUSES, status, 'Any')} />
          <button class="ncc-btn" type="submit">
            Filter
          </button>
        </form>
        <DataTable columns={columns} rows={rows} empty="No vendor matches that filter." />
        <Pager
          page={pageNo}
          pageSize={pageSize}
          total={total}
          baseHref={qs.size ? `/app/inventory/vendors?${qs.toString()}` : '/app/inventory/vendors'}
        />
      </Panel>
    </>
  )
})

type VendorRow = NonNullable<Awaited<ReturnType<typeof q.findVendor>>>

/**
 * One form for create and edit, as with items.
 *
 * GSTIN and PAN are optional at this boundary because a small sand or metal
 * supplier genuinely may not have one, and refusing to record the vendor at all
 * would only push the purchase off the books. vendorSchema still checks the
 * shape of whatever is entered, so a mistyped GSTIN is caught rather than filed.
 */
function VendorForm(props: { csrf: string; action: string; vendor: VendorRow | null }) {
  const v = props.vendor
  return (
    <form class="ncc-stack" method="post" action={props.action}>
      <CsrfInput token={props.csrf} />
      <div class="ncc-grid ncc-grid--2">
        <FormField label="Name" name="name" value={v?.name} required />
        <FormField
          label="Type"
          name="vendorType"
          required
          options={enumOptions(VENDOR_TYPES, v?.vendor_type ?? null, v ? undefined : 'Choose one')}
        />
        <FormField label="GSTIN" name="gstin" value={v?.gstin} hint="15 characters, or leave blank." />
        <FormField label="PAN" name="pan" value={v?.pan} />
        <FormField label="Udyam number" name="msmeUdyamNo" value={v?.msme_udyam_no} hint="MSME registration, if any." />
        <FormField
          label="Payment terms (days)"
          name="paymentTermsDays"
          type="number"
          min="0"
          max="365"
          value={v ? Number(v.payment_terms_days) : 30}
        />
        <FormField label="Contact name" name="contactName" value={v?.contact_name} />
        <FormField label="Phone" name="phone" value={v?.phone} />
        <FormField label="Email" name="email" type="email" value={v?.email} />
        <FormField label="City" name="city" value={v?.city} />
        <FormField label="Account name" name="bankAccountName" value={v?.bank_account_name} />
        <FormField label="Account number" name="bankAccountNo" value={v?.bank_account_no} />
        <FormField label="IFSC" name="bankIfsc" value={v?.bank_ifsc} />
      </div>
      <FormField label="Address" name="address" rows={3} value={v?.address} />
      <div class="ncc-row">
        <button class="ncc-btn ncc-btn-primary" type="submit">
          {v ? 'Save vendor' : 'Create vendor'}
        </button>
        <a class="ncc-btn" href={v ? `/app/inventory/vendors/${v.id}` : '/app/inventory/vendors'}>
          Cancel
        </a>
      </div>
    </form>
  )
}

inventory.get('/app/inventory/vendors/new', requirePermission(PERMISSIONS.INVENTORY_VENDOR_MANAGE), (c) => {
  return page(
    c,
    { title: 'New vendor', path: '/app/inventory/vendors', subtitle: 'The code is allotted on save' },
    <>
      {banner(c)}
      <Panel title="Vendor details">
        <VendorForm csrf={currentSession(c).csrfToken} action="/app/inventory/vendors" vendor={null} />
      </Panel>
    </>
  )
})

inventory.post('/app/inventory/vendors', requirePermission(PERMISSIONS.INVENTORY_VENDOR_MANAGE), async (c) => {
  const parsed = vendorSchema.safeParse(await readBody(c))
  if (!parsed.success) return errRedirect(c, '/app/inventory/vendors/new', firstError(parsed.error))
  const vendorId = await svc.createVendor(c.get('db'), actorOf(c), parsed.data)
  return okRedirect(c, `/app/inventory/vendors/${vendorId}`, 'Vendor created.')
})

inventory.get('/app/inventory/vendors/:vendorId/edit', requirePermission(PERMISSIONS.INVENTORY_VENDOR_MANAGE), async (c) => {
  const vendorId = idParam(c, 'vendorId')
  const vendor = await q.findVendor(c.get('db'), vendorId)
  if (!vendor) throw new NotFoundError('Vendor not found')

  return page(
    c,
    { title: `Edit ${vendor.name}`, path: '/app/inventory/vendors', subtitle: vendor.code },
    <>
      {banner(c)}
      <Panel title="Vendor details">
        <VendorForm
          csrf={currentSession(c).csrfToken}
          action={`/app/inventory/vendors/${vendorId}`}
          vendor={vendor}
        />
      </Panel>
    </>
  )
})

inventory.post('/app/inventory/vendors/:vendorId', requirePermission(PERMISSIONS.INVENTORY_VENDOR_MANAGE), async (c) => {
  const vendorId = idParam(c, 'vendorId')
  const parsed = vendorSchema.safeParse(await readBody(c))
  if (!parsed.success) return errRedirect(c, `/app/inventory/vendors/${vendorId}/edit`, firstError(parsed.error))
  await svc.updateVendor(c.get('db'), actorOf(c), vendorId, parsed.data)
  return okRedirect(c, `/app/inventory/vendors/${vendorId}`, 'Vendor saved.')
})

type VendorRateRow = Awaited<ReturnType<typeof q.vendorRateRows>>[number]
type VendorPoRow = Awaited<ReturnType<typeof q.vendorPurchaseHistory>>[number]

/**
 * The vendor page.
 *
 * vendorRateRows has no canViewRates parameter because a rate card is nothing
 * but rates: there is no non-money version of it worth rendering. So the whole
 * card, query included, is skipped without inventory.view_rates rather than
 * fetched and blanked. That keeps to the same rule as everywhere else — money a
 * user may not see is not in the response at all.
 */
inventory.get('/app/inventory/vendors/:vendorId', requirePermission(PERMISSIONS.INVENTORY_VENDOR_MANAGE), async (c) => {
  const db = c.get('db')
  const vendorId = idParam(c, 'vendorId')
  const rates = canRates(c)

  const vendor = await q.findVendor(db, vendorId)
  if (!vendor) throw new NotFoundError('Vendor not found')

  const [rateRows, history, items] = await Promise.all([
    rates ? q.vendorRateRows(db, vendorId) : Promise.resolve([]),
    q.vendorPurchaseHistory(db, vendorId, rates),
    rates ? q.itemOptions(db) : Promise.resolve([]),
  ])

  const csrf = currentSession(c).csrfToken

  const rateColumns: Column<VendorRateRow>[] = [
    { header: 'Item', cell: (r) => `${r.item_code} - ${r.item_name}` },
    { header: 'Rate', numeric: true, cell: (r) => <Money paise={Number(r.rate_paise)} /> },
    { header: 'Per', cell: (r) => r.unit_code },
    { header: 'From', cell: (r) => <DateText value={r.valid_from} /> },
    {
      header: 'To',
      cell: (r) => (r.valid_to ? <DateText value={r.valid_to} /> : <span class="ncc-muted">current</span>),
    },
    { header: 'Freight', cell: (r) => (r.freight_included === 1 ? 'Included' : 'Extra') },
    {
      header: 'Min order',
      numeric: true,
      cell: (r) => (r.min_order_qty === null ? <span class="ncc-muted">-</span> : <Qty value={Number(r.min_order_qty)} unit={r.unit_code} />),
    },
  ]

  const historyColumns: Column<VendorPoRow>[] = [
    { header: 'Order', cell: (r) => <a href={`/app/inventory/po/${r.id}`}>{r.po_no}</a> },
    { header: 'Date', cell: (r) => <DateText value={r.po_date} /> },
    { header: 'Project', cell: (r) => r.project_code ?? <span class="ncc-muted">none</span> },
    { header: 'Value', numeric: true, cell: (r) => <Money paise={paiseOf(r, 'total_paise')} hidden={!rates} /> },
    { header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
  ]

  return page(
    c,
    {
      title: vendor.name,
      path: '/app/inventory/vendors',
      subtitle: `${vendor.code} - ${vendor.vendor_type.replace(/_/g, ' ')}`,
      actions: (
        <a class="ncc-btn" href={`/app/inventory/vendors/${vendorId}/edit`}>
          Edit
        </a>
      ),
    },
    <>
      {banner(c)}
      {vendor.status === 'blacklisted' ? (
        <Alert tone="error">
          Blacklisted. {vendor.blacklist_reason ?? 'No reason recorded.'} A purchase order cannot be raised on this
          vendor until the status is changed back.
        </Alert>
      ) : vendor.status === 'on_hold' ? (
        <Alert tone="warn">On hold. New orders are blocked; orders already approved can still be received.</Alert>
      ) : null}
      <div class="ncc-grid ncc-grid--2">
        <Panel title="Vendor">
          <DefinitionList
            rows={[
              ['Status', <StatusBadge status={vendor.status} />],
              ['Type', vendor.vendor_type.replace(/_/g, ' ')],
              ['GSTIN', vendor.gstin ?? 'Not registered'],
              ['PAN', vendor.pan ?? '-'],
              // The Udyam number is what makes the 45-day payment rule apply to
              // this vendor, so it is on the face of the page rather than buried
              // in the edit form.
              ['Udyam (MSME)', vendor.msme_udyam_no ?? 'Not an MSME on record'],
              ['Payment terms', `${Number(vendor.payment_terms_days)} days`],
            ]}
          />
        </Panel>
        <Panel title="Contact and bank">
          <DefinitionList
            rows={[
              ['Contact', vendor.contact_name ?? '-'],
              ['Phone', vendor.phone ?? '-'],
              ['Email', vendor.email ?? '-'],
              ['Address', vendor.address ?? '-'],
              ['City', vendor.city ?? '-'],
              [
                'Bank',
                vendor.bank_account_no
                  ? `${vendor.bank_account_name ?? vendor.name} - ${vendor.bank_account_no} - ${vendor.bank_ifsc ?? ''}`
                  : 'Not on record',
              ],
            ]}
          />
        </Panel>
      </div>

      {rates ? (
        <Panel title="Rate card">
          <DataTable
            columns={rateColumns}
            rows={rateRows}
            empty="No rate recorded for this vendor yet."
            caption="A new rate closes the one it supersedes the day before it starts, so the history stays readable. The purchase order form warns when a typed rate differs from the last one by more than 10 percent."
          />
          <form class="ncc-stack" method="post" action={`/app/inventory/vendors/${vendorId}/rates`}>
            <CsrfInput token={csrf} />
            <div class="ncc-grid ncc-grid--2">
              <FormField label="Item" name="itemId" required options={selectOptions(items)} />
              <FormField label="Rate" name="rate" type="number" step="0.01" min="0" required hint="Rupees per unit" />
              <FormField label="Valid from" name="validFrom" type="date" required value={today()} />
              <FormField label="Valid to" name="validTo" type="date" hint="Leave blank while it stands." />
              <FormField label="Freight included" name="freightIncluded" options={YES_NO(false)} />
              <FormField label="Minimum order" name="minOrderQty" type="number" step="0.001" min="0" />
            </div>
            <div>
              <button class="ncc-btn" type="submit">
                Record rate
              </button>
            </div>
          </form>
        </Panel>
      ) : null}
      <Panel title="Purchase history">
        <DataTable columns={historyColumns} rows={history} empty="No order has been placed on this vendor." />
      </Panel>

      <div class="ncc-grid ncc-grid--2">
        <Panel title="Rating">
          <form class="ncc-stack" method="post" action={`/app/inventory/vendors/${vendorId}/rating`}>
            <CsrfInput token={csrf} />
            <FormField
              label="Quality (1-5)"
              name="ratingQuality"
              type="number"
              step="0.1"
              min="1"
              max="5"
              required
              value={vendor.rating_quality === null ? '' : Number(vendor.rating_quality)}
            />
            <FormField
              label="Timeliness (1-5)"
              name="ratingTimeliness"
              type="number"
              step="0.1"
              min="1"
              max="5"
              required
              value={vendor.rating_timeliness === null ? '' : Number(vendor.rating_timeliness)}
              hint="Kept separate from quality on purpose: good material that always arrives late is a different problem."
            />
            <div>
              <button class="ncc-btn" type="submit">
                Save rating
              </button>
            </div>
          </form>
        </Panel>
        <Panel title="Status">
          <form class="ncc-stack" method="post" action={`/app/inventory/vendors/${vendorId}/status`}>
            <CsrfInput token={csrf} />
            <FormField label="Status" name="status" required options={enumOptions(VENDOR_STATUSES, vendor.status)} />
            <FormField
              label="Blacklist reason"
              name="blacklistReason"
              rows={2}
              value={vendor.blacklist_reason}
              hint="Required to blacklist. It stays on the record where the next buyer will read it."
            />
            <div>
              <button class="ncc-btn" type="submit">
                Change status
              </button>
            </div>
          </form>
        </Panel>
      </div>
    </>
  )
})

inventory.post('/app/inventory/vendors/:vendorId/rates', requirePermission(PERMISSIONS.INVENTORY_VENDOR_MANAGE), async (c) => {
  const vendorId = idParam(c, 'vendorId')
  const back = `/app/inventory/vendors/${vendorId}`
  const parsed = vendorRateSchema.safeParse(await readBody(c))
  if (!parsed.success) return errRedirect(c, back, firstError(parsed.error))

  // Same rename as opening stock: the field is `rate` because the input is, the
  // service takes ratePaise, and the conversion happened once in the schema.
  const { rate, ...rest } = parsed.data
  await svc.upsertVendorRate(c.get('db'), actorOf(c), vendorId, { ...rest, ratePaise: rate })
  return okRedirect(c, back, 'Rate recorded. Any earlier rate for that item now ends the day before this one starts.')
})

inventory.post('/app/inventory/vendors/:vendorId/rating', requirePermission(PERMISSIONS.INVENTORY_VENDOR_MANAGE), async (c) => {
  const vendorId = idParam(c, 'vendorId')
  const back = `/app/inventory/vendors/${vendorId}`
  const parsed = vendorRatingSchema.safeParse(await readBody(c))
  if (!parsed.success) return errRedirect(c, back, firstError(parsed.error))
  await svc.rateVendor(c.get('db'), actorOf(c), vendorId, parsed.data)
  return okRedirect(c, back, 'Rating saved.')
})

inventory.post('/app/inventory/vendors/:vendorId/status', requirePermission(PERMISSIONS.INVENTORY_VENDOR_MANAGE), async (c) => {
  const vendorId = idParam(c, 'vendorId')
  const back = `/app/inventory/vendors/${vendorId}`
  const parsed = vendorStatusSchema.safeParse(await readBody(c))
  if (!parsed.success) return errRedirect(c, back, firstError(parsed.error))

  const result = await svc.setVendorStatus(
    c.get('db'),
    actorOf(c),
    vendorId,
    parsed.data.status,
    parsed.data.blacklistReason
  )

  // Blacklisting does not cancel work already in flight, and pretending it did
  // would leave someone expecting a delivery that no longer has a live order
  // behind it. The count says what is still open so it can be dealt with.
  const parts = [`Status set to ${parsed.data.status.replace(/_/g, ' ')}.`]
  if (result.openPoCount > 0) {
    parts.push(
      `${result.openPoCount} order${result.openPoCount === 1 ? '' : 's'} on this vendor ${
        result.openPoCount === 1 ? 'is' : 'are'
      } still open. Those are untouched: short-close them if they should not be delivered.`
    )
  }
  return okRedirect(c, back, parts.join(' '))
})

/* Consumption variance ----------------------------------------------------- */

/**
 * Issued against theoretical consumption for one project (spec 6.4 rule 4).
 *
 * Guarded by inventory.view as the spec's route table says. getConsumptionVariance
 * computes the value of what was issued unconditionally, so unlike the queries
 * the money is fetched here and then withheld in the template for a caller
 * without view_rates. That is the one place in this module where the money
 * reaches the handler and not the HTML: the report's arithmetic needs the
 * valuation to produce an excess value at all, and splitting the service in two
 * to keep the SELECT narrow would duplicate the norm logic.
 */
inventory.get('/app/inventory/reports/consumption', requirePermission(PERMISSIONS.INVENTORY_VIEW), async (c) => {
  const db = c.get('db')
  const scope = currentScope(c)
  const rates = canRates(c)
  const projectId = Number(queryParam(c, 'projectId') ?? '') || null

  const [projects, report] = await Promise.all([
    q.projectOptions(db, scope),
    projectId ? svc.getConsumptionVariance(db, projectId) : Promise.resolve(null),
  ])

  const columns: Column<svc.ConsumptionVarianceLine>[] = [
    { header: 'Item', cell: (r) => `${r.itemCode} - ${r.itemName}` },
    { header: 'Issued', numeric: true, cell: (r) => <Qty value={r.qtyIssued} unit={r.unit} /> },
    { header: 'Value', numeric: true, cell: (r) => <Money paise={r.valuePaise} hidden={!rates} /> },
    {
      header: 'Expected so far',
      numeric: true,
      // The pro-rated figure, not the at-completion one: a half-built house
      // compared against its finished expectation shows every item under-used.
      cell: (r) =>
        r.expectedAtProgress === null ? <span class="ncc-muted">no norm</span> : <Qty value={r.expectedAtProgress} unit={r.unit} />,
    },
    {
      header: 'At completion',
      numeric: true,
      cell: (r) => (r.expectedAtCompletion === null ? <span class="ncc-muted">-</span> : <Qty value={r.expectedAtCompletion} unit={r.unit} />),
    },
    {
      header: 'Variance',
      numeric: true,
      cell: (r) => (r.variancePct === null ? <span class="ncc-muted">-</span> : `${r.variancePct > 0 ? '+' : ''}${r.variancePct}%`),
    },
    {
      header: 'Excess',
      numeric: true,
      cell: (r) =>
        r.excessQty === null || r.excessQty <= 0 ? (
          <span class="ncc-muted">-</span>
        ) : (
          <>
            <strong>
              <Qty value={r.excessQty} unit={r.unit} />
            </strong>
            <div class="ncc-muted">
              <Money paise={r.excessValuePaise} hidden={!rates} />
            </div>
          </>
        ),
    },
    { header: 'Flag', cell: (r) => <StatusBadge status={r.flag} /> },
  ]

  return page(
    c,
    {
      title: 'Consumption variance',
      path: '/app/inventory/reports/consumption',
      subtitle: report ? `${report.projectCode} - ${report.projectName}` : 'Issued against theoretical, per project',
    },
    <>
      {banner(c)}
      <Panel title="Project">
        <form method="get" action="/app/inventory/reports/consumption" class="ncc-row" style="flex-wrap:wrap;gap:.75rem">
          <FormField label="Project" name="projectId" required options={selectOptions(projects, projectId)} />
          <button class="ncc-btn" type="submit">
            {projectId ? 'Change' : 'Run report'}
          </button>
        </form>
      </Panel>
      {report === null ? (
        <Alert tone="warn">Choose a project to run the report.</Alert>
      ) : (
        <>
          {/* The notes are the report's own account of what it could not do -
              a missing built-up area, no norms configured. Printed before the
              table, because a table of blanks with the explanation underneath
              reads as a broken page. */}
          {report.notes.length > 0 ? (
            <Alert tone="warn">
              {report.notes.map((n) => (
                <div>{n}</div>
              ))}
            </Alert>
          ) : null}
          <div class="ncc-grid ncc-grid--kpi">
            <KpiCard
              label="Built-up area"
              value={report.builtUpAreaSqft === null ? 'Not recorded' : `${report.builtUpAreaSqft} sqft`}
              hint="The whole expectation is derived from this."
            />
            <KpiCard label="Physical progress" value={`${report.physicalProgressPct}%`} hint="Expectation is pro-rated by it." />
            <KpiCard
              label="Items issued"
              value={report.lines.length}
              hint={report.normsConfigured ? undefined : 'No consumption norms are configured yet.'}
            />
          </div>
          <Panel title="Lines">
            <DataTable
              columns={columns}
              rows={report.lines}
              empty="Nothing has been issued to this project yet."
              caption="Issued quantity is the ledger's own arithmetic: material returned from site reduces it. Only issues and returns carry a project, so receipts and transfers are not in this table."
            />
          </Panel>
        </>
      )}
    </>
  )
})

/* Equipment ---------------------------------------------------------------- */

const EQUIPMENT_STATUSES = ['available', 'deployed', 'under_repair', 'retired'] as const

type EquipmentListRow = Awaited<ReturnType<typeof q.listEquipment>>[number]

/**
 * Equipment. Reads take inventory.view; deploy and return take
 * inventory.transfer, because spec 6.4 defines no equipment write permission and
 * inventing a key would put a grant in the code that is not in the seeded RBAC
 * table. Moving a mixer between sites is a transfer of company property, which
 * is the nearest existing right. Flagged in the module comment above.
 */
inventory.get('/app/inventory/equipment', requirePermission(PERMISSIONS.INVENTORY_VIEW), async (c) => {
  const db = c.get('db')
  const rates = canRates(c)
  const { page: pageNo, offset, pageSize } = pageParam(c, PAGE_SIZE)
  const status = queryParam(c, 'status') ?? null

  const [rows, total] = await Promise.all([
    q.listEquipment(db, { status, canViewRates: rates, limit: pageSize, offset }),
    q.countEquipment(db, { status }),
  ])

  const dueSoon = (d: string | null): boolean => d !== null && d <= addDays(today(), 30)

  const columns: Column<EquipmentListRow>[] = [
    {
      header: 'Machine',
      cell: (r) => (
        <>
          <a href={`/app/inventory/equipment/${r.id}`}>
            <strong>{r.name}</strong>
          </a>
          <div class="ncc-muted">
            {r.code} - {r.equipment_type}
          </div>
        </>
      ),
    },
    { header: 'Ownership', cell: (r) => (r.ownership === 'hired' ? `Hired from ${r.hire_vendor_name ?? 'unnamed vendor'}` : 'Owned') },
    { header: 'Hire rate', numeric: true, cell: (r) => <Money paise={paiseOf(r, 'hire_rate_per_day_paise')} hidden={!rates} /> },
    {
      header: 'Where',
      cell: (r) => r.project_code ?? r.location_name ?? <span class="ncc-muted">not recorded</span>,
    },
    {
      header: 'Service due',
      // A machine whose service or insurance has lapsed is the one that stops
      // work or voids a claim, so the list marks it rather than leaving it to
      // the nightly alert nobody reads.
      cell: (r) =>
        r.next_service_due === null ? (
          <span class="ncc-muted">not set</span>
        ) : dueSoon(r.next_service_due) ? (
          <strong>
            <DateText value={r.next_service_due} />
          </strong>
        ) : (
          <DateText value={r.next_service_due} />
        ),
    },
    {
      header: 'Insurance',
      cell: (r) =>
        r.insurance_valid_until === null ? (
          <span class="ncc-muted">not set</span>
        ) : dueSoon(r.insurance_valid_until) ? (
          <strong>
            <DateText value={r.insurance_valid_until} />
          </strong>
        ) : (
          <DateText value={r.insurance_valid_until} />
        ),
    },
    { header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
  ]

  return page(
    c,
    {
      title: 'Equipment',
      path: '/app/inventory/equipment',
      subtitle: 'Machines, where they are and what is due on them',
    },
    <>
      {banner(c)}
      <Panel title="Equipment">
        <form method="get" action="/app/inventory/equipment" class="ncc-row" style="flex-wrap:wrap;gap:.75rem">
          <FormField label="Status" name="status" options={enumOptions(EQUIPMENT_STATUSES, status, 'Any')} />
          <button class="ncc-btn" type="submit">
            Filter
          </button>
        </form>
        <DataTable
          columns={columns}
          rows={rows}
          empty="No equipment matches that filter."
          caption="A bold service or insurance date falls within the next 30 days."
        />
        <Pager
          page={pageNo}
          pageSize={pageSize}
          total={total}
          baseHref={status ? `/app/inventory/equipment?status=${status}` : '/app/inventory/equipment'}
        />
      </Panel>
    </>
  )
})

type DeploymentRow = Awaited<ReturnType<typeof q.equipmentDeploymentRows>>[number]

inventory.get('/app/inventory/equipment/:equipmentId', requirePermission(PERMISSIONS.INVENTORY_VIEW), async (c) => {
  const db = c.get('db')
  const scope = currentScope(c)
  const equipmentId = idParam(c, 'equipmentId')
  const rates = canRates(c)
  const move = can(c, PERMISSIONS.INVENTORY_TRANSFER)

  const eq = await q.findEquipment(db, equipmentId)
  if (!eq) throw new NotFoundError('Equipment not found')

  const [deployments, projects, locations] = await Promise.all([
    q.equipmentDeploymentRows(db, equipmentId),
    move ? q.projectOptions(db, scope) : Promise.resolve([]),
    move ? q.locationOptions(db, scope) : Promise.resolve([]),
  ])

  const csrf = currentSession(c).csrfToken
  const open = deployments.find((d) => d.to_date === null) ?? null
  const insuranceLapsed = eq.insurance_valid_until !== null && eq.insurance_valid_until < today()
  const serviceOverdue = eq.next_service_due !== null && eq.next_service_due < today()

  const columns: Column<DeploymentRow>[] = [
    { header: 'Project', cell: (r) => `${r.project_code} - ${r.project_name}` },
    { header: 'From', cell: (r) => <DateText value={r.from_date} /> },
    { header: 'To', cell: (r) => (r.to_date ? <DateText value={r.to_date} /> : <strong>on site now</strong>) },
    {
      header: 'Days',
      numeric: true,
      // Inclusive of both dates, the same arithmetic returnEquipment bills on,
      // so a one-day deployment reads as 1 rather than 0.
      cell: (r) => daysBetween(r.from_date, r.to_date ?? today()) + 1,
    },
    {
      header: 'Meter',
      numeric: true,
      cell: (r) =>
        r.meter_start === null
          ? <span class="ncc-muted">not read</span>
          : r.meter_end === null
            ? `${Number(r.meter_start)} onwards`
            : `${Number(r.meter_start)} to ${Number(r.meter_end)} (${Number(r.meter_end) - Number(r.meter_start)})`,
    },
    { header: 'Operator', cell: (r) => r.operator_name ?? <span class="ncc-muted">-</span> },
  ]

  return page(
    c,
    {
      title: eq.name,
      path: '/app/inventory/equipment',
      subtitle: `${eq.code} - ${eq.equipment_type}`,
    },
    <>
      {banner(c)}
      {insuranceLapsed ? (
        <Alert tone="error">
          Insurance expired on {formatDate(eq.insurance_valid_until)}. Running this machine uninsured is the company's
          exposure, not the site's. Deployment is still allowed and recorded, so the decision has a name against it.
        </Alert>
      ) : null}
      {serviceOverdue ? (
        <Alert tone="warn">Service was due on {formatDate(eq.next_service_due)}.</Alert>
      ) : null}
      <div class="ncc-grid ncc-grid--2">
        <Panel title="Machine">
          <DefinitionList
            rows={[
              ['Status', <StatusBadge status={eq.status} />],
              ['Ownership', eq.ownership === 'hired' ? 'Hired' : 'Owned'],
              ['Hire rate per day', <Money paise={paiseOf(eq, 'hire_rate_per_day_paise')} hidden={!rates} />],
              ['Current project', eq.project_code ?? 'Not on a site'],
              ['Current yard or store', eq.location_name ?? 'Not recorded'],
              ['Service due', eq.next_service_due ? <DateText value={eq.next_service_due} /> : 'Not set'],
              [
                'Insurance valid until',
                eq.insurance_valid_until ? <DateText value={eq.insurance_valid_until} /> : 'Not set',
              ],
            ]}
          />
        </Panel>
        {move && eq.status !== 'retired' ? (
          open ? (
            <Panel title="Return from site">
              <form class="ncc-stack" method="post" action={`/api/equipment/${equipmentId}/return`}>
                <CsrfInput token={csrf} />
                <FormField label="Returned on" name="toDate" type="date" required value={today()} />
                <FormField label="Meter reading" name="meterEnd" type="number" step="0.01" min="0" />
                <FormField label="Back to" name="locationId" options={selectOptions(locations, null, 'Leave unassigned')} />
                <div>
                  <button class="ncc-btn ncc-btn-primary" type="submit">
                    Record return
                  </button>
                </div>
              </form>
            </Panel>
          ) : (
            <Panel title="Deploy to a site">
              <form class="ncc-stack" method="post" action={`/api/equipment/${equipmentId}/deploy`}>
                <CsrfInput token={csrf} />
                <FormField label="Project" name="projectId" required options={selectOptions(projects)} />
                <FormField label="From" name="fromDate" type="date" required value={today()} />
                <FormField label="Meter reading" name="meterStart" type="number" step="0.01" min="0" />
                <FormField label="Operator" name="operatorName" />
                <div>
                  <button class="ncc-btn ncc-btn-primary" type="submit">
                    Deploy
                  </button>
                </div>
              </form>
            </Panel>
          )
        ) : null}
      </div>
      <Panel title="Deployment history">
        <DataTable
          columns={columns}
          rows={deployments}
          empty="This machine has not been deployed yet."
          caption="Hire cost is worked out on return and reported, not posted. Expenses are the finance module's to write, so a hire day cannot be billed twice."
        />
      </Panel>
    </>
  )
})

inventory.post('/api/equipment/:equipmentId/deploy', requirePermission(PERMISSIONS.INVENTORY_TRANSFER), async (c) => {
  const equipmentId = idParam(c, 'equipmentId')
  const back = `/app/inventory/equipment/${equipmentId}`
  const parsed = equipmentDeploySchema.safeParse(await readBody(c))
  if (!parsed.success) return errRedirect(c, back, firstError(parsed.error))
  await svc.deployEquipment(c.get('db'), actorOf(c), equipmentId, parsed.data)
  return okRedirect(c, back, 'Deployed. The open deployment row is what marks it as on site.')
})

inventory.post('/api/equipment/:equipmentId/return', requirePermission(PERMISSIONS.INVENTORY_TRANSFER), async (c) => {
  const equipmentId = idParam(c, 'equipmentId')
  const back = `/app/inventory/equipment/${equipmentId}`
  const parsed = equipmentReturnSchema.safeParse(await readBody(c))
  if (!parsed.success) return errRedirect(c, back, firstError(parsed.error))

  const result = await svc.returnEquipment(c.get('db'), actorOf(c), equipmentId, parsed.data)

  const parts = [`Returned after ${result.days} day${result.days === 1 ? '' : 's'}.`]
  if (result.meterHours !== null) parts.push(`${result.meterHours} on the meter.`)
  if (result.hireCostPaise !== null) {
    // Reported, not posted: equipment_deployments.expense_id stays null until
    // finance links it, so the figure here is a number to check an invoice
    // against rather than a booked cost.
    parts.push(`Hire works out at ${formatRupees(result.hireCostPaise)}, which is not yet booked as an expense.`)
  }
  return okRedirect(c, back, parts.join(' '))
})

export default inventory
