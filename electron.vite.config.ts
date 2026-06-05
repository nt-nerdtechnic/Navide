import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { resolve, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

// ── App version ──────────────────────────────────────────────────────────────
// 手動維護的版本號 —— 每次有意義的改動就在這裡 bump。
// 不用 git hash 當版本（hash 對人不直觀，未 commit 的 dirty 改動也不會反映）。
const APP_VERSION = '0.1.6'

// Build-time tag shown in the header: "v<APP_VERSION> @MM/DD HH:mm".
// The timestamp distinguishes each dev-mode launch; the version string stays
// fixed until you bump APP_VERSION above.
function buildTag(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  return `v${APP_VERSION} @${stamp}`
}

const APP_BUILD = buildTag()

// Generate a fresh random token each dev session and write to tmpdir.
// The Electron main process reads this file and injects the token into every
// renderer request via session.webRequest — browsers can't guess the token.
const DEV_TOKEN = randomBytes(32).toString('hex')
writeFileSync(join(tmpdir(), 'agent-team-dev-token'), DEV_TOKEN)

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/main/index.ts')
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts')
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    server: {
      port: 5174,
    },
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html')
      }
    },
    define: {
      __APP_BUILD__: JSON.stringify(APP_BUILD)
    },
    plugins: [
      vue(),
      // Block all non-Electron requests with a per-session random token.
      // The main process reads the token from tmpdir and injects it via
      // session.webRequest — no browser can guess a 32-byte random value.
      {
        name: 'electron-only',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.headers['x-electron-token'] !== DEV_TOKEN) {
              res.writeHead(403, { 'Content-Type': 'text/plain' })
              res.end('403 Forbidden')
              return
            }
            next()
          })
        },
      },
    ]
  }
})
