import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import type { Db, Queryable, Trx } from '../../db/kysely.js'
import { writeAudit } from '../../lib/audit.js'
import { nextNumber } from '../../lib/numbering.js'
import { sequenceCode } from '../../lib/numbering.js'
import { ConflictError, NotFoundError, UnprocessableError } from '../../lib/errors.js'
import { PERMISSIONS, resolveApprovalLimit } from '../../lib/permissions.js'
import { notify, notifyPermission } from '../../lib/notify.js'
import type { ScopeContext } from '../../lib/scope.js'
import { formatPaise, splitGst, variancePct } from '../../lib/money.js'
import { addDays, formatDate, nowSqlDateTime, today } from '../../lib/dates.js'
import { batchBalances, equipmentDue, expiringBatches, lowStock } from './queries.js'
import type {
  AdjustmentLineInput,
  ApprovedLineInput,
  GrnLineInput,
  IssueLineInput,
  PoLineInput,
  RequisitionLineInput,
  ReturnLineInput,
  TransferLineInput,
  TransferReceiveLineInput,
} from './schemas.js'

/**
 * Inventory policy (spec 6.4).
 *
 * The rule the whole module is built around, quoted from the header of
 * migrations/005_inventory.sql: stock_ledger is append only and item_stock is
 * a rebuildable cache. Nothing outside postStockMovement writes item_stock.
 * GRN posting, issue, return, transfer dispatch, transfer receipt, adjustment
 * and opening balance all reach the ledger through that one function, which
 * is what makes scripts/reconcile-stock.mjs able to recompute every balance
 * from the ledger and compare.
 *
 * Stock is valued at weighted average cost. Spec 6.4 does not name a costing
 * method, and one had to be chosen to keep item_stock.value_paise consistent
 * with a replay of the ledger; weighted average is the only method of the
 * three candidates that a replay in id order reproduces exactly without
 * storing per-layer state. Recorded as a provisional decision in DECISIONS.md
 * 2.7 rather than settled here.
 *
 * mysql2 runs without decimalNumbers, so DECIMAL columns arrive as strings
 * despite being typed number in src/db/types.ts. Every quantity read from a
 * row is therefore wrapped in Number() before arithmetic.
 */

export interface Actor {
  userId: number
  ip: string | null
}

/** Quantities are DECIMAL(14,3); every computed quantity is rounded to match. */
function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

/** Trims a quantity for a message: 12.000 reads as 12, 12.500 as 12.5. */
function qty(n: number): string {
  return String(round3(n))
}

/*
 * Notification addressing lives in src/lib/notify.ts.
 *
 * Spec 6.4 rules 3 and 6 name the recipients as "the procurement lead", "the
 * owner" and "accounts". Open question 8.1 has not settled the role list, so
 * matching on a role key would break the day a role is renamed; notify.ts
 * addresses by permission key instead. These three functions were declared here
 * until CRM needed the same addressing — they moved rather than being copied
 * because usersWithPermission encodes the deny-before-grant override
 * precedence, and a second copy of that is a second place for it to drift.
 */

/* The one writer ---------------------------------------------------------- */

export type StockTxnType =
  | 'grn'
  | 'issue'
  | 'return'
  | 'transfer_out'
  | 'transfer_in'
  | 'adjustment'
  | 'opening'

export interface StockMovement {
  itemId: number
  locationId: number
  txnDate: string
  txnType: StockTxnType
  /** The document this movement came from, for the drill-down on the ledger. */
  refTable: string
  refId: number
  qtyIn: number
  qtyOut: number
  /**
   * The rate for an in-movement. Ignored on an out-movement: material leaves
   * at the weighted average the store actually holds, never at a rate typed
   * on a form, because a replay of the ledger has to reproduce item_stock and
   * a replay cannot know what someone typed.
   */
  ratePaise: number | null
  projectId: number | null
  batchNo: string | null
}

export interface MovementResult {
  ledgerId: number
  balanceAfter: number
  /** The rate the movement actually went out or in at, for the line row. */
  ratePaise: number
}

/**
 * The only function in the codebase that writes item_stock (spec 6.4 rule 1).
 *
 * It appends one stock_ledger row, then updates the cached balance from the
 * balance it just computed. The row is locked FOR UPDATE first, so two
 * storekeepers issuing the last of the cement serialise instead of both
 * reading the same balance and both succeeding.
 *
 * The lock needs a row to lock, and item_stock has no row for an item that
 * has never moved at that location. INSERT ... ON DUPLICATE KEY UPDATE
 * item_id = item_id creates it at zero without disturbing an existing one,
 * which is the same create-then-lock idiom nextNumber uses on
 * document_numbering.
 *
 * Must be called inside the caller's transaction: the ledger row, the cache
 * update and the document that caused them commit together or not at all.
 */
export async function postStockMovement(
  trx: Trx,
  actor: Actor,
  m: StockMovement
): Promise<MovementResult> {
  if (m.qtyIn < 0 || m.qtyOut < 0) {
    throw new UnprocessableError('A stock movement cannot carry a negative quantity.')
  }
  if (m.qtyIn > 0 && m.qtyOut > 0) {
    throw new UnprocessableError('A stock movement goes one way. Post the in and the out as two rows.')
  }
  if (m.qtyIn === 0 && m.qtyOut === 0) {
    throw new UnprocessableError('A stock movement of zero has nothing to record.')
  }

  await sql`
    INSERT INTO item_stock (item_id, location_id, qty_on_hand, value_paise)
    VALUES (${m.itemId}, ${m.locationId}, 0, 0)
    ON DUPLICATE KEY UPDATE item_id = item_id
  `.execute(trx)

  const cached = await trx
    .selectFrom('item_stock')
    .select(['qty_on_hand', 'value_paise'])
    .where('item_id', '=', m.itemId)
    .where('location_id', '=', m.locationId)
    .forUpdate()
    .executeTakeFirstOrThrow()

  const qtyBefore = Number(cached.qty_on_hand)
  const valueBefore = Number(cached.value_paise)
  const balanceAfter = round3(qtyBefore + m.qtyIn - m.qtyOut)

  // Rule 2. Opening balances are the exception: they establish a starting
  // position rather than move against one.
  if (balanceAfter < 0 && m.txnType !== 'opening') {
    const named = await trx
      .selectFrom('items')
      .innerJoin('units', 'units.id', 'items.unit_id')
      .select(['items.code', 'items.name', 'units.code as unit_code'])
      .where('items.id', '=', m.itemId)
      .executeTakeFirst()
    const store = await trx
      .selectFrom('locations')
      .select('name')
      .where('id', '=', m.locationId)
      .executeTakeFirst()
    const unit = named?.unit_code ?? 'units'
    throw new UnprocessableError(
      `${store?.name ?? 'That store'} holds ${qty(qtyBefore)} ${unit} of ${named?.name ?? 'the item'}` +
        ` (${named?.code ?? m.itemId}). This movement is short by ${qty(-balanceAfter)} ${unit}.` +
        ' Record the receipt or the transfer that brought it in first.'
    )
  }

  // Weighted average. DECIMAL columns arrive as strings, hence the Number()
  // above; the division is on numbers.
  const wac = qtyBefore > 0 ? valueBefore / qtyBefore : 0

  let ratePaise: number
  let valueDelta: number
  if (m.qtyIn > 0) {
    ratePaise = m.ratePaise === null ? Math.round(wac) : m.ratePaise
    valueDelta = Math.round(ratePaise * m.qtyIn)
  } else {
    ratePaise = Math.round(wac)
    // Emptying the store removes the whole remaining value rather than
    // rate * qty, so rounding cannot leave value behind zero quantity.
    valueDelta = -(balanceAfter <= 0 ? valueBefore : Math.round(wac * m.qtyOut))
  }

  // value_paise carries the magnitude; direction is in qty_in and qty_out, as
  // it is for quantity. scripts/reconcile-stock.mjs replays it that way.
  const inserted = await trx
    .insertInto('stock_ledger')
    .values({
      item_id: m.itemId,
      location_id: m.locationId,
      txn_date: m.txnDate,
      txn_type: m.txnType,
      ref_table: m.refTable,
      ref_id: m.refId,
      qty_in: m.qtyIn,
      qty_out: m.qtyOut,
      rate_paise: ratePaise,
      value_paise: Math.abs(valueDelta),
      balance_after: balanceAfter,
      project_id: m.projectId,
      batch_no: m.batchNo,
      created_by: actor.userId,
    })
    .executeTakeFirst()

  const ledgerId = Number(inserted.insertId ?? 0)

  await trx
    .updateTable('item_stock')
    .set({
      qty_on_hand: balanceAfter,
      value_paise: Math.max(0, valueBefore + valueDelta),
      last_txn_id: ledgerId,
    })
    .where('item_id', '=', m.itemId)
    .where('location_id', '=', m.locationId)
    .execute()

  return { ledgerId, balanceAfter, ratePaise }
}

/* Items and brands -------------------------------------------------------- */

export interface ItemInput {
  code: string
  name: string
  categoryId: number
  unitId: number
  costHeadId: number | null
  specification: string | null
  hsnCode: string | null
  gstPct: number
  reorderLevel: number | null
  wastageAllowancePct: number
  shelfLifeDays: number | null
  isBatchTracked: boolean
  isActive: boolean
}

export async function createItem(db: Db, actor: Actor, input: ItemInput): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const clash = await trx
      .selectFrom('items')
      .select('id')
      .where('code', '=', input.code)
      .executeTakeFirst()
    if (clash) throw new ConflictError(`Item code ${input.code} is already in use.`)

    const row = await trx
      .insertInto('items')
      .values({
        code: input.code,
        name: input.name,
        category_id: input.categoryId,
        unit_id: input.unitId,
        cost_head_id: input.costHeadId,
        specification: input.specification,
        hsn_code: input.hsnCode,
        gst_pct: input.gstPct,
        reorder_level: input.reorderLevel,
        wastage_allowance_pct: input.wastageAllowancePct,
        shelf_life_days: input.shelfLifeDays,
        is_batch_tracked: input.isBatchTracked ? 1 : 0,
        is_active: input.isActive ? 1 : 0,
        created_by: actor.userId,
      })
      .executeTakeFirst()

    const itemId = Number(row.insertId ?? 0)
    await writeAudit(trx, {
      userId: actor.userId,
      action: 'inventory.item_create',
      entityType: 'item',
      entityId: itemId,
      after: { code: input.code, name: input.name },
      ip: actor.ip,
    })
    return itemId
  })
}

export async function updateItem(db: Db, actor: Actor, itemId: number, input: ItemInput): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const before = await trx
      .selectFrom('items')
      .selectAll()
      .where('id', '=', itemId)
      .executeTakeFirst()
    if (!before) throw new NotFoundError('Item not found')

    if (before.code !== input.code) {
      const clash = await trx
        .selectFrom('items')
        .select('id')
        .where('code', '=', input.code)
        .where('id', '<>', itemId)
        .executeTakeFirst()
      if (clash) throw new ConflictError(`Item code ${input.code} is already in use.`)
    }

    await trx
      .updateTable('items')
      .set({
        code: input.code,
        name: input.name,
        category_id: input.categoryId,
        unit_id: input.unitId,
        cost_head_id: input.costHeadId,
        specification: input.specification,
        hsn_code: input.hsnCode,
        gst_pct: input.gstPct,
        reorder_level: input.reorderLevel,
        wastage_allowance_pct: input.wastageAllowancePct,
        shelf_life_days: input.shelfLifeDays,
        is_batch_tracked: input.isBatchTracked ? 1 : 0,
        is_active: input.isActive ? 1 : 0,
      })
      .where('id', '=', itemId)
      .execute()

    // snake_case so diffFields lines up against the row read above.
    await writeAudit(trx, {
      userId: actor.userId,
      action: 'inventory.item_update',
      entityType: 'item',
      entityId: itemId,
      before,
      after: {
        code: input.code,
        name: input.name,
        category_id: input.categoryId,
        unit_id: input.unitId,
        cost_head_id: input.costHeadId,
        specification: input.specification,
        hsn_code: input.hsnCode,
        gst_pct: input.gstPct,
        reorder_level: input.reorderLevel,
        wastage_allowance_pct: input.wastageAllowancePct,
        shelf_life_days: input.shelfLifeDays,
        is_batch_tracked: input.isBatchTracked ? 1 : 0,
        is_active: input.isActive ? 1 : 0,
      },
      ip: actor.ip,
    })
  })
}

/**
 * Adds an approved-brand row for an item (spec 6.4 rule 6).
 *
 * Approving a brand needs inventory.approve_po, the same permission that
 * approves the order it would be bought on. Anyone may record a brand; only
 * that holder may mark it approved, so the approved list stays a decision
 * rather than a side effect of data entry.
 */
export async function addItemBrand(
  db: Db,
  actor: Actor,
  itemId: number,
  input: { brand: string; isApproved: boolean; note: string | null },
  canApprove: boolean
): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const item = await trx
      .selectFrom('items')
      .select(['id', 'code', 'name'])
      .where('id', '=', itemId)
      .executeTakeFirst()
    if (!item) throw new NotFoundError('Item not found')

    const approved = input.isApproved && canApprove
    if (input.isApproved && !canApprove) {
      throw new UnprocessableError(
        'Marking a brand approved needs the inventory.approve_po permission. Record it unapproved and ask for approval.'
      )
    }

    const existing = await trx
      .selectFrom('item_brands')
      .select('id')
      .where('item_id', '=', itemId)
      .where('brand', '=', input.brand)
      .executeTakeFirst()
    if (existing) throw new ConflictError(`${input.brand} is already listed against ${item.code}.`)

    const row = await trx
      .insertInto('item_brands')
      .values({
        item_id: itemId,
        brand: input.brand,
        is_approved: approved ? 1 : 0,
        approved_by: approved ? actor.userId : null,
        note: input.note,
      })
      .executeTakeFirst()

    const brandId = Number(row.insertId ?? 0)
    await writeAudit(trx, {
      userId: actor.userId,
      action: 'inventory.item_brand_add',
      entityType: 'item_brand',
      entityId: brandId,
      after: { itemId, brand: input.brand, isApproved: approved },
      ip: actor.ip,
    })
    return brandId
  })
}

export async function setItemBrandApproval(
  db: Db,
  actor: Actor,
  brandId: number,
  approved: boolean
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const before = await trx
      .selectFrom('item_brands')
      .select(['id', 'item_id', 'brand', 'is_approved'])
      .where('id', '=', brandId)
      .executeTakeFirst()
    if (!before) throw new NotFoundError('Brand not found')

    await trx
      .updateTable('item_brands')
      .set({ is_approved: approved ? 1 : 0, approved_by: approved ? actor.userId : null })
      .where('id', '=', brandId)
      .execute()

    await writeAudit(trx, {
      userId: actor.userId,
      action: approved ? 'inventory.item_brand_approve' : 'inventory.item_brand_unapprove',
      entityType: 'item_brand',
      entityId: brandId,
      before: { isApproved: Number(before.is_approved) === 1 },
      after: { isApproved: approved },
      ip: actor.ip,
    })
  })
}

/* Vendors ----------------------------------------------------------------- */

export interface VendorInput {
  name: string
  vendorType: 'material' | 'equipment_hire' | 'subcontractor' | 'service' | 'transport'
  gstin: string | null
  pan: string | null
  msmeUdyamNo: string | null
  contactName: string | null
  phone: string | null
  email: string | null
  address: string | null
  city: string | null
  paymentTermsDays: number
  bankAccountName: string | null
  bankAccountNo: string | null
  bankIfsc: string | null
}

/**
 * Creates a vendor and gives it a VN0001 style code.
 *
 * The code is derived from the row's own id, in the same transaction, rather
 * than from MAX(code) + 1. numbering.ts spells out why: two clerks saving at
 * once both read the same maximum and both write the same code. There is no
 * 'vendor' DocType in the numbering table, and inventing a statutory-looking
 * document series for a master record would be inventing a business rule, so
 * the row is inserted with a throwaway unique code and then renamed once its
 * id is known.
 */
export async function createVendor(db: Db, actor: Actor, input: VendorInput): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .insertInto('vendors')
      .values({
        code: `TMP-${randomUUID().slice(0, 12)}`,
        name: input.name,
        vendor_type: input.vendorType,
        gstin: input.gstin,
        pan: input.pan,
        msme_udyam_no: input.msmeUdyamNo,
        contact_name: input.contactName,
        phone: input.phone,
        email: input.email,
        address: input.address,
        city: input.city,
        payment_terms_days: input.paymentTermsDays,
        bank_account_name: input.bankAccountName,
        bank_account_no: input.bankAccountNo,
        bank_ifsc: input.bankIfsc,
        created_by: actor.userId,
      })
      .executeTakeFirst()

    const vendorId = Number(row.insertId ?? 0)
    const code = sequenceCode('VN', vendorId)
    await trx.updateTable('vendors').set({ code }).where('id', '=', vendorId).execute()

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'inventory.vendor_create',
      entityType: 'vendor',
      entityId: vendorId,
      after: { code, name: input.name, vendorType: input.vendorType, bank_account_no: input.bankAccountNo },
      ip: actor.ip,
    })
    return vendorId
  })
}

export async function updateVendor(db: Db, actor: Actor, vendorId: number, input: VendorInput): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const before = await trx
      .selectFrom('vendors')
      .selectAll()
      .where('id', '=', vendorId)
      .executeTakeFirst()
    if (!before) throw new NotFoundError('Vendor not found')

    await trx
      .updateTable('vendors')
      .set({
        name: input.name,
        vendor_type: input.vendorType,
        gstin: input.gstin,
        pan: input.pan,
        msme_udyam_no: input.msmeUdyamNo,
        contact_name: input.contactName,
        phone: input.phone,
        email: input.email,
        address: input.address,
        city: input.city,
        payment_terms_days: input.paymentTermsDays,
        bank_account_name: input.bankAccountName,
        bank_account_no: input.bankAccountNo,
        bank_ifsc: input.bankIfsc,
      })
      .where('id', '=', vendorId)
      .execute()

    // Keyed in snake_case so diffFields lines the two sides up, and so
    // writeAudit's redaction list matches bank_account_no on both.
    await writeAudit(trx, {
      userId: actor.userId,
      action: 'inventory.vendor_update',
      entityType: 'vendor',
      entityId: vendorId,
      before,
      after: {
        name: input.name,
        vendor_type: input.vendorType,
        gstin: input.gstin,
        pan: input.pan,
        msme_udyam_no: input.msmeUdyamNo,
        contact_name: input.contactName,
        phone: input.phone,
        email: input.email,
        address: input.address,
        city: input.city,
        payment_terms_days: input.paymentTermsDays,
        bank_account_name: input.bankAccountName,
        bank_account_no: input.bankAccountNo,
        bank_ifsc: input.bankIfsc,
      },
      ip: actor.ip,
    })
  })
}

/**
 * Holds or blacklists a vendor.
 *
 * Blacklisting does not cancel work already committed. Open orders are listed
 * back to the caller instead, because a PO is a contract and voiding it is a
 * commercial decision someone has to take deliberately.
 */
export async function setVendorStatus(
  db: Db,
  actor: Actor,
  vendorId: number,
  status: 'active' | 'on_hold' | 'blacklisted',
  blacklistReason: string | null
): Promise<{ openPoCount: number }> {
  return db.transaction().execute(async (trx) => {
    const before = await trx
      .selectFrom('vendors')
      .select(['id', 'code', 'name', 'status'])
      .where('id', '=', vendorId)
      .forUpdate()
      .executeTakeFirst()
    if (!before) throw new NotFoundError('Vendor not found')

    if (status === 'blacklisted' && (blacklistReason === null || blacklistReason.trim().length === 0)) {
      throw new UnprocessableError('Blacklisting a vendor needs a reason on the record.')
    }

    const open = await trx
      .selectFrom('purchase_orders')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('vendor_id', '=', vendorId)
      .where('status', 'in', ['pending_approval', 'approved', 'partially_received'])
      .executeTakeFirst()

    await trx
      .updateTable('vendors')
      .set({
        status,
        blacklist_reason: status === 'blacklisted' ? blacklistReason : null,
      })
      .where('id', '=', vendorId)
      .execute()

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'inventory.vendor_status',
      entityType: 'vendor',
      entityId: vendorId,
      before: { status: before.status },
      after: { status, blacklist_reason: status === 'blacklisted' ? blacklistReason : null },
      ip: actor.ip,
    })

    return { openPoCount: Number(open?.n ?? 0) }
  })
}

export async function rateVendor(
  db: Db,
  actor: Actor,
  vendorId: number,
  ratings: { ratingQuality: number; ratingTimeliness: number }
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const before = await trx
      .selectFrom('vendors')
      .select(['id', 'rating_quality', 'rating_timeliness'])
      .where('id', '=', vendorId)
      .executeTakeFirst()
    if (!before) throw new NotFoundError('Vendor not found')

    await trx
      .updateTable('vendors')
      .set({ rating_quality: ratings.ratingQuality, rating_timeliness: ratings.ratingTimeliness })
      .where('id', '=', vendorId)
      .execute()

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'inventory.vendor_rate',
      entityType: 'vendor',
      entityId: vendorId,
      before: {
        rating_quality: before.rating_quality === null ? null : Number(before.rating_quality),
        rating_timeliness: before.rating_timeliness === null ? null : Number(before.rating_timeliness),
      },
      after: { rating_quality: ratings.ratingQuality, rating_timeliness: ratings.ratingTimeliness },
      ip: actor.ip,
    })
  })
}

/**
 * Records a vendor's rate for an item, closing the rate it supersedes.
 *
 * vendor_item_rates is a dated history, not a current-value column, so a new
 * rate ends the previous one the day before it starts rather than overwriting
 * it. The rate variance check on a PO (rule 7) reads that history, and it can
 * only say "last purchased at X on date Y" if the old rows survive.
 */
export async function upsertVendorRate(
  db: Db,
  actor: Actor,
  vendorId: number,
  input: {
    itemId: number
    ratePaise: number
    validFrom: string
    validTo: string | null
    freightIncluded: boolean
    minOrderQty: number | null
  }
): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const vendor = await trx
      .selectFrom('vendors')
      .select('id')
      .where('id', '=', vendorId)
      .executeTakeFirst()
    if (!vendor) throw new NotFoundError('Vendor not found')

    await trx
      .updateTable('vendor_item_rates')
      .set({ valid_to: addDays(input.validFrom, -1) })
      .where('vendor_id', '=', vendorId)
      .where('item_id', '=', input.itemId)
      .where('valid_from', '<', input.validFrom)
      .where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>=', input.validFrom)]))
      .execute()

    const row = await trx
      .insertInto('vendor_item_rates')
      .values({
        vendor_id: vendorId,
        item_id: input.itemId,
        rate_paise: input.ratePaise,
        valid_from: input.validFrom,
        valid_to: input.validTo,
        freight_included: input.freightIncluded ? 1 : 0,
        min_order_qty: input.minOrderQty,
        created_by: actor.userId,
      })
      .executeTakeFirst()

    const rateId = Number(row.insertId ?? 0)
    await writeAudit(trx, {
      userId: actor.userId,
      action: 'inventory.vendor_rate_set',
      entityType: 'vendor_item_rate',
      entityId: rateId,
      after: { vendor_id: vendorId, item_id: input.itemId, rate_paise: input.ratePaise, valid_from: input.validFrom },
      ip: actor.ip,
    })
    return rateId
  })
}

/* Requisitions ------------------------------------------------------------ */

export interface RequisitionInput {
  projectId: number
  projectStageId: number | null
  requiredByDate: string | null
  remarks: string | null
  lines: RequisitionLineInput[]
}

export async function createRequisition(db: Db, actor: Actor, input: RequisitionInput): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const project = await trx
      .selectFrom('projects')
      .select(['id', 'status'])
      .where('id', '=', input.projectId)
      .executeTakeFirst()
    if (!project) throw new NotFoundError('Project not found')
    if (project.status === 'closed' || project.status === 'cancelled') {
      throw new UnprocessableError(`This project is ${project.status}. Material cannot be requisitioned against it.`)
    }

    const reqNo = await nextNumber(trx, 'requisition')
    const row = await trx
      .insertInto('material_requisitions')
      .values({
        req_no: reqNo,
        project_id: input.projectId,
        project_stage_id: input.projectStageId,
        requested_by: actor.userId,
        required_by_date: input.requiredByDate,
        status: 'draft',
        remarks: input.remarks,
      })
      .executeTakeFirst()

    const requisitionId = Number(row.insertId ?? 0)

    await trx
      .insertInto('requisition_lines')
      .values(
        input.lines.map((l) => ({
          requisition_id: requisitionId,
          item_id: l.itemId,
          qty_requested: l.qtyRequested,
          remarks: l.remarks,
        }))
      )
      .execute()

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'inventory.requisition_create',
      entityType: 'material_requisition',
      entityId: requisitionId,
      after: { req_no: reqNo, project_id: input.projectId, lines: input.lines.length },
      ip: actor.ip,
    })
    return requisitionId
  })
}

/**
 * Submits a requisition for approval.
 *
 * The approvers are resolved by permission, not by role name, and the
 * requester is excluded from the notification because they already know.
 */
export async function submitRequisition(db: Db, actor: Actor, requisitionId: number): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const req = await trx
      .selectFrom('material_requisitions')
      .innerJoin('projects', 'projects.id', 'material_requisitions.project_id')
      .select([
        'material_requisitions.id',
        'material_requisitions.req_no',
        'material_requisitions.status',
        'projects.name as project_name',
      ])
      .where('material_requisitions.id', '=', requisitionId)
      .forUpdate()
      .executeTakeFirst()
    if (!req) throw new NotFoundError('Requisition not found')
    if (req.status !== 'draft') {
      throw new UnprocessableError(`This requisition is already ${req.status.replace(/_/g, ' ')}.`)
    }

    await trx
      .updateTable('material_requisitions')
      .set({ status: 'submitted' })
      .where('id', '=', requisitionId)
      .execute()

    await notifyPermission(trx, PERMISSIONS.INVENTORY_PO_CREATE, {
      actorId: actor.userId,
      kind: 'requisition_submitted',
      title: `Requisition ${req.req_no} needs approval`,
      body: `${req.project_name} has submitted a material requisition.`,
      linkPath: `/app/inventory/requisitions/${requisitionId}`,
    })

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'inventory.requisition_submit',
      entityType: 'material_requisition',
      entityId: requisitionId,
      before: { status: req.status },
      after: { status: 'submitted' },
      ip: actor.ip,
    })
  })
}

/**
 * Approves a requisition line by line.
 *
 * An approver may cut a quantity but never raise it above what was asked for:
 * approving 60 bags against a request for 50 is not an approval, it is a new
 * requisition nobody raised. Self-approval is refused, which is the point of
 * having an approval step at all.
 */
export async function approveRequisition(
  db: Db,
  actor: Actor,
  requisitionId: number,
  input: { lines: ApprovedLineInput[]; remarks: string | null }
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const req = await trx
      .selectFrom('material_requisitions')
      .select(['id', 'req_no', 'status', 'requested_by'])
      .where('id', '=', requisitionId)
      .forUpdate()
      .executeTakeFirst()
    if (!req) throw new NotFoundError('Requisition not found')
    if (req.status !== 'submitted') {
      throw new UnprocessableError(
        `Only a submitted requisition can be approved. This one is ${req.status.replace(/_/g, ' ')}.`
      )
    }
    if (req.requested_by === actor.userId) {
      throw new UnprocessableError('A requisition cannot be approved by the person who raised it.')
    }

    const existing = await trx
      .selectFrom('requisition_lines')
      .innerJoin('items', 'items.id', 'requisition_lines.item_id')
      .select(['requisition_lines.id', 'requisition_lines.qty_requested', 'items.code'])
      .where('requisition_lines.requisition_id', '=', requisitionId)
      .execute()

    const byId = new Map(existing.map((l) => [Number(l.id), l]))
    for (const line of input.lines) {
      const row = byId.get(line.lineId)
      if (!row) throw new UnprocessableError('That line is not on this requisition.')
      if (line.qtyApproved > Number(row.qty_requested)) {
        throw new UnprocessableError(
          `${row.code}: ${qty(line.qtyApproved)} cannot be approved against a request for ${qty(Number(row.qty_requested))}.`
        )
      }
      await trx
        .updateTable('requisition_lines')
        .set({ qty_approved: line.qtyApproved })
        .where('id', '=', line.lineId)
        .execute()
    }

    // Lines left untouched keep qty_approved NULL, which orderableRequisitionLines
    // reads as "not approved" rather than as zero.
    const anyApproved = input.lines.some((l) => l.qtyApproved > 0)
    if (!anyApproved) {
      throw new UnprocessableError(
        'Every line was cut to zero. Reject the requisition instead, so the reason is on the record.'
      )
    }

    await trx
      .updateTable('material_requisitions')
      .set({
        status: 'approved',
        approved_by: actor.userId,
        approved_at: nowSqlDateTime(),
        remarks: input.remarks,
      })
      .where('id', '=', requisitionId)
      .execute()

    await notify(trx, {
      userIds: [req.requested_by],
      exceptUserId: actor.userId,
      kind: 'requisition_approved',
      title: `Requisition ${req.req_no} approved`,
      linkPath: `/app/inventory/requisitions/${requisitionId}`,
    })

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'inventory.requisition_approve',
      entityType: 'material_requisition',
      entityId: requisitionId,
      before: { status: req.status },
      after: { status: 'approved', lines: input.lines },
      ip: actor.ip,
    })
  })
}

export async function rejectRequisition(
  db: Db,
  actor: Actor,
  requisitionId: number,
  reason: string
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const req = await trx
      .selectFrom('material_requisitions')
      .select(['id', 'req_no', 'status', 'requested_by'])
      .where('id', '=', requisitionId)
      .forUpdate()
      .executeTakeFirst()
    if (!req) throw new NotFoundError('Requisition not found')
    if (req.status !== 'submitted') {
      throw new UnprocessableError(
        `Only a submitted requisition can be rejected. This one is ${req.status.replace(/_/g, ' ')}.`
      )
    }

    await trx
      .updateTable('material_requisitions')
      .set({ status: 'rejected', reject_reason: reason, approved_by: actor.userId, approved_at: nowSqlDateTime() })
      .where('id', '=', requisitionId)
      .execute()

    await notify(trx, {
      userIds: [req.requested_by],
      exceptUserId: actor.userId,
      kind: 'requisition_rejected',
      title: `Requisition ${req.req_no} rejected`,
      body: reason,
      linkPath: `/app/inventory/requisitions/${requisitionId}`,
      severity: 'warn',
    })

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'inventory.requisition_reject',
      entityType: 'material_requisition',
      entityId: requisitionId,
      before: { status: req.status },
      after: { status: 'rejected', reject_reason: reason },
      ip: actor.ip,
    })
  })
}

/* Purchase orders --------------------------------------------------------- */

export interface PoInput {
  vendorId: number
  projectId: number | null
  requisitionId: number | null
  poDate: string
  expectedDelivery: string | null
  deliveryLocationId: number
  freightPaise: number
  paymentTermsDays: number | null
  advancePct: number
  terms: string | null
  lines: PoLineInput[]
}

/**
 * Line and document totals for a PO.
 *
 * purchase_orders stores one gst_paise figure and no place of supply, so the
 * CGST/SGST/IGST split is computed per line and only its total is kept. The
 * split itself belongs on the vendor's tax invoice, which is a finance
 * document (spec 6.8), not on the order.
 */
function poTotals(lines: readonly PoLineInput[], freightPaise: number) {
  let subtotal = 0
  let gst = 0
  const lineTotals: number[] = []
  for (const l of lines) {
    const taxable = Math.round(l.ratePaise * l.qtyOrdered)
    const split = splitGst(taxable, l.gstPct)
    subtotal += taxable
    gst += split.totalPaise - taxable
    lineTotals.push(taxable)
  }
  return { subtotal, gst, lineTotals, total: subtotal + gst + freightPaise }
}

export interface RateWarning {
  itemId: number
  itemCode: string
  itemName: string
  ratePaise: number
  lastRatePaise: number
  lastPurchasedOn: string
  lastVendorName: string
  variancePct: number
}

/**
 * Rate variance against the last purchase (spec 6.4 rule 7).
 *
 * Warns above ten percent and does not block. A rate can legitimately move
 * more than ten percent in a month for steel or diesel, so blocking would
 * teach buyers to enter last month's rate and adjust it on the invoice. The
 * warning names the figure it is comparing against, because "variance 14%"
 * with no baseline is not something a buyer can act on.
 */
export const RATE_VARIANCE_THRESHOLD_PCT = 10

export async function poRateWarnings(
  db: Queryable,
  lines: readonly { itemId: number; ratePaise: number }[]
): Promise<RateWarning[]> {
  const out: RateWarning[] = []
  for (const line of lines) {
    const last = await db
      .selectFrom('grn_lines')
      .innerJoin('goods_receipts', 'goods_receipts.id', 'grn_lines.grn_id')
      .innerJoin('vendors', 'vendors.id', 'goods_receipts.vendor_id')
      .innerJoin('items', 'items.id', 'grn_lines.item_id')
      .select([
        'grn_lines.rate_paise',
        'goods_receipts.received_on',
        'vendors.name as vendor_name',
        'items.code as item_code',
        'items.name as item_name',
      ])
      .where('grn_lines.item_id', '=', line.itemId)
      .where('goods_receipts.status', '=', 'posted')
      .where('grn_lines.rate_paise', '>', 0)
      .orderBy('goods_receipts.received_on', 'desc')
      .orderBy('grn_lines.id', 'desc')
      .limit(1)
      .executeTakeFirst()

    if (!last) continue
    const lastRate = Number(last.rate_paise)
    if (lastRate <= 0) continue
    const variance = ((line.ratePaise - lastRate) / lastRate) * 100
    if (Math.abs(variance) <= RATE_VARIANCE_THRESHOLD_PCT) continue

    out.push({
      itemId: line.itemId,
      itemCode: last.item_code,
      itemName: last.item_name,
      ratePaise: line.ratePaise,
      lastRatePaise: lastRate,
      lastPurchasedOn: String(last.received_on),
      lastVendorName: last.vendor_name,
      variancePct: Math.round(variance * 10) / 10,
    })
  }
  return out
}

/**
 * Creates a draft PO (spec 6.4 rule 7).
 *
 * Returns the rate warnings alongside the id rather than throwing, because
 * rule 7 is explicit that a variance surfaces in the form and does not block.
 * The caller renders them; nothing here depends on the buyer reading them.
 *
 * Totals are recomputed here from the line rates. The form computes them in
 * Alpine for feedback, and spec 6.4's component note says the server side is
 * the authority, so the client figures are not read at all.
 */
export async function createPo(
  db: Db,
  actor: Actor,
  input: PoInput
): Promise<{ poId: number; poNo: string; warnings: RateWarning[] }> {
  const warnings = await poRateWarnings(db, input.lines)

  return await db.transaction().execute(async (trx) => {
    const vendor = await trx
      .selectFrom('vendors')
      .select(['id', 'name', 'status', 'payment_terms_days'])
      .where('id', '=', input.vendorId)
      .executeTakeFirst()
    if (!vendor) throw new NotFoundError('That vendor does not exist.')
    if (vendor.status === 'blacklisted') {
      throw new UnprocessableError(
        `${vendor.name} is blacklisted. Remove the blacklist before ordering, so the decision to buy from them again is recorded as a decision.`
      )
    }
    if (vendor.status === 'on_hold') {
      throw new UnprocessableError(`${vendor.name} is on hold. Clear the hold before raising a purchase order.`)
    }

    const totals = poTotals(input.lines, input.freightPaise)
    const poNo = await nextNumber(trx, 'po')

    const inserted = await trx
      .insertInto('purchase_orders')
      .values({
        po_no: poNo,
        vendor_id: input.vendorId,
        project_id: input.projectId,
        requisition_id: input.requisitionId,
        po_date: input.poDate,
        expected_delivery: input.expectedDelivery,
        delivery_location_id: input.deliveryLocationId,
        subtotal_paise: totals.subtotal,
        gst_paise: totals.gst,
        freight_paise: input.freightPaise,
        total_paise: totals.total,
        // Falls back to the vendor's own terms rather than a hardcoded 30, so
        // the MSME 45-day ceiling that vendors.payment_terms_days already
        // carries is not quietly overwritten by a default on this form.
        payment_terms_days: input.paymentTermsDays ?? Number(vendor.payment_terms_days),
        advance_pct: input.advancePct,
        status: 'draft',
        terms: input.terms,
        created_by: actor.userId,
      })
      .executeTakeFirst()

    const poId = Number(inserted.insertId ?? 0)

    await trx
      .insertInto('po_lines')
      .values(
        input.lines.map((l, i) => ({
          po_id: poId,
          item_id: l.itemId,
          brand: l.brand,
          qty_ordered: l.qtyOrdered,
          rate_paise: l.ratePaise,
          gst_pct: l.gstPct,
          qty_received: 0,
          line_total_paise: totals.lineTotals[i]!,
          cost_head_id: l.costHeadId,
          remarks: l.remarks,
        }))
      )
      .execute()

    if (input.requisitionId !== null) {
      await linkRequisitionOrdered(trx, input.requisitionId)
    }

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'inventory.po_create',
      entityType: 'purchase_order',
      entityId: poId,
      after: {
        po_no: poNo,
        vendor_id: input.vendorId,
        project_id: input.projectId,
        total_paise: totals.total,
        line_count: input.lines.length,
        rate_warning_count: warnings.length,
      },
      ip: actor.ip,
    })

    return { poId, poNo, warnings }
  })
}

/**
 * Moves a requisition's status along as its lines get ordered.
 *
 * qty_ordered is summed from po_lines rather than incremented in place, so a
 * short-closed or cancelled PO releasing its claim does not need a
 * compensating decrement. The requisition's status is derived, not accumulated.
 */
async function linkRequisitionOrdered(trx: Trx, requisitionId: number): Promise<void> {
  const lines = await trx
    .selectFrom('requisition_lines')
    .select(['id', 'item_id', 'qty_requested', 'qty_approved'])
    .where('requisition_id', '=', requisitionId)
    .execute()
  if (lines.length === 0) return

  const ordered = await trx
    .selectFrom('po_lines')
    .innerJoin('purchase_orders', 'purchase_orders.id', 'po_lines.po_id')
    .select(['po_lines.item_id', trx.fn.sum('po_lines.qty_ordered').as('qty')])
    .where('purchase_orders.requisition_id', '=', requisitionId)
    .where('purchase_orders.status', 'not in', ['cancelled', 'short_closed'])
    .groupBy('po_lines.item_id')
    .execute()

  const orderedByItem = new Map<number, number>()
  for (const o of ordered) orderedByItem.set(Number(o.item_id), Number(o.qty))

  let anyOrdered = false
  let allOrdered = true
  for (const l of lines) {
    const want = Number(l.qty_approved ?? l.qty_requested)
    const got = orderedByItem.get(Number(l.item_id)) ?? 0
    await trx.updateTable('requisition_lines').set({ qty_ordered: got }).where('id', '=', l.id).execute()
    if (got > 0) anyOrdered = true
    if (got + 0.0005 < want) allOrdered = false
  }

  await trx
    .updateTable('material_requisitions')
    .set({ status: allOrdered ? 'ordered' : anyOrdered ? 'partially_ordered' : 'approved' })
    .where('id', '=', requisitionId)
    .execute()
}

/** Draft to pending_approval. Refuses an empty PO, which a draft can be. */
export async function submitPo(db: Db, actor: Actor, poId: number): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const po = await trx
      .selectFrom('purchase_orders')
      .select(['id', 'po_no', 'status', 'total_paise'])
      .where('id', '=', poId)
      .forUpdate()
      .executeTakeFirst()
    if (!po) throw new NotFoundError('That purchase order does not exist.')
    if (po.status !== 'draft') {
      throw new ConflictError(`This purchase order is already ${po.status.replace(/_/g, ' ')}. Only a draft can be submitted.`)
    }

    const lineCount = await trx
      .selectFrom('po_lines')
      .select(trx.fn.countAll().as('n'))
      .where('po_id', '=', poId)
      .executeTakeFirstOrThrow()
    if (Number(lineCount.n) === 0) {
      throw new UnprocessableError('A purchase order needs at least one line before it can be submitted.')
    }

    await trx.updateTable('purchase_orders').set({ status: 'pending_approval' }).where('id', '=', poId).execute()

    await notifyPermission(trx, PERMISSIONS.INVENTORY_APPROVE_PO, {
      actorId: actor.userId,
      kind: 'po_pending_approval',
      title: `Purchase order ${po.po_no} needs approval`,
      body: `${formatPaise(Number(po.total_paise))} to approve.`,
      linkPath: `/app/inventory/po/${poId}`,
      severity: 'info',
    })

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'inventory.po_submit',
      entityType: 'purchase_order',
      entityId: poId,
      before: { status: 'draft' },
      after: { status: 'pending_approval' },
      ip: actor.ip,
    })
  })
}

export interface PoApprovalResult {
  status: 'approved' | 'awaiting_second_approval'
  poNo: string
  totalPaise: number
}

/**
 * Approves a PO against approval_limits (spec 6.4 routes: "approve_po + limit.
 * Self-approval blocked. Above the approval_limits value escalates").
 *
 * Three refusals, in this order:
 *
 *   1. Self-approval. The creator cannot approve, whatever they hold. Spec 4.2
 *      says the owner cannot self-approve expenses, and a PO is the same act
 *      with a different table, so there is no owner exemption here either.
 *   2. No limit row at all. resolveApprovalLimit returning null means "cannot
 *      approve any amount", never "unlimited" (see its doc comment). Since
 *      approval_limits is seeded empty pending open question 8.2, this is the
 *      live behaviour today, and the message says so rather than implying the
 *      user lacks a permission they do in fact hold.
 *   3. Above the ceiling. Escalates, naming the figure and the ceiling.
 *
 * Above requires_second_approval_above the first approval is recorded and the
 * status stays pending_approval, because a PO that reads "approved" with one
 * of two required signatures is the failure the second signature exists to
 * prevent.
 */
export async function approvePo(db: Db, actor: Actor, poId: number, roleKeys: readonly string[]): Promise<PoApprovalResult> {
  return await db.transaction().execute(async (trx) => {
    const po = await trx
      .selectFrom('purchase_orders')
      .select([
        'id', 'po_no', 'status', 'total_paise', 'created_by', 'vendor_id',
        'approved_by', 'second_approved_by',
      ])
      .where('id', '=', poId)
      .forUpdate()
      .executeTakeFirst()
    if (!po) throw new NotFoundError('That purchase order does not exist.')
    if (po.status !== 'pending_approval') {
      throw new ConflictError(
        `This purchase order is ${po.status.replace(/_/g, ' ')}. Only one awaiting approval can be approved.`
      )
    }
    if (Number(po.created_by) === actor.userId) {
      throw new UnprocessableError(
        'You raised this purchase order, so you cannot approve it. Someone else holding the approval permission has to.'
      )
    }
    if (po.approved_by !== null && Number(po.approved_by) === actor.userId) {
      throw new UnprocessableError('You have already approved this purchase order. The second approval has to come from someone else.')
    }

    const total = Number(po.total_paise)
    const limit = await resolveApprovalLimit(trx, roleKeys, 'purchase_order', today())
    if (limit === null) {
      throw new UnprocessableError(
        `No purchase order approval limit is set for your role, so no amount can be approved yet. An administrator sets these under Roles and approval limits.`
      )
    }
    if (total > limit.maxValue) {
      throw new UnprocessableError(
        `${formatPaise(total)} is above your approval limit of ${formatPaise(limit.maxValue)}. This needs someone with a higher limit.`
      )
    }

    const needsSecond =
      limit.requiresSecondApprovalAbove !== null && total > limit.requiresSecondApprovalAbove
    const isFirst = po.approved_by === null

    if (needsSecond && isFirst) {
      await trx
        .updateTable('purchase_orders')
        .set({ approved_by: actor.userId, approved_at: nowSqlDateTime() })
        .where('id', '=', poId)
        .execute()

      await notifyPermission(trx, PERMISSIONS.INVENTORY_APPROVE_PO, {
        actorId: actor.userId,
        kind: 'po_second_approval',
        title: `Purchase order ${po.po_no} needs a second approval`,
        body: `${formatPaise(total)} is above the ${formatPaise(limit.requiresSecondApprovalAbove!)} single-approval threshold.`,
        linkPath: `/app/inventory/po/${poId}`,
        severity: 'warn',
      })

      await writeAudit(trx, {
        userId: actor.userId,
        action: 'inventory.po_approve_first',
        entityType: 'purchase_order',
        entityId: poId,
        before: { status: 'pending_approval', approved_by: null },
        after: {
          status: 'pending_approval',
          approved_by: actor.userId,
          total_paise: total,
          limit_role_key: limit.roleKey,
          requires_second_above: limit.requiresSecondApprovalAbove,
        },
        ip: actor.ip,
      })

      return { status: 'awaiting_second_approval' as const, poNo: po.po_no, totalPaise: total }
    }

    await trx
      .updateTable('purchase_orders')
      .set(
        isFirst
          ? { status: 'approved', approved_by: actor.userId, approved_at: nowSqlDateTime() }
          : { status: 'approved', second_approved_by: actor.userId, second_approved_at: nowSqlDateTime() }
      )
      .where('id', '=', poId)
      .execute()

    await notify(trx, {
      userIds: [Number(po.created_by)],
      exceptUserId: actor.userId,
      kind: 'po_approved',
      title: `Purchase order ${po.po_no} approved`,
      body: `${formatPaise(total)} approved. You can send it to the vendor.`,
      linkPath: `/app/inventory/po/${poId}`,
      severity: 'info',
    })

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'inventory.po_approve',
      entityType: 'purchase_order',
      entityId: poId,
      before: { status: 'pending_approval' },
      after: {
        status: 'approved',
        total_paise: total,
        limit_role_key: limit.roleKey,
        limit_max_value: limit.maxValue,
        second_approval: !isFirst,
      },
      ip: actor.ip,
    })

    return { status: 'approved' as const, poNo: po.po_no, totalPaise: total }
  })
}

/**
 * Short-closes a PO (spec 6.4 routes: "Reason mandatory").
 *
 * Short close is the honest end for an order the vendor will not complete: it
 * keeps what was received and stops expecting the rest. Cancelling instead
 * would imply nothing arrived, and a PO with GRNs against it cannot be
 * truthfully cancelled, so that case is refused with the received figure named.
 */
export async function shortClosePo(db: Db, actor: Actor, poId: number, reason: string): Promise<void> {
  const trimmed = reason.trim()
  if (trimmed.length === 0) {
    throw new UnprocessableError('Give a reason for short-closing. It is the only record of why the balance was abandoned.')
  }

  await db.transaction().execute(async (trx) => {
    const po = await trx
      .selectFrom('purchase_orders')
      .select(['id', 'po_no', 'status', 'created_by'])
      .where('id', '=', poId)
      .forUpdate()
      .executeTakeFirst()
    if (!po) throw new NotFoundError('That purchase order does not exist.')
    if (po.status === 'short_closed') throw new ConflictError('This purchase order is already short-closed.')
    if (po.status === 'cancelled') throw new ConflictError('This purchase order is cancelled.')
    if (po.status === 'received') {
      throw new UnprocessableError('This purchase order is fully received. There is no balance to short-close.')
    }
    if (po.status === 'draft' || po.status === 'pending_approval') {
      throw new UnprocessableError(
        `A ${po.status.replace(/_/g, ' ')} purchase order has nothing outstanding against it. Cancel it instead.`
      )
    }

    const balance = await trx
      .selectFrom('po_lines')
      .select([
        trx.fn.sum(sql<number>`qty_ordered - qty_received`).as('outstanding'),
      ])
      .where('po_id', '=', poId)
      .executeTakeFirstOrThrow()

    await trx
      .updateTable('purchase_orders')
      .set({ status: 'short_closed', short_close_reason: trimmed })
      .where('id', '=', poId)
      .execute()

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'inventory.po_short_close',
      entityType: 'purchase_order',
      entityId: poId,
      before: { status: po.status },
      after: {
        status: 'short_closed',
        short_close_reason: trimmed,
        qty_abandoned: round3(Number(balance.outstanding ?? 0)),
      },
      ip: actor.ip,
    })
  })
}

/* Goods receipts ---------------------------------------------------------- */

export interface GrnInput {
  poId: number | null
  vendorId: number
  locationId: number
  projectId: number | null
  receivedOn: string
  vehicleNo: string | null
  invoiceNo: string | null
  invoiceDate: string | null
  invoiceAmountPaise: number | null
  weighbridgeSlipNo: string | null
  gateEntryNo: string | null
  inspectedBy: number | null
  lines: GrnLineInput[]
}

/**
 * Creates a GRN in draft. Nothing touches stock here.
 *
 * A receipt is entered at the gate, often on a phone, against a lorry that is
 * waiting. Posting is the separate act that moves stock, so a half-entered
 * receipt is a draft rather than a stock error.
 */
export async function createGrn(db: Db, actor: Actor, input: GrnInput): Promise<{ grnId: number; grnNo: string }> {
  return await db.transaction().execute(async (trx) => {
    if (input.poId !== null) {
      const po = await trx
        .selectFrom('purchase_orders')
        .select(['id', 'po_no', 'status', 'vendor_id'])
        .where('id', '=', input.poId)
        .executeTakeFirst()
      if (!po) throw new NotFoundError('That purchase order does not exist.')
      if (Number(po.vendor_id) !== input.vendorId) {
        throw new UnprocessableError(
          `Purchase order ${po.po_no} is on a different vendor. Receive against the vendor who was ordered from, or record this as a direct receipt with no purchase order.`
        )
      }
      if (po.status === 'draft' || po.status === 'pending_approval') {
        throw new UnprocessableError(
          `Purchase order ${po.po_no} is not approved yet. Material received against an unapproved order is a direct receipt; either approve the order or leave the order field empty.`
        )
      }
      if (po.status === 'cancelled') {
        throw new UnprocessableError(`Purchase order ${po.po_no} is cancelled.`)
      }
    }

    const grnNo = await nextNumber(trx, 'grn')

    const inserted = await trx
      .insertInto('goods_receipts')
      .values({
        grn_no: grnNo,
        po_id: input.poId,
        vendor_id: input.vendorId,
        location_id: input.locationId,
        project_id: input.projectId,
        received_on: input.receivedOn,
        vehicle_no: input.vehicleNo,
        invoice_no: input.invoiceNo,
        invoice_date: input.invoiceDate,
        invoice_amount_paise: input.invoiceAmountPaise,
        weighbridge_slip_no: input.weighbridgeSlipNo,
        gate_entry_no: input.gateEntryNo,
        status: 'draft',
        received_by: actor.userId,
        inspected_by: input.inspectedBy,
      })
      .executeTakeFirst()

    const grnId = Number(inserted.insertId ?? 0)

    await trx
      .insertInto('grn_lines')
      .values(
        input.lines.map((l) => ({
          grn_id: grnId,
          po_line_id: l.poLineId,
          item_id: l.itemId,
          brand: l.brand,
          qty_challan: l.qtyChallan,
          qty_received: l.qtyReceived,
          qty_accepted: l.qtyAccepted,
          qty_rejected: l.qtyRejected,
          rejection_reason: l.rejectionReason,
          batch_no: l.batchNo,
          manufacture_date: l.manufactureDate,
          expiry_date: l.expiryDate,
          rate_paise: l.ratePaise,
        }))
      )
      .execute()

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'inventory.grn_create',
      entityType: 'goods_receipt',
      entityId: grnId,
      after: {
        grn_no: grnNo,
        po_id: input.poId,
        vendor_id: input.vendorId,
        location_id: input.locationId,
        line_count: input.lines.length,
        status: 'draft',
      },
      ip: actor.ip,
    })

    return { grnId, grnNo }
  })
}

export interface GrnPostResult {
  grnNo: string
  ledgerIds: number[]
  /** Lines where the challan and the counted quantity disagree (rule 3). */
  shortages: { itemCode: string; itemName: string; qtyChallan: number; qtyReceived: number; unit: string }[]
  /** Lines posted on an unapproved brand (rule 6). */
  brandExceptions: { itemCode: string; itemName: string; brand: string }[]
  poStatus: string | null
}

/**
 * Posts a GRN: the irreversible step (spec 6.4 routes, "Irreversible, only
 * cancellable by a reversing entry").
 *
 * Two gates before any stock moves, both from spec 6.4:
 *
 *   Rule 3, three-way match. When qty_challan and qty_received disagree the
 *   GRN cannot post until rejection_reason is filled, and posting notifies
 *   procurement and accounts so the vendor's invoice is queried before it is
 *   paid rather than after. Sand arrives short as a matter of routine; the
 *   point of three numbers is that the shortage survives into the record.
 *
 *   Rule 6, brand substitution. A line whose brand is not an approved brand
 *   for the item needs inventory.approve_po to post, and writes an audit entry
 *   plus a notification to the owner. The packages page names brands publicly,
 *   so a substitution is a commitment being broken and has to be a decision
 *   someone made, not a row that appeared.
 *
 * `canApproveBrand` is passed in rather than read here: the route already has
 * the permission set on c.var.perms, and a service reaching back for
 * permissions is how a permission check ends up in two places that disagree.
 */
export async function postGrn(
  db: Db,
  actor: Actor,
  grnId: number,
  canApproveBrand: boolean
): Promise<GrnPostResult> {
  return await db.transaction().execute(async (trx) => {
    const grn = await trx
      .selectFrom('goods_receipts')
      .select(['id', 'grn_no', 'status', 'po_id', 'vendor_id', 'location_id', 'project_id', 'received_on', 'invoice_no'])
      .where('id', '=', grnId)
      .forUpdate()
      .executeTakeFirst()
    if (!grn) throw new NotFoundError('That goods receipt does not exist.')
    if (grn.status === 'posted') throw new ConflictError('This goods receipt is already posted. Post a reversing adjustment to correct it.')
    if (grn.status === 'cancelled') throw new ConflictError('This goods receipt is cancelled.')

    const lines = await trx
      .selectFrom('grn_lines')
      .innerJoin('items', 'items.id', 'grn_lines.item_id')
      .innerJoin('units', 'units.id', 'items.unit_id')
      .select([
        'grn_lines.id as line_id',
        'grn_lines.po_line_id',
        'grn_lines.item_id',
        'grn_lines.brand',
        'grn_lines.qty_challan',
        'grn_lines.qty_received',
        'grn_lines.qty_accepted',
        'grn_lines.rejection_reason',
        'grn_lines.batch_no',
        'grn_lines.expiry_date',
        'grn_lines.rate_paise',
        'items.code as item_code',
        'items.name as item_name',
        'units.code as unit',
      ])
      .where('grn_lines.grn_id', '=', grnId)
      .orderBy('grn_lines.id')
      .execute()

    if (lines.length === 0) {
      throw new UnprocessableError('This goods receipt has no lines. There is nothing to post.')
    }

    // Rule 3. Every mismatch is collected before throwing, so a storekeeper
    // with four short lines is told about four, not told about one four times.
    const unexplained: string[] = []
    const shortages: GrnPostResult['shortages'] = []
    for (const l of lines) {
      const challan = Number(l.qty_challan)
      const received = Number(l.qty_received)
      if (Math.abs(challan - received) < 0.0005) continue
      shortages.push({
        itemCode: l.item_code,
        itemName: l.item_name,
        qtyChallan: challan,
        qtyReceived: received,
        unit: l.unit,
      })
      if ((l.rejection_reason ?? '').trim().length === 0) {
        unexplained.push(
          `${l.item_code} ${l.item_name}: challan says ${qty(challan)} ${l.unit}, counted ${qty(received)} ${l.unit}`
        )
      }
    }
    if (unexplained.length > 0) {
      throw new UnprocessableError(
        `Fill in a reason on every line where the challan and the counted quantity disagree, then post. Without it the shortage cannot be claimed from the vendor.\n\n${unexplained.join('\n')}`
      )
    }

    // Rule 6. A brand is checked against item_brands for that item. A line
    // with no brand recorded is not a substitution: the item master itself
    // carries the brand in that case and there is nothing to compare.
    const brandExceptions: GrnPostResult['brandExceptions'] = []
    for (const l of lines) {
      const brand = (l.brand ?? '').trim()
      if (brand.length === 0) continue
      const approved = await trx
        .selectFrom('item_brands')
        .select('id')
        .where('item_id', '=', Number(l.item_id))
        .where('brand', '=', brand)
        .where('is_approved', '=', 1)
        .executeTakeFirst()
      if (approved) continue
      brandExceptions.push({ itemCode: l.item_code, itemName: l.item_name, brand })
    }

    if (brandExceptions.length > 0 && !canApproveBrand) {
      throw new UnprocessableError(
        `These lines are on brands that are not approved for the item, so posting needs purchase approval rights. The packages page names the approved brands to clients, so a substitution has to be approved by someone who can carry that decision.\n\n${brandExceptions
          .map((b) => `${b.itemCode} ${b.itemName}: ${b.brand}`)
          .join('\n')}`
      )
    }

    const ledgerIds: number[] = []
    for (const l of lines) {
      const accepted = Number(l.qty_accepted)
      if (accepted <= 0) continue
      const result = await postStockMovement(trx, actor, {
        itemId: Number(l.item_id),
        locationId: Number(grn.location_id),
        txnDate: String(grn.received_on),
        txnType: 'grn',
        refTable: 'goods_receipts',
        refId: grnId,
        qtyIn: accepted,
        qtyOut: 0,
        ratePaise: Number(l.rate_paise),
        projectId: grn.project_id === null ? null : Number(grn.project_id),
        batchNo: l.batch_no,
      })
      ledgerIds.push(result.ledgerId)
    }

    // po_lines.qty_received is the accepted quantity, not the received one.
    // Rejected material is physically on site awaiting return but is not
    // stock and does not discharge the order, so the balance stays open.
    let poStatus: string | null = null
    if (grn.po_id !== null) {
      const poId = Number(grn.po_id)
      for (const l of lines) {
        if (l.po_line_id === null) continue
        const posted = await trx
          .selectFrom('grn_lines')
          .innerJoin('goods_receipts', 'goods_receipts.id', 'grn_lines.grn_id')
          .select(trx.fn.sum('grn_lines.qty_accepted').as('qty'))
          .where('grn_lines.po_line_id', '=', Number(l.po_line_id))
          .where((eb) =>
            eb.or([eb('goods_receipts.status', '=', 'posted'), eb('goods_receipts.id', '=', grnId)])
          )
          .executeTakeFirstOrThrow()
        await trx
          .updateTable('po_lines')
          .set({ qty_received: round3(Number(posted.qty ?? 0)) })
          .where('id', '=', Number(l.po_line_id))
          .execute()
      }

      const balance = await trx
        .selectFrom('po_lines')
        .select([
          trx.fn.sum(sql<number>`GREATEST(qty_ordered - qty_received, 0)`).as('outstanding'),
          trx.fn.sum('qty_received').as('received'),
        ])
        .where('po_id', '=', poId)
        .executeTakeFirstOrThrow()

      const outstanding = Number(balance.outstanding ?? 0)
      const received = Number(balance.received ?? 0)
      poStatus = outstanding < 0.0005 ? 'received' : received > 0 ? 'partially_received' : 'approved'
      await trx
        .updateTable('purchase_orders')
        .set({ status: poStatus as 'received' | 'partially_received' | 'approved' })
        .where('id', '=', poId)
        // A short-closed or cancelled order is not dragged back open by a late
        // receipt against it; the short close was a decision.
        .where('status', 'in', ['approved', 'partially_received', 'received'])
        .execute()
    }

    await trx
      .updateTable('goods_receipts')
      .set({ status: 'posted', posted_at: nowSqlDateTime() })
      .where('id', '=', grnId)
      .execute()

    const vendor = await trx
      .selectFrom('vendors')
      .select('name')
      .where('id', '=', Number(grn.vendor_id))
      .executeTakeFirst()
    const vendorName = vendor?.name ?? 'the vendor'

    // Rule 3's second half. Procurement and accounts both need this before the
    // invoice is paid, and they are resolved by permission rather than role
    // name because 8.1 may yet rename the roles.
    if (shortages.length > 0) {
      const body =
        `${shortages
          .map((s) => `${s.itemCode} ${s.itemName}: challan ${qty(s.qtyChallan)} ${s.unit}, counted ${qty(s.qtyReceived)} ${s.unit}`)
          .join('; ')}. ` +
        (grn.invoice_no ? `Vendor invoice ${grn.invoice_no}. ` : '') +
        'Query this before the invoice is paid.'

      for (const key of [PERMISSIONS.INVENTORY_PO_CREATE, PERMISSIONS.FINANCE_PAYMENT_RECORD]) {
        await notifyPermission(trx, key, {
          actorId: actor.userId,
          kind: 'grn_quantity_shortfall',
          title: `${grn.grn_no}: short delivery from ${vendorName}`,
          body,
          linkPath: `/app/inventory/grn/${grnId}`,
          severity: 'warn',
        })
      }
    }

    // Rule 6's second half: the owner is told, by permission not by role.
    if (brandExceptions.length > 0) {
      await notifyPermission(trx, PERMISSIONS.PROJECTS_VIEW_COST, {
        actorId: actor.userId,
        kind: 'grn_unapproved_brand',
        title: `${grn.grn_no}: unapproved brand accepted`,
        body: `${brandExceptions.map((b) => `${b.itemName} supplied as ${b.brand}`).join('; ')}, from ${vendorName}. Approved by ${actor.userId}.`,
        linkPath: `/app/inventory/grn/${grnId}`,
        severity: 'critical',
      })

      await writeAudit(trx, {
        userId: actor.userId,
        action: 'inventory.grn_brand_substitution',
        entityType: 'goods_receipt',
        entityId: grnId,
        after: {
          grn_no: grn.grn_no,
          vendor_id: Number(grn.vendor_id),
          substitutions: brandExceptions.map((b) => ({ item_code: b.itemCode, brand: b.brand })),
        },
        ip: actor.ip,
      })
    }

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'inventory.grn_post',
      entityType: 'goods_receipt',
      entityId: grnId,
      before: { status: grn.status },
      after: {
        status: 'posted',
        po_id: grn.po_id === null ? null : Number(grn.po_id),
        po_status: poStatus,
        location_id: Number(grn.location_id),
        ledger_row_count: ledgerIds.length,
        shortage_line_count: shortages.length,
        unapproved_brand_line_count: brandExceptions.length,
      },
      ip: actor.ip,
    })

    return { grnNo: grn.grn_no, ledgerIds, shortages, brandExceptions, poStatus }
  })
}

/* Material issues --------------------------------------------------------- */

export interface IssueInput {
  locationId: number
  projectId: number
  projectStageId: number | null
  issuedOn: string
  issuedToType: 'own_labour' | 'labour_contractor' | 'subcontractor'
  labourContractorId: number | null
  receivedByName: string | null
  purpose: string | null
  lines: IssueLineInput[]
}

export interface BatchPick {
  batchNo: string | null
  qty: number
  expiryDate: string | null
  isExpired: boolean
}

/**
 * Allocates an issue quantity across batches, oldest expiry first (spec 6.4
 * rule 8).
 *
 * Expired batches are used last, not skipped. Skipping them would leave
 * expired cement sitting in the ledger forever with no way to consume it, and
 * the store's actual choice — use it, scrap it via an adjustment, or return it
 * — belongs to a person. What this does is refuse to reach for an expired
 * batch while a good one is available, and report what it took so the caller
 * can warn.
 *
 * An item the store holds without any batch number (tracking_mode 'quantity')
 * comes back as a single null-batch pick, which is the same shape so the
 * caller has one code path.
 */
export function allocateBatches(available: readonly BatchPick[], wanted: number): BatchPick[] {
  const good = available.filter((b) => !b.isExpired && b.qty > 0)
  const expired = available.filter((b) => b.isExpired && b.qty > 0)
  const order = [...good, ...expired]

  const picks: BatchPick[] = []
  let left = round3(wanted)
  for (const b of order) {
    if (left <= 0) break
    const take = Math.min(b.qty, left)
    if (take <= 0) continue
    picks.push({ ...b, qty: round3(take) })
    left = round3(left - take)
  }
  // Any unallocated remainder is left to postStockMovement to refuse against
  // the real balance, so the shortfall message is computed in one place.
  if (left > 0) picks.push({ batchNo: null, qty: left, expiryDate: null, isExpired: false })
  return picks
}

export interface IssueResult {
  issueId: number
  issueNo: string
  /** Batches taken past their expiry date, for the caller's warning banner. */
  expiredPicks: { itemCode: string; itemName: string; batchNo: string; expiryDate: string; qty: number }[]
}

/**
 * Issues material to a project. Posts stock immediately: unlike a GRN there is
 * no draft, because material physically leaves the store as the slip is
 * written and a draft issue is stock that is gone from the yard and still on
 * the books.
 *
 * Rule 2 is enforced by postStockMovement, which holds the row lock and knows
 * the real balance, so nothing here pre-checks quantity. Rule 8 chooses the
 * batch: a line naming a batch takes that batch, a line naming none is
 * allocated oldest-expiry-first and the caller is told about anything expired.
 */
export async function createIssue(db: Db, actor: Actor, input: IssueInput): Promise<IssueResult> {
  return await db.transaction().execute(async (trx) => {
    const project = await trx
      .selectFrom('projects')
      .select(['id', 'name', 'status'])
      .where('id', '=', input.projectId)
      .executeTakeFirst()
    if (!project) throw new NotFoundError('That project does not exist.')
    if (project.status === 'closed' || project.status === 'cancelled') {
      throw new UnprocessableError(`${project.name} is ${project.status}. Material cannot be issued to it.`)
    }

    const issueNo = await nextNumber(trx, 'issue')

    const inserted = await trx
      .insertInto('material_issues')
      .values({
        issue_no: issueNo,
        location_id: input.locationId,
        project_id: input.projectId,
        project_stage_id: input.projectStageId,
        issued_on: input.issuedOn,
        issued_to_type: input.issuedToType,
        labour_contractor_id: input.labourContractorId,
        received_by_name: input.receivedByName,
        purpose: input.purpose,
        status: 'posted',
        issued_by: actor.userId,
      })
      .executeTakeFirst()

    const issueId = Number(inserted.insertId ?? 0)
    const expiredPicks: IssueResult['expiredPicks'] = []

    for (const line of input.lines) {
      const item = await trx
        .selectFrom('items')
        .innerJoin('units', 'units.id', 'items.unit_id')
        .select(['items.code', 'items.name', 'items.is_batch_tracked', 'items.is_active', 'units.code as unit'])
        .where('items.id', '=', line.itemId)
        .executeTakeFirst()
      if (!item) throw new NotFoundError('One of the items on this issue does not exist.')
      if (item.is_active === 0) {
        throw new UnprocessableError(`${item.code} ${item.name} is inactive. Reactivate it in the item master before issuing it.`)
      }

      let picks: BatchPick[]
      if (line.batchNo !== null) {
        picks = [{ batchNo: line.batchNo, qty: line.qtyIssued, expiryDate: null, isExpired: false }]
      } else if (item.is_batch_tracked === 0) {
        picks = [{ batchNo: null, qty: line.qtyIssued, expiryDate: null, isExpired: false }]
      } else {
        const balances = await batchBalances(trx, line.itemId, input.locationId)
        picks = allocateBatches(
          balances.map((b) => ({
            batchNo: b.batchNo,
            qty: b.qty,
            expiryDate: b.expiryDate,
            isExpired: b.expiryDate !== null && b.expiryDate < input.issuedOn,
          })),
          line.qtyIssued
        )
      }

      for (const pick of picks) {
        await postStockMovement(trx, actor, {
          itemId: line.itemId,
          locationId: input.locationId,
          txnDate: input.issuedOn,
          txnType: 'issue',
          refTable: 'material_issues',
          refId: issueId,
          qtyIn: 0,
          qtyOut: pick.qty,
          ratePaise: null,
          projectId: input.projectId,
          batchNo: pick.batchNo,
        })

        if (pick.isExpired && pick.batchNo !== null && pick.expiryDate !== null) {
          expiredPicks.push({
            itemCode: item.code,
            itemName: item.name,
            batchNo: pick.batchNo,
            expiryDate: pick.expiryDate,
            qty: pick.qty,
          })
        }
      }

      // rate_paise on the line is the weighted average the store actually held,
      // read back from the ledger rows this issue just wrote rather than from
      // the caller, so the cost that lands on the project matches the cost that
      // left the store.
      const issuedValue = await trx
        .selectFrom('stock_ledger')
        .select([
          trx.fn.sum(sql<number>`qty_out`).as('qty'),
          trx.fn.sum(sql<number>`value_paise`).as('value'),
        ])
        .where('ref_table', '=', 'material_issues')
        .where('ref_id', '=', issueId)
        .where('item_id', '=', line.itemId)
        .executeTakeFirstOrThrow()

      const issuedQty = Number(issuedValue.qty ?? 0)
      await trx
        .insertInto('issue_lines')
        .values({
          issue_id: issueId,
          item_id: line.itemId,
          qty_issued: line.qtyIssued,
          qty_returned: 0,
          rate_paise: issuedQty > 0 ? Math.round(Number(issuedValue.value ?? 0) / issuedQty) : null,
          cost_head_id: line.costHeadId,
          batch_no: picks.length === 1 ? picks[0]!.batchNo : null,
        })
        .execute()
    }

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'inventory.issue',
      entityType: 'material_issue',
      entityId: issueId,
      after: {
        issue_no: issueNo,
        location_id: input.locationId,
        project_id: input.projectId,
        line_count: input.lines.length,
        expired_batch_line_count: expiredPicks.length,
      },
      ip: actor.ip,
    })

    return { issueId, issueNo, expiredPicks }
  })
}

/**
 * Returns unused material from a project to the store it came from.
 *
 * The return goes back at the rate it left at, which postStockMovement handles
 * by taking rate_paise null on an in-movement as "use the store's weighted
 * average". That is deliberately not the issue's own rate: material returned a
 * month later re-enters a store whose average has moved, and forcing the old
 * rate back in would make item_stock.value_paise disagree with a ledger replay.
 */
export async function returnIssue(
  db: Db,
  actor: Actor,
  issueId: number,
  returnedOn: string,
  lines: readonly ReturnLineInput[]
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const issue = await trx
      .selectFrom('material_issues')
      .select(['id', 'issue_no', 'status', 'location_id', 'project_id'])
      .where('id', '=', issueId)
      .forUpdate()
      .executeTakeFirst()
    if (!issue) throw new NotFoundError('That issue does not exist.')
    if (issue.status === 'cancelled') throw new ConflictError('That issue is cancelled.')

    for (const line of lines) {
      const il = await trx
        .selectFrom('issue_lines')
        .innerJoin('items', 'items.id', 'issue_lines.item_id')
        .innerJoin('units', 'units.id', 'items.unit_id')
        .select([
          'issue_lines.id',
          'issue_lines.item_id',
          'issue_lines.qty_issued',
          'issue_lines.qty_returned',
          'issue_lines.batch_no',
          'items.code as item_code',
          'items.name as item_name',
          'units.code as unit',
        ])
        .where('issue_lines.id', '=', line.issueLineId)
        .where('issue_lines.issue_id', '=', issueId)
        .forUpdate()
        .executeTakeFirst()
      if (!il) throw new NotFoundError('One of the lines being returned is not on that issue.')

      const alreadyBack = Number(il.qty_returned)
      const outstanding = round3(Number(il.qty_issued) - alreadyBack)
      if (line.qtyReturned > outstanding + 0.0005) {
        throw new UnprocessableError(
          `${il.item_code} ${il.item_name}: ${qty(line.qtyReturned)} ${il.unit} cannot come back when only ${qty(outstanding)} ${il.unit} is still out` +
            (alreadyBack > 0 ? ` (${qty(alreadyBack)} ${il.unit} was returned earlier).` : '.')
        )
      }

      await postStockMovement(trx, actor, {
        itemId: Number(il.item_id),
        locationId: Number(issue.location_id),
        txnDate: returnedOn,
        txnType: 'return',
        refTable: 'material_issues',
        refId: issueId,
        qtyIn: line.qtyReturned,
        qtyOut: 0,
        ratePaise: null,
        projectId: Number(issue.project_id),
        batchNo: il.batch_no,
      })

      await trx
        .updateTable('issue_lines')
        .set({ qty_returned: round3(alreadyBack + line.qtyReturned) })
        .where('id', '=', line.issueLineId)
        .execute()
    }

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'inventory.issue_return',
      entityType: 'material_issue',
      entityId: issueId,
      after: {
        issue_no: issue.issue_no,
        returned_on: returnedOn,
        location_id: Number(issue.location_id),
        line_count: lines.length,
        qty_total: round3(lines.reduce((s, l) => s + l.qtyReturned, 0)),
      },
      ip: actor.ip,
    })
  })
}

/* Transfers --------------------------------------------------------------- */

export interface TransferInput {
  fromLocationId: number
  toLocationId: number
  dispatchedOn: string
  vehicleNo: string | null
  lines: TransferLineInput[]
}

/**
 * The single transit location (spec 6.4 rule 5).
 *
 * One shared row, not one per transfer. Every ledger entry carries
 * ref_table/ref_id, so the balance held for a given transfer is derivable from
 * the ledger, and a location per transfer would make the locations table grow
 * without bound while telling nobody anything the ledger does not already say.
 */
async function ensureTransitLocation(trx: Trx): Promise<number> {
  const existing = await trx
    .selectFrom('locations')
    .select('id')
    .where('location_type', '=', 'transit')
    .orderBy('id')
    .executeTakeFirst()
  if (existing) return existing.id

  const row = await trx
    .insertInto('locations')
    .values({
      code: 'TRANSIT',
      name: 'In transit between stores',
      location_type: 'transit',
      project_id: null,
      city: '',
      is_active: 1,
    })
    .executeTakeFirst()
  return Number(row.insertId ?? 0)
}

/**
 * Dispatches a transfer: source -> transit, never source -> destination.
 *
 * Rule 5's whole point. A single-step transfer means a lorry that never
 * arrived still shows as stock at the receiving site, and the shortage is then
 * discovered as an unexplained negative at the far end weeks later.
 */
export async function dispatchTransfer(
  db: Db,
  actor: Actor,
  input: TransferInput
): Promise<{ transferId: number; transferNo: string }> {
  if (input.fromLocationId === input.toLocationId) {
    throw new UnprocessableError('The sending and receiving stores are the same. Nothing would move.')
  }

  return await db.transaction().execute(async (trx) => {
    const stores = await trx
      .selectFrom('locations')
      .select(['id', 'name', 'location_type', 'is_active'])
      .where('id', 'in', [input.fromLocationId, input.toLocationId])
      .execute()
    const from = stores.find((s) => s.id === input.fromLocationId)
    const to = stores.find((s) => s.id === input.toLocationId)
    if (!from || !to) throw new NotFoundError('One of those stores does not exist.')
    if (to.is_active === 0) {
      throw new UnprocessableError(`${to.name} is not active, so material cannot be sent to it.`)
    }
    if (from.location_type === 'transit' || to.location_type === 'transit') {
      throw new UnprocessableError('Transit is not a store. It holds material only between a dispatch and its receipt.')
    }

    const transitId = await ensureTransitLocation(trx)
    const transferNo = await nextNumber(trx, 'transfer')

    const inserted = await trx
      .insertInto('stock_transfers')
      .values({
        transfer_no: transferNo,
        from_location_id: input.fromLocationId,
        to_location_id: input.toLocationId,
        dispatched_on: input.dispatchedOn,
        vehicle_no: input.vehicleNo,
        status: 'in_transit',
        dispatched_by: actor.userId,
      })
      .executeTakeFirst()

    const transferId = Number(inserted.insertId ?? 0)

    for (const line of input.lines) {
      const out = await postStockMovement(trx, actor, {
        itemId: line.itemId,
        locationId: input.fromLocationId,
        txnDate: input.dispatchedOn,
        txnType: 'transfer_out',
        refTable: 'stock_transfers',
        refId: transferId,
        qtyIn: 0,
        qtyOut: line.qtySent,
        ratePaise: null,
        projectId: null,
        batchNo: line.batchNo,
      })

      // Into transit at the rate it left the source store at, so the value in
      // transit is the value that left rather than the destination's average.
      await postStockMovement(trx, actor, {
        itemId: line.itemId,
        locationId: transitId,
        txnDate: input.dispatchedOn,
        txnType: 'transfer_in',
        refTable: 'stock_transfers',
        refId: transferId,
        qtyIn: line.qtySent,
        qtyOut: 0,
        ratePaise: out.ratePaise,
        projectId: null,
        batchNo: line.batchNo,
      })

      await trx
        .insertInto('transfer_lines')
        .values({
          transfer_id: transferId,
          item_id: line.itemId,
          qty_sent: line.qtySent,
          qty_received: null,
          shortage_qty: null,
          rate_paise: out.ratePaise,
          batch_no: line.batchNo,
        })
        .execute()
    }

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'inventory.transfer_dispatch',
      entityType: 'stock_transfer',
      entityId: transferId,
      after: {
        transfer_no: transferNo,
        from_location_id: input.fromLocationId,
        to_location_id: input.toLocationId,
        transit_location_id: transitId,
        line_count: input.lines.length,
        status: 'in_transit',
      },
      ip: actor.ip,
    })

    return { transferId, transferNo }
  })
}

export interface TransferReceiveResult {
  transferNo: string
  shortages: { itemCode: string; itemName: string; qtySent: number; qtyReceived: number; shortage: number; unit: string }[]
}

/**
 * Receives a transfer: transit -> destination, recording shortage_qty.
 *
 * The shortfall stays in transit rather than vanishing. That is the honest
 * position: material that left one store and did not reach the other is
 * neither store's stock and is not yet a write-off. Someone has to decide
 * whether it was stolen, miscounted or is still on the lorry, and that
 * decision is a stock adjustment against transit with a reason attached.
 * Silently discarding it here would make the ledger balance by forgetting.
 */
export async function receiveTransfer(
  db: Db,
  actor: Actor,
  transferId: number,
  receivedOn: string,
  lines: readonly TransferReceiveLineInput[]
): Promise<TransferReceiveResult> {
  return await db.transaction().execute(async (trx) => {
    const transfer = await trx
      .selectFrom('stock_transfers')
      .select(['id', 'transfer_no', 'status', 'from_location_id', 'to_location_id', 'dispatched_on'])
      .where('id', '=', transferId)
      .forUpdate()
      .executeTakeFirst()
    if (!transfer) throw new NotFoundError('That transfer does not exist.')
    if (transfer.status === 'received') throw new ConflictError('That transfer is already received.')
    if (transfer.status === 'cancelled') throw new ConflictError('That transfer is cancelled.')
    if (receivedOn < String(transfer.dispatched_on)) {
      throw new UnprocessableError(
        `The receipt date is before the dispatch date of ${formatDate(String(transfer.dispatched_on))}.`
      )
    }

    const transitId = await ensureTransitLocation(trx)
    const shortages: TransferReceiveResult['shortages'] = []

    for (const line of lines) {
      const tl = await trx
        .selectFrom('transfer_lines')
        .innerJoin('items', 'items.id', 'transfer_lines.item_id')
        .innerJoin('units', 'units.id', 'items.unit_id')
        .select([
          'transfer_lines.id',
          'transfer_lines.item_id',
          'transfer_lines.qty_sent',
          'transfer_lines.rate_paise',
          'transfer_lines.batch_no',
          'items.code as item_code',
          'items.name as item_name',
          'units.code as unit',
        ])
        .where('transfer_lines.id', '=', line.lineId)
        .where('transfer_lines.transfer_id', '=', transferId)
        .forUpdate()
        .executeTakeFirst()
      if (!tl) throw new NotFoundError('One of the lines being received is not on that transfer.')

      const sent = Number(tl.qty_sent)
      if (line.qtyReceived > sent + 0.0005) {
        throw new UnprocessableError(
          `${tl.item_code} ${tl.item_name}: ${qty(line.qtyReceived)} ${tl.unit} cannot be received when only ${qty(sent)} ${tl.unit} was sent. Receive what arrived and post an adjustment for the difference, so the extra has a reason on it.`
        )
      }

      const shortage = round3(sent - line.qtyReceived)

      if (line.qtyReceived > 0) {
        await postStockMovement(trx, actor, {
          itemId: Number(tl.item_id),
          locationId: transitId,
          txnDate: receivedOn,
          txnType: 'transfer_out',
          refTable: 'stock_transfers',
          refId: transferId,
          qtyIn: 0,
          qtyOut: line.qtyReceived,
          ratePaise: null,
          projectId: null,
          batchNo: tl.batch_no,
        })

        await postStockMovement(trx, actor, {
          itemId: Number(tl.item_id),
          locationId: Number(transfer.to_location_id),
          txnDate: receivedOn,
          txnType: 'transfer_in',
          refTable: 'stock_transfers',
          refId: transferId,
          qtyIn: line.qtyReceived,
          qtyOut: 0,
          ratePaise: tl.rate_paise === null ? null : Number(tl.rate_paise),
          projectId: null,
          batchNo: tl.batch_no,
        })
      }

      await trx
        .updateTable('transfer_lines')
        .set({ qty_received: line.qtyReceived, shortage_qty: shortage })
        .where('id', '=', line.lineId)
        .execute()

      if (shortage > 0.0005) {
        shortages.push({
          itemCode: tl.item_code,
          itemName: tl.item_name,
          qtySent: sent,
          qtyReceived: line.qtyReceived,
          shortage,
          unit: tl.unit,
        })
      }
    }

    await trx
      .updateTable('stock_transfers')
      .set({ status: 'received', received_on: receivedOn, received_by: actor.userId })
      .where('id', '=', transferId)
      .execute()

    if (shortages.length > 0) {
      await notifyPermission(trx, PERMISSIONS.INVENTORY_STOCK_ADJUST, {
        actorId: actor.userId,
        kind: 'transfer_shortage',
        title: `${transfer.transfer_no}: short on arrival`,
        body: `${shortages
          .map((s) => `${s.itemCode} ${s.itemName} short ${qty(s.shortage)} ${s.unit}`)
          .join('; ')}. The shortfall is still held in transit and needs an adjustment with a reason.`,
        linkPath: `/app/inventory/transfers/${transferId}`,
        severity: 'warn',
      })
    }

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'inventory.transfer_receive',
      entityType: 'stock_transfer',
      entityId: transferId,
      before: { status: transfer.status },
      after: {
        status: 'received',
        received_on: receivedOn,
        to_location_id: Number(transfer.to_location_id),
        line_count: lines.length,
        shortage_line_count: shortages.length,
      },
      ip: actor.ip,
    })

    return { transferNo: transfer.transfer_no, shortages }
  })
}

/* Adjustments and opening stock ------------------------------------------- */

export type AdjustmentReason = 'physical_count' | 'damage' | 'theft' | 'expiry' | 'wastage' | 'correction'

export interface AdjustmentInput {
  locationId: number
  adjustmentDate: string
  reason: AdjustmentReason
  narration: string
  lines: AdjustmentLineInput[]
}

export interface AdjustmentResult {
  adjustmentId: number
  lines: { itemCode: string; itemName: string; qtySystem: number; qtyPhysical: number; qtyDiff: number; unit: string }[]
  netValuePaise: number
}

/**
 * Posts a physical count as an adjustment.
 *
 * qty_system is read here, inside the transaction, from the same item_stock row
 * postStockMovement is about to lock. The form only submits the counted figure
 * (see adjustmentSchema): a system quantity that arrives from a form is a
 * number the operator can make agree with their count, which defeats the point
 * of counting.
 *
 * A line whose count already matches the system writes no ledger row. A
 * zero-difference "adjustment" in an append-only ledger is noise that makes
 * the real ones harder to find.
 */
export async function postAdjustment(db: Db, actor: Actor, input: AdjustmentInput): Promise<AdjustmentResult> {
  return await db.transaction().execute(async (trx) => {
    const location = await trx
      .selectFrom('locations')
      .select(['id', 'name'])
      .where('id', '=', input.locationId)
      .executeTakeFirst()
    if (!location) throw new NotFoundError('That store does not exist.')

    const inserted = await trx
      .insertInto('stock_adjustments')
      .values({
        location_id: input.locationId,
        adjustment_date: input.adjustmentDate,
        reason: input.reason,
        narration: input.narration,
        created_by: actor.userId,
      })
      .executeTakeFirst()

    const adjustmentId = Number(inserted.insertId ?? 0)
    const reported: AdjustmentResult['lines'] = []
    let netValuePaise = 0

    for (const line of input.lines) {
      const item = await trx
        .selectFrom('items')
        .innerJoin('units', 'units.id', 'items.unit_id')
        .select(['items.code', 'items.name', 'units.code as unit'])
        .where('items.id', '=', line.itemId)
        .executeTakeFirst()
      if (!item) throw new NotFoundError('One of the counted items does not exist.')

      const cached = await trx
        .selectFrom('item_stock')
        .select(['qty_on_hand', 'value_paise'])
        .where('item_id', '=', line.itemId)
        .where('location_id', '=', input.locationId)
        .executeTakeFirst()

      const qtySystem = cached ? Number(cached.qty_on_hand) : 0
      const qtyDiff = round3(line.qtyPhysical - qtySystem)
      const wac = cached && qtySystem > 0 ? Number(cached.value_paise) / qtySystem : 0

      await trx
        .insertInto('adjustment_lines')
        .values({
          adjustment_id: adjustmentId,
          item_id: line.itemId,
          qty_system: qtySystem,
          qty_physical: line.qtyPhysical,
          qty_diff: qtyDiff,
          rate_paise: Math.round(wac),
        })
        .execute()

      reported.push({
        itemCode: item.code,
        itemName: item.name,
        qtySystem,
        qtyPhysical: line.qtyPhysical,
        qtyDiff,
        unit: item.unit,
      })
      netValuePaise += Math.round(wac * qtyDiff)

      if (Math.abs(qtyDiff) < 0.0005) continue

      await postStockMovement(trx, actor, {
        itemId: line.itemId,
        locationId: input.locationId,
        txnDate: input.adjustmentDate,
        txnType: 'adjustment',
        refTable: 'stock_adjustments',
        refId: adjustmentId,
        qtyIn: qtyDiff > 0 ? qtyDiff : 0,
        qtyOut: qtyDiff < 0 ? -qtyDiff : 0,
        ratePaise: qtyDiff > 0 ? Math.round(wac) : null,
        projectId: null,
        batchNo: null,
      })
    }

    // Theft and an unexplained shrink are the two an owner has to see. Damage,
    // expiry and wastage are expected losses on a site; correction is a
    // bookkeeping fix. Notifying on all six would train people to ignore it.
    const shrink = reported.filter((l) => l.qtyDiff < -0.0005)
    if (input.reason === 'theft' || (input.reason === 'physical_count' && shrink.length > 0)) {
      await notifyPermission(trx, PERMISSIONS.PROJECTS_VIEW_COST, {
        actorId: actor.userId,
        kind: 'stock_shrinkage',
        title:
          input.reason === 'theft'
            ? `Theft recorded at ${location.name}`
            : `Physical count short at ${location.name}`,
        body: `${shrink
          .map((l) => `${l.itemCode} ${l.itemName} short ${qty(-l.qtyDiff)} ${l.unit}`)
          .join('; ')}. ${formatPaise(Math.abs(netValuePaise))} at the store's average rate. ${input.narration}`,
        linkPath: `/app/inventory/adjustments/${adjustmentId}`,
        severity: 'critical',
      })
    }

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'inventory.stock_adjust',
      entityType: 'stock_adjustment',
      entityId: adjustmentId,
      after: {
        location_id: input.locationId,
        adjustment_date: input.adjustmentDate,
        reason: input.reason,
        narration: input.narration,
        line_count: input.lines.length,
        net_value_paise: netValuePaise,
        lines: reported.map((l) => ({ item_code: l.itemCode, qty_system: l.qtySystem, qty_physical: l.qtyPhysical, qty_diff: l.qtyDiff })),
      },
      ip: actor.ip,
    })

    return { adjustmentId, lines: reported, netValuePaise }
  })
}

/* Opening stock ------------------------------------------------------------ */

export interface OpeningStockInput {
  locationId: number
  itemId: number
  qty: number
  ratePaise: number
  batchNo: string | null
  asOn: string
}

/**
 * Records opening stock: the one and only writer of txn_type = 'opening'.
 *
 * This is the deliberate exception to rule 2. Every other movement refuses to
 * drive a balance negative; opening stock is how a store that already has
 * material on the shelf gets a starting balance at all, so it cannot be
 * blocked by the balance it is there to establish. It still goes through
 * postStockMovement, so item_stock keeps exactly one writer.
 *
 * Refused once the item already has ledger history at that location. An
 * "opening" balance posted after real movements would silently restate a
 * period people have already reported on; the honest instrument for that is an
 * adjustment with a reason and a narration.
 */
export async function postOpeningStock(
  db: Db,
  actor: Actor,
  input: OpeningStockInput
): Promise<{ ledgerId: number; balanceAfter: number }> {
  return await db.transaction().execute(async (trx) => {
    const location = await trx
      .selectFrom('locations')
      .select(['id', 'name'])
      .where('id', '=', input.locationId)
      .executeTakeFirst()
    if (!location) throw new NotFoundError('That store does not exist.')

    const item = await trx
      .selectFrom('items')
      .select(['id', 'code', 'name', 'is_batch_tracked'])
      .where('id', '=', input.itemId)
      .executeTakeFirst()
    if (!item) throw new NotFoundError('That item does not exist.')

    const prior = await trx
      .selectFrom('stock_ledger')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('item_id', '=', input.itemId)
      .where('location_id', '=', input.locationId)
      .executeTakeFirst()

    if (Number(prior?.n ?? 0) > 0) {
      throw new ConflictError(
        `${item.code} ${item.name} already has stock movements at ${location.name}. ` +
          'Opening stock can only be set before the first movement. Use a stock adjustment with a reason instead.'
      )
    }

    if (item.is_batch_tracked === 1 && (input.batchNo ?? '').trim().length === 0) {
      throw new UnprocessableError(`${item.code} ${item.name} is batch tracked. Enter the batch number on the material.`)
    }

    const movement = await postStockMovement(trx, actor, {
      itemId: input.itemId,
      locationId: input.locationId,
      txnDate: input.asOn,
      txnType: 'opening',
      refTable: 'item_stock',
      refId: input.itemId,
      qtyIn: input.qty,
      qtyOut: 0,
      ratePaise: input.ratePaise,
      projectId: null,
      batchNo: input.batchNo,
    })

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'inventory.opening_stock',
      entityType: 'stock_ledger',
      entityId: movement.ledgerId,
      after: {
        item_id: input.itemId,
        item_code: item.code,
        location_id: input.locationId,
        qty: input.qty,
        rate_paise: input.ratePaise,
        batch_no: input.batchNo,
        as_on: input.asOn,
      },
      ip: actor.ip,
    })

    return { ledgerId: movement.ledgerId, balanceAfter: movement.balanceAfter }
  })
}

/* Equipment --------------------------------------------------------------- */

export interface EquipmentDeployInput {
  projectId: number
  fromDate: string
  meterStart: number | null
  operatorName: string | null
}

export interface EquipmentReturnInput {
  toDate: string
  meterEnd: number | null
  locationId: number | null
}

/**
 * Deploys a machine to a project.
 *
 * The open deployment row is the lock, not equipment.status: status is a
 * denormalised convenience for the list screen, and trusting it alone would
 * let two deployments overlap the moment the two disagree.
 */
export async function deployEquipment(
  db: Db,
  actor: Actor,
  equipmentId: number,
  input: EquipmentDeployInput
): Promise<{ deploymentId: number }> {
  return await db.transaction().execute(async (trx) => {
    const eq = await trx
      .selectFrom('equipment')
      .select(['id', 'code', 'name', 'status', 'ownership', 'insurance_valid_until', 'next_service_due'])
      .where('id', '=', equipmentId)
      .executeTakeFirst()
    if (!eq) throw new NotFoundError('That equipment does not exist.')
    if (eq.status === 'retired') throw new ConflictError(`${eq.code} ${eq.name} is retired.`)
    if (eq.status === 'under_repair') {
      throw new ConflictError(`${eq.code} ${eq.name} is under repair. Mark it available before deploying it.`)
    }

    const project = await trx
      .selectFrom('projects')
      .select(['id', 'code', 'name', 'status'])
      .where('id', '=', input.projectId)
      .executeTakeFirst()
    if (!project) throw new NotFoundError('That project does not exist.')
    if (project.status === 'closed' || project.status === 'cancelled') {
      throw new ConflictError(`${project.code} ${project.name} is ${project.status}. Equipment cannot be deployed to it.`)
    }

    const open = await trx
      .selectFrom('equipment_deployments')
      .innerJoin('projects', 'projects.id', 'equipment_deployments.project_id')
      .select(['equipment_deployments.id', 'equipment_deployments.from_date', 'projects.code', 'projects.name'])
      .where('equipment_deployments.equipment_id', '=', equipmentId)
      .where('equipment_deployments.to_date', 'is', null)
      .executeTakeFirst()
    if (open) {
      throw new ConflictError(
        `${eq.code} ${eq.name} is already on ${open.code} ${open.name} since ${formatDate(String(open.from_date))}. ` +
          'Record its return first.'
      )
    }

    const inserted = await trx
      .insertInto('equipment_deployments')
      .values({
        equipment_id: equipmentId,
        project_id: input.projectId,
        from_date: input.fromDate,
        meter_start: input.meterStart,
        operator_name: input.operatorName,
        created_by: actor.userId,
      })
      .executeTakeFirst()

    const deploymentId = Number(inserted.insertId ?? 0)

    await trx
      .updateTable('equipment')
      .set({ status: 'deployed', current_project_id: input.projectId, current_location_id: null })
      .where('id', '=', equipmentId)
      .execute()

    // Compliance is reported, not blocked. A crane whose insurance lapsed
    // yesterday still has to come off the site today, and refusing the
    // deployment would only get the paperwork skipped.
    const flags: string[] = []
    if (eq.insurance_valid_until !== null && String(eq.insurance_valid_until) < input.fromDate) {
      flags.push(`insurance expired ${formatDate(String(eq.insurance_valid_until))}`)
    }
    if (eq.next_service_due !== null && String(eq.next_service_due) < input.fromDate) {
      flags.push(`service overdue since ${formatDate(String(eq.next_service_due))}`)
    }
    if (flags.length > 0) {
      await notifyPermission(trx, PERMISSIONS.INVENTORY_ITEM_MANAGE, {
        actorId: actor.userId,
        kind: 'equipment_compliance',
        title: `${eq.code} ${eq.name} deployed with open compliance`,
        body: `On ${project.code} ${project.name} from ${formatDate(input.fromDate)}: ${flags.join('; ')}.`,
        linkPath: `/app/inventory/equipment/${equipmentId}`,
        severity: 'warn',
      })
    }

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'inventory.equipment_deploy',
      entityType: 'equipment_deployment',
      entityId: deploymentId,
      after: {
        equipment_id: equipmentId,
        equipment_code: eq.code,
        project_id: input.projectId,
        from_date: input.fromDate,
        meter_start: input.meterStart,
        operator_name: input.operatorName,
        compliance_flags: flags,
      },
      ip: actor.ip,
    })

    return { deploymentId }
  })
}

export interface EquipmentReturnResult {
  deploymentId: number
  days: number
  meterHours: number | null
  hireCostPaise: number | null
}

/**
 * Closes the open deployment and returns the machine to a yard or store.
 *
 * Hire cost is computed and reported but not posted: expenses are the finance
 * module's writer (spec 6.8), and a second path into the expense table is how
 * the same day's hire ends up billed twice. equipment_deployments.expense_id
 * stays null until finance links it.
 */
export async function returnEquipment(
  db: Db,
  actor: Actor,
  equipmentId: number,
  input: EquipmentReturnInput
): Promise<EquipmentReturnResult> {
  return await db.transaction().execute(async (trx) => {
    const eq = await trx
      .selectFrom('equipment')
      .select(['id', 'code', 'name', 'ownership', 'hire_rate_per_day_paise'])
      .where('id', '=', equipmentId)
      .executeTakeFirst()
    if (!eq) throw new NotFoundError('That equipment does not exist.')

    const open = await trx
      .selectFrom('equipment_deployments')
      .select(['id', 'project_id', 'from_date', 'meter_start'])
      .where('equipment_id', '=', equipmentId)
      .where('to_date', 'is', null)
      .executeTakeFirst()
    if (!open) throw new ConflictError(`${eq.code} ${eq.name} is not deployed anywhere.`)

    const fromDate = String(open.from_date).slice(0, 10)
    if (input.toDate < fromDate) {
      throw new UnprocessableError(
        `The return date is before the deployment date, ${formatDate(fromDate)}. Check the date on the log sheet.`
      )
    }

    const meterStart = open.meter_start === null ? null : Number(open.meter_start)
    if (input.meterEnd !== null && meterStart !== null && input.meterEnd < meterStart) {
      throw new UnprocessableError(
        `The closing meter reading (${input.meterEnd}) is below the opening reading (${meterStart}). ` +
          'Meters do not run backwards, so one of the two readings is wrong.'
      )
    }

    if (input.locationId !== null) {
      const dest = await trx
        .selectFrom('locations')
        .select(['id', 'is_active'])
        .where('id', '=', input.locationId)
        .executeTakeFirst()
      if (!dest) throw new NotFoundError('That yard or store does not exist.')
      if (dest.is_active === 0) throw new UnprocessableError('That yard or store is inactive.')
    }

    await trx
      .updateTable('equipment_deployments')
      .set({ to_date: input.toDate, meter_end: input.meterEnd })
      .where('id', '=', open.id)
      .execute()

    await trx
      .updateTable('equipment')
      .set({ status: 'available', current_project_id: null, current_location_id: input.locationId })
      .where('id', '=', equipmentId)
      .execute()

    // Inclusive of both ends: a machine that arrives and leaves on the same day
    // is one day's hire, not nought.
    const days = Math.floor((Date.parse(`${input.toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000) + 1
    const meterHours = input.meterEnd !== null && meterStart !== null ? Number((input.meterEnd - meterStart).toFixed(1)) : null
    const hireCostPaise =
      eq.ownership === 'hired' && eq.hire_rate_per_day_paise !== null
        ? Math.round(Number(eq.hire_rate_per_day_paise) * days)
        : null

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'inventory.equipment_return',
      entityType: 'equipment_deployment',
      entityId: open.id,
      after: {
        equipment_id: equipmentId,
        equipment_code: eq.code,
        project_id: open.project_id,
        from_date: fromDate,
        to_date: input.toDate,
        meter_start: meterStart,
        meter_end: input.meterEnd,
        days,
        meter_hours: meterHours,
        hire_cost_paise: hireCostPaise,
        returned_to_location_id: input.locationId,
      },
      ip: actor.ip,
    })

    return { deploymentId: open.id, days, meterHours, hireCostPaise }
  })
}

/* Alerts ------------------------------------------------------------------- */

export interface StockAlerts {
  lowStock: Awaited<ReturnType<typeof lowStock>>
  expiring: Awaited<ReturnType<typeof expiringBatches>>
  equipment: Awaited<ReturnType<typeof equipmentDue>>
  negative: { itemId: number; itemCode: string; itemName: string; locationName: string; qtyOnHand: number; unit: string }[]
}

/**
 * The dashboard's alert block and the daily cron read the same function, so a
 * storekeeper and the email cannot disagree about what is low.
 *
 * `negative` should always be empty: rule 2 refuses every movement that would
 * drive a balance below zero, and opening stock is the only entry point that
 * skips that check. A row here means either the cache has drifted from the
 * ledger (run scripts/reconcile-stock.mjs) or something wrote item_stock
 * outside postStockMovement, which is the invariant this module is built on.
 * It is surfaced rather than logged because a silent canary is not a canary.
 *
 * `equipment` rides along because the spec's route table gives the daily job one
 * endpoint for reorder level, expiry, equipment service and insurance. It takes
 * no scope: a machine whose insurance has lapsed is a company problem, not a
 * problem belonging to whichever project it happens to be parked on.
 */
export async function stockAlerts(
  db: Db,
  scope: ScopeContext | null,
  opts: { expiryWithinDays?: number; limit?: number } = {}
): Promise<StockAlerts> {
  const [low, expiring, equipment, negativeRows] = await Promise.all([
    lowStock(db, scope, opts.limit ?? 50),
    expiringBatches(db, opts.expiryWithinDays ?? 30),
    equipmentDue(db, opts.expiryWithinDays ?? 30),
    db
      .selectFrom('item_stock')
      .innerJoin('items', 'items.id', 'item_stock.item_id')
      .innerJoin('units', 'units.id', 'items.unit_id')
      .innerJoin('locations', 'locations.id', 'item_stock.location_id')
      .select([
        'item_stock.item_id',
        'items.code as item_code',
        'items.name as item_name',
        'locations.name as location_name',
        'item_stock.qty_on_hand',
        'units.code as unit',
      ])
      .where('item_stock.qty_on_hand', '<', 0)
      .orderBy('items.code')
      .execute(),
  ])

  return {
    lowStock: low,
    expiring,
    equipment,
    negative: negativeRows.map((r) => ({
      itemId: Number(r.item_id),
      itemCode: r.item_code,
      itemName: r.item_name,
      locationName: r.location_name,
      qtyOnHand: Number(r.qty_on_hand),
      unit: r.unit,
    })),
  }
}

/* Consumption variance (rule 4) -------------------------------------------- */

/** Beyond this much over the pro-rated expectation, a line is flagged. */
export const CONSUMPTION_VARIANCE_THRESHOLD_PCT = 10

export type ConsumptionFlag = 'over' | 'under' | 'within' | 'no_norm' | 'no_area'

export interface ConsumptionVarianceLine {
  itemId: number
  itemCode: string
  itemName: string
  unit: string
  qtyIssued: number
  valuePaise: number
  normPerSqft: number | null
  wastageAllowancePct: number
  expectedAtCompletion: number | null
  expectedAtProgress: number | null
  variancePct: number | null
  excessQty: number | null
  excessValuePaise: number | null
  flag: ConsumptionFlag
}

export interface ConsumptionVarianceReport {
  projectId: number
  projectCode: string
  projectName: string
  projectType: string
  deliveryModel: string
  builtUpAreaSqft: number | null
  physicalProgressPct: number
  lines: ConsumptionVarianceLine[]
  notes: string[]
  normsConfigured: boolean
}

/**
 * Actual against theoretical consumption for one project (spec 6.4 rule 4).
 *
 * Expected quantity is the spec's formula, built_up_area_sqft * norm per sqft,
 * grossed up by items.wastage_allowance_pct. That figure is the expectation at
 * completion, so it is reported alongside a second figure pro-rated by
 * projects.physical_progress_pct, and the variance percentage is taken against
 * the pro-rated one. Comparing a half-built house's issues against its
 * finished-house expectation would show every item under-consumed and the
 * report would be ignored by the second week.
 *
 * Quantity issued is the ledger's own arithmetic, SUM(qty_out - qty_in) over
 * rows carrying this project_id, so returned material reduces consumption. Only
 * issues and returns carry a project_id; GRNs, transfers and adjustments belong
 * to a store rather than a site.
 *
 * An item with no consumption_norms row reports flag 'no_norm' and no
 * expectation. The norms are open question 8.4 and are seeded empty on purpose:
 * a guessed norm generates false theft alerts until people stop reading the
 * report, which costs more than having no report.
 */
export async function getConsumptionVariance(db: Db, projectId: number): Promise<ConsumptionVarianceReport> {
  const project = await db
    .selectFrom('projects')
    .select(['id', 'code', 'name', 'project_type', 'delivery_model', 'built_up_area_sqft', 'physical_progress_pct'])
    .where('id', '=', projectId)
    .executeTakeFirst()
  if (!project) throw new NotFoundError('That project does not exist.')

  const area = project.built_up_area_sqft === null ? null : Number(project.built_up_area_sqft)
  const progressPct = Number(project.physical_progress_pct)

  const issued = await db
    .selectFrom('stock_ledger')
    .innerJoin('items', 'items.id', 'stock_ledger.item_id')
    .innerJoin('units', 'units.id', 'items.unit_id')
    .select([
      'stock_ledger.item_id',
      'items.code as item_code',
      'items.name as item_name',
      'items.wastage_allowance_pct',
      'units.code as unit',
      sql<number>`SUM(stock_ledger.qty_out - stock_ledger.qty_in)`.as('qty_net'),
      sql<number>`SUM(CASE WHEN stock_ledger.qty_out > 0
        THEN COALESCE(stock_ledger.value_paise, 0)
        ELSE -COALESCE(stock_ledger.value_paise, 0) END)`.as('value_net'),
    ])
    .where('stock_ledger.project_id', '=', projectId)
    .groupBy(['stock_ledger.item_id', 'items.code', 'items.name', 'items.wastage_allowance_pct', 'units.code'])
    .orderBy('items.code')
    .execute()

  const norms = await db
    .selectFrom('consumption_norms')
    .select(['item_id', 'qty_per_sqft'])
    .where('project_type', '=', project.project_type)
    .execute()

  const normByItem = new Map<number, number>()
  for (const n of norms) normByItem.set(Number(n.item_id), Number(n.qty_per_sqft))

  const lines: ConsumptionVarianceLine[] = issued.map((r) => {
    const itemId = Number(r.item_id)
    const qtyIssued = round3(Number(r.qty_net ?? 0))
    const wastagePct = Number(r.wastage_allowance_pct)
    const norm = normByItem.get(itemId) ?? null

    let expectedAtCompletion: number | null = null
    let expectedAtProgress: number | null = null
    let pct: number | null = null
    let excessQty: number | null = null
    let excessValuePaise: number | null = null
    let flag: ConsumptionFlag = 'no_norm'

    if (norm === null) {
      flag = 'no_norm'
    } else if (area === null) {
      flag = 'no_area'
    } else {
      expectedAtCompletion = round3(area * norm * (1 + wastagePct / 100))
      expectedAtProgress = round3(expectedAtCompletion * (progressPct / 100))
      pct = variancePct(qtyIssued, expectedAtProgress)
      excessQty = round3(qtyIssued - expectedAtProgress)
      // Valued at what actually left the store, not at a standard rate: the
      // question the owner asks next is how much money walked off site.
      const avgRate = qtyIssued > 0 ? Number(r.value_net ?? 0) / qtyIssued : 0
      excessValuePaise = Math.round(avgRate * excessQty)
      flag =
        pct === null
          ? 'within'
          : pct > CONSUMPTION_VARIANCE_THRESHOLD_PCT
            ? 'over'
            : pct < -CONSUMPTION_VARIANCE_THRESHOLD_PCT
              ? 'under'
              : 'within'
    }

    return {
      itemId,
      itemCode: r.item_code,
      itemName: r.item_name,
      unit: r.unit,
      qtyIssued,
      valuePaise: Number(r.value_net ?? 0),
      normPerSqft: norm,
      wastageAllowancePct: wastagePct,
      expectedAtCompletion,
      expectedAtProgress,
      variancePct: pct,
      excessQty,
      excessValuePaise,
      flag,
    }
  })

  const notes: string[] = []
  if (norms.length === 0) {
    notes.push(
      'No consumption norms are set for this project type, so nothing can be compared yet. ' +
        'The norms are a company decision (open question 8.4) and are deliberately not guessed.'
    )
  }
  if (area === null) {
    notes.push('This project has no built-up area recorded, so the theoretical quantity cannot be computed.')
  }
  if (project.delivery_model !== 'package_per_sqft') {
    notes.push(
      `The per-sqft norm is specified for package_per_sqft projects; this one is ${project.delivery_model}. ` +
        'Read the comparison as indicative.'
    )
  }
  if (progressPct <= 0) {
    notes.push(
      'Physical progress is nil, so the pro-rated expectation is nil and every issued item reads as over-consumption. ' +
        'Compare against the at-completion column until progress is recorded.'
    )
  }

  return {
    projectId,
    projectCode: project.code,
    projectName: project.name,
    projectType: project.project_type,
    deliveryModel: project.delivery_model,
    builtUpAreaSqft: area,
    physicalProgressPct: progressPct,
    lines,
    notes,
    normsConfigured: norms.length > 0,
  }
}
