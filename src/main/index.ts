import { app, BrowserWindow, dialog, ipcMain, nativeImage, session, shell } from 'electron'
import { join } from 'node:path'
import { writeFile, readFile, mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { startBackend, type BackendHandle } from './backend'

// Give the Electron process a distinct name so it can be targeted precisely
// with `pkill -f agent-team-electron` without affecting other Electron apps.
process.title = 'agent-team-electron'

if (process.platform === 'darwin') {
  app.dock.setIcon(nativeImage.createFromPath(join(__dirname, '../../resources/icon.png')))
}

let backend: BackendHandle | null = null
let mainWindow: BrowserWindow | null = null
let rolesWindow: BrowserWindow | null = null
let stagesWindow: BrowserWindow | null = null
let editorWindow: BrowserWindow | null = null

function loadWindow(win: BrowserWindow, params: Record<string, string>): void {
  const qs = new URLSearchParams(params).toString()
  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}${qs ? '?' + qs : ''}`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { search: qs ? '?' + qs : '' })
  }
}

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Agent-Team',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  loadWindow(win, { window: 'main' })
}

function openRolesWindow(): void {
  if (rolesWindow && !rolesWindow.isDestroyed()) {
    rolesWindow.focus()
    return
  }
  const win = new BrowserWindow({
    width: 900,
    height: 720,
    title: 'Agent-Team · Role Manager',
    parent: mainWindow ?? undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  rolesWindow = win
  win.on('closed', () => {
    if (rolesWindow === win) rolesWindow = null
  })
  loadWindow(win, { window: 'roles' })
}

ipcMain.handle('backend:info', () => {
  if (!backend) return { status: 'starting' as const }
  return {
    status: 'ready' as const,
    host: backend.host,
    port: backend.port,
    httpUrl: `http://${backend.host}:${backend.port}`,
    wsUrl: `ws://${backend.host}:${backend.port}/ws`
  }
})

ipcMain.handle('workspace:pick', async (_event, defaultPath?: string) => {
  const opts: Electron.OpenDialogOptions = {
    title: 'Pick workspace folder',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Use this folder'
  }
  if (defaultPath && typeof defaultPath === 'string') opts.defaultPath = defaultPath

  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, opts)
    : await dialog.showOpenDialog(opts)

  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

function openStagesWindow(): void {
  if (stagesWindow && !stagesWindow.isDestroyed()) {
    stagesWindow.focus()
    return
  }
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    title: 'Agent-Team · Stage Manager',
    parent: mainWindow ?? undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  stagesWindow = win
  win.on('closed', () => {
    if (stagesWindow === win) stagesWindow = null
  })
  loadWindow(win, { window: 'stages' })
}

function openDiffWindow(params: Record<string, string>): void {
  // Editor window already open — send IPC so it opens a diff tab without reload.
  if (editorWindow && !editorWindow.isDestroyed()) {
    editorWindow.webContents.send('editor:openDiff', params)
    editorWindow.focus()
    return
  }
  // No editor window yet — open one with the diff pre-loaded via URL params.
  // EditorWindowApp reads diff_filepath/diff_staged on startup and opens the tab.
  openEditorWindow({
    workspace_path: params.workspace_path,
    diff_filepath: params.filepath,
    diff_staged: params.staged,
    diff_name: params.name ?? params.filepath,
  })
}

ipcMain.handle('window:openRoles', () => {
  openRolesWindow()
  return { ok: true }
})

ipcMain.handle('window:openStages', () => {
  openStagesWindow()
  return { ok: true }
})

ipcMain.handle('window:openDiff', (_event, args: Record<string, string>) => {
  openDiffWindow(args ?? {})
  return { ok: true }
})

function openBranchDiffWindow(params: Record<string, string>): void {
  if (editorWindow && !editorWindow.isDestroyed()) {
    editorWindow.webContents.send('editor:openBranchDiff', params)
    editorWindow.focus()
    return
  }
  openEditorWindow({
    workspace_path: params.workspace_path,
    branch_diff_base: params.branch_diff_base ?? 'main',
    branch_diff_compare: params.branch_diff_compare ?? '',
  })
}

ipcMain.handle('window:openBranchDiff', (_event, args: Record<string, string>) => {
  openBranchDiffWindow(args ?? {})
  return { ok: true }
})

function openEditorWindow(params: Record<string, string>): void {
  const search = { window: 'editor', ...params }
  if (editorWindow && !editorWindow.isDestroyed()) {
    // If only switching sidebar (no new file), avoid reload — just focus + notify sidebar.
    if (!params.filepath && params.sidebar) {
      editorWindow.webContents.send('editor:switchSidebar', params.sidebar)
      editorWindow.focus()
      return
    }
    loadWindow(editorWindow, search)
    editorWindow.focus()
    return
  }
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: 'Agent-Team · Editor',
    parent: mainWindow ?? undefined,
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  editorWindow = win
  win.on('closed', () => {
    if (editorWindow === win) editorWindow = null
  })
  loadWindow(win, search)
}

ipcMain.handle('window:openEditor', (_event, args: Record<string, string>) => {
  openEditorWindow(args ?? {})
  return { ok: true }
})

ipcMain.handle(
  'dialog:saveJson',
  async (
    _event,
    args: { defaultName?: string; content: string; title?: string }
  ): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> => {
    const defaultName = args?.defaultName ?? 'export.json'
    const ext = defaultName.includes('.') ? defaultName.slice(defaultName.lastIndexOf('.') + 1) : 'json'
    const extFilters: Record<string, { name: string; extensions: string[] }> = {
      md:   { name: 'Markdown', extensions: ['md'] },
      json: { name: 'JSON',     extensions: ['json'] },
      txt:  { name: 'Text',     extensions: ['txt'] },
    }
    const primaryFilter = extFilters[ext] ?? { name: ext.toUpperCase(), extensions: [ext] }
    const opts: Electron.SaveDialogOptions = {
      title: args?.title ?? 'Export',
      defaultPath: defaultName,
      filters: [
        primaryFilter,
        { name: 'All Files', extensions: ['*'] }
      ]
    }
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const result = win
      ? await dialog.showSaveDialog(win, opts)
      : await dialog.showSaveDialog(opts)
    if (result.canceled || !result.filePath) return { ok: false, canceled: true }
    try {
      const fs = await import('node:fs/promises')
      await fs.writeFile(result.filePath, args.content, 'utf-8')
      return { ok: true, path: result.filePath }
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) }
    }
  }
)

ipcMain.handle(
  'dialog:openJson',
  async (
    _event,
    args?: { title?: string }
  ): Promise<{ ok: boolean; path?: string; content?: string; canceled?: boolean; error?: string }> => {
    const opts: Electron.OpenDialogOptions = {
      title: args?.title ?? 'Import JSON',
      properties: ['openFile'],
      filters: [
        { name: 'JSON', extensions: ['json'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    }
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true }
    try {
      const fs = await import('node:fs/promises')
      const content = await fs.readFile(result.filePaths[0], 'utf-8')
      return { ok: true, path: result.filePaths[0], content }
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) }
    }
  }
)

ipcMain.handle(
  'dialog:pickFile',
  async (
    _event,
    args?: { title?: string; filters?: Electron.FileFilter[]; defaultPath?: string }
  ): Promise<{ ok: boolean; path?: string; canceled?: boolean }> => {
    const opts: Electron.OpenDialogOptions = {
      title: args?.title ?? 'Select File',
      properties: ['openFile'],
      filters: args?.filters ?? [{ name: 'All Files', extensions: ['*'] }],
    }
    if (args?.defaultPath) opts.defaultPath = args.defaultPath
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true }
    return { ok: true, path: result.filePaths[0] }
  }
)

ipcMain.handle('shell:openTerminal', async (_event, command: string) => {
  if (!command || typeof command !== 'string') return { ok: false, error: 'invalid command' }
  // Open Terminal.app and run the install command interactively (sudo / OAuth
  // prompts need a real TTY). The command is AppleScript-escaped.
  const escaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const script = `tell application "Terminal" to do script "${escaped}"\ntell application "Terminal" to activate`
  return await new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const proc = spawn('osascript', ['-e', script])
    proc.on('error', (err) => resolve({ ok: false, error: String(err) }))
    proc.on('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: `osascript exited ${code}` }))
  })
})

ipcMain.handle('shell:openPath', async (_event, target: string) => {
  if (!target || typeof target !== 'string') return { ok: false, error: 'invalid path' }
  // shell.openPath returns an empty string on success, or an error message.
  const err = await shell.openPath(target)
  if (err) {
    // If openPath failed (e.g. file doesn't exist), try revealing the parent
    // directory in Finder so the user can navigate from there.
    try {
      shell.showItemInFolder(target)
      return { ok: true, revealed: true }
    } catch {
      return { ok: false, error: err }
    }
  }
  return { ok: true }
})

ipcMain.handle('shell:revealPath', async (_event, target: string) => {
  if (!target || typeof target !== 'string') return { ok: false, error: 'invalid path' }
  try {
    shell.showItemInFolder(target)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

ipcMain.handle('shell:openExternal', async (_event, url: string) => {
  if (!url || typeof url !== 'string') return { ok: false, error: 'invalid url' }
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'only http/https allowed' }
  try {
    await shell.openExternal(url)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

// Write read-only content (e.g. a file's HEAD version) to a temp file and open
// it with the OS default app — the equivalent of Cursor's "Open File (HEAD)".
ipcMain.handle('shell:openTempFile', async (_event, filename: string, content: string) => {
  if (!filename || typeof filename !== 'string') return { ok: false, error: 'invalid filename' }
  try {
    const dir = join(tmpdir(), 'agent-team-head')
    await mkdir(dir, { recursive: true })
    const safe = filename.replace(/[/\\]/g, '_')
    const file = join(dir, safe)
    await writeFile(file, content ?? '', 'utf8')
    const err = await shell.openPath(file)
    return err ? { ok: false, error: err } : { ok: true, path: file }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

// Read bytes from a file starting at a given offset. Used by the stage watcher
// to scan the outputLogFile for sentinel strings — more reliable than cleanBuffer
// which can be truncated or have scanFrom issues from Q&A injections.
ipcMain.handle('keybindings:read', async () => {
  const filePath = join(app.getPath('userData'), 'keybindings.json')
  try {
    const content = await readFile(filePath, 'utf-8')
    return { ok: true, content }
  } catch {
    return { ok: true, content: '[]' }
  }
})

ipcMain.handle('keybindings:write', async (_event, content: string) => {
  if (typeof content !== 'string') return { ok: false, error: 'invalid content' }
  const filePath = join(app.getPath('userData'), 'keybindings.json')
  try {
    await writeFile(filePath, content, 'utf-8')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

ipcMain.handle('fs:readFrom', async (_event, filePath: string, fromByte: number) => {
  if (!filePath || typeof filePath !== 'string') return { ok: false, content: '' }
  try {
    const fs = await import('node:fs/promises')
    const stat = await fs.stat(filePath)
    if (stat.size <= fromByte) return { ok: true, content: '', newOffset: fromByte }
    const fh = await fs.open(filePath, 'r')
    const buf = Buffer.alloc(stat.size - fromByte)
    await fh.read(buf, 0, buf.length, fromByte)
    await fh.close()
    return { ok: true, content: buf.toString('utf-8'), newOffset: stat.size }
  } catch {
    return { ok: false, content: '', newOffset: fromByte }
  }
})

// Disable hardware-accelerated rendering entirely.
// --disable-gpu eliminates the GPU subprocess without running GPU code in-process.
// Previously we used --in-process-gpu to prevent a separate GPU process from
// crashing (SIGTERM/exit_code=15), but on macOS 26.5 + Electron 33 the
// Chrome_InProcGpuThread crashes on shutdown inside fontations_ffi teardown
// (SIGSEGV at 0x18).  --disable-gpu avoids both problems.
// WebSocket stability is now handled by the 50ms batch + 64KB cap in terminals.py.
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')

app.whenReady().then(async () => {
  // In dev mode, inject the per-session random token into every renderer →
  // dev-server request so browsers without the token get 403.
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    try {
      const devToken = readFileSync(join(tmpdir(), 'agent-team-dev-token'), 'utf-8').trim()
      const origin = new URL(rendererUrl).origin
      session.defaultSession.webRequest.onBeforeSendHeaders(
        { urls: [`${origin}/*`] },
        (details, callback) => {
          callback({ requestHeaders: { ...details.requestHeaders, 'x-electron-token': devToken } })
        }
      )
    } catch {
      // Token file missing — dev server may not be running yet, proceed anyway.
    }
  }

  try {
    backend = await startBackend()
    console.log(`[main] backend ready at ${backend.host}:${backend.port}`)
  } catch (err) {
    console.error('[main] backend failed to start', err)
  }

  await createWindow()

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async (e) => {
  if (backend) {
    e.preventDefault()
    const b = backend
    backend = null
    await b.stop()
    app.quit()
  }
})
