/**
 * The ten public paths, in TypeScript.
 *
 * scripts/lib/pages.mjs holds the same list for the build and parity tooling,
 * which runs as plain Node with no compile step. This file is its typed twin
 * for the server. Two copies of a list is normally a smell, so
 * scripts/check-pages-parity.mjs asserts they are identical and fails the
 * build if they drift.
 */

export interface PublicPage {
  slug: string
  path: string
  /** sitemap.xml priority, preserved from the legacy sitemap.php. */
  priority: string
  changefreq: 'weekly' | 'monthly' | 'yearly'
}

export const PAGES: readonly PublicPage[] = [
  { slug: 'home', path: '/', priority: '1.00', changefreq: 'weekly' },
  { slug: 'services', path: '/construction-services-in-bengaluru', priority: '0.90', changefreq: 'monthly' },
  { slug: 'packages', path: '/construction-packages-in-bengaluru', priority: '0.90', changefreq: 'monthly' },
  {
    slug: 'projects',
    path: '/best-construction-company-in-bengaluru-projects',
    priority: '0.80',
    changefreq: 'weekly',
  },
  { slug: 'bengaluru', path: '/best-construction-company-in-bengaluru', priority: '0.90', changefreq: 'monthly' },
  { slug: 'tumkur', path: '/construction-company-in-tumkur', priority: '0.90', changefreq: 'monthly' },
  { slug: 'about', path: '/about-us', priority: '0.70', changefreq: 'monthly' },
  { slug: 'contact', path: '/contact-us', priority: '0.80', changefreq: 'monthly' },
  { slug: 'terms', path: '/terms', priority: '0.30', changefreq: 'yearly' },
  { slug: 'privacy', path: '/privacy-policy', priority: '0.30', changefreq: 'yearly' },
]

/**
 * The file at the web root that serves a page.
 *
 * Derived from the public URL, not the slug. The two differ for eight of the
 * ten pages: slug "about" is served at /about-us, slug "projects" at
 * /best-construction-company-in-bengaluru-projects. Naming files after slugs
 * is the bug scripts/test-htaccess.mjs caught once already.
 */
export function pageFileFor(page: Pick<PublicPage, 'path'>): string {
  if (page.path === '/') return '/index.html'
  return page.path.replace(/\/+$/, '') + '.html'
}

/** Non-page files served verbatim, each asserted byte-identical by the freeze. */
export const INFRA_PATHS: readonly string[] = [
  '/robots.txt',
  '/sitemap.xml',
  '/humans.txt',
  '/llms.txt',
  '/llms-full.txt',
  '/.well-known/security.txt',
  '/097ee841c58a4b25b8eb2c348ca67dce.txt',
  '/google9706eb5d9d6a7b15.html',
]
