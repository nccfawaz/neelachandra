#!/usr/bin/env node
/**
 * tsc compiles .ts and ignores everything else, but src/lib/password.ts
 * reads data/common-passwords.txt at runtime relative to its own compiled
 * location. Without this step the production build boots and then throws the
 * first time somebody sets a password.
 */
import { cp, mkdir, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const pairs = [['src/lib/data', 'dist/lib/data']]

for (const [from, to] of pairs) {
  const src = path.join(root, from)
  const dest = path.join(root, to)
  if (!existsSync(src)) {
    console.error(`copy-runtime-data: missing ${from}`)
    process.exit(1)
  }
  await mkdir(dest, { recursive: true })
  await cp(src, dest, { recursive: true })
  const files = await readdir(dest)
  console.log(`copy-runtime-data: ${from} -> ${to} (${files.length} file(s))`)
}
