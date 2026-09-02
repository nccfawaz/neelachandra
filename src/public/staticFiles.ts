import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * Serving the frozen public site from disk (spec 3.2).
 *
 * The ten marketing pages are not JSX. They are the byte output of
 * scripts/build-site.mjs, which is golden-plus-corrections, and the parity
 * gate asserts that. Re-expressing them as components would mean the gate
 * compares a build artefact against a second build artefact, and the freeze
 * would be enforced against nothing. So Node reads the same files Apache
 * would have served.
 *
 * Files are read once and cached in memory with a strong ETag. The whole site
 * is well under a megabyte and the Hostinger process is long lived, so a
 * cache miss per file per boot is the entire cost. Cache is keyed by resolved
 * absolute path, and paths are resolved through a containment check, so a
 * traversal attempt cannot reach outside the site root.
 */

const SITE_ROOT = path.resolve(process.env.NCC_SITE_ROOT ?? process.cwd())

export interface StaticAsset {
  body: Buffer
  contentType: string
  etag: string
}

const cache = new Map<string, StaticAsset | null>()

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.pdf': 'application/pdf',
}

export function contentTypeFor(file: string): string {
  return TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Resolves a request path to a file inside the site root, or null.
 *
 * The containment check compares the resolved path against the root with a
 * separator suffix. Comparing with startsWith on the bare root would accept
 * a sibling directory whose name merely begins with the root's name.
 */
function safeResolve(relative: string): string | null {
  const decoded = (() => {
    try {
      return decodeURIComponent(relative)
    } catch {
      return null
    }
  })()
  if (decoded === null) return null
  if (decoded.includes('\0')) return null

  const full = path.resolve(SITE_ROOT, '.' + (decoded.startsWith('/') ? decoded : '/' + decoded))
  if (full !== SITE_ROOT && !full.startsWith(SITE_ROOT + path.sep)) return null
  return full
}

export async function loadStatic(relative: string): Promise<StaticAsset | null> {
  const full = safeResolve(relative)
  if (full === null) return null

  const cached = cache.get(full)
  if (cached !== undefined) return cached

  let asset: StaticAsset | null = null
  try {
    const stat = await fs.stat(full)
    if (stat.isFile()) {
      const body = await fs.readFile(full)
      asset = {
        body,
        contentType: contentTypeFor(full),
        etag: '"' + crypto.createHash('sha256').update(body).digest('base64url').slice(0, 27) + '"',
      }
    }
  } catch {
    asset = null
  }

  cache.set(full, asset)
  return asset
}

/** Test and deploy hook: forgets everything so a rebuild is picked up. */
export function clearStaticCache(): void {
  cache.clear()
}

export { SITE_ROOT }
