import { sql } from 'kysely'
import type { Db, Queryable } from '../../db/kysely.js'
import type { ScopeContext } from '../../lib/scope.js'
import { accessibleLocationIds, projectScopeFilter } from '../../lib/scope.js'
import { today } from '../../lib/dates.js'

/**
 * Inventory reads (spec 6.4).
 *
 * Three things are load bearing, and they are the same three as in
 * src/modules/projects/queries.ts.
 *
 * Scoping is a SQL predicate. A site supervisor's stock list is restricted by
 * accessibleLocationIds inside the query, never by filtering rows after they
 * have been fetched and counted.
 *
 * Rate visibility is a parameter, not a post-processing step. When
 * canViewRates is false no rate or value column is in the SELECT, so a
 * purchase rate cannot reach the HTML for a storekeeper (spec 6.4 routes
 * table, `inventory.view_rates`).
 *
 * mysql2 is configured without decimalNumbers, so DECIMAL columns arrive as
 * strings even though src/db/types.ts types them as number. Every caller that
 * does arithmetic on a quantity wraps it in Number() for that reason.
 */

const PAGE_SIZE = 25

/** Empty means "scoped to nothing", which must match no row rather than all. */
function scopeIn(ids: number[]): number[] {
  return ids.length ? ids : [0]
}

export interface StockRow {
  item_id: number
  location_id: number
  item_code: string
  item_name: string
  unit_code: string
  category_name: string
  location_code: string
  location_name: string
  qty_on_hand: number
  reorder_level: number | null
  value_paise?: number | null
}

export async function stockRows(
  db: Db,
  scope: ScopeContext,
  opts: {
    canViewRates: boolean
    q?: string | null
    categoryId?: number | null
    locationId?: number | null
    belowReorder?: boolean
    limit?: number
    offset?: number
  }
): Promise<StockRow[]> {
  const locations = await accessibleLocationIds(db, scope)

  let query = db
    .selectFrom('item_stock')
    .innerJoin('items', 'items.id', 'item_stock.item_id')
    .innerJoin('units', 'units.id', 'items.unit_id')
    .innerJoin('item_categories', 'item_categories.id', 'items.category_id')
    .innerJoin('locations', 'locations.id', 'item_stock.location_id')
    .select([
      'item_stock.item_id',
      'item_stock.location_id',
      'items.code as item_code',
      'items.name as item_name',
      'items.reorder_level',
      'units.code as unit_code',
      'item_categories.name as category_name',
      'locations.code as location_code',
      'locations.name as location_name',
      'item_stock.qty_on_hand',
    ])
    .orderBy('items.code')
    .orderBy('locations.code')
    .limit(opts.limit ?? PAGE_SIZE)
    .offset(opts.offset ?? 0)

  if (opts.canViewRates) query = query.select('item_stock.value_paise')
  if (locations) query = query.where('item_stock.location_id', 'in', scopeIn(locations))
  if (opts.locationId) query = query.where('item_stock.location_id', '=', opts.locationId)
  if (opts.categoryId) query = query.where('items.category_id', '=', opts.categoryId)
  if (opts.q) {
    const like = `%${opts.q}%`
    query = query.where((eb) => eb.or([eb('items.code', 'like', like), eb('items.name', 'like', like)]))
  }
  if (opts.belowReorder) {
    query = query
      .where('items.reorder_level', 'is not', null)
      .where(sql<boolean>`item_stock.qty_on_hand <= items.reorder_level`)
  }

  return (await query.execute()) as unknown as StockRow[]
}

export async function stockRowCount(
  db: Db,
  scope: ScopeContext,
  opts: { q?: string | null; categoryId?: number | null; locationId?: number | null; belowReorder?: boolean }
): Promise<number> {
  const locations = await accessibleLocationIds(db, scope)

  let query = db
    .selectFrom('item_stock')
    .innerJoin('items', 'items.id', 'item_stock.item_id')
    .select((eb) => eb.fn.countAll<number>().as('n'))

  if (locations) query = query.where('item_stock.location_id', 'in', scopeIn(locations))
  if (opts.locationId) query = query.where('item_stock.location_id', '=', opts.locationId)
  if (opts.categoryId) query = query.where('items.category_id', '=', opts.categoryId)
  if (opts.q) {
    const like = `%${opts.q}%`
    query = query.where((eb) => eb.or([eb('items.code', 'like', like), eb('items.name', 'like', like)]))
  }
  if (opts.belowReorder) {
    query = query
      .where('items.reorder_level', 'is not', null)
      .where(sql<boolean>`item_stock.qty_on_hand <= items.reorder_level`)
  }

  const row = await query.executeTakeFirst()
  return Number(row?.n ?? 0)
}

export async function stockSummary(
  db: Db,
  scope: ScopeContext,
  canViewRates: boolean
): Promise<{ items: number; locations: number; valuePaise: number | null }> {
  const locations = await accessibleLocationIds(db, scope)

  let query = db
    .selectFrom('item_stock')
    .select((eb) => [
      eb.fn.count<number>('item_stock.item_id').distinct().as('items'),
      eb.fn.count<number>('item_stock.location_id').distinct().as('locations'),
      eb.fn.sum<number>('item_stock.value_paise').as('value_paise'),
    ])
    .where('item_stock.qty_on_hand', '>', 0)

  if (locations) query = query.where('item_stock.location_id', 'in', scopeIn(locations))

  const row = await query.executeTakeFirst()
  return {
    items: Number(row?.items ?? 0),
    locations: Number(row?.locations ?? 0),
    valuePaise: canViewRates ? Number(row?.value_paise ?? 0) : null,
  }
}

/** Items at or below their reorder level. Drives the KPI and the cron alert. */
export async function lowStock(db: Db, scope: ScopeContext | null, limit = 50) {
  const locations = scope ? await accessibleLocationIds(db, scope) : null

  let query = db
    .selectFrom('item_stock')
    .innerJoin('items', 'items.id', 'item_stock.item_id')
    .innerJoin('units', 'units.id', 'items.unit_id')
    .innerJoin('locations', 'locations.id', 'item_stock.location_id')
    .select([
      'item_stock.item_id',
      'item_stock.location_id',
      'items.code as item_code',
      'items.name as item_name',
      'items.reorder_level',
      'units.code as unit_code',
      'locations.name as location_name',
      'item_stock.qty_on_hand',
    ])
    .where('items.is_active', '=', 1)
    .where('items.reorder_level', 'is not', null)
    .where(sql<boolean>`item_stock.qty_on_hand <= items.reorder_level`)
    .orderBy('items.code')
    .limit(limit)

  if (locations) query = query.where('item_stock.location_id', 'in', scopeIn(locations))

  return query.execute()
}

/**
 * Batch balances for one item at one location, oldest expiry first (spec 6.4
 * rule 8). The balance is the ledger's own arithmetic rather than a cached
 * per-batch quantity, because item_stock is deliberately not batch grained.
 */
export async function batchBalances(db: Queryable, itemId: number, locationId: number) {
  const rows = await db
    .selectFrom('stock_ledger')
    .leftJoin('grn_lines', (join) =>
      join.onRef('grn_lines.batch_no', '=', 'stock_ledger.batch_no').onRef('grn_lines.item_id', '=', 'stock_ledger.item_id')
    )
    .select([
      'stock_ledger.batch_no',
      sql<number>`SUM(stock_ledger.qty_in - stock_ledger.qty_out)`.as('qty'),
      sql<string | null>`MAX(grn_lines.expiry_date)`.as('expiry_date'),
    ])
    .where('stock_ledger.item_id', '=', itemId)
    .where('stock_ledger.location_id', '=', locationId)
    .where('stock_ledger.batch_no', 'is not', null)
    .groupBy('stock_ledger.batch_no')
    .execute()

  return rows
    .map((r) => ({ batchNo: String(r.batch_no), qty: Number(r.qty ?? 0), expiryDate: r.expiry_date ?? null }))
    .filter((r) => r.qty > 0)
    .sort((a, b) => (a.expiryDate ?? '9999-12-31').localeCompare(b.expiryDate ?? '9999-12-31'))
}

/**
 * Batches at or past expiry that still hold stock. Feeds the cron alert and
 * the expiry warning on the issue form (spec 6.4 rule 8).
 */
export async function expiringBatches(db: Queryable, withinDays = 30, onDate: string = today()) {
  const rows = await db
    .selectFrom('grn_lines')
    .innerJoin('goods_receipts', 'goods_receipts.id', 'grn_lines.grn_id')
    .innerJoin('items', 'items.id', 'grn_lines.item_id')
    .innerJoin('locations', 'locations.id', 'goods_receipts.location_id')
    .select([
      'grn_lines.item_id',
      'grn_lines.batch_no',
      'grn_lines.expiry_date',
      'goods_receipts.location_id',
      'items.code as item_code',
      'items.name as item_name',
      'locations.name as location_name',
    ])
    .where('goods_receipts.status', '=', 'posted')
    .where('grn_lines.batch_no', 'is not', null)
    .where('grn_lines.expiry_date', 'is not', null)
    .where('grn_lines.expiry_date', '<=', sql<string>`DATE_ADD(${onDate}, INTERVAL ${sql.lit(withinDays)} DAY)`)
    .orderBy('grn_lines.expiry_date')
    .execute()

  const out: Array<{
    itemId: number
    itemCode: string
    itemName: string
    locationId: number
    locationName: string
    batchNo: string
    expiryDate: string
    qty: number
  }> = []

  for (const r of rows) {
    const balances = await batchBalances(db, Number(r.item_id), Number(r.location_id))
    const held = balances.find((b) => b.batchNo === String(r.batch_no))
    if (!held || held.qty <= 0) continue
    out.push({
      itemId: Number(r.item_id),
      itemCode: r.item_code,
      itemName: r.item_name,
      locationId: Number(r.location_id),
      locationName: r.location_name,
      batchNo: String(r.batch_no),
      expiryDate: String(r.expiry_date),
      qty: held.qty,
    })
  }
  return out
}

/** The movement history behind one balance. The audit answer to "why is it 12". */
export async function itemLedger(
  db: Queryable,
  opts: { itemId: number; locationId?: number | null; canViewRates: boolean; limit?: number }
) {
  let query = db
    .selectFrom('stock_ledger')
    .innerJoin('locations', 'locations.id', 'stock_ledger.location_id')
    .leftJoin('projects', 'projects.id', 'stock_ledger.project_id')
    .leftJoin('users', 'users.id', 'stock_ledger.created_by')
    .select([
      'stock_ledger.id',
      'stock_ledger.txn_date',
      'stock_ledger.txn_type',
      'stock_ledger.ref_table',
      'stock_ledger.ref_id',
      'stock_ledger.qty_in',
      'stock_ledger.qty_out',
      'stock_ledger.balance_after',
      'stock_ledger.batch_no',
      'locations.name as location_name',
      'projects.code as project_code',
      'users.full_name as created_by_name',
    ])
    .where('stock_ledger.item_id', '=', opts.itemId)
    .orderBy('stock_ledger.id', 'desc')
    .limit(opts.limit ?? 100)

  if (opts.canViewRates) query = query.select(['stock_ledger.rate_paise', 'stock_ledger.value_paise'])
  if (opts.locationId) query = query.where('stock_ledger.location_id', '=', opts.locationId)

  return query.execute()
}

export async function listItems(
  db: Queryable,
  opts: { q?: string | null; categoryId?: number | null; activeOnly?: boolean; limit?: number; offset?: number }
) {
  let query = db
    .selectFrom('items')
    .innerJoin('units', 'units.id', 'items.unit_id')
    .innerJoin('item_categories', 'item_categories.id', 'items.category_id')
    .leftJoin('cost_heads', 'cost_heads.id', 'items.cost_head_id')
    .select([
      'items.id',
      'items.code',
      'items.name',
      'items.gst_pct',
      'items.reorder_level',
      'items.wastage_allowance_pct',
      'items.shelf_life_days',
      'items.is_batch_tracked',
      'items.is_active',
      'items.hsn_code',
      'units.code as unit_code',
      'item_categories.name as category_name',
      'cost_heads.name as cost_head_name',
    ])
    .orderBy('items.code')
    .limit(opts.limit ?? PAGE_SIZE)
    .offset(opts.offset ?? 0)

  if (opts.activeOnly) query = query.where('items.is_active', '=', 1)
  if (opts.categoryId) query = query.where('items.category_id', '=', opts.categoryId)
  if (opts.q) {
    const like = `%${opts.q}%`
    query = query.where((eb) => eb.or([eb('items.code', 'like', like), eb('items.name', 'like', like)]))
  }

  return query.execute()
}

export async function countItems(
  db: Queryable,
  opts: { q?: string | null; categoryId?: number | null; activeOnly?: boolean }
): Promise<number> {
  let query = db.selectFrom('items').select((eb) => eb.fn.countAll<number>().as('n'))
  if (opts.activeOnly) query = query.where('items.is_active', '=', 1)
  if (opts.categoryId) query = query.where('items.category_id', '=', opts.categoryId)
  if (opts.q) {
    const like = `%${opts.q}%`
    query = query.where((eb) => eb.or([eb('items.code', 'like', like), eb('items.name', 'like', like)]))
  }
  const row = await query.executeTakeFirst()
  return Number(row?.n ?? 0)
}

export async function findItem(db: Queryable, id: number) {
  return db
    .selectFrom('items')
    .innerJoin('units', 'units.id', 'items.unit_id')
    .innerJoin('item_categories', 'item_categories.id', 'items.category_id')
    .select([
      'items.id',
      'items.code',
      'items.name',
      'items.category_id',
      'items.unit_id',
      'items.cost_head_id',
      'items.specification',
      'items.hsn_code',
      'items.gst_pct',
      'items.reorder_level',
      'items.wastage_allowance_pct',
      'items.shelf_life_days',
      'items.is_batch_tracked',
      'items.is_active',
      'units.code as unit_code',
      'item_categories.name as category_name',
    ])
    .where('items.id', '=', id)
    .executeTakeFirst()
}

export async function itemBrandRows(db: Queryable, itemId: number) {
  return db
    .selectFrom('item_brands')
    .leftJoin('users', 'users.id', 'item_brands.approved_by')
    .select([
      'item_brands.id',
      'item_brands.brand',
      'item_brands.is_approved',
      'item_brands.note',
      'users.full_name as approved_by_name',
    ])
    .where('item_brands.item_id', '=', itemId)
    .orderBy('item_brands.brand')
    .execute()
}

export async function itemOptions(db: Queryable) {
  return db
    .selectFrom('items')
    .innerJoin('units', 'units.id', 'items.unit_id')
    .select(['items.id', 'items.code', 'items.name', 'items.gst_pct', 'items.is_batch_tracked', 'units.code as unit_code'])
    .where('items.is_active', '=', 1)
    .orderBy('items.code')
    .execute()
}

export async function categoryOptions(db: Queryable) {
  return db
    .selectFrom('item_categories')
    .select(['id', 'code', 'name'])
    .orderBy('sort_order')
    .orderBy('name')
    .execute()
}

export async function unitOptions(db: Queryable) {
  return db.selectFrom('units').select(['id', 'code', 'name', 'decimal_places']).orderBy('code').execute()
}

export async function costHeadOptions(db: Queryable) {
  return db
    .selectFrom('cost_heads')
    .select(['id', 'code', 'name', 'head_type'])
    .where('is_active', '=', 1)
    .orderBy('sort_order')
    .orderBy('code')
    .execute()
}

/** Stores the caller may touch. Scoped users get their site stores plus transit. */
export async function locationOptions(db: Db, scope: ScopeContext | null, types?: readonly string[]) {
  const allowed = scope ? await accessibleLocationIds(db, scope) : null

  let query = db
    .selectFrom('locations')
    .leftJoin('projects', 'projects.id', 'locations.project_id')
    .select([
      'locations.id',
      'locations.code',
      'locations.name',
      'locations.location_type',
      'locations.project_id',
      'projects.code as project_code',
    ])
    .where('locations.is_active', '=', 1)
    .orderBy('locations.location_type')
    .orderBy('locations.code')

  if (types && types.length) {
    query = query.where('locations.location_type', 'in', types as Array<'central_store'>)
  }
  if (allowed) query = query.where('locations.id', 'in', scopeIn(allowed))

  return query.execute()
}

export async function listRequisitions(
  db: Db,
  scope: ScopeContext,
  opts: { status?: string | null; projectId?: number | null; limit?: number; offset?: number }
) {
  const scoped = await projectScopeFilter(db, scope)

  let query = db
    .selectFrom('material_requisitions as mr')
    .innerJoin('projects', 'projects.id', 'mr.project_id')
    .innerJoin('users', 'users.id', 'mr.requested_by')
    .select((eb) => [
      'mr.id',
      'mr.req_no',
      'mr.status',
      'mr.required_by_date',
      'mr.created_at',
      'projects.code as project_code',
      'projects.name as project_name',
      'users.full_name as requested_by_name',
      eb
        .selectFrom('requisition_lines')
        .select(sql<number>`COUNT(*)`.as('c'))
        .whereRef('requisition_lines.requisition_id', '=', 'mr.id')
        .as('line_count'),
    ])
    .orderBy('mr.id', 'desc')
    .limit(opts.limit ?? PAGE_SIZE)
    .offset(opts.offset ?? 0)

  if (opts.status) query = query.where('mr.status', '=', opts.status as 'draft')
  if (opts.projectId) query = query.where('mr.project_id', '=', opts.projectId)
  if (scoped) query = query.where('mr.project_id', 'in', scopeIn(scoped))

  return query.execute()
}

export async function countRequisitions(
  db: Db,
  scope: ScopeContext,
  opts: { status?: string | null; projectId?: number | null }
): Promise<number> {
  const scoped = await projectScopeFilter(db, scope)
  let query = db.selectFrom('material_requisitions').select((eb) => eb.fn.countAll<number>().as('n'))
  if (opts.status) query = query.where('status', '=', opts.status as 'draft')
  if (opts.projectId) query = query.where('project_id', '=', opts.projectId)
  if (scoped) query = query.where('project_id', 'in', scopeIn(scoped))
  const row = await query.executeTakeFirst()
  return Number(row?.n ?? 0)
}

export async function findRequisition(db: Queryable, id: number) {
  return db
    .selectFrom('material_requisitions as mr')
    .innerJoin('projects', 'projects.id', 'mr.project_id')
    .innerJoin('users as req', 'req.id', 'mr.requested_by')
    .leftJoin('users as app', 'app.id', 'mr.approved_by')
    .leftJoin('project_stages', 'project_stages.id', 'mr.project_stage_id')
    .select([
      'mr.id',
      'mr.req_no',
      'mr.project_id',
      'mr.project_stage_id',
      'mr.status',
      'mr.required_by_date',
      'mr.remarks',
      'mr.reject_reason',
      'mr.approved_at',
      'mr.created_at',
      // The raiser's id as well as their name: the detail page has to know
      // whether the viewer is the raiser, because approveRequisition() refuses
      // self-approval and a disabled button explains that before the click.
      'mr.requested_by',
      'projects.code as project_code',
      'projects.name as project_name',
      'req.full_name as requested_by_name',
      'app.full_name as approved_by_name',
      'project_stages.name as stage_name',
    ])
    .where('mr.id', '=', id)
    .executeTakeFirst()
}

export async function requisitionLineRows(db: Queryable, requisitionId: number) {
  return db
    .selectFrom('requisition_lines as rl')
    .innerJoin('items', 'items.id', 'rl.item_id')
    .innerJoin('units', 'units.id', 'items.unit_id')
    .select([
      'rl.id',
      'rl.item_id',
      'rl.qty_requested',
      'rl.qty_approved',
      'rl.qty_ordered',
      'rl.remarks',
      'items.code as item_code',
      'items.name as item_name',
      'units.code as unit_code',
    ])
    .where('rl.requisition_id', '=', requisitionId)
    .orderBy('rl.id')
    .execute()
}

/** Approved requisition lines with quantity still to order, for PO prefill. */
export async function orderableRequisitionLines(db: Queryable, requisitionId: number) {
  const rows = await db
    .selectFrom('requisition_lines as rl')
    .innerJoin('items', 'items.id', 'rl.item_id')
    .innerJoin('units', 'units.id', 'items.unit_id')
    .select([
      'rl.id',
      'rl.item_id',
      'rl.qty_requested',
      'rl.qty_approved',
      'rl.qty_ordered',
      'items.code as item_code',
      'items.name as item_name',
      'items.gst_pct',
      'units.code as unit_code',
    ])
    .where('rl.requisition_id', '=', requisitionId)
    .orderBy('rl.id')
    .execute()

  return rows
    .map((r) => {
      const approved = r.qty_approved === null ? Number(r.qty_requested) : Number(r.qty_approved)
      return { ...r, qty_pending: Math.round((approved - Number(r.qty_ordered)) * 1000) / 1000 }
    })
    .filter((r) => r.qty_pending > 0)
}

export async function listPurchaseOrders(
  db: Db,
  scope: ScopeContext,
  opts: { status?: string | null; vendorId?: number | null; canViewRates: boolean; limit?: number; offset?: number }
) {
  const scoped = await projectScopeFilter(db, scope)

  let query = db
    .selectFrom('purchase_orders as po')
    .innerJoin('vendors', 'vendors.id', 'po.vendor_id')
    .leftJoin('projects', 'projects.id', 'po.project_id')
    .select([
      'po.id',
      'po.po_no',
      'po.po_date',
      'po.status',
      'po.expected_delivery',
      'vendors.name as vendor_name',
      'projects.code as project_code',
    ])
    .orderBy('po.id', 'desc')
    .limit(opts.limit ?? PAGE_SIZE)
    .offset(opts.offset ?? 0)

  if (opts.canViewRates) query = query.select(['po.total_paise', 'po.subtotal_paise', 'po.gst_paise'])
  if (opts.status) query = query.where('po.status', '=', opts.status as 'draft')
  if (opts.vendorId) query = query.where('po.vendor_id', '=', opts.vendorId)
  if (scoped) {
    query = query.where((eb) =>
      eb.or([eb('po.project_id', 'is', null), eb('po.project_id', 'in', scopeIn(scoped))])
    )
  }

  return query.execute()
}

export async function countPurchaseOrders(
  db: Db,
  scope: ScopeContext,
  opts: { status?: string | null; vendorId?: number | null }
): Promise<number> {
  const scoped = await projectScopeFilter(db, scope)
  let query = db.selectFrom('purchase_orders').select((eb) => eb.fn.countAll<number>().as('n'))
  if (opts.status) query = query.where('status', '=', opts.status as 'draft')
  if (opts.vendorId) query = query.where('vendor_id', '=', opts.vendorId)
  if (scoped) {
    query = query.where((eb) => eb.or([eb('project_id', 'is', null), eb('project_id', 'in', scopeIn(scoped))]))
  }
  const row = await query.executeTakeFirst()
  return Number(row?.n ?? 0)
}

export async function findPurchaseOrder(db: Queryable, id: number, canViewRates: boolean) {
  let query = db
    .selectFrom('purchase_orders as po')
    .innerJoin('vendors', 'vendors.id', 'po.vendor_id')
    .innerJoin('locations', 'locations.id', 'po.delivery_location_id')
    .leftJoin('projects', 'projects.id', 'po.project_id')
    .leftJoin('material_requisitions as mr', 'mr.id', 'po.requisition_id')
    .leftJoin('users as cre', 'cre.id', 'po.created_by')
    .leftJoin('users as app', 'app.id', 'po.approved_by')
    .leftJoin('users as app2', 'app2.id', 'po.second_approved_by')
    .select([
      'po.id',
      'po.po_no',
      'po.po_date',
      'po.status',
      'po.vendor_id',
      'po.project_id',
      'po.requisition_id',
      'po.delivery_location_id',
      'po.expected_delivery',
      'po.payment_terms_days',
      'po.advance_pct',
      'po.terms',
      'po.short_close_reason',
      'po.approved_at',
      'po.second_approved_at',
      'po.created_by',
      'po.approved_by',
      'po.created_at',
      'vendors.name as vendor_name',
      'vendors.code as vendor_code',
      'vendors.gstin as vendor_gstin',
      'vendors.address as vendor_address',
      'vendors.city as vendor_city',
      'vendors.phone as vendor_phone',
      'vendors.email as vendor_email',
      'locations.name as delivery_location_name',
      'locations.address as delivery_address',
      'projects.code as project_code',
      'projects.name as project_name',
      'mr.req_no',
      'cre.full_name as created_by_name',
      'app.full_name as approved_by_name',
      'app2.full_name as second_approved_by_name',
    ])
    .where('po.id', '=', id)

  if (canViewRates) {
    query = query.select(['po.subtotal_paise', 'po.gst_paise', 'po.freight_paise', 'po.total_paise'])
  }

  return query.executeTakeFirst()
}

export async function poLineRows(db: Queryable, poId: number, canViewRates: boolean) {
  let query = db
    .selectFrom('po_lines as pl')
    .innerJoin('items', 'items.id', 'pl.item_id')
    .innerJoin('units', 'units.id', 'items.unit_id')
    .leftJoin('cost_heads', 'cost_heads.id', 'pl.cost_head_id')
    .select([
      'pl.id',
      'pl.item_id',
      'pl.brand',
      'pl.qty_ordered',
      'pl.qty_received',
      'pl.gst_pct',
      'pl.remarks',
      'pl.cost_head_id',
      'items.code as item_code',
      'items.name as item_name',
      'items.hsn_code',
      'units.code as unit_code',
      'cost_heads.name as cost_head_name',
    ])
    .where('pl.po_id', '=', poId)
    .orderBy('pl.id')

  if (canViewRates) query = query.select(['pl.rate_paise', 'pl.line_total_paise'])

  return query.execute()
}

/** PO lines with quantity outstanding, for GRN prefill. */
export async function receivablePoLines(db: Queryable, poId: number) {
  const rows = await db
    .selectFrom('po_lines as pl')
    .innerJoin('items', 'items.id', 'pl.item_id')
    .innerJoin('units', 'units.id', 'items.unit_id')
    .select([
      'pl.id',
      'pl.item_id',
      'pl.brand',
      'pl.qty_ordered',
      'pl.qty_received',
      'pl.rate_paise',
      'items.code as item_code',
      'items.name as item_name',
      'items.is_batch_tracked',
      'units.code as unit_code',
    ])
    .where('pl.po_id', '=', poId)
    .orderBy('pl.id')
    .execute()

  return rows.map((r) => ({
    ...r,
    qty_pending: Math.round((Number(r.qty_ordered) - Number(r.qty_received)) * 1000) / 1000,
  }))
}

export interface RateReference {
  itemId: number
  vendorRatePaise: number | null
  lastPurchases: Array<{ ratePaise: number; receivedOn: string; vendorName: string }>
}

/**
 * The reference rates for one item: the vendor's own current contract rate
 * and the last three receipts (spec 6.4 rule 7).
 *
 * One query per item rather than a window function partitioned by item. A PO
 * has a handful of lines, and ROW_NUMBER() would put a MariaDB version
 * dependency into a hot path while §8.11 is unanswered.
 */
export async function rateReference(
  db: Queryable,
  itemId: number,
  vendorId: number | null,
  onDate: string = today()
): Promise<RateReference> {
  let ratePaise: number | null = null
  if (vendorId) {
    const row = await db
      .selectFrom('vendor_item_rates')
      .select('rate_paise')
      .where('vendor_id', '=', vendorId)
      .where('item_id', '=', itemId)
      .where('valid_from', '<=', onDate)
      .where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>=', onDate)]))
      .orderBy('valid_from', 'desc')
      .executeTakeFirst()
    ratePaise = row ? Number(row.rate_paise) : null
  }

  const grns = await db
    .selectFrom('grn_lines as gl')
    .innerJoin('goods_receipts as gr', 'gr.id', 'gl.grn_id')
    .innerJoin('vendors', 'vendors.id', 'gr.vendor_id')
    .select(['gl.rate_paise', 'gr.received_on', 'vendors.name as vendor_name'])
    .where('gl.item_id', '=', itemId)
    .where('gr.status', '=', 'posted')
    .orderBy('gr.received_on', 'desc')
    .orderBy('gl.id', 'desc')
    .limit(3)
    .execute()

  return {
    itemId,
    vendorRatePaise: ratePaise,
    lastPurchases: grns.map((g) => ({
      ratePaise: Number(g.rate_paise),
      receivedOn: String(g.received_on),
      vendorName: g.vendor_name,
    })),
  }
}

export async function listGrns(
  db: Db,
  scope: ScopeContext,
  opts: { status?: string | null; locationId?: number | null; limit?: number; offset?: number }
) {
  const locations = await accessibleLocationIds(db, scope)

  let query = db
    .selectFrom('goods_receipts as gr')
    .innerJoin('vendors', 'vendors.id', 'gr.vendor_id')
    .innerJoin('locations', 'locations.id', 'gr.location_id')
    .leftJoin('purchase_orders as po', 'po.id', 'gr.po_id')
    .leftJoin('users', 'users.id', 'gr.received_by')
    .select((eb) => [
      'gr.id',
      'gr.grn_no',
      'gr.received_on',
      'gr.status',
      'gr.invoice_no',
      'gr.vehicle_no',
      'vendors.name as vendor_name',
      'locations.name as location_name',
      'po.po_no',
      'users.full_name as received_by_name',
      eb
        .selectFrom('grn_lines')
        .select(sql<number>`COUNT(*)`.as('c'))
        .whereRef('grn_lines.grn_id', '=', 'gr.id')
        .as('line_count'),
      eb
        .selectFrom('grn_lines')
        .select(sql<number>`COUNT(*)`.as('c'))
        .whereRef('grn_lines.grn_id', '=', 'gr.id')
        .where(sql<boolean>`grn_lines.qty_challan <> grn_lines.qty_received`)
        .as('mismatch_count'),
    ])
    .orderBy('gr.id', 'desc')
    .limit(opts.limit ?? PAGE_SIZE)
    .offset(opts.offset ?? 0)

  if (opts.status) query = query.where('gr.status', '=', opts.status as 'draft')
  if (opts.locationId) query = query.where('gr.location_id', '=', opts.locationId)
  if (locations) query = query.where('gr.location_id', 'in', scopeIn(locations))

  return query.execute()
}

export async function countGrns(
  db: Db,
  scope: ScopeContext,
  opts: { status?: string | null; locationId?: number | null }
): Promise<number> {
  const locations = await accessibleLocationIds(db, scope)
  let query = db.selectFrom('goods_receipts').select((eb) => eb.fn.countAll<number>().as('n'))
  if (opts.status) query = query.where('status', '=', opts.status as 'draft')
  if (opts.locationId) query = query.where('location_id', '=', opts.locationId)
  if (locations) query = query.where('location_id', 'in', scopeIn(locations))
  const row = await query.executeTakeFirst()
  return Number(row?.n ?? 0)
}

export async function findGrn(db: Queryable, id: number) {
  return db
    .selectFrom('goods_receipts as gr')
    .innerJoin('vendors', 'vendors.id', 'gr.vendor_id')
    .innerJoin('locations', 'locations.id', 'gr.location_id')
    .leftJoin('purchase_orders as po', 'po.id', 'gr.po_id')
    .leftJoin('projects', 'projects.id', 'gr.project_id')
    .leftJoin('users as rec', 'rec.id', 'gr.received_by')
    .leftJoin('users as ins', 'ins.id', 'gr.inspected_by')
    .select([
      'gr.id',
      'gr.grn_no',
      'gr.po_id',
      'gr.vendor_id',
      'gr.location_id',
      'gr.project_id',
      'gr.received_on',
      'gr.vehicle_no',
      'gr.invoice_no',
      'gr.invoice_date',
      'gr.invoice_amount_paise',
      'gr.weighbridge_slip_no',
      'gr.gate_entry_no',
      'gr.status',
      'gr.posted_at',
      'gr.created_at',
      'vendors.name as vendor_name',
      'vendors.code as vendor_code',
      'locations.name as location_name',
      'po.po_no',
      'projects.code as project_code',
      'rec.full_name as received_by_name',
      'ins.full_name as inspected_by_name',
    ])
    .where('gr.id', '=', id)
    .executeTakeFirst()
}

export async function grnLineRows(db: Queryable, grnId: number, canViewRates: boolean) {
  let query = db
    .selectFrom('grn_lines as gl')
    .innerJoin('items', 'items.id', 'gl.item_id')
    .innerJoin('units', 'units.id', 'items.unit_id')
    .select([
      'gl.id',
      'gl.item_id',
      'gl.po_line_id',
      'gl.brand',
      'gl.qty_challan',
      'gl.qty_received',
      'gl.qty_accepted',
      'gl.qty_rejected',
      'gl.rejection_reason',
      'gl.batch_no',
      'gl.manufacture_date',
      'gl.expiry_date',
      'items.code as item_code',
      'items.name as item_name',
      'units.code as unit_code',
    ])
    .where('gl.grn_id', '=', grnId)
    .orderBy('gl.id')

  if (canViewRates) query = query.select('gl.rate_paise')

  return query.execute()
}

export async function listIssues(
  db: Db,
  scope: ScopeContext,
  opts: { projectId?: number | null; locationId?: number | null; limit?: number; offset?: number }
) {
  const scoped = await projectScopeFilter(db, scope)

  let query = db
    .selectFrom('material_issues as mi')
    .innerJoin('projects', 'projects.id', 'mi.project_id')
    .innerJoin('locations', 'locations.id', 'mi.location_id')
    .leftJoin('users', 'users.id', 'mi.issued_by')
    .select((eb) => [
      'mi.id',
      'mi.issue_no',
      'mi.issued_on',
      'mi.status',
      'mi.issued_to_type',
      'mi.received_by_name',
      'projects.code as project_code',
      'locations.name as location_name',
      'users.full_name as issued_by_name',
      eb
        .selectFrom('issue_lines')
        .select(sql<number>`COUNT(*)`.as('c'))
        .whereRef('issue_lines.issue_id', '=', 'mi.id')
        .as('line_count'),
    ])
    .orderBy('mi.id', 'desc')
    .limit(opts.limit ?? PAGE_SIZE)
    .offset(opts.offset ?? 0)

  if (opts.projectId) query = query.where('mi.project_id', '=', opts.projectId)
  if (opts.locationId) query = query.where('mi.location_id', '=', opts.locationId)
  if (scoped) query = query.where('mi.project_id', 'in', scopeIn(scoped))

  return query.execute()
}

export async function countIssues(
  db: Db,
  scope: ScopeContext,
  opts: { projectId?: number | null; locationId?: number | null }
): Promise<number> {
  const scoped = await projectScopeFilter(db, scope)
  let query = db.selectFrom('material_issues').select((eb) => eb.fn.countAll<number>().as('n'))
  if (opts.projectId) query = query.where('project_id', '=', opts.projectId)
  if (opts.locationId) query = query.where('location_id', '=', opts.locationId)
  if (scoped) query = query.where('project_id', 'in', scopeIn(scoped))
  const row = await query.executeTakeFirst()
  return Number(row?.n ?? 0)
}

export async function findIssue(db: Queryable, id: number) {
  return db
    .selectFrom('material_issues as mi')
    .innerJoin('projects', 'projects.id', 'mi.project_id')
    .innerJoin('locations', 'locations.id', 'mi.location_id')
    .leftJoin('project_stages', 'project_stages.id', 'mi.project_stage_id')
    .leftJoin('labour_contractors as lc', 'lc.id', 'mi.labour_contractor_id')
    .leftJoin('users', 'users.id', 'mi.issued_by')
    .select([
      'mi.id',
      'mi.issue_no',
      'mi.location_id',
      'mi.project_id',
      'mi.project_stage_id',
      'mi.issued_on',
      'mi.issued_to_type',
      'mi.labour_contractor_id',
      'mi.received_by_name',
      'mi.purpose',
      'mi.status',
      'mi.created_at',
      'projects.code as project_code',
      'projects.name as project_name',
      'locations.name as location_name',
      'project_stages.name as stage_name',
      'lc.name as contractor_name',
      'users.full_name as issued_by_name',
    ])
    .where('mi.id', '=', id)
    .executeTakeFirst()
}

export async function issueLineRows(db: Queryable, issueId: number, canViewRates: boolean) {
  let query = db
    .selectFrom('issue_lines as il')
    .innerJoin('items', 'items.id', 'il.item_id')
    .innerJoin('units', 'units.id', 'items.unit_id')
    .leftJoin('cost_heads', 'cost_heads.id', 'il.cost_head_id')
    .select([
      'il.id',
      'il.item_id',
      'il.qty_issued',
      'il.qty_returned',
      'il.batch_no',
      'items.code as item_code',
      'items.name as item_name',
      'units.code as unit_code',
      'cost_heads.name as cost_head_name',
    ])
    .where('il.issue_id', '=', issueId)
    .orderBy('il.id')

  if (canViewRates) query = query.select('il.rate_paise')

  return query.execute()
}

export async function listTransfers(
  db: Db,
  scope: ScopeContext,
  opts: { status?: string | null; limit?: number; offset?: number }
) {
  const locations = await accessibleLocationIds(db, scope)

  let query = db
    .selectFrom('stock_transfers as st')
    .innerJoin('locations as fl', 'fl.id', 'st.from_location_id')
    .innerJoin('locations as tl', 'tl.id', 'st.to_location_id')
    .leftJoin('users', 'users.id', 'st.dispatched_by')
    .select((eb) => [
      'st.id',
      'st.transfer_no',
      'st.dispatched_on',
      'st.received_on',
      'st.status',
      'st.vehicle_no',
      'fl.name as from_location_name',
      'tl.name as to_location_name',
      'users.full_name as dispatched_by_name',
      eb
        .selectFrom('transfer_lines')
        .select(sql<number>`COUNT(*)`.as('c'))
        .whereRef('transfer_lines.transfer_id', '=', 'st.id')
        .as('line_count'),
    ])
    .orderBy('st.id', 'desc')
    .limit(opts.limit ?? PAGE_SIZE)
    .offset(opts.offset ?? 0)

  if (opts.status) query = query.where('st.status', '=', opts.status as 'in_transit')
  if (locations) {
    query = query.where((eb) =>
      eb.or([eb('st.from_location_id', 'in', scopeIn(locations)), eb('st.to_location_id', 'in', scopeIn(locations))])
    )
  }

  return query.execute()
}

export async function countTransfers(
  db: Db,
  scope: ScopeContext,
  opts: { status?: string | null }
): Promise<number> {
  const locations = await accessibleLocationIds(db, scope)
  let query = db.selectFrom('stock_transfers').select((eb) => eb.fn.countAll<number>().as('n'))
  if (opts.status) query = query.where('status', '=', opts.status as 'in_transit')
  if (locations) {
    query = query.where((eb) =>
      eb.or([eb('from_location_id', 'in', scopeIn(locations)), eb('to_location_id', 'in', scopeIn(locations))])
    )
  }
  const row = await query.executeTakeFirst()
  return Number(row?.n ?? 0)
}

export async function findTransfer(db: Queryable, id: number) {
  return db
    .selectFrom('stock_transfers as st')
    .innerJoin('locations as fl', 'fl.id', 'st.from_location_id')
    .innerJoin('locations as tl', 'tl.id', 'st.to_location_id')
    .leftJoin('users as dis', 'dis.id', 'st.dispatched_by')
    .leftJoin('users as rec', 'rec.id', 'st.received_by')
    .select([
      'st.id',
      'st.transfer_no',
      'st.from_location_id',
      'st.to_location_id',
      'st.dispatched_on',
      'st.received_on',
      'st.vehicle_no',
      'st.status',
      'st.created_at',
      'fl.name as from_location_name',
      'tl.name as to_location_name',
      'dis.full_name as dispatched_by_name',
      'rec.full_name as received_by_name',
    ])
    .where('st.id', '=', id)
    .executeTakeFirst()
}

export async function transferLineRows(db: Queryable, transferId: number) {
  return db
    .selectFrom('transfer_lines as tl')
    .innerJoin('items', 'items.id', 'tl.item_id')
    .innerJoin('units', 'units.id', 'items.unit_id')
    .select([
      'tl.id',
      'tl.item_id',
      'tl.qty_sent',
      'tl.qty_received',
      'tl.shortage_qty',
      'tl.batch_no',
      'items.code as item_code',
      'items.name as item_name',
      'units.code as unit_code',
    ])
    .where('tl.transfer_id', '=', transferId)
    .orderBy('tl.id')
    .execute()
}

export async function listAdjustments(
  db: Db,
  scope: ScopeContext,
  opts: { reason?: string | null; limit?: number; offset?: number }
) {
  const locations = await accessibleLocationIds(db, scope)

  let query = db
    .selectFrom('stock_adjustments as sa')
    .innerJoin('locations', 'locations.id', 'sa.location_id')
    .leftJoin('users as cre', 'cre.id', 'sa.created_by')
    .leftJoin('users as app', 'app.id', 'sa.approved_by')
    .select((eb) => [
      'sa.id',
      'sa.adjustment_date',
      'sa.reason',
      'sa.narration',
      'sa.approved_at',
      'locations.name as location_name',
      'cre.full_name as created_by_name',
      'app.full_name as approved_by_name',
      eb
        .selectFrom('adjustment_lines')
        .select(sql<number>`COUNT(*)`.as('c'))
        .whereRef('adjustment_lines.adjustment_id', '=', 'sa.id')
        .as('line_count'),
    ])
    .orderBy('sa.id', 'desc')
    .limit(opts.limit ?? PAGE_SIZE)
    .offset(opts.offset ?? 0)

  if (opts.reason) query = query.where('sa.reason', '=', opts.reason as 'damage')
  if (locations) query = query.where('sa.location_id', 'in', scopeIn(locations))

  return query.execute()
}

export async function countAdjustments(
  db: Db,
  scope: ScopeContext,
  opts: { reason?: string | null }
): Promise<number> {
  const locations = await accessibleLocationIds(db, scope)
  let query = db.selectFrom('stock_adjustments').select((eb) => eb.fn.countAll<number>().as('n'))
  if (opts.reason) query = query.where('reason', '=', opts.reason as 'damage')
  if (locations) query = query.where('location_id', 'in', scopeIn(locations))
  const row = await query.executeTakeFirst()
  return Number(row?.n ?? 0)
}

export async function findAdjustment(db: Queryable, id: number) {
  return db
    .selectFrom('stock_adjustments as sa')
    .innerJoin('locations', 'locations.id', 'sa.location_id')
    .leftJoin('users as cre', 'cre.id', 'sa.created_by')
    .leftJoin('users as app', 'app.id', 'sa.approved_by')
    .select([
      'sa.id',
      'sa.location_id',
      'sa.adjustment_date',
      'sa.reason',
      'sa.narration',
      'sa.approved_by',
      'sa.approved_at',
      'sa.created_at',
      'locations.name as location_name',
      'cre.full_name as created_by_name',
      'app.full_name as approved_by_name',
    ])
    .where('sa.id', '=', id)
    .executeTakeFirst()
}

export async function adjustmentLineRows(db: Queryable, adjustmentId: number, canViewRates: boolean) {
  let query = db
    .selectFrom('adjustment_lines as al')
    .innerJoin('items', 'items.id', 'al.item_id')
    .innerJoin('units', 'units.id', 'items.unit_id')
    .select([
      'al.id',
      'al.item_id',
      'al.qty_system',
      'al.qty_physical',
      'al.qty_diff',
      'items.code as item_code',
      'items.name as item_name',
      'units.code as unit_code',
    ])
    .where('al.adjustment_id', '=', adjustmentId)
    .orderBy('al.id')

  if (canViewRates) query = query.select('al.rate_paise')

  return query.execute()
}

export async function listVendors(
  db: Queryable,
  opts: { q?: string | null; vendorType?: string | null; status?: string | null; limit?: number; offset?: number }
) {
  let query = db
    .selectFrom('vendors')
    .select([
      'id',
      'code',
      'name',
      'vendor_type',
      'status',
      'city',
      'phone',
      'contact_name',
      'gstin',
      'payment_terms_days',
      'rating_quality',
      'rating_timeliness',
    ])
    .orderBy('name')
    .limit(opts.limit ?? PAGE_SIZE)
    .offset(opts.offset ?? 0)

  if (opts.vendorType) query = query.where('vendor_type', '=', opts.vendorType as 'material')
  if (opts.status) query = query.where('status', '=', opts.status as 'active')
  if (opts.q) {
    const like = `%${opts.q}%`
    query = query.where((eb) =>
      eb.or([eb('name', 'like', like), eb('code', 'like', like), eb('gstin', 'like', like)])
    )
  }

  return query.execute()
}

export async function countVendors(
  db: Queryable,
  opts: { q?: string | null; vendorType?: string | null; status?: string | null }
): Promise<number> {
  let query = db.selectFrom('vendors').select((eb) => eb.fn.countAll<number>().as('n'))
  if (opts.vendorType) query = query.where('vendor_type', '=', opts.vendorType as 'material')
  if (opts.status) query = query.where('status', '=', opts.status as 'active')
  if (opts.q) {
    const like = `%${opts.q}%`
    query = query.where((eb) =>
      eb.or([eb('name', 'like', like), eb('code', 'like', like), eb('gstin', 'like', like)])
    )
  }
  const row = await query.executeTakeFirst()
  return Number(row?.n ?? 0)
}

export async function findVendor(db: Queryable, id: number) {
  return db.selectFrom('vendors').selectAll().where('id', '=', id).executeTakeFirst()
}

export async function vendorOptions(db: Queryable, vendorType?: string | null) {
  let query = db
    .selectFrom('vendors')
    .select(['id', 'code', 'name', 'payment_terms_days'])
    .where('status', '=', 'active')
    .orderBy('name')
  if (vendorType) query = query.where('vendor_type', '=', vendorType as 'material')
  return query.execute()
}

export async function vendorRateRows(db: Queryable, vendorId: number) {
  return db
    .selectFrom('vendor_item_rates as vir')
    .innerJoin('items', 'items.id', 'vir.item_id')
    .innerJoin('units', 'units.id', 'items.unit_id')
    .select([
      'vir.id',
      'vir.item_id',
      'vir.rate_paise',
      'vir.valid_from',
      'vir.valid_to',
      'vir.freight_included',
      'vir.min_order_qty',
      'items.code as item_code',
      'items.name as item_name',
      'units.code as unit_code',
    ])
    .where('vir.vendor_id', '=', vendorId)
    .orderBy('items.code')
    .orderBy('vir.valid_from', 'desc')
    .execute()
}

export async function vendorPurchaseHistory(db: Queryable, vendorId: number, canViewRates: boolean, limit = 20) {
  let query = db
    .selectFrom('purchase_orders as po')
    .leftJoin('projects', 'projects.id', 'po.project_id')
    .select(['po.id', 'po.po_no', 'po.po_date', 'po.status', 'projects.code as project_code'])
    .where('po.vendor_id', '=', vendorId)
    .orderBy('po.id', 'desc')
    .limit(limit)
  if (canViewRates) query = query.select('po.total_paise')
  return query.execute()
}

export interface ConsumptionRow {
  itemId: number
  itemCode: string
  itemName: string
  unitCode: string
  issuedQty: number
  wastageAllowancePct: number
  normPerSqft: number | null
  expectedQty: number | null
  variancePct: number | null
}

/**
 * Issued against expected consumption for one project (spec 6.4 rule 4).
 *
 * consumption_norms is unseeded because §8.4 is unanswered, so expectedQty is
 * null wherever there is no norm and the caller renders "no norm set". It
 * does not fall back to a plausible figure: a fabricated norm produces a
 * variance number that reads exactly like a measured one.
 */
export async function consumptionForProject(db: Queryable, projectId: number): Promise<ConsumptionRow[]> {
  const project = await db
    .selectFrom('projects')
    .select(['built_up_area_sqft', 'project_type'])
    .where('id', '=', projectId)
    .executeTakeFirst()

  const rows = await db
    .selectFrom('issue_lines as il')
    .innerJoin('material_issues as mi', 'mi.id', 'il.issue_id')
    .innerJoin('items', 'items.id', 'il.item_id')
    .innerJoin('units', 'units.id', 'items.unit_id')
    .select([
      'il.item_id',
      'items.code as item_code',
      'items.name as item_name',
      'items.wastage_allowance_pct',
      'units.code as unit_code',
      sql<number>`SUM(il.qty_issued - il.qty_returned)`.as('issued_qty'),
    ])
    .where('mi.project_id', '=', projectId)
    .where('mi.status', '=', 'posted')
    .groupBy(['il.item_id', 'items.code', 'items.name', 'items.wastage_allowance_pct', 'units.code'])
    .orderBy('items.code')
    .execute()

  const area = project?.built_up_area_sqft === null || project?.built_up_area_sqft === undefined
    ? null
    : Number(project.built_up_area_sqft)

  const norms = project
    ? await db
        .selectFrom('consumption_norms')
        .select(['item_id', 'qty_per_sqft'])
        .where('project_type', '=', project.project_type)
        .execute()
    : []
  const normByItem = new Map(norms.map((n) => [Number(n.item_id), Number(n.qty_per_sqft)]))

  return rows.map((r) => {
    const issuedQty = Number(r.issued_qty ?? 0)
    const wastage = Number(r.wastage_allowance_pct ?? 0)
    const norm = normByItem.get(Number(r.item_id)) ?? null
    const expected = norm !== null && area !== null ? norm * area * (1 + wastage / 100) : null
    return {
      itemId: Number(r.item_id),
      itemCode: r.item_code,
      itemName: r.item_name,
      unitCode: r.unit_code,
      issuedQty,
      wastageAllowancePct: wastage,
      normPerSqft: norm,
      expectedQty: expected === null ? null : Math.round(expected * 1000) / 1000,
      variancePct:
        expected === null || expected === 0 ? null : Math.round(((issuedQty - expected) / expected) * 1000) / 10,
    }
  })
}

export async function listEquipment(
  db: Queryable,
  opts: { status?: string | null; canViewRates: boolean; limit?: number; offset?: number }
) {
  let query = db
    .selectFrom('equipment as eq')
    .leftJoin('locations', 'locations.id', 'eq.current_location_id')
    .leftJoin('projects', 'projects.id', 'eq.current_project_id')
    .leftJoin('vendors', 'vendors.id', 'eq.hire_vendor_id')
    .select([
      'eq.id',
      'eq.code',
      'eq.name',
      'eq.equipment_type',
      'eq.ownership',
      'eq.status',
      'eq.next_service_due',
      'eq.insurance_valid_until',
      'locations.name as location_name',
      'projects.code as project_code',
      'vendors.name as hire_vendor_name',
    ])
    .orderBy('eq.code')
    .limit(opts.limit ?? PAGE_SIZE)
    .offset(opts.offset ?? 0)

  if (opts.canViewRates) query = query.select('eq.hire_rate_per_day_paise')
  if (opts.status) query = query.where('eq.status', '=', opts.status as 'available')

  return query.execute()
}

export async function countEquipment(db: Queryable, opts: { status?: string | null }): Promise<number> {
  let query = db.selectFrom('equipment').select((eb) => eb.fn.countAll<number>().as('n'))
  if (opts.status) query = query.where('status', '=', opts.status as 'available')
  const row = await query.executeTakeFirst()
  return Number(row?.n ?? 0)
}

export async function findEquipment(db: Queryable, id: number) {
  return db
    .selectFrom('equipment as eq')
    .leftJoin('locations', 'locations.id', 'eq.current_location_id')
    .leftJoin('projects', 'projects.id', 'eq.current_project_id')
    .select([
      'eq.id',
      'eq.code',
      'eq.name',
      'eq.equipment_type',
      'eq.ownership',
      'eq.status',
      'eq.current_location_id',
      'eq.current_project_id',
      'eq.hire_rate_per_day_paise',
      'eq.next_service_due',
      'eq.insurance_valid_until',
      'locations.name as location_name',
      'projects.code as project_code',
    ])
    .where('eq.id', '=', id)
    .executeTakeFirst()
}

export async function equipmentDeploymentRows(db: Queryable, equipmentId: number, limit = 20) {
  return db
    .selectFrom('equipment_deployments as ed')
    .innerJoin('projects', 'projects.id', 'ed.project_id')
    .select([
      'ed.id',
      'ed.project_id',
      'ed.from_date',
      'ed.to_date',
      'ed.meter_start',
      'ed.meter_end',
      'ed.operator_name',
      'projects.code as project_code',
      'projects.name as project_name',
    ])
    .where('ed.equipment_id', '=', equipmentId)
    .orderBy('ed.from_date', 'desc')
    .limit(limit)
    .execute()
}

/**
 * Equipment whose service or insurance falls due inside the window, for the
 * daily alert (spec 6.4 route table: the stock-alerts job covers reorder level,
 * expiry, equipment service and insurance).
 *
 * Retired machines are excluded because nobody is going to insure a machine
 * that has been struck off; everything else is included, deployed or not, since
 * a lapsed policy on a machine sitting in the yard is still a lapsed policy.
 *
 * Two booleans rather than one "due" flag: an expired insurance is a legal
 * problem and an overdue service is a maintenance one, and whoever reads the
 * alert deals with them through different people.
 */
export async function equipmentDue(db: Queryable, withinDays = 30, onDate: string = today()) {
  const horizon = sql<string>`DATE_ADD(${onDate}, INTERVAL ${sql.lit(withinDays)} DAY)`

  const rows = await db
    .selectFrom('equipment as eq')
    .leftJoin('projects', 'projects.id', 'eq.current_project_id')
    .select([
      'eq.id',
      'eq.code',
      'eq.name',
      'eq.status',
      'eq.next_service_due',
      'eq.insurance_valid_until',
      'projects.code as project_code',
    ])
    .where('eq.status', '!=', 'retired')
    .where((eb) =>
      eb.or([eb('eq.next_service_due', '<=', horizon), eb('eq.insurance_valid_until', '<=', horizon)])
    )
    .orderBy('eq.code')
    .execute()

  return rows.map((r) => ({
    equipmentId: Number(r.id),
    code: r.code,
    name: r.name,
    status: r.status,
    projectCode: r.project_code,
    nextServiceDue: r.next_service_due,
    insuranceValidUntil: r.insurance_valid_until,
    serviceOverdue: r.next_service_due !== null && r.next_service_due < onDate,
    insuranceLapsed: r.insurance_valid_until !== null && r.insurance_valid_until < onDate,
  }))
}

/** Counts for the module landing page. One query, not one per card. */
export async function inventoryCounts(db: Db, scope: ScopeContext) {
  const scoped = await projectScopeFilter(db, scope)

  let req = db
    .selectFrom('material_requisitions')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('status', '=', 'submitted')
  let po = db
    .selectFrom('purchase_orders')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('status', '=', 'pending_approval')
  const grn = db
    .selectFrom('goods_receipts')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('status', '=', 'draft')
  const transit = db
    .selectFrom('stock_transfers')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('status', '=', 'in_transit')

  if (scoped) {
    req = req.where('project_id', 'in', scopeIn(scoped))
    po = po.where((eb) => eb.or([eb('project_id', 'is', null), eb('project_id', 'in', scopeIn(scoped))]))
  }

  const [reqRow, poRow, grnRow, transitRow] = await Promise.all([
    req.executeTakeFirst(),
    po.executeTakeFirst(),
    grn.executeTakeFirst(),
    transit.executeTakeFirst(),
  ])

  return {
    requisitionsToApprove: Number(reqRow?.n ?? 0),
    posToApprove: Number(poRow?.n ?? 0),
    grnsDraft: Number(grnRow?.n ?? 0),
    transfersInTransit: Number(transitRow?.n ?? 0),
  }
}

/** Projects a caller may pick from, scoped. Site stores exist only for these. */
export async function projectOptions(db: Db, scope: ScopeContext) {
  const scoped = await projectScopeFilter(db, scope)
  let query = db
    .selectFrom('projects')
    .select(['id', 'code', 'name', 'built_up_area_sqft'])
    .where('status', 'in', ['mobilising', 'in_progress', 'on_hold', 'snagging'])
    .orderBy('code')
  if (scoped) query = query.where('id', 'in', scopeIn(scoped))
  return query.execute()
}

export async function projectStageOptions(db: Queryable, projectId: number) {
  return db
    .selectFrom('project_stages')
    .select(['id', 'seq', 'name'])
    .where('project_id', '=', projectId)
    .orderBy('seq')
    .execute()
}

export async function labourContractorOptions(db: Queryable) {
  return db
    .selectFrom('labour_contractors')
    .select(['id', 'code', 'name'])
    .where('status', '=', 'active')
    .orderBy('name')
    .execute()
}

export async function inspectorOptions(db: Queryable) {
  return db
    .selectFrom('users')
    .select(['id', 'full_name'])
    .where('status', '=', 'active')
    .orderBy('full_name')
    .execute()
}

