import { BrowserWindow, type BrowserWindowConstructorOptions } from 'electron'

/** What one machine-wide window is: its renderer route and its chrome. */
export interface StandaloneWindowSpec {
  /** The `?window=` value main.ts dispatches on. */
  window: string
  title: string
  width: number
  height: number
  minWidth: number
  minHeight: number
}

export interface StandaloneWindowOptions {
  preload: string
  frame: Pick<BrowserWindowConstructorOptions, 'titleBarStyle'>
  locale: () => string
  load: (window: BrowserWindow, params: Record<string, string>) => void
}

/**
 * One machine-wide window, independent of workspace window lifetimes: a second
 * open focuses the existing one (restoring it when minimized) and re-sends the
 * UI locale instead of loading again. Shared by the Token Monitor and Turn
 * Stats windows, which differ only in their spec.
 */
export function createStandaloneWindowOpener(
  spec: StandaloneWindowSpec,
  options: StandaloneWindowOptions
): () => void {
  let current: BrowserWindow | null = null
  return () => {
    if (current && !current.isDestroyed()) {
      if (current.isMinimized()) current.restore()
      current.show()
      current.focus()
      current.webContents.send('settings:language-changed', options.locale())
      return
    }
    const win = new BrowserWindow({
      width: spec.width,
      height: spec.height,
      minWidth: spec.minWidth,
      minHeight: spec.minHeight,
      title: spec.title,
      show: false,
      ...options.frame,
      backgroundColor: '#0d1117',
      webPreferences: {
        preload: options.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    })
    current = win
    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) {
        win.show()
        win.focus()
      }
    })
    win.on('closed', () => {
      if (current === win) current = null
    })
    options.load(win, { window: spec.window, locale: options.locale() })
  }
}
