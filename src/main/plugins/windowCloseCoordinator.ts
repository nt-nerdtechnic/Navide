import type { BrowserWindow, WebContents } from 'electron'
export type NativeWindowCloseReason = 'native-window-close' | 'reload' | 'quit'

export type WindowCloseOutcome =
  | { ok: true; id: string }
  | { ok: false; reason: 'refused' | 'busy' | 'unavailable' | 'timeout' }

export interface WindowCloseHost {
  hasWindowCloseParticipants(hostWindow: BrowserWindow): boolean
  prepareWindowClose(hostWindow: BrowserWindow, reason: NativeWindowCloseReason): Promise<WindowCloseOutcome>
  commitWindowClose(id: string): void
  cancelWindowClose(id: string): void
  /** Main owns the Electron lookup so this coordinator stays runtime-free. */
  windowForWebContents(target: WebContents): BrowserWindow | null
}

/**
 * Call order for every main-driven close:
 *   1. `prepare…` returns `ok` only when receiver consent and each provider
 *      prepare have settled; refusal/busy/timeout leaves the window usable.
 *   2. `commitWindowClose` destroys the prepared provider items exactly once.
 *   3. Only then is the window destroyed (or the reload applied).
 */

export interface WindowCloseCoordinator {
  /** Intercept native close, prepare every participant, then destroy once. */
  watch(window: BrowserWindow): void
  /** Route the View > Reload Window action through the same preparation. */
  prepareAndReload(target: WebContents): Promise<boolean>
  /** Prepare every affected window before any window or backend is committed. */
  prepareForQuit(windows: readonly BrowserWindow[]): Promise<boolean>
}

function findWindowFor(host: WindowCloseHost, target: WebContents): BrowserWindow | null {
  return host.windowForWebContents(target)
}

export function createWindowCloseCoordinator(host: WindowCloseHost): WindowCloseCoordinator {
  // A refused preparation must leave the window fully usable, so the mark only
  // spans one close attempt and is cleared on both success and failure.
  const closing = new Set<number>()

  function watch(window: BrowserWindow): void {
    window.on('close', (event) => {
      if (!host.hasWindowCloseParticipants(window)) return
      if (closing.has(window.id)) {
        event.preventDefault()
        return
      }
      event.preventDefault()
      closing.add(window.id)
      void (async () => {
        try {
          const preparation = await host.prepareWindowClose(window, 'native-window-close')
          if (!preparation.ok) return
          host.commitWindowClose(preparation.id)
          if (!window.isDestroyed()) window.destroy()
        } finally {
          closing.delete(window.id)
        }
      })()
    })
    window.once('closed', () => {
      closing.delete(window.id)
    })
  }

  async function prepareAndReload(target: WebContents): Promise<boolean> {
    if (target.isDestroyed()) return true
    const window = findWindowFor(host, target)
    if (!window || window.isDestroyed() || !host.hasWindowCloseParticipants(window)) return false
    const preparation = await host.prepareWindowClose(window, 'reload')
    if (!preparation.ok) return true
    host.commitWindowClose(preparation.id)
    if (!target.isDestroyed()) target.reload()
    return true
  }

  async function prepareForQuit(windows: readonly BrowserWindow[]): Promise<boolean> {
    const targets = windows.filter((window) => !window.isDestroyed() && host.hasWindowCloseParticipants(window))
    if (targets.length === 0) return true
    const committed: string[] = []
    const preparedWindows: BrowserWindow[] = []
    for (const target of targets) {
      const preparation = await host.prepareWindowClose(target, 'quit')
      if (!preparation.ok) {
        for (const id of committed) host.cancelWindowClose(id)
        return false
      }
      if (preparation.id) {
        committed.push(preparation.id)
        preparedWindows.push(target)
      }
    }
    for (const id of committed) host.commitWindowClose(id)
    for (const target of preparedWindows) {
      if (!target.isDestroyed()) target.destroy()
    }
    return true
  }

  return { watch, prepareAndReload, prepareForQuit }
}
