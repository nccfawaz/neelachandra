# Sandbox scaffold (archived, not part of the build)

These six files are the unmodified Cloudflare Pages starter template that the
build sandbox generated before any work on this project began. They are kept
here only so the repository contains every file that existed on disk.

**Do not use them. Do not copy them back to the repository root.**

## Why they are archived instead of live

This project targets **Hostinger Node.js + MariaDB**. See
`NCC_BUILD_SPEC.md` section 2 for the committed stack.

If `wrangler.jsonc`, `vite.config.ts` and `tsconfig.json` sat at the repository
root, they would be picked up automatically by tooling and would point an
implementer at Cloudflare Workers. That target cannot run this application:

- Cloudflare Workers cannot hold a pooled MySQL/MariaDB connection over a TCP
  socket, which is what `mysql2/promise` plus Kysely requires.
- Nodemailer over `smtp.hostinger.com:465` needs raw TCP, unavailable in Workers.
- `@node-rs/argon2` is a native addon and will not load in the Workers runtime.
- The spec's session, rate limit and cron design assumes a sleeping and
  restarting Node process on Hostinger, not an edge isolate.

The scaffold also declares the project name `webapp`, which is not this project.

## File inventory

| Archived path                     | Original path             | Contents             |
| --------------------------------- | ------------------------- | -------------------- |
| `wrangler.jsonc`                  | `/wrangler.jsonc`         | Starter, name webapp |
| `vite.config.ts`                  | `/vite.config.ts`         | Cloudflare Pages build |
| `tsconfig.json`                   | `/tsconfig.json`          | Starter compiler options |
| `src/index.tsx`                   | `/src/index.tsx`          | Hello world route    |
| `src/renderer.tsx`                | `/src/renderer.tsx`       | Starter jsxRenderer  |
| `public/static/style.css`         | `/public/static/style.css`| One h1 font rule     |

Every file is byte-identical to what the sandbox generated. None contains any
Neelachandra code, content or configuration.

## One part worth keeping

`tsconfig.json` sets the correct JSX pragma for Hono:

```json
"jsx": "react-jsx",
"jsxImportSource": "hono/jsx"
```

The real `tsconfig.json`, written in phase 1, needs those two settings because
the public site is rendered with `hono/jsx`. Everything else in these files is
Cloudflare specific and should be discarded.
