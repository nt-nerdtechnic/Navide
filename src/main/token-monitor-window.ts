import { BrowserWindow, type BrowserWindowConstructorOptions } from 'electron'

/** One machine-wide monitor, independent of workspace window lifetimes. */
export function createTokenMonitorWindowOpener(options: {
  preload: string
  frame: Pick<BrowserWindowConstructorOptions, 'titleBarStyle'>
  locale: () => string
  load: (window: BrowserWindow, params: Record<string, string>) => void
}): () => void {
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
      width: 1200,
      height: 800,
      minWidth: 760,
      minHeight: 480,
      title: 'Token Monitor',
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
    options.load(win, { window: 'token-monitor', locale: options.locale() })
  }
}
