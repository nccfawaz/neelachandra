import { defineConfig } from 'vite'

// Client asset build only (spec 2.11). The server is compiled by tsc into
// dist/, and the public marketing pages are static HTML, so the only thing
// this build does is minify the dashboard stylesheet from
// src/dashboard/assets into public/assets/css. There is no JS bundle:
// dashboard interactivity is htmx plus Alpine loaded directly from
// public/assets/vendor.
export default defineConfig({
  // public/ is managed by hand (spec tree section 3): favicon, per-page css,
  // images, vendor libs. Vite must not treat it as its own public dir or
  // copy it into the build output.
  publicDir: false,
  build: {
    outDir: 'public',
    emptyOutDir: false,
    rollupOptions: {
      input: {
        dashboard: 'src/dashboard/assets/css/dashboard.css',
      },
      output: {
        // Stable, unhashed names: server-rendered HTML references these
        // paths directly.
        assetFileNames: 'assets/css/[name][extname]',
      },
    },
  },
})
