import { defineConfig } from 'vitest/config'

/**
 * The browser suite. One file today, and it exists because of a class of defect
 * neither of the other two suites can see.
 *
 * tsc reads types, `npm test` renders markup to a string, and
 * `npm run test:integration` executes SQL. None of them runs a browser, so none
 * of them can observe what a *policy* does to a page: a Content-Security-Policy
 * that blocks Alpine's expression evaluator leaves the HTML byte-identical, the
 * types unchanged and every query passing, while the page silently stops
 * behaving as its markup claims. DECISIONS 22.4 is that defect. Only a browser
 * enforcing a real CSP header can prove the fix.
 *
 * Kept out of `npm test` and out of CI on purpose. It needs Playwright's
 * chromium binary, which `.github/workflows/gates.yml` deliberately does not
 * install (`npm ci --ignore-scripts`, and the header there explains why a
 * faked pixel axis would be a green by substitution). This suite is in the same
 * category as `npm run parity` and `npm run test:htaccess`: real, local, and
 * absent from CI rather than approximated in it. Run it after touching
 * `public/assets/js/*.js`, the vendored Alpine, or anything about the CSP.
 *
 * Env comes from tests/setup-env.ts — obvious fakes — because the suite imports
 * a routes module to render the real component and src/env.ts validates at
 * import time. Nothing here opens a database connection.
 *
 * testTimeout is 30s rather than the integration suite's 10s: a cold chromium
 * launch on Windows is seconds by itself, and a timeout that fires on a slow
 * launch would make the gate flaky, which is how a gate gets ignored.
 */
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    setupFiles: ['tests/setup-env.ts'],
    environment: 'node',
    restoreMocks: true,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
})
