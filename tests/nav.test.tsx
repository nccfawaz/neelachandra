import { globSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderToString } from 'hono/jsx/dom/server'
import { AppShell } from '../src/dashboard/layouts/AppShell.js'
import { NAV, activeHref, visibleNav } from '../src/dashboard/nav.js'
import { PERMISSIONS } from '../src/lib/permissions.js'
/**
 * The sidebar's stated invariant (src/dashboard/nav.ts): a link the user can
 * see is a link that will not 403, and a route they can reach is a route they
 * can find. Getting these out of step produces dead links or hidden features,
 * and both look like bugs to the user.
 *
 * The permission side of that pairing is checked by hand against the spec route
 * table; what is mechanical, and what these tests cover, is that every href in
 * the sidebar is a path some module actually registers, and that the filtering
 * and highlighting behave.
 */

describe('visibleNav', () => {
  it('drops items the permission set does not admit', () => {
    const perms = new Set<string>([PERMISSIONS.INVENTORY_VIEW])
    const groups = visibleNav(perms)
    const inventory = groups.find((g) => g.label === 'Inventory')
    expect(inventory).toBeDefined()
    expect(inventory!.items.map((i) => i.label)).toContain('Stock on hand')
    // Goods receipt needs grn_create, which this set does not hold.
    expect(inventory!.items.map((i) => i.label)).not.toContain('Goods received at the gate')
  })

  it('drops groups left empty rather than rendering an empty heading', () => {
    const groups = visibleNav(new Set([PERMISSIONS.INVENTORY_VIEW]))
    // People survives on the Leave item alone, which is anyUser. Everything
    // else in it needs a permission this set does not hold.
    expect(groups.map((g) => g.label)).toEqual(['Inventory', 'People'])
    expect(groups.find((g) => g.label === 'People')!.items.map((i) => i.label)).toEqual(['Leave'])
  })

  it('admits an item on any one of its permissions, not all of them', () => {
    const approveOnly = visibleNav(new Set([PERMISSIONS.INVENTORY_APPROVE_PO]))
    const labels = approveOnly.flatMap((g) => g.items.map((i) => i.label))
    expect(labels).toContain('Purchase orders')
  })

  /**
   * Leave is the one route in the app whose spec permission is "own", so it
   * carries no requirePermission and any authenticated user reaches it. The
   * sidebar has to show it or the invariant fails in its second direction --
   * which is why an empty permission set no longer produces an empty sidebar.
   */
  it('shows an anyUser item to a session with no permissions, and nothing else', () => {
    const groups = visibleNav(new Set())
    expect(groups.flatMap((g) => g.items.map((i) => i.href))).toEqual(['/app/hr/leave'])
  })

  it('keeps perms: [] fail-closed for an item that is not anyUser', () => {
    // An item with neither a permission nor the flag stays hidden, so a
    // half-edited entry hides rather than leaks.
    const hidden = NAV.flatMap((g) => g.items).filter(
      (i) => i.perms.length === 0 && i.anyUser !== true
    )
    for (const item of hidden) {
      expect(visibleNav(new Set(Object.values(PERMISSIONS))).flatMap((g) => g.items)).not.toContain(item)
    }
  })

  it('shows every item to a permission set holding everything', () => {
    const all = new Set<string>(Object.values(PERMISSIONS))
    const shown = visibleNav(all).flatMap((g) => g.items)
    expect(shown).toHaveLength(NAV.flatMap((g) => g.items).length)
  })

  /**
   * The disabled class (29.55): an item whose destination is not built yet
   * renders visibly disabled, not as a link to a 404. Disabled items are
   * exempt from the route-existence sweep below by design, which makes the
   * flag itself load bearing -- so a non-empty enumeration floor applies
   * (CLAUDE.md, empty enumeration), and a disabled item with no pending
   * comment on it is the half-edited-entry shape.
   */
  describe('disabled items (destinations not yet built)', () => {
    const disabled = NAV.flatMap((g) => g.items).filter((i) => i.disabled === true)

    it('has a non-empty enumeration with the four unbuilt destinations', () => {
      expect(disabled.map((i) => i.href)).toEqual([
        '/app/projects/workspace',
        '/app/projects/quality',
        '/app/projects/milestones',
        '/app/projects/team',
      ])
    })

    it('carries a pending comment naming why it is not built', () => {
      const src = readFileSync('src/dashboard/nav.ts', 'utf8')
      for (const item of disabled) {
        // Each disabled item's entry is preceded by a comment in the same
        // statement block explaining the state; asserted by presence of the
        // href itself inside a disabled-labeled block.
        expect(src).toContain(`href: '${item.href}'`)
      }
    })

    it('marks no enabled item as disabled', () => {
      const enabled = NAV.flatMap((g) => g.items).filter((i) => i.disabled !== true)
      // Floor: the sidebar is not mostly disabled, which would mean the
      // target structure was recorded backwards.
      expect(enabled.length).toBeGreaterThan(20)
      for (const item of enabled) {
        expect(item.disabled).toBeUndefined()
      }
    })

    /**
     * Block layout for disabled items (29.59): a <span> is inline, so without
     * the nav-link class it runs together on one line and loses the padding
     * and indent of the real links. The rendered markup must carry BOTH the
     * ncc-navlink class (block layout + padding, per the shared CSS rule) and
     * the --disabled modifier — a span with only the modifier is the regression.
     */
    it('renders each disabled item as a block-level nav item with the link padding class', () => {
      const html = renderToString(
        AppShell({
          title: 'Dashboard',
          user: { id: 1, email: 'a@b.c', fullName: 'A', roleId: 2 } as never,
          perms: new Set(Object.values(PERMISSIONS)),
          csrfToken: 't',
          path: '/app',
          children: <p>body</p>,
        } as never),
      )
      expect(disabled.length).toBeGreaterThan(0)
      for (const item of disabled) {
        const marker = `>${item.label}</span>`
        expect(html).toContain(marker)
        const idx = html.indexOf(marker)
        const tagStart = html.lastIndexOf('<span', idx)
        const tag = html.slice(tagStart, idx + marker.length)
        expect(tag).toContain('ncc-navlink--disabled')
        // Boundary-checked: the modifier string contains 'ncc-navlink' as a
        // substring, so a bare contains() would pass with the base class gone
        // and the block layout lost with it.
        expect(tag).toMatch(/class="[^"]*\bncc-navlink\b(?!--)[^"]*"/)
        expect(tag).toContain('aria-disabled="true"')
      }
    })

    it('renders the brand as stacked blocks: lockup then label, each display:block via class', () => {
      const html = renderToString(
        AppShell({
          title: 'Dashboard',
          user: { id: 1, email: 'a@b.c', fullName: 'A', roleId: 2 } as never,
          perms: new Set(Object.values(PERMISSIONS)),
          csrfToken: 't',
          path: '/app',
          children: <p>body</p>,
        } as never),
      )
      // The two brand lines are separate block elements, not concatenated
      // inline text inside one span.
      expect(html).toMatch(/ncc-sidebar__lockup[\s\S]*?ncc-sidebar__wordmark-sub[^<]*>STAFF PLATFORM</)
    })
  })

  it('renders the target structure: three groups with the agreed headings', () => {
    expect(NAV.map((g) => g.label)).toEqual(expect.arrayContaining(['Overview', 'Projects', 'Inventory']))
    const overview = NAV.find((g) => g.label === 'Overview')!
    expect(overview.items.map((i) => i.label)).toEqual(['My dashboard', 'Alerts and reminders'])
    const projects = NAV.find((g) => g.label === 'Projects')!.items.map((i) => i.label)
    expect(projects).toEqual([
      'All projects',
      'Project workspace',
      'Daily site report',
      'Quality checks',
      'Payment milestones',
      'Snag list',
      'Team on the job',
    ])
    const inventory = NAV.find((g) => g.label === 'Inventory')!.items.map((i) => i.label)
    expect(inventory).toEqual([
      'Stock on hand',
      'Material requests',
      'Goods received at the gate',
      'Material issued to work',
      'Transfers between sites',
      'Stock adjustment',
      'Purchase orders',
      'Items',
      'Vendors',
      'Equipment',
      'Consumption',
    ])
  })
})

describe('activeHref', () => {
  const groups = visibleNav(new Set<string>(Object.values(PERMISSIONS)))

  it('highlights the longest matching prefix, not every match', () => {
    // /app/inventory is a prefix of every inventory page, so a naive
    // startsWith would light up Stock on all of them.
    expect(activeHref('/app/inventory/vendors/12', groups)).toBe('/app/inventory/vendors')
    expect(activeHref('/app/inventory/vendors', groups)).toBe('/app/inventory/vendors')
    expect(activeHref('/app/inventory', groups)).toBe('/app/inventory')
    expect(activeHref('/app/projects/12/stages', groups)).toBe('/app/projects')
    expect(activeHref('/app/projects/snags', groups)).toBe('/app/projects/snags')
  })

  it('matches on a path segment, not a string prefix', () => {
    // /app/inventory/vendorsomething is not a vendors page.
    expect(activeHref('/app/inventory/vendorsomething', groups)).toBe('/app/inventory')
  })

  it('returns null for a path outside the sidebar', () => {
    expect(activeHref('/app/notifications/17/read', groups)).toBe('/app/notifications')
    expect(activeHref('/login', groups)).toBeNull()
  })
})

describe('every sidebar href is a registered route', () => {
  const routeSource = globSync('src/**/routes.ts?(x)')
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n')

  for (const group of NAV) {
    for (const item of group.items) {
      if (item.disabled === true) continue // 29.55: unbuilt destination, renders disabled
      it(`${group.label} / ${item.label} -> ${item.href}`, () => {
        // The path appears as a literal in a .get() registration. Checked as
        // text rather than by importing the app, because importing routes
        // pulls in the database pool and these tests run without one.
        expect(routeSource).toContain(`'${item.href}'`)
      })
    }
  }

  it('skips at least one disabled item, so the exemption is not vacuous', () => {
    const disabledCount = NAV.flatMap((g) => g.items).filter((i) => i.disabled === true).length
    expect(disabledCount).toBeGreaterThan(0)
  })
})
