import { beforeEach, describe, expect, it, vi } from 'vitest'

// A window hosting embedded AI panels ends them when it closes, except while
// the app quits (the panels restore next launch). The probe that says "the app
// is quitting" must fall back to false when a plugin vetoes the quit after the
// confirm dialog said Quit — otherwise every later window close leaves its
// panels running. `quitConfirmed` itself keeps its meaning (the main window's
// prompt is not shown again). Drives the real `src/main/index.ts` before-quit
// listener with `electron` mocked, as quit-fast-path.test.ts does.

type Listener = (...args: never[]) => unknown

const appListeners: Array<[string, Listener]> = []
const ipcListeners = new Map<string, Listener>()
const windowSends: Array<[string, unknown]> = []
const dialogState = vi.hoisted(() => ({ response: 0, prompts: 0, notices: [] as Array<{ message?: string; detail?: string }> }))

// index.ts runs the Linux keyring preflight at import; never spawn dbus-send here.
vi.mock('./linuxKeyring', () => ({ applyLinuxKeyringPreflight: () => false }))
// A cancelled quit after the teardown restarts the backend; record it in place
// of spawning one.
const backendState = vi.hoisted(() => ({ events: [] as string[] }))
vi.mock('./backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./backend')>()
  return {
    ...actual,
    startBackend: async () => {
      backendState.events.push('backend started')
      const { EventEmitter } = await import('node:events')
      return {
        host: '127.0.0.1', port: 1, shell: '/bin/sh', hostSessionToken: 't', dataDir: '/tmp',
        proc: new EventEmitter(), stop: async () => {},
      }
    },
  }
})
vi.mock('electron', () => {
  const app = {
    isPackaged: false,
    getPath: () => '/tmp/navide-quit-fast-path-test',
    setPath: () => {},
    getName: () => 'Navide',
    getVersion: () => '0.0.0-test',
    on: (event: string, listener: Listener) => { appListeners.push([event, listener]) },
    once: () => {},
    setName: () => {},
    quit: () => {},
    // Never resolves: no window, no backend — the state this fast path is for.
    whenReady: () => new Promise(() => {}),
    requestSingleInstanceLock: () => true,
    commandLine: { hasSwitch: () => false, appendSwitch: () => {} },
    setAboutPanelOptions: () => {},
  }
  class BrowserWindow {
    static getAllWindows(): unknown[] {
      return [{
        isDestroyed: () => false,
        destroy: () => {},
        getTitle: () => 'Plans',
        id: 1,
        isFocused: () => true,
        webContents: {
          send: (channel: string, arg: unknown) => {
            windowSends.push([channel, arg])
            if (channel === 'app:quitProgress') backendState.events.push(`quit stage ${String(arg)}`)
          },
        },
      }]
    }
    static getFocusedWindow(): unknown { return null }
    static fromWebContents(): unknown { return null }
    static fromId(): unknown { return null }
  }
  return {
    app,
    BrowserWindow,
    // New frame-asset registration runs at module evaluation; tests only need it inert.
    protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {}, unhandle: () => {} },
    dialog: {
      showMessageBox: (_win: unknown, opts?: { buttons?: unknown[] }) => {
        // Count only the quit prompt (two buttons), not the refusal notice.
        const options = (opts ?? _win) as { buttons?: unknown[] }
        if (options?.buttons?.length === 2) dialogState.prompts++
        else {
          dialogState.notices.push(options as { message?: string; detail?: string })
          backendState.events.push('notice')
        }
        return Promise.resolve({ response: dialogState.response, checkboxChecked: false })
      },
      showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
    },
    ipcMain: {
      handle: (channel: string, listener: Listener) => { ipcListeners.set(channel, listener) },
      on: (channel: string, listener: Listener) => { ipcListeners.set(channel, listener) },
      removeHandler: () => {},
      removeListener: () => {},
      off: () => {},
    },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }), createEmpty: () => ({}) },
    Notification: class { static isSupported(): boolean { return false } show(): void {} },
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

type BeforeQuit = (event: { preventDefault: () => void }) => Promise<unknown>

async function boot(): Promise<{ beforeQuit: BeforeQuit; appQuitting: () => boolean }> {
  await import('./index')
  const { frontendPluginManager } = await import('./plugins/frontendPluginManager')
  // A window with a close participant (a plugin holding a draft) that refuses.
  vi.spyOn(frontendPluginManager, 'hasWindowCloseParticipants').mockReturnValue(true)
  vi.spyOn(frontendPluginManager, 'prepareWindowClose').mockResolvedValue(
    { ok: false, reason: 'refused' } as never,
  )
  const setQuitConfirm = ipcListeners.get('app:setQuitConfirm') as (event: unknown, cfg: unknown) => void
  setQuitConfirm({}, { enabled: true })
  const beforeQuit = appListeners.filter(([event]) => event === 'before-quit')
  expect(beforeQuit).toHaveLength(1)
  return {
    beforeQuit: beforeQuit[0]![1] as unknown as BeforeQuit,
    appQuitting: () => (frontendPluginManager as unknown as { appQuitting: () => boolean }).appQuitting(),
  }
}

describe('embedded AI panels after a cancelled quit', () => {
  beforeEach(() => {
    appListeners.length = 0
    ipcListeners.clear()
    windowSends.length = 0
    dialogState.response = 0
    dialogState.prompts = 0
    dialogState.notices.length = 0
    vi.resetModules()
  })

  it('a plugin veto after the prompt said Quit leaves the app not quitting', { timeout: 60_000 }, async () => {
    const { beforeQuit, appQuitting } = await boot()
    expect(appQuitting()).toBe(false)

    // Cmd+Q → prompt → Quit: the listener re-enters through app.quit().
    await beforeQuit({ preventDefault: vi.fn() })
    expect(dialogState.prompts).toBe(1)
    // The re-entry: a plugin refuses to let its window go.
    const preventDefault = vi.fn()
    await beforeQuit({ preventDefault })
    expect(preventDefault).toHaveBeenCalled()

    // The app stays open, so closing a panel's window must end its panels.
    expect(appQuitting()).toBe(false)

    // quitConfirmed keeps its meaning: the next Cmd+Q does not prompt again.
    await beforeQuit({ preventDefault: vi.fn() })
    expect(dialogState.prompts).toBe(1)
    expect(appQuitting()).toBe(false)
  })

  it('a quit cancelled at the prompt leaves the app not quitting', { timeout: 60_000 }, async () => {
    const { beforeQuit, appQuitting } = await boot()
    dialogState.response = 1
    await beforeQuit({ preventDefault: vi.fn() })
    expect(dialogState.prompts).toBe(1)
    expect(appQuitting()).toBe(false)
  })

  it('reports quitting while the confirmed quit is being prepared', { timeout: 60_000 }, async () => {
    const { beforeQuit, appQuitting } = await boot()
    const { frontendPluginManager } = await import('./plugins/frontendPluginManager')
    let seen: boolean | null = null
    vi.mocked(frontendPluginManager.prepareWindowClose).mockImplementation(async () => {
      seen = appQuitting()
      return { ok: true, id: 'w' } as never
    })
    vi.spyOn(frontendPluginManager, 'commitWindowClose').mockImplementation(() => undefined as never)
    await beforeQuit({ preventDefault: vi.fn() })
    await beforeQuit({ preventDefault: vi.fn() })
    expect(seen).toBe(true)
    expect(appQuitting()).toBe(true)
  })
})

// autoUpdater.quitAndInstall() emits before-quit, which marks the windows
// prepared; an install that then fails or times out leaves the app running, so
// it must clear that flag along with dockQuitInProgress — else every later
// window close keeps its panels running. Source-scanned because the updater
// hooks are wired inside app.whenReady(), which this harness never resolves.
describe('embedded AI panels after an abandoned update install', () => {
  it('clears both quit flags the probe reads', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const mainSource = readFileSync(resolve(process.cwd(), 'src/main/index.ts'), 'utf8')
    const hook = /onInstallAbandoned: \(\) => \{([^}]*)\}/.exec(mainSource)
    expect(hook, 'index.ts wires no onInstallAbandoned hook').not.toBeNull()
    expect(hook![1]).toContain('dockQuitInProgress = false')
    expect(hook![1]).toContain('quittingWindowsPrepared = false')
  })
})

// Past before-quit, Electron closes every window and silently cancels the quit
// when one of those closes is prevented (a beforeunload, or a close participant
// that appeared after the quit was prepared). No event says so: will-quit just
// never comes. The flags must not stay set — every later window close would
// leave its panels running — and the user must learn why the app did not quit.
describe('embedded AI panels after a quit cancelled while closing windows', () => {
  beforeEach(() => {
    appListeners.length = 0
    ipcListeners.clear()
    windowSends.length = 0
    dialogState.response = 0
    dialogState.prompts = 0
    dialogState.notices.length = 0
    vi.resetModules()
  })

  async function bootNativeQuit(): Promise<{ beforeQuit: BeforeQuit; willQuit: () => void; appQuitting: () => boolean }> {
    await import('./index')
    const { frontendPluginManager } = await import('./plugins/frontendPluginManager')
    vi.spyOn(frontendPluginManager, 'hasWindowCloseParticipants').mockReturnValue(false)
    vi.spyOn(frontendPluginManager, 'hasBackendActivity').mockReturnValue(false)
    const setQuitConfirm = ipcListeners.get('app:setQuitConfirm') as (event: unknown, cfg: unknown) => void
    setQuitConfirm({}, {
      enabled: false,
      cancelledMessage: 'Navide did not quit',
      cancelledDetail: 'Stopped by: {windows}.',
      cancelledUnknownWindow: 'a window that has closed since',
    })
    const willQuit = appListeners.filter(([event]) => event === 'will-quit')
    return {
      beforeQuit: appListeners.find(([event]) => event === 'before-quit')![1] as unknown as BeforeQuit,
      willQuit: () => { for (const [, listener] of willQuit) (listener as () => void)() },
      appQuitting: () => (frontendPluginManager as unknown as { appQuitting: () => boolean }).appQuitting(),
    }
  }

  it('clears the flags and names the window when will-quit never comes', { timeout: 60_000 }, async () => {
    const { beforeQuit, appQuitting } = await bootNativeQuit()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const preventDefault = vi.fn()
      await beforeQuit({ preventDefault })
      expect(preventDefault).not.toHaveBeenCalled()
      expect(appQuitting()).toBe(true)

      await vi.advanceTimersByTimeAsync(10_000)
      expect(appQuitting()).toBe(false)
      expect(dialogState.notices).toEqual([
        expect.objectContaining({ message: 'Navide did not quit', detail: 'Stopped by: Plans.' }),
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('restarts the backend and lifts the shutdown screen when the teardown already ran', { timeout: 60_000 }, async () => {
    const { beforeQuit, appQuitting } = await bootNativeQuit()
    const { frontendPluginManager } = await import('./plugins/frontendPluginManager')
    backendState.events.length = 0
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      // First pass: a live plugin backend sends the quit through the teardown,
      // which stops the backend and puts up the shutdown screen.
      vi.mocked(frontendPluginManager.hasBackendActivity).mockReturnValue(true)
      const teardown = vi.fn()
      await beforeQuit({ preventDefault: teardown })
      expect(teardown).toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1_000)
      // The teardown's app.quit() re-enters with nothing left to stop.
      vi.mocked(frontendPluginManager.hasBackendActivity).mockReturnValue(false)
      await beforeQuit({ preventDefault: vi.fn() })

      // Closing the windows cancels the quit: will-quit never comes.
      await vi.advanceTimersByTimeAsync(10_000)
      await vi.waitFor(() => expect(backendState.events).toContain('notice'))
      expect(backendState.events).toEqual([
        'quit stage saving',
        'quit stage stopping',
        'quit stage closing',
        'backend started',
        'quit stage cancelled',
        'notice',
      ])
      // The renderers reconnect on this, as after any backend restart.
      expect(windowSends).toContainEqual(['backend:changed', expect.objectContaining({ status: 'ready' })])
      expect(appQuitting()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves a quit that reached will-quit alone', { timeout: 60_000 }, async () => {
    const { beforeQuit, willQuit, appQuitting } = await bootNativeQuit()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await beforeQuit({ preventDefault: vi.fn() })
      willQuit()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(appQuitting()).toBe(true)
      expect(dialogState.notices).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})
