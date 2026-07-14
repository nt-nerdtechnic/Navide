import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let app: ElectronApplication
let mainWindow: Page
let editorWindow: Page
let root: string
let workspaceOne: string
let workspaceTwo: string

async function waitForBackend(page: Page): Promise<void> {
  await page.waitForFunction(
    async () => {
      const api = (window as unknown as {
        agentTeam?: { getBackendInfo?: () => Promise<{ status: string }> }
      }).agentTeam
      return (await api?.getBackendInfo?.())?.status === 'ready'
    },
    null,
    { timeout: 40_000 }
  )
}

async function openEditorFile(
  page: Page,
  workspacePath: string,
  filepath: string,
  line?: number
): Promise<void> {
  await page.evaluate(
    async ({ workspacePath, filepath, line }) => {
      const api = (window as unknown as {
        agentTeam?: {
          openEditorWindow?: (args: {
            workspace_path: string
            filepath: string
            line?: number
          }) => Promise<{ ok: boolean }>
        }
      }).agentTeam
      await api?.openEditorWindow?.({ workspace_path: workspacePath, filepath, line })
    },
    { workspacePath, filepath, line }
  )
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'agent-team-editor-e2e-'))
  workspaceOne = join(root, 'workspace-one')
  workspaceTwo = join(root, 'workspace-two')
  mkdirSync(workspaceOne)
  mkdirSync(workspaceTwo)
  writeFileSync(join(workspaceOne, 'alpha.ts'), 'const one = 1\nconst two = 2\nconst three = 3\n')
  writeFileSync(join(workspaceOne, 'beta.yaml'), 'name: beta\nenabled: true\n')
  writeFileSync(join(workspaceOne, 'gamma.md'), '# Gamma\n')
  writeFileSync(join(workspaceTwo, 'other.ts'), 'export const other = true\n')

  app = await electron.launch({
    args: [join(__dirname, '..'), `--user-data-dir=${join(root, 'user-data')}`],
    env: { ...process.env, NODE_ENV: 'production' },
  })
  mainWindow = await app.firstWindow()
  await mainWindow.waitForLoadState('domcontentloaded')
  await waitForBackend(mainWindow)
})

test.afterAll(async () => {
  await app?.close()
  if (root) rmSync(root, { recursive: true, force: true })
})

test('built editor safely handles rapid same-workspace opens and a workspace switch', async () => {
  const editorCreated = app.waitForEvent('window')
  await Promise.all([
    openEditorFile(mainWindow, workspaceOne, 'alpha.ts', 2),
    openEditorFile(mainWindow, workspaceOne, 'beta.yaml'),
    openEditorFile(mainWindow, workspaceOne, 'gamma.md'),
  ])
  editorWindow = await editorCreated
  await editorWindow.waitForLoadState('domcontentloaded')

  await expect(editorWindow.locator('.ide-tab-name')).toHaveText([
    'alpha.ts',
    'beta.yaml',
    'gamma.md',
  ])
  expect(app.windows()).toHaveLength(2)
  expect(new URL(editorWindow.url()).pathname).toMatch(/\/renderer\/index\.html$/)

  await editorWindow.evaluate(() => {
    ;(window as unknown as { __editorE2eMarker?: string }).__editorE2eMarker = 'same-renderer'
  })
  await openEditorFile(mainWindow, workspaceOne, 'alpha.ts', 3)

  await expect(editorWindow.locator('.ide-tab.active .ide-tab-name')).toHaveText('alpha.ts')
  await expect(editorWindow.locator('.ep-status-pos:visible')).toHaveText(/Ln 3, Col 1/)
  expect(await editorWindow.evaluate(
    () => (window as unknown as { __editorE2eMarker?: string }).__editorE2eMarker
  )).toBe('same-renderer')

  await Promise.all([
    editorWindow.waitForNavigation(),
    openEditorFile(mainWindow, workspaceTwo, 'other.ts'),
  ])

  await expect(editorWindow.locator('.ide-tab-name')).toHaveText(['other.ts'])
  expect(new URL(editorWindow.url()).searchParams.get('workspace_path')).toBe(workspaceTwo)
  expect(await editorWindow.evaluate(
    () => (window as unknown as { __editorE2eMarker?: string }).__editorE2eMarker
  )).toBeUndefined()
})
