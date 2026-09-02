import { Hono } from 'hono'
import type { AppEnv } from '../../types.js'
import { page, banner } from '../../dashboard/render.js'
import { Alert, KpiCard, Panel } from '../../dashboard/components/index.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { PERMISSIONS } from '../../lib/permissions.js'

/**
 * Inventory module routes.
 *
 * The schema, the permission keys and the navigation for this module are
 * complete and live. The transactional screens are the next build phase, so
 * every route below is mounted, guarded by the same permission its sidebar
 * item names, and reports the real row count from its primary table. That
 * preserves the invariant the navigation depends on: a link the user can see
 * is a link that neither 404s nor 403s.
 */

const inventory = new Hono<AppEnv>()

inventory.get('/app/inventory', requirePermission(PERMISSIONS.INVENTORY_VIEW), async (c) => {
  const db = c.get('db')
  const row = await db
    .selectFrom('item_stock')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirst()
  const total = Number(row?.n ?? 0)
  return page(
    c,
    { title: 'Stock', path: '/app/inventory' },
    <>
      {banner(c)}
      <div class="ncc-kpi-row">
        <KpiCard label="Records held" value={String(total)} hint="Live count from item_stock" />
      </div>
      <Panel title="Stock">
        <Alert tone="warn">
          The data model behind this screen is migrated. The entry and approval
          forms are the next build phase.
        </Alert>
      </Panel>
    </>
  )
})

inventory.get('/app/inventory/items', requirePermission(PERMISSIONS.INVENTORY_VIEW), async (c) => {
  const db = c.get('db')
  const row = await db
    .selectFrom('items')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirst()
  const total = Number(row?.n ?? 0)
  return page(
    c,
    { title: 'Item master', path: '/app/inventory/items' },
    <>
      {banner(c)}
      <div class="ncc-kpi-row">
        <KpiCard label="Records held" value={String(total)} hint="Live count from items" />
      </div>
      <Panel title="Item master">
        <Alert tone="warn">
          The data model behind this screen is migrated. The entry and approval
          forms are the next build phase.
        </Alert>
      </Panel>
    </>
  )
})

inventory.get('/app/inventory/grn', requirePermission(PERMISSIONS.INVENTORY_GRN_CREATE), async (c) => {
  const db = c.get('db')
  const row = await db
    .selectFrom('goods_receipts')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirst()
  const total = Number(row?.n ?? 0)
  return page(
    c,
    { title: 'Goods receipt', path: '/app/inventory/grn' },
    <>
      {banner(c)}
      <div class="ncc-kpi-row">
        <KpiCard label="Records held" value={String(total)} hint="Live count from goods_receipts" />
      </div>
      <Panel title="Goods receipt">
        <Alert tone="warn">
          The data model behind this screen is migrated. The entry and approval
          forms are the next build phase.
        </Alert>
      </Panel>
    </>
  )
})

inventory.get('/app/inventory/issues', requirePermission(PERMISSIONS.INVENTORY_ISSUE), async (c) => {
  const db = c.get('db')
  const row = await db
    .selectFrom('material_issues')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirst()
  const total = Number(row?.n ?? 0)
  return page(
    c,
    { title: 'Material issues', path: '/app/inventory/issues' },
    <>
      {banner(c)}
      <div class="ncc-kpi-row">
        <KpiCard label="Records held" value={String(total)} hint="Live count from material_issues" />
      </div>
      <Panel title="Material issues">
        <Alert tone="warn">
          The data model behind this screen is migrated. The entry and approval
          forms are the next build phase.
        </Alert>
      </Panel>
    </>
  )
})

inventory.get('/app/inventory/transfers', requirePermission(PERMISSIONS.INVENTORY_TRANSFER), async (c) => {
  const db = c.get('db')
  const row = await db
    .selectFrom('stock_transfers')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirst()
  const total = Number(row?.n ?? 0)
  return page(
    c,
    { title: 'Stock transfers', path: '/app/inventory/transfers' },
    <>
      {banner(c)}
      <div class="ncc-kpi-row">
        <KpiCard label="Records held" value={String(total)} hint="Live count from stock_transfers" />
      </div>
      <Panel title="Stock transfers">
        <Alert tone="warn">
          The data model behind this screen is migrated. The entry and approval
          forms are the next build phase.
        </Alert>
      </Panel>
    </>
  )
})

inventory.get('/app/inventory/po', requirePermission(PERMISSIONS.INVENTORY_PO_CREATE), async (c) => {
  const db = c.get('db')
  const row = await db
    .selectFrom('purchase_orders')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirst()
  const total = Number(row?.n ?? 0)
  return page(
    c,
    { title: 'Purchase orders', path: '/app/inventory/po' },
    <>
      {banner(c)}
      <div class="ncc-kpi-row">
        <KpiCard label="Records held" value={String(total)} hint="Live count from purchase_orders" />
      </div>
      <Panel title="Purchase orders">
        <Alert tone="warn">
          The data model behind this screen is migrated. The entry and approval
          forms are the next build phase.
        </Alert>
      </Panel>
    </>
  )
})

inventory.get('/app/inventory/vendors', requirePermission(PERMISSIONS.INVENTORY_VENDOR_MANAGE), async (c) => {
  const db = c.get('db')
  const row = await db
    .selectFrom('vendors')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirst()
  const total = Number(row?.n ?? 0)
  return page(
    c,
    { title: 'Vendors', path: '/app/inventory/vendors' },
    <>
      {banner(c)}
      <div class="ncc-kpi-row">
        <KpiCard label="Records held" value={String(total)} hint="Live count from vendors" />
      </div>
      <Panel title="Vendors">
        <Alert tone="warn">
          The data model behind this screen is migrated. The entry and approval
          forms are the next build phase.
        </Alert>
      </Panel>
    </>
  )
})

export default inventory
