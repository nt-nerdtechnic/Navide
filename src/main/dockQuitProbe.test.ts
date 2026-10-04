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
const dialogState = vi.hoisted(() => ({ response: 0, prompts: 0 }))

// index.ts runs the Linux keyring preflight at import; never spawn dbus-send here.
vi.mock('./linuxKeyring', () => ({ applyLinuxKeyringPreflight: () => false }))
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
        webContents: {
          send: (channel: string, arg: unknown) => { windowSends.push([channel, arg]) },
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
        return Promise.resolve({ response: dialogState.response, checkboxChecked: false })
      },
      showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
    },
    ipcMain: {
      handle: (channel: string, listener: Listener) => { ipcListeners.set(channel, listener) },
      on: (channel: string, listener: Listener) => { ipcListeners.set(channel, listener) },
      removeHandler: () => {},
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
