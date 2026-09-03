import { globSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
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
    expect(inventory!.items.map((i) => i.label)).toContain('Stock')
    // Goods receipt needs grn_create, which this set does not hold.
    expect(inventory!.items.map((i) => i.label)).not.toContain('Goods receipt')
  })

  it('drops groups left empty rather than rendering an empty heading', () => {
    const groups = visibleNav(new Set([PERMISSIONS.INVENTORY_VIEW]))
    expect(groups.map((g) => g.label)).toEqual(['Inventory'])
  })

  it('admits an item on any one of its permissions, not all of them', () => {
    const approveOnly = visibleNav(new Set([PERMISSIONS.INVENTORY_APPROVE_PO]))
    const labels = approveOnly.flatMap((g) => g.items.map((i) => i.label))
    expect(labels).toContain('Purchase orders')
  })

  it('returns nothing for a session with no permissions', () => {
    expect(visibleNav(new Set())).toEqual([])
  })

  it('shows every item to a permission set holding everything', () => {
    const all = new Set<string>(Object.values(PERMISSIONS))
    const shown = visibleNav(all).flatMap((g) => g.items)
    expect(shown).toHaveLength(NAV.flatMap((g) => g.items).length)
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
      it(`${group.label} / ${item.label} -> ${item.href}`, () => {
        // The path appears as a literal in a .get() registration. Checked as
        // text rather than by importing the app, because importing routes
        // pulls in the database pool and these tests run without one.
        expect(routeSource).toContain(`'${item.href}'`)
      })
    }
  }
})
