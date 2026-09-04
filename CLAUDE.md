# Working notes for this repository

`DECISIONS.md` is the binding record of choices; `NCC_BUILD_SPEC.md` is the authority
and wins over any instruction in a prompt. This file holds only the things that have
already cost a session real time.

## Verification: a command that exits 0 having done nothing is not a pass

**The path is nested.** The extracted tree is
`C:\Users\HP\Downloads\neelachandra-main\neelachandra-main` — the project root is one
level *below* the directory of the same name. `tsconfig.json`, `package.json` and
`migrations/` are all in the inner one.

**Do not assume the working directory.** The harness prints `Shell cwd was reset to
C:\Users\HP\Downloads\neelachandra-main` after any `cd` out of the tree, and that path is
the *outer* directory. Whether a given call actually starts there or where the previous
one ended is not reliably observable, so treat it as unknown and make every verification
command carry its own `cd`:

```bash
cd /c/Users/HP/Downloads/neelachandra-main/neelachandra-main && npx tsc --noEmit
```

Run from the outer directory, `npx tsc --noEmit` finds no `tsconfig.json`, type-checks
nothing, prints nothing and **exits 0**. It is indistinguishable from a clean build in
every observable way except the one that matters. This has been reported as a green
once, on 2026-09-04, and caught only because the output was empty when 60 files should
have produced at least a file count.

That is the same shape as the pool hang of 2026-09-03 (fixed in `38ca44f`): every
Kysely query hung forever while `npm test` stayed green, because the suite never opened
a connection. Both are a gate that passes by not executing.

The rule that covers both: **a green is only a green if you can say what it executed.**
Before reporting a pass, check that the command found its config, that the counts are
non-zero, and that the number of files or tests is the number you expect. Prefer the
`package.json` scripts (`npm run typecheck`, `npm test`, `npm run test:integration`)
over bare binaries — they carry `-p tsconfig.json` and the config path with them, so
they fail loudly from the wrong directory instead of quietly.

## The database is not optional to verification

`npm test` opens no connection: it is evidence about pure functions and form contracts
only. `npm run test:integration` needs the persistent dev MariaDB on port **3307** and
throws rather than falling back, which is deliberate. Do not tear that database down.
