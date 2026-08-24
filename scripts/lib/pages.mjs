// The canonical page list for the public site.
//
// These are the 10 URLs published in the live sitemap.xml, verified against
// $staticPages in the legacy sitemap.php. Slug order here is the order every
// report in this toolchain uses, so it is stable and diffable.
//
// Do not add a page here without also adding it to the spec. This list is the
// definition of "the public site" for the design and content freeze.

export const ORIGIN = process.env.NCC_ORIGIN ?? 'https://neelachandra.com'

export const PAGES = [
  { slug: 'home', path: '/' },
  { slug: 'services', path: '/construction-services-in-bengaluru' },
  { slug: 'packages', path: '/construction-packages-in-bengaluru' },
  { slug: 'projects', path: '/best-construction-company-in-bengaluru-projects' },
  { slug: 'bengaluru', path: '/best-construction-company-in-bengaluru' },
  { slug: 'tumkur', path: '/construction-company-in-tumkur' },
  { slug: 'about', path: '/about-us' },
  { slug: 'contact', path: '/contact-us' },
  { slug: 'terms', path: '/terms' },
  { slug: 'privacy', path: '/privacy-policy' },
]

// Viewports for the screenshot comparison. Desktop, tablet, phone.
// 390 is iPhone 14/15 logical width, which is the realistic low end for a
// client browsing on the site.
export const VIEWPORTS = [1440, 768, 390]

// Non-page files that must survive byte-identical or with only the corrections
// listed in spec 7.5 item 6. Captured so a later diff can prove it.
export const INFRA_FILES = [
  '/robots.txt',
  '/sitemap.xml',
  '/site.webmanifest',
  '/humans.txt',
  '/llms.txt',
  '/llms-full.txt',
  '/security.txt',
  '/.well-known/security.txt',
  '/097ee841c58a4b25b8eb2c348ca67dce.txt',
  '/google9706eb5d9d6a7b15.html',
]

export function urlFor (path, origin = ORIGIN) {
  return new URL(path, origin).toString()
}
