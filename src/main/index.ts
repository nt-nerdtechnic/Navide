import { app, BrowserWindow, dialog, ipcMain, nativeImage, Notification, session, shell } from 'electron'
import { join, dirname } from 'node:path'
import { writeFile, readFile, mkdir } from 'node:fs/promises'
import { appendFileSync, readFileSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { startBackend, type BackendHandle } from './backend'
import { initUpdater } from './updater'
import { WindowRegistry, type WindowBounds, type WindowEntry } from './window-registry'
import { setWindowDockTileBadge } from './dock-tile-badge'

// Give the Electron process a distinct name so it can be targeted precisely
// with `pkill -f agent-team-electron` without affecting other Electron apps.
process.title = 'agent-team-electron'

// TEMP diagnostics for the Dock-tile badge: file-based so the trail is
// readable regardless of how the app was launched. Remove once verified.
function logDockThumb(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}`
  console.log(`[dock-thumb] ${line}`)
  try { appendFileSync(join(tmpdir(), 'agent-team-dock-thumb.log'), line + '\n') } catch { /* diagnostics only */ }
}

if (process.platform === 'darwin') {
  app.dock.setIcon(nativeImage.createFromPath(join(__dirname, '../../resources/icon.png')))
}

let backend: BackendHandle | null = null
// In-flight initial backend start, so before-quit can wait for it (capped) and
// stop the process instead of orphaning it when the user quits mid-startup.
let backendStarting: Promise<void> | null = null
// Message from the most recent failed start/restart attempt, so the renderer
// can show a real error instead of sitting in "starting" forever after a
// retry also fails. Cleared as soon as a start attempt succeeds.
let backendLastError: string | null = null
// Multiple independent main windows (VS Code-style cmd+shift+N). `mainWindow`
// tracks the most-recently-focused one so dialogs parent to it; `mainWindows`
// holds them all for lifecycle code that must reach every main window.
let mainWindow: BrowserWindow | null = null
const mainWindows = new Set<BrowserWindow>()
// Maps each main window to its workspace_path so we can focus an existing window
// instead of creating a duplicate when the same folder is opened again.
const mainWindowWorkspaces = new Map<BrowserWindow, string>()
// Crash-restore: persists open workspace windows so an unexpected exit can be
// detected and offered for restore on the next launch (see window-registry.ts).
// Path resolved lazily — dev re-points userData (…-dev) below, after imports.
const windowRegistry = new WindowRegistry(() => join(app.getPath('userData'), 'open-windows.json'))
// Windows from the previous (uncleanly exited) run, offered to the FIRST
// renderer that asks via restore:getPending; cleared on apply/dismiss.
let pendingRestore: WindowEntry[] | null = null
let pendingRestoreClaimed = false
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

async function createWindow(
  params: Record<string, string> = {},
  opts?: { bounds?: WindowBounds }
): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: opts?.bounds?.width ?? 1280,
    height: opts?.bounds?.height ?? 800,
    ...(opts?.bounds ? { x: opts.bounds.x, y: opts.bounds.y } : {}),
    title: 'Agent-Team',
    titleBarStyle: 'hidden',
    // Start hidden and show only once the renderer has painted its first frame,
    // so the user never sees the white flash of an unpainted window. The dark
    // backgroundColor matches the default theme as a safety net for the instant
    // between show() and paint.
    show: false,
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  mainWindows.add(win)
  mainWindow = win
  const winId = win.id // captured — win.id is not readable after destroy
  if (params.workspace_path) {
    mainWindowWorkspaces.set(win, params.workspace_path)
    windowRegistry.setWorkspace(winId, params.workspace_path)
  }
  win.on('moved', () => { if (!win.isDestroyed()) windowRegistry.setBounds(winId, win.getBounds()) })
  win.on('resized', () => { if (!win.isDestroyed()) windowRegistry.setBounds(winId, win.getBounds()) })
  // Show on first paint (theme already applied → no white/wrong-theme flash).
  // Fallback timer guarantees the window appears even if ready-to-show is missed.
  let _shown = false
  const showOnce = (): void => {
    if (_shown || win.isDestroyed()) return
    _shown = true
    win.show()
  }
  win.once('ready-to-show', showOnce)
  setTimeout(showOnce, 4000)
  win.on('focus', () => { mainWindow = win })
  win.on('closed', () => {
    mainWindows.delete(win)
    mainWindowWorkspaces.delete(win)
    windowRegistry.remove(winId)
    if (mainWindow === win) {
      const remaining = [...mainWindows]
      mainWindow = remaining.length ? remaining[remaining.length - 1] : null
    }
    if (mainWindows.size === 0) {
      if (editorWindow && !editorWindow.isDestroyed()) editorWindow.close()
    }
  })

  loadWindow(win, { window: 'main', ...params })
  return win
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
    backgroundColor: '#0d1117',
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

function backendInfoPayload() {
  if (!backend) {
    return backendLastError
      ? { status: 'error' as const, error: backendLastError }
      : { status: 'starting' as const }
  }
  return {
    status: 'ready' as const,
    host: backend.host,
    port: backend.port,
    pid: backend.proc.pid,
    shell: backend.shell,
    httpUrl: `http://${backend.host}:${backend.port}`,
    wsUrl: `ws://${backend.host}:${backend.port}/ws`
  }
}

// Push the current backend info to every window so each renderer's useBackend
// can reconnect after a restart (the port changes) or show disconnected on stop.
function broadcastBackendChanged(): void {
  const payload = backendInfoPayload()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('backend:changed', payload)
  }
}

ipcMain.handle('backend:info', () => backendInfoPayload())

// Serialize lifecycle ops so a double-click can't spawn two backends or race a
// stop against a start.
let backendBusy = false

ipcMain.handle('backend:restart', async () => {
  if (backendBusy) return backendInfoPayload()
  backendBusy = true
  try {
    if (backend) {
      const b = backend
      backend = null
      await b.stop()
    }
    try {
      backend = await startBackend()
      backendLastError = null
      console.log(`[main] backend restarted at ${backend.host}:${backend.port}`)
    } catch (err) {
      console.error('[main] backend restart failed', err)
      backend = null
      backendLastError = String(err)
    }
    broadcastBackendChanged()
    return backendInfoPayload()
  } finally {
    backendBusy = false
  }
})

ipcMain.handle('backend:stop', async () => {
  if (backendBusy) return { ok: false }
  backendBusy = true
  try {
    if (backend) {
      const b = backend
      backend = null
      await b.stop()
    }
    broadcastBackendChanged()
    return { ok: true }
  } finally {
    backendBusy = false
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

ipcMain.handle('workspace:new', async () => {
  const opts: Electron.OpenDialogOptions = {
    title: 'New workspace folder',
    defaultPath: app.getPath('home'),
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Use this folder'
  }

  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, opts)
    : await dialog.showOpenDialog(opts)

  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

ipcMain.handle('app:home-dir', () => app.getPath('home'))

function openStagesWindow(): void {
  if (stagesWindow && !stagesWindow.isDestroyed()) {
    stagesWindow.focus()
    return
  }
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    title: 'Agent-Team · Stage Manager',
    backgroundColor: '#0d1117',
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
    editorWindow.webContents.send('editor:switchSidebar', 'git')
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
    sidebar: 'git',
  })
}

ipcMain.handle('window:openMain', (_event, args?: { workspace_path?: string }) => {
  const params: Record<string, string> = {}
  const ws = (args?.workspace_path ?? '').trim()
  if (ws) {
    params.workspace_path = ws
    // duplicate=1 marks a window cloned from a live one (its source's CLI
    // sessions are still running), so the renderer skips pane restore once.
    // Externally-opened workspaces (openWorkspaceFromPath) must NOT carry
    // this — their previous sessions are dead and restore should run.
    params.duplicate = '1'
  }
  void createWindow(params)
  return { ok: true }
})

// The renderer switches workspaces at runtime (Welcome picker / back-to-Welcome)
// without reloading, so main's per-window workspace map — and the crash-restore
// registry — must be told. Empty path = the window returned to Welcome.
ipcMain.on('window:reportWorkspace', (event, workspacePath: string) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || !mainWindows.has(win)) return
  const ws = String(workspacePath ?? '').trim()
  if (ws) mainWindowWorkspaces.set(win, ws)
  else mainWindowWorkspaces.delete(win)
  windowRegistry.setWorkspace(win.id, ws)
})

// ── Crash-restore prompt (see window-registry.ts) ────────────────────────────
// The first window to ask claims the banner; apply/dismiss both clear it.
ipcMain.handle('restore:getPending', () => {
  if (!pendingRestore || pendingRestoreClaimed) return null
  pendingRestoreClaimed = true
  return pendingRestore.map((w) => w.workspace_path)
})

ipcMain.handle('restore:apply', () => {
  const entries = pendingRestore ?? []
  pendingRestore = null
  for (const entry of entries) {
    // Already reopened manually → focus, don't duplicate.
    let focused = false
    for (const [win, wp] of mainWindowWorkspaces) {
      if (!win.isDestroyed() && wp === entry.workspace_path) {
        if (win.isMinimized()) win.restore()
        win.focus()
        focused = true
        break
      }
    }
    if (!focused) {
      // No duplicate=1 flag: a crash-restore boot's sessions are dead, so the
      // renderer runs pane restore (restore=1 is informational only).
      void createWindow(
        { workspace_path: entry.workspace_path, restore: '1' },
        entry.bounds ? { bounds: entry.bounds } : undefined
      )
    }
  }
  return { ok: true, opened: entries.length }
})

ipcMain.handle('restore:dismiss', () => {
  pendingRestore = null
  return { ok: true }
})

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

// Allowlist for git ref names: alphanumeric, dots, slashes, hyphens, underscores.
// Rejects anything starting with '-' (flag smuggling) and shell metacharacters.
const GIT_REF_RE = /^[A-Za-z0-9._/\-]+$/

function validateRef(value: string, label: string): string | null {
  if (!value) return null // empty is OK (means "omit")
  if (value.startsWith('-')) return `invalid ${label}: must not start with '-'`
  if (!GIT_REF_RE.test(value)) return `invalid ${label}: contains disallowed characters`
  return null
}

// Run git diff directly in main process — no Python backend needed, always up-to-date.
ipcMain.handle('git:diff-head', async (_event, args: { workspace_path: string; base?: string; compare?: string }) => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileAsync = promisify(execFile)
  const cwd = (args.workspace_path ?? '').trim()
  if (!cwd) return { ok: false, diff: '', error: 'workspace_path required' }
  const compare = (args.compare ?? '').trim()
  const base = (args.base ?? '').trim()
  const refErr = validateRef(base, 'base') ?? validateRef(compare, 'compare')
  if (refErr) return { ok: false, diff: '', error: refErr }
  try {
    const gitArgs: string[] = ['-c', 'core.quotePath=false', 'diff']
    if (compare && base) {
      gitArgs.push(`${base}...${compare}`)
    } else {
      gitArgs.push('HEAD')
    }
    const { stdout } = await execFileAsync('git', gitArgs, { cwd, maxBuffer: 4 * 1024 * 1024 })
    return { ok: true, diff: stdout.slice(0, 100_000) }
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string }
    return { ok: false, diff: '', error: e.stderr?.trim() || e.message || 'git error' }
  }
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
    titleBarStyle: 'hidden',
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

// Native OS notification for CLI state changes (turn done / needs input). The
// renderer decides WHEN to call this (background-only, deduped) and supplies the
// already-localized title/body; main stays i18n-agnostic. Clicking the
// notification restores+focuses the most-recent main window and tells its
// renderer which pane to switch to via `notify:focusPane`.
ipcMain.handle(
  'window:notify',
  (_event, args: { paneId?: string; title?: string; body?: string }): { ok: boolean } => {
    if (!Notification.isSupported()) return { ok: false }
    const title = String(args?.title ?? '').trim()
    if (!title) return { ok: false }
    const notification = new Notification({
      title,
      body: String(args?.body ?? ''),
      silent: false,
    })
    const paneId = String(args?.paneId ?? '')
    notification.on('click', () => {
      const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
      if (!win) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      if (paneId) win.webContents.send('notify:focusPane', paneId)
    })
    notification.show()
    return { ok: true }
  }
)

// Dock badge (macOS-only, Terminal.app-style): a number for how many panes have
// unseen done/attention activity. The renderer tracks WHEN to update it
// (useSystemNotify's pendingCount); main just reflects the count.
ipcMain.on('window:setBadgeCount', (event, count: number) => {
  if (process.platform !== 'darwin') return
  app.dock?.setBadge(count > 0 ? String(count) : '')
  // Mirror the count onto the sender window's own Dock tile (Terminal.app-style):
  // the system red badge shows on its thumbnail while the window is minimized.
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win && !win.isDestroyed()) {
    const ok = setWindowDockTileBadge(win, count > 0 ? String(count) : '')
    logDockThumb(`badge count=${count} minimized=${win.isMinimized()} dockTile=${ok}`)
  }
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

ipcMain.handle(
  'dialog:pickFiles',
  async (
    _event,
    args?: { title?: string; filters?: Electron.FileFilter[]; defaultPath?: string }
  ): Promise<{ ok: boolean; paths?: string[]; canceled?: boolean }> => {
    const opts: Electron.OpenDialogOptions = {
      title: args?.title ?? 'Select Files',
      properties: ['openFile', 'multiSelections'],
      filters: args?.filters ?? [{ name: 'All Files', extensions: ['*'] }],
    }
    if (args?.defaultPath) opts.defaultPath = args.defaultPath
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true }
    return { ok: true, paths: result.filePaths }
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

ipcMain.on('settings:language-changed', (_event, locale: string) => {
  for (const win of [mainWindow, rolesWindow, stagesWindow, editorWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('settings:language-changed', locale)
    }
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

// Dev isolation: give a `npm run dev` instance its own Electron userData so its
// renderer localStorage (layout, settings) doesn't clobber the packaged app's
// when both run at once. Must be set before the app is ready / userData is read.
// The backend's state dir is isolated separately (see backend.ts). Packaged
// builds are untouched.
if (!app.isPackaged) {
  app.setPath('userData', `${app.getPath('userData')}-dev`)
}

// Folder paths handed to the app from outside (Finder "Open With", a macOS
// Quick Action, or CLI args) open as workspaces. Paths that arrive via the
// `open-file` event before the app is ready (cold launch) are queued here and
// drained in whenReady once a window can be created.
const pendingOpenPaths: string[] = []

// Resolve an incoming path to a workspace folder (a file resolves to its parent)
// and open it in a new main window. Returns false if the path doesn't exist.
function openWorkspaceFromPath(p: string): boolean {
  const target = (p ?? '').trim()
  if (!target) return false
  let dir: string
  try {
    dir = statSync(target).isDirectory() ? target : dirname(target)
  } catch {
    return false
  }
  if (app.isReady()) {
    console.log('[main] open workspace from external path:', dir)
    // If a window already has this workspace open, focus it instead of duplicating.
    for (const [win, wp] of mainWindowWorkspaces) {
      if (!win.isDestroyed() && wp === dir) {
        if (win.isMinimized()) win.restore()
        app.focus({ steal: true })
        win.focus()
        return true
      }
    }
    // The app is usually backgrounded when a Quick Action / "Open With" fires,
    // so bring it to the front and focus the new window — otherwise the window
    // opens behind Finder and looks like nothing happened.
    void createWindow({ workspace_path: dir }).then((win) => {
      app.focus({ steal: true })
      win.focus()
    })
  } else {
    console.log('[main] queue workspace from external path (pre-ready):', dir)
    pendingOpenPaths.push(dir)
  }
  return true
}

// Pull workspace folder paths out of a process argv array (cold-start CLI args
// or a relaunch's second-instance argv). Skips flags and the executable itself.
function workspacePathsFromArgv(argv: string[]): string[] {
  return argv.slice(1).filter((a) => a && !a.startsWith('-') && existsSync(a))
}

// macOS delivers folders/files opened via Finder, "Open With", or a Quick Action
// (`open -b <bundleid> <path>`) through this event — the canonical way to receive
// an external path. Register it as early as possible so launch-time events queue.
app.on('open-file', (event, p) => {
  event.preventDefault()
  openWorkspaceFromPath(p)
})

// Single-instance lock: a second launch must NOT spawn a parallel backend.
// On macOS, closing the window leaves the app alive (see window-all-closed
// below), so relaunching from Finder/Dock would otherwise start a second main
// process — each spawning its own backend that fights over the shared
// ~/.agent-team state, while the orphaned backend is never reaped.
//
// Packaged builds only. In dev, electron-vite owns the process lifecycle and
// restarts often; an instance that didn't exit cleanly (Ctrl+C not reaping the
// Electron child, or macOS keeping the app alive after the window closed) would
// hold the lock and make the next `npm run dev` silently quit at launch.
const gotSingleInstanceLock = !app.isPackaged || app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    // A relaunch carrying folder paths (e.g. a Quick Action that still uses
    // `open -n`) lands here because we hold the single-instance lock. Open the
    // folders as workspaces instead of dropping them.
    const paths = workspacePathsFromArgv(argv)
    if (paths.length) {
      for (const dir of paths) openWorkspaceFromPath(dir)
      return
    }
    // Plain relaunch with no path: focus the existing window (or create one) and
    // reuse the running backend instead of booting another.
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    } else {
      void createWindow()
    }
  })
}

// Lock down top-level navigation. By default, dropping a file onto a window (or
// any stray location change) navigates the whole window to that URL, replacing
// the app with e.g. a raw .js file's source. This app is a single index.html
// SPA — it never legitimately navigates away — so allow only the dev-server
// origin (HMR/reloads) and our own index.html, and deny every window.open
// except external http(s) links routed to the OS browser.
const DEV_ORIGIN = process.env['ELECTRON_RENDERER_URL']
  ? new URL(process.env['ELECTRON_RENDERER_URL']).origin
  : null
function isAppNavigation(url: string): boolean {
  try {
    const u = new URL(url)
    if (DEV_ORIGIN && u.origin === DEV_ORIGIN) return true
    if (u.protocol === 'file:') return u.pathname.endsWith('/renderer/index.html')
  } catch {
    // Malformed URL — treat as not-app and block.
  }
  return false
}
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (e, url) => {
    if (!isAppNavigation(url)) e.preventDefault()
  })
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
})

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return
  // Detect an unclean previous exit and stash its windows for the restore
  // banner. Always reset the file (start tracking this run) — but only OFFER
  // restore in packaged builds: dev restarts (electron-vite) always look like
  // crashes. AGENT_TEAM_FORCE_RESTORE=1 enables the offer in dev for testing.
  {
    const pending = windowRegistry.readPendingAndReset()
    const restoreEnabled = app.isPackaged || process.env['AGENT_TEAM_FORCE_RESTORE'] === '1'
    pendingRestore = restoreEnabled ? pending : null
    if (pendingRestore) console.log('[main] unclean exit detected;', pendingRestore.length, 'workspace(s) restorable')
  }
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

  // Start the backend in PARALLEL with window creation, not before it. Awaiting
  // here meant the first window (and its renderer's first paint) didn't even
  // begin loading until the backend had fully spawned. The renderer shows its
  // boot overlay and connects once the backend is ready (broadcastBackendChanged);
  // it already tolerates a not-yet-ready backend (same path as a restart).
  backendStarting = startBackend()
    .then((b) => {
      backend = b
      backendLastError = null
      console.log(`[main] backend ready at ${b.host}:${b.port}`)
      broadcastBackendChanged()
    })
    .catch((err) => {
      console.error('[main] backend failed to start', err)
      backendLastError = String(err)
      broadcastBackendChanged()
    })

  // Open any folders requested at launch: queued open-file events (macOS cold
  // launch from a Quick Action) plus CLI path args on a packaged build. Dev runs
  // skip argv parsing — electron-vite's argv contains paths that aren't workspaces.
  const queued = [...pendingOpenPaths]
  pendingOpenPaths.length = 0
  const cli = app.isPackaged ? workspacePathsFromArgv(process.argv) : []
  const launchPaths = [...new Set([...queued, ...cli])]
  let openedAny = false
  for (const p of launchPaths) {
    if (openWorkspaceFromPath(p)) openedAny = true
  }
  if (!openedAny) await createWindow()

  // Auto-updater: only run in packaged builds — dev mode has no GitHub Release to check.
  if (app.isPackaged) {
    setTimeout(() => initUpdater(), 5000)
  }

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async (e) => {
  // A user-initiated quit is a clean exit — nothing to restore next launch.
  // Must run before the early return below (backend may already be gone).
  windowRegistry.markCleanExit()
  if (!backend && !backendStarting) return
  e.preventDefault()
  // Never let a wedged/slow backend block quit: cap every wait below.
  const forced = new Promise<void>((r) => setTimeout(r, 3000))
  // If the backend is still spawning (quit mid-startup), wait for it (capped) so
  // we can stop it rather than orphan the process.
  if (!backend && backendStarting) await Promise.race([backendStarting, forced])
  const b = backend
  backend = null
  backendStarting = null
  if (b) await Promise.race([b.stop(), forced])
  app.quit()
})
