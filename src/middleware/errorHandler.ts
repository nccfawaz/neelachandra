import type { Context, ErrorHandler, NotFoundHandler } from 'hono'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { HTTPException } from 'hono/http-exception'
import { isAppError, RateLimitError } from '../lib/errors.js'
import { isProd } from '../env.js'
import type { AppEnv } from '../types.js'

/**
 * Replaces error.php for all 4xx and 5xx (spec 3.1 rule 6).
 *
 * The copy lives in one ERROR_COPY record so the 30 ErrorDocument lines in
 * .htaccess are no longer needed, and the wording is the same wording the
 * generated static pages already carry (scripts/build-error-pages.mjs), so a
 * request served by Apache and a request served by Node say the same thing.
 *
 * Presentation is not re-invented here. The static page built from the golden
 * donor is read from disk and served, because inventing a second error design
 * inside the app would put two different looks on the same site.
 */

export const ERROR_COPY: Record<number, { title: string; body: string }> = {
  400: { title: 'Bad request', body: 'The request could not be understood. Check the address and try again.' },
  401: { title: 'Sign in required', body: 'This area needs valid credentials.' },
  403: { title: 'Access denied', body: 'You do not have permission to view this resource.' },
  404: {
    title: 'Page not found',
    body: 'The page you asked for does not exist, or it has moved. The links below cover everything on the site.',
  },
  405: { title: 'Method not allowed', body: 'That action is not supported on this address.' },
  408: { title: 'Request timed out', body: 'The connection took too long. Please try again.' },
  409: { title: 'Conflict', body: 'Someone else changed this record while you were editing it. Reload and try again.' },
  410: { title: 'Page removed', body: 'This page has been permanently removed.' },
  422: { title: 'Could not save', body: 'Some of the values submitted are not valid. Correct them and try again.' },
  429: { title: 'Too many requests', body: 'Please wait a moment before trying again.' },
  500: { title: 'Something went wrong', body: 'An error occurred on our side. Please try again shortly.' },
  502: { title: 'Bad gateway', body: 'A server upstream returned an invalid response. Please try again shortly.' },
  503: {
    title: 'Temporarily unavailable',
    body: 'The site is briefly unavailable, usually for maintenance. Please try again shortly.',
  },
  504: { title: 'Gateway timed out', body: 'A server upstream took too long to respond. Please try again shortly.' },
}

// Codes that have a pre-built static page at the web root. The others fall
// back to the nearest built page so the chrome is still correct.
const BUILT = new Set([400, 401, 403, 404, 405, 408, 410, 429, 500, 502, 503, 504])
const SUBSTITUTE: Record<number, number> = { 409: 400, 422: 400 }

const SITE_ROOT = process.env.NCC_SITE_ROOT ?? process.cwd()
const cache = new Map<number, string>()

async function staticErrorPage(code: number): Promise<string | null> {
  const file = BUILT.has(code) ? code : SUBSTITUTE[code]
  if (!file) return null
  const hit = cache.get(file)
  if (hit) return hit
  try {
    const html = await readFile(path.join(SITE_ROOT, `${file}.html`), 'utf8')
    cache.set(file, html)
    return html
  } catch {
    return null
  }
}

/**
 * Minimal fallback for when the static page is absent, which happens in a
 * bare test checkout. Deliberately plain: it is not a design, it is a
 * last resort that must never be mistaken for one.
 */
function fallbackPage(code: number, copy: { title: string; body: string }): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${code} ${copy.title} | Neelachandra Construction</title>
<meta name="robots" content="noindex, follow"></head>
<body><h1>${code} ${copy.title}</h1><p>${copy.body}</p><p><a href="/">Home</a></p></body></html>`
}

function statusOf(err: unknown): number {
  if (isAppError(err)) return err.status
  if (err instanceof HTTPException) return err.status
  return 500
}

function wantsJson(c: Context<AppEnv>): boolean {
  if (c.req.header('hx-request')) return false
  const accept = c.req.header('accept') ?? ''
  if (accept.includes('application/json')) return true
  return new URL(c.req.url).pathname.startsWith('/api/')
}

async function respond(c: Context<AppEnv>, code: number, message: string, detail?: unknown) {
  const copy = ERROR_COPY[code] ?? ERROR_COPY[500]!
  c.status(code as 400)

  if (wantsJson(c)) {
    return c.json({ error: { status: code, title: copy.title, message, detail } })
  }

  // htmx expects a fragment, not a whole document. Swapping a full <html>
  // into a div is how an error turns a working page into nested chrome.
  if (c.req.header('hx-request')) {
    return c.html(
      `<div class="ncc-alert ncc-alert--error" role="alert"><strong>${copy.title}.</strong> ${message}</div>`
    )
  }

  const page = await staticErrorPage(code)
  return c.html(page ?? fallbackPage(code, copy))
}

export const errorHandler: ErrorHandler<AppEnv> = async (err, c) => {
  const code = statusOf(err)

  if (err instanceof RateLimitError) {
    c.header('Retry-After', String(err.retryAfterSeconds))
  }

  // 5xx is a bug in this codebase, so it is logged with the request id and
  // the stack. 4xx is a user or client mistake and logging every one of them
  // just fills the log with 404s from scanners.
  if (code >= 500) {
    console.error(
      `[${c.get('requestId') ?? '-'}] ${c.req.method} ${new URL(c.req.url).pathname} -> ${code}`,
      err
    )
  }

  // The message of a 5xx is never shown to the user in production: an
  // exception text can carry a table name, a column list or a query.
  const message =
    code >= 500 && isProd
      ? (ERROR_COPY[500]?.body ?? 'An error occurred.')
      : isAppError(err) || err instanceof HTTPException
        ? err.message
        : (ERROR_COPY[code]?.body ?? 'An error occurred.')

  const detail = isAppError(err) && !isProd ? err.detail : undefined
  return respond(c, code, message, detail)
}

export const notFoundHandler: NotFoundHandler<AppEnv> = async (c) => {
  return respond(c, 404, ERROR_COPY[404]!.body)
}
