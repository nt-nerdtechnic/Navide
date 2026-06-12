import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

// Drives the built Electron app end-to-end:
//   1. it launches and shows the Welcome (workspace-first) entry screen
//   2. picking a workspace (native dialog stubbed) enters the main UI
// Run order matters (shared app instance), so workers=1 in playwright.config.

let app: ElectronApplication
let page: Page
let tmp: string | undefined

test.beforeAll(async () => {
  app = await electron.launch({
    args: [join(__dirname, '..')], // project root → package.json main = out/main/index.js
    env: { ...process.env, NODE_ENV: 'production' }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  await app?.close()
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

test('launches and shows the Welcome entry screen', async () => {
  await expect(page.locator('h1', { hasText: 'Agent-Team' })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('Open Workspace')).toBeVisible()
})

test('picking a workspace via Browse enters the main UI', async () => {
  tmp = mkdtempSync(join(tmpdir(), 'agent-team-e2e-'))

  // Stub the native folder picker (main process) to return our temp workspace.
  await app.evaluate(async ({ dialog }, dir) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as any
  }, tmp)

  // workspace.touch() is a WS round-trip; wait until the backend is ready so
  // the selection actually completes and the Welcome overlay detaches.
  await page.waitForFunction(
    async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const info = await (window as any).agentTeam?.getBackendInfo?.()
      return info?.status === 'ready'
    },
    null,
    { timeout: 40_000 }
  )
  await page.waitForTimeout(1500) // let the renderer WebSocket finish connecting

  // The main UI (ControlPane) is mounted *behind* the Welcome overlay, so it
  // also has a Browse button — scope strictly to the overlay to avoid ambiguity.
  const welcome = page.locator('.welcome-overlay')
  const browseBtn = welcome.getByRole('button', { name: /Browse/ })
  // Retry the Browse click to absorb the WS-connect race; once touch() succeeds
  // the Welcome overlay detaches and we're in the main UI.
  await expect(async () => {
    await browseBtn.click()
    await expect(welcome).toBeHidden({ timeout: 4000 })
  }).toPass({ timeout: 30_000 })

  // Welcome gate is gone → main UI is now the active screen.
  await expect(welcome).toHaveCount(0)
})
