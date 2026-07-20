import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'

// ── Mini-IDE plugin bundle (Phase 2 M4) ──────────────────────────────────────
// A SEPARATE Vite build from the core renderer (electron.vite.config.ts). The
// separation is load-bearing: it lets this bundle alias `composables/useBackend`
// to the `capabilityBackend` shim WITHOUT touching the core renderer, which
// keeps its real WebSocket-backed `useBackend`. (A shared build can't diverge a
// module per entry — EditorWindowApp is one module in the graph — so the design
// calls for core and plugin to "each build their own copy, not runtime-shared".)
//
// Output: out/renderer/plugins/mini-ide/ — the host loads it via `loadFile`
// exactly like the noop/fs_probe plugins. Wired into `pnpm build` after
// `electron-vite build` so out/renderer already exists.

const APP_VERSION: string = JSON.parse(
  readFileSync(resolve(__dirname, 'package.json'), 'utf-8')
).version

// Root at the plugin dir so its index.html emits directly at the outDir root
// (out/renderer/plugins/mini-ide/index.html) rather than nested. Imports reach
// outside this root into src/ — fine for a build (no dev-server fs restriction).
const pluginRoot = resolve(__dirname, 'src/renderer/plugins/mini-ide')
const capabilityBackend = resolve(pluginRoot, 'capabilityBackend')

export default defineConfig({
  root: pluginRoot,
  // Relative base so emitted asset URLs resolve under file:// in the packaged
  // WebContentsView (no dev server here — this entry is always loadFile'd).
  base: './',
  plugins: [vue()],
  resolve: {
    // Redirect the mini-IDE's `useBackend` to the capability shim — for THIS
    // bundle only. Covers every relative form the tree uses:
    //   ./composables/useBackend  ../composables/useBackend
    //   ../../composables/useBackend  ./useBackend  ../useBackend
    alias: [
      { find: /^(?:\.\.?\/)+(?:composables\/)?useBackend$/, replacement: capabilityBackend },
    ],
  },
  define: {
    __APP_BUILD__: JSON.stringify(`v${APP_VERSION} plugin`),
  },
  optimizeDeps: {
    include: ['monaco-editor'],
  },
  build: {
    outDir: resolve(__dirname, 'out/renderer/plugins/mini-ide'),
    emptyOutDir: true,
    rollupOptions: {
      input: { index: resolve(pluginRoot, 'index.html') },
    },
  },
})
