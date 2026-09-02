import { serve } from '@hono/node-server'
import app from './app.js'
import { env, isProd } from './env.js'
import { assertDatabaseReady, closePool } from './db/pool.js'
import { ensureUploadDirs } from './lib/files.js'

/**
 * Process entry (spec 2.1, 2.12).
 *
 * Boot order matters. The database and the upload directories are checked
 * before the port is opened, so a misconfigured deploy fails immediately and
 * visibly rather than accepting traffic and returning 500 per request. On
 * Hostinger a process that exits on boot shows up in the app log; a process
 * that serves errors looks healthy.
 */

async function main(): Promise<void> {
  await assertDatabaseReady()
  await ensureUploadDirs()

  const server = serve({ fetch: app.fetch, port: env.PORT, hostname: '0.0.0.0' }, (info) => {
    console.log(
      `[ncc] listening on http://0.0.0.0:${info.port} (${isProd ? 'production' : env.NODE_ENV})`
    )
  })

  /**
   * Hostinger stops the app with SIGTERM. Without this the process is killed
   * mid-request and the connection pool is dropped without a QUIT, which
   * leaves MariaDB holding sessions until they time out. Ten users cannot
   * exhaust max_connections, but a redeploy loop can.
   */
  let shuttingDown = false
  const shutdown = (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[ncc] ${signal} received, closing`)
    server.close(() => {
      void closePool().finally(() => process.exit(0))
    })
    // A request that will not finish must not hold the deploy open forever.
    setTimeout(() => process.exit(0), 10_000).unref()
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  // An unhandled rejection leaves the process in an unknown state. Logging
  // and continuing is how a subtle data bug survives to production, so it is
  // logged loudly and the process ends; the platform restarts it clean.
  process.on('unhandledRejection', (reason) => {
    console.error('[ncc] unhandled rejection', reason)
    shutdown('unhandledRejection')
  })
}

main().catch((err) => {
  console.error('[ncc] failed to start', err)
  process.exit(1)
})
