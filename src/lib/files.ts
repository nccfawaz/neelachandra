import { createWriteStream } from 'node:fs'
import { mkdir, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createHash } from 'node:crypto'
import type { Queryable } from '../db/kysely.js'
import { env } from '../env.js'
import { BadRequestError, UnprocessableError } from './errors.js'
import { today } from './dates.js'

/**
 * File upload with MIME sniffing and checksum (spec 2.7, 6.6 rule 6).
 *
 * ==========================================================================
 * PRECONDITION BEFORE ANY UPLOAD ROUTE LANDS -- DECISIONS.md 15.1
 *
 * `storeUpload` below has no callers and `GET /api/files/:id` has no handler.
 * Before either gains one:
 *
 *   1. Multipart CSRF must be covered. `csrfProtect` does not read the token
 *      out of a multipart body (`src/middleware/csrf.ts:29`) -- it skips the
 *      *body parse*, then still calls `verifyToken`, so the token has to
 *      arrive in the `x-csrf-token` header. A plain
 *      <form enctype="multipart/form-data"> is therefore REJECTED, not
 *      accepted. Post it through htmx instead: AppShell already sets
 *      hx-headers with the token on <body>, so `hx-post` +
 *      `hx-encoding="multipart/form-data"` passes as written.
 *      Do NOT satisfy this by exempting the route from `csrfProtect` or by
 *      bypassing `verifyToken` for multipart. An upload endpoint is the one
 *      route where a forged cross-site POST writes a file to disk as a real
 *      user.
 *
 *   2. `files` has `uploaded_by` and `visibility` and no `entity_type` /
 *      `entity_id`, so nothing on the row says which permission protects it.
 *      A serving route needs that decided first: 6.6 rule 6 puts an Aadhaar
 *      scan behind this route, and `uploaded_by` is not a permission check.
 * ==========================================================================
 *
 * Two locations chosen by sensitivity: UPLOAD_PUBLIC_DIR is served
 * statically, UPLOAD_PRIVATE_DIR is streamed through a permission check at
 * GET /api/files/:id. Both sit outside the repository so a deploy does not
 * delete uploads and a leaked filename does not leak a document.
 *
 * The declared Content-Type from the browser is not trusted. The first bytes
 * of the file are sniffed against a magic-number table, and a mismatch is a
 * rejection. Trusting the declared type is how a .php lands in a directory
 * that Apache will execute.
 */

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024

/** Magic numbers for the formats a construction site actually uploads. */
const SIGNATURES: Array<{ mime: string; ext: string; test: (b: Buffer) => boolean }> = [
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: 'image/png',
    ext: 'png',
    test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    mime: 'image/webp',
    ext: 'webp',
    test: (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP',
  },
  { mime: 'image/heic', ext: 'heic', test: (b) => b.subarray(4, 8).toString('ascii') === 'ftyp' && /hei|mif1|msf1/.test(b.subarray(8, 12).toString('ascii')) },
  { mime: 'application/pdf', ext: 'pdf', test: (b) => b.subarray(0, 5).toString('ascii') === '%PDF-' },
  {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ext: 'xlsx',
    // xlsx and docx are both zip containers; the distinction comes from the
    // declared type, which is only consulted after the container is proven.
    test: (b) => b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07),
  },
]

const ZIP_DECLARED_TYPES: Record<string, string> = {
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
}

export interface SniffResult {
  mime: string
  ext: string
}

export function sniff(head: Buffer, declaredType?: string | null): SniffResult {
  for (const sig of SIGNATURES) {
    if (sig.test(head)) {
      if (sig.ext === 'xlsx' && declaredType && ZIP_DECLARED_TYPES[declaredType]) {
        return { mime: declaredType, ext: ZIP_DECLARED_TYPES[declaredType]! }
      }
      return { mime: sig.mime, ext: sig.ext }
    }
  }
  throw new UnprocessableError(
    'That file type is not accepted. Upload a JPEG, PNG, WebP, HEIC, PDF or Office document.'
  )
}

export interface StoredFile {
  id: number
  storagePath: string
  mime: string
  sizeBytes: number
  sha256: string
}

/**
 * Writes an uploaded File to disk and inserts the files row.
 *
 * The stored name is a checksum-derived name under a year and month
 * directory, not the original name. Two reasons: the original name may
 * contain path separators or a double extension, and a site photo called
 * IMG_0001.jpg from ten phones collides ten times.
 */
export async function storeUpload(
  db: Queryable,
  file: File,
  opts: { uploadedBy: number | null; visibility?: 'private' | 'public' }
): Promise<StoredFile> {
  if (file.size <= 0) throw new BadRequestError('That file is empty.')
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new UnprocessableError(
      `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 15 MB. Photos taken on a phone can be resized before upload.`
    )
  }

  const bytes = Buffer.from(await file.arrayBuffer())
  const detected = sniff(bytes.subarray(0, 64), file.type || null)
  const sha256 = createHash('sha256').update(bytes).digest('hex')

  const visibility = opts.visibility ?? 'private'
  const root = visibility === 'public' ? env.UPLOAD_PUBLIC_DIR : env.UPLOAD_PRIVATE_DIR
  const day = today()
  const relDir = path.join(day.slice(0, 4), day.slice(5, 7))
  const relPath = path.join(relDir, `${sha256.slice(0, 32)}.${detected.ext}`)
  const absDir = path.resolve(root, relDir)
  const absPath = path.resolve(root, relPath)

  await mkdir(absDir, { recursive: true })

  // Identical content already on disk is not rewritten. Site photos of the
  // same drawing get uploaded repeatedly and the checksum name makes the
  // dedupe free.
  const exists = await stat(absPath).then(
    () => true,
    () => false
  )
  if (!exists) {
    await pipeline(async function* () {
      yield bytes
    }, createWriteStream(absPath, { mode: 0o640 }))
  }

  const inserted = await db
    .insertInto('files')
    .values({
      storage_path: relPath.split(path.sep).join('/'),
      original_name: safeOriginalName(file.name),
      mime: detected.mime,
      size_bytes: bytes.length,
      sha256,
      visibility,
      uploaded_by: opts.uploadedBy,
    })
    .executeTakeFirstOrThrow()

  return {
    id: Number(inserted.insertId),
    storagePath: relPath,
    mime: detected.mime,
    sizeBytes: bytes.length,
    sha256,
  }
}

function safeOriginalName(name: string): string {
  const base = path.basename(name || 'upload')
  return base.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255) || 'upload'
}

export function absolutePathFor(row: { storage_path: string; visibility: string }): string {
  const root = row.visibility === 'public' ? env.UPLOAD_PUBLIC_DIR : env.UPLOAD_PRIVATE_DIR
  const abs = path.resolve(root, row.storage_path)
  // Defence in depth against a storage_path that somehow contains "..".
  if (!abs.startsWith(path.resolve(root))) {
    throw new BadRequestError('Invalid file path')
  }
  return abs
}

export async function deleteStoredFile(
  db: Queryable,
  fileId: number
): Promise<void> {
  const row = await db
    .selectFrom('files')
    .select(['storage_path', 'visibility'])
    .where('id', '=', fileId)
    .executeTakeFirst()
  if (!row) return
  await db.deleteFrom('files').where('id', '=', fileId).execute()
  await unlink(absolutePathFor(row)).catch(() => {
    // The row is gone, which is what matters. An orphan on disk is a
    // housekeeping matter, not a request failure.
  })
}

export async function ensureUploadDirs(): Promise<void> {
  await mkdir(path.resolve(env.UPLOAD_PRIVATE_DIR), { recursive: true })
  await mkdir(path.resolve(env.UPLOAD_PUBLIC_DIR), { recursive: true })
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
