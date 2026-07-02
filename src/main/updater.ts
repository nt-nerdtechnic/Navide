import { autoUpdater } from 'electron-updater'
import { ipcMain, BrowserWindow } from 'electron'

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

export function initUpdater(): void {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on('update-available', (info) => {
    broadcast('updater:update-available', { version: info.version })
  })
  autoUpdater.on('download-progress', (p) => {
    broadcast('updater:download-progress', { percent: Math.round(p.percent) })
  })
  autoUpdater.on('update-downloaded', (info) => {
    broadcast('updater:update-downloaded', { version: info.version })
  })
  autoUpdater.on('error', (err) => {
    // Silent — update failures should not crash the app
    console.error('[updater]', err.message)
  })

  ipcMain.handle('updater:check', () => autoUpdater.checkForUpdates())
  ipcMain.handle('updater:download', () => autoUpdater.downloadUpdate())
  ipcMain.handle('updater:install', () => autoUpdater.quitAndInstall())
}
