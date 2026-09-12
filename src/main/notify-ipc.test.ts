import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The renderer's useSystemNotify ends in two IPC channels owned by
// `src/main/index.ts`: `window:notify` (desktop notification whose click brings
// the pane back) and `window:setBadgeCount` (Dock badge). This drives the real
// handlers with `electron` mocked, the same way quit-fast-path.test.ts does.

type Listener = (...args: never[]) => unknown

const ipcListeners = new Map<string, Listener>()
const shown: Array<{ title: string; body: string; silent?: boolean }> = []
const clickHandlers: Array<() => void> = []
let notificationsSupported = true
const dockSetBadge = vi.fn()
const appFocus = vi.fn()
const setWindowDockTileBadge = vi.fn()

const fakeWin = {
  isDestroyed: () => false,
  isMinimized: () => true,
  restore: vi.fn(),
  isVisible: () => false,
  show: vi.fn(),
  focus: vi.fn(),
  webContents: { send: vi.fn() },
}

vi.mock('./dock-tile-badge', () => ({
  setWindowDockTileBadge: (...args: unknown[]) => setWindowDockTileBadge(...args),
}))

vi.mock('electron', () => {
  const app = {
    isPackaged: false,
    getPath: () => '/tmp/navide-notify-ipc-test',
    setPath: () => {},
    getName: () => 'Navide',
    getVersion: () => '0.0.0-test',
    on: () => {},
    once: () => {},
    setName: () => {},
    quit: () => {},
    whenReady: () => new Promise(() => {}),
    requestSingleInstanceLock: () => true,
    commandLine: { appendSwitch: () => {} },
    setAboutPanelOptions: () => {},
    focus: (...args: unknown[]) => appFocus(...args),
    dock: { setBadge: (...args: unknown[]) => dockSetBadge(...args), setIcon: () => {} },
  }
  class BrowserWindow {
    static getAllWindows(): unknown[] { return [] }
    static getFocusedWindow(): unknown { return null }
    static fromWebContents(sender: unknown): unknown { return sender === 'sender' ? fakeWin : null }
    static fromId(): unknown { return null }
  }
  class Notification {
    static isSupported(): boolean { return notificationsSupported }
    constructor(private readonly opts: { title: string; body: string; silent?: boolean }) {}
    on(event: string, cb: () => void): void { if (event === 'click') clickHandlers.push(cb) }
    show(): void { shown.push(this.opts) }
  }
  return {
    app,
    BrowserWindow,
    Notification,
    dialog: {
      showMessageBox: () => Promise.resolve({ response: 0 }),
      showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
    },
    ipcMain: {
      handle: (channel: string, listener: Listener) => { ipcListeners.set(channel, listener) },
      on: (channel: string, listener: Listener) => { ipcListeners.set(channel, listener) },
      removeHandler: () => {},
    },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }), createEmpty: () => ({}) },
    powerMonitor: { on: () => {} },
    safeStorage: { isEncryptionAvailable: () => false },
    session: {
      defaultSession: { webRequest: { onHeadersReceived: () => {} } },
      fromPartition: () => ({}),
    },
    shell: { openExternal: () => Promise.resolve(), showItemInFolder: () => {} },
    Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => ({ popup: () => {} }) },
  }
})

type NotifyHandler = (event: { sender: unknown }, args: Record<string, unknown>) => { ok: boolean }
type BadgeHandler = (event: { sender: unknown }, count: number) => void

function setPlatform(p: string): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

describe('window:notify / window:setBadgeCount IPC', () => {
  const realPlatform = process.platform
  let notify: NotifyHandler
  let setBadge: BadgeHandler

  beforeEach(async () => {
    shown.length = 0
    clickHandlers.length = 0
    notificationsSupported = true
    dockSetBadge.mockClear()
    appFocus.mockClear()
    setWindowDockTileBadge.mockClear()
    fakeWin.restore.mockClear()
    fakeWin.show.mockClear()
    fakeWin.focus.mockClear()
    fakeWin.webContents.send.mockClear()
    if (!ipcListeners.has('window:notify')) await import('./index')
    notify = ipcListeners.get('window:notify') as unknown as NotifyHandler
    setBadge = ipcListeners.get('window:setBadgeCount') as unknown as BadgeHandler
    expect(notify).toBeTypeOf('function')
    expect(setBadge).toBeTypeOf('function')
  }, 60_000)

  afterEach(() => setPlatform(realPlatform))

  it('shows a non-silent notification with the given title and body', () => {
    const res = notify({ sender: 'sender' }, { paneId: 'p1', title: 'CLI finished', body: 'x completed' })
    expect(res).toEqual({ ok: true })
    expect(shown).toEqual([{ title: 'CLI finished', body: 'x completed', silent: false }])
  })

  it('honours silent from the renderer and defaults to audible', () => {
    notify({ sender: 'sender' }, { title: 'quiet', silent: true })
    notify({ sender: 'sender' }, { title: 'loud' })
    expect(shown.map((n) => n.silent)).toEqual([true, false])
  })

  it('clicking the notification reveals the sender window and focuses the pane', () => {
    notify({ sender: 'sender' }, { paneId: 'p1', title: 'T' })
    expect(clickHandlers).toHaveLength(1)
    clickHandlers[0]!()
    expect(fakeWin.restore).toHaveBeenCalledTimes(1)
    expect(fakeWin.show).toHaveBeenCalledTimes(1)
    expect(appFocus).toHaveBeenCalledWith({ steal: true })
    expect(fakeWin.focus).toHaveBeenCalledTimes(1)
    expect(fakeWin.webContents.send).toHaveBeenCalledWith('notify:focusPane', 'p1')
  })

  it('a click without a paneId still reveals the window but sends no focusPane', () => {
    notify({ sender: 'sender' }, { title: 'T' })
    clickHandlers[0]!()
    expect(fakeWin.focus).toHaveBeenCalledTimes(1)
    expect(fakeWin.webContents.send).not.toHaveBeenCalled()
  })

  it('refuses an empty or whitespace title', () => {
    expect(notify({ sender: 'sender' }, { title: '   ' })).toEqual({ ok: false })
    expect(notify({ sender: 'sender' }, {})).toEqual({ ok: false })
    expect(shown).toEqual([])
  })

  it('reports ok:false when notifications are unsupported', () => {
    notificationsSupported = false
    expect(notify({ sender: 'sender' }, { title: 'T' })).toEqual({ ok: false })
    expect(shown).toEqual([])
  })

  it('setBadgeCount mirrors the count to the app Dock and the sender window tile', () => {
    setPlatform('darwin')
    setBadge({ sender: 'sender' }, 3)
    expect(dockSetBadge).toHaveBeenCalledWith('3')
    expect(setWindowDockTileBadge).toHaveBeenCalledWith(fakeWin, '3')
  })

  it('setBadgeCount(0) clears both badges', () => {
    setPlatform('darwin')
    setBadge({ sender: 'sender' }, 0)
    expect(dockSetBadge).toHaveBeenCalledWith('')
    expect(setWindowDockTileBadge).toHaveBeenCalledWith(fakeWin, '')
  })

  it('setBadgeCount skips the window tile when the sender has no window', () => {
    setPlatform('darwin')
    setBadge({ sender: 'orphan' }, 2)
    expect(dockSetBadge).toHaveBeenCalledWith('2')
    expect(setWindowDockTileBadge).not.toHaveBeenCalled()
  })

  it('setBadgeCount is a no-op off macOS', () => {
    setPlatform('linux')
    setBadge({ sender: 'sender' }, 5)
    expect(dockSetBadge).not.toHaveBeenCalled()
    expect(setWindowDockTileBadge).not.toHaveBeenCalled()
  })
})
