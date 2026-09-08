#!/usr/bin/env node
// Starts the local dev stack: MariaDB on 3307 if it is not already listening,
// then the dev server with .env loaded.
//
// Why this exists: `tsx watch src/server.ts` does not load .env on this
// machine's tsx version, so `npm run dev` died with eight "missing" variables
// while the file sat complete at the project root (DECISIONS 25.1). The dev
// script now carries --env-file=.env itself, and this script is the one
// command that brings the whole stack up for a fresh session.
//
// MariaDB is NOT torn down by this script. The persistent dev database at
// C:/Users/HP/ncc-devdb outlives every session (CLAUDE.md); this only starts
// it when nothing is listening on 3307.

import net from 'node:net'
import { spawn } from 'node:child_process'
import process from 'node:process'

const MARIADB_PORT = 3307
const APP_PORT = Number(process.env.PORT ?? 3000)
const MARIADB_BIN = 'C:/Users/HP/ncc-devdb/mariadb-11.4.4-winx64/bin/mysqld.exe'
const MARIADB_CONF = 'C:/Users/HP/ncc-devdb/data/my.ini'

function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => {
      socket.destroy()
      resolve(false)
    })
    socket.setTimeout(1500, () => {
      socket.destroy()
      resolve(false)
    })
  })
}

async function waitForPort(port, timeoutMs, everyMs = 500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true
    await new Promise((r) => setTimeout(r, everyMs))
  }
  return false
}

async function main() {
  if (await portOpen(MARIADB_PORT)) {
    console.log(`[dev-stack] MariaDB already listening on ${MARIADB_PORT}`)
  } else {
    console.log(`[dev-stack] starting MariaDB (${MARIADB_BIN}) ...`)
    const mysqld = spawn(MARIADB_BIN, ['--defaults-file=' + MARIADB_CONF, '--console'], {
      stdio: 'ignore',
      detached: true,
    })
    mysqld.unref()
    const up = await waitForPort(MARIADB_PORT, 30_000)
    if (!up) {
      console.error(`[dev-stack] MariaDB did not open ${MARIADB_PORT} within 30s`)
      process.exit(1)
    }
    console.log(`[dev-stack] MariaDB up on ${MARIADB_PORT}`)
  }

  // The child carries --env-file=.env itself, so no .env parsing is needed
  // here; PORT is forwarded because the machine-level PORT=0 override would
  // otherwise win over .env (run doc). Inherit stdio so tsx watch's output
  // and the app's logs are visible. Ctrl-C stops the server; MariaDB, started
  // detached, stays up.
  const child = spawn(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'watch', '--env-file=.env', 'src/server.ts'],
    { stdio: 'inherit', env: { ...process.env, PORT: String(APP_PORT) } }
  )
  child.on('exit', (code) => process.exit(code ?? 0))
}

main()
