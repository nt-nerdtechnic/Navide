import { autoUpdater } from 'electron-updater'
import { ipcMain, BrowserWindow } from 'electron'
import { createUpdaterService, type UpdaterService } from './updater-service'
import type { UpdateState } from '../shared/updater'

let service: UpdaterService | null = null

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function publishState(state: UpdateState): void {
  broadcast('updater:state-changed', state)
  if (state.status === 'error') console.error('[updater]', state.message)
}

export function initUpdater(options: {
  enabled: boolean
  currentVersion: string
  checkDelayMs?: number
}): void {
  if (service) return

  service = createUpdaterService(
    autoUpdater,
    options.currentVersion,
    options.enabled,
    publishState,
  )

  ipcMain.handle('updater:get-state', () => service!.getState())
  ipcMain.handle('updater:check', () => service!.check())
  ipcMain.handle('updater:download', () => service!.download())
  ipcMain.handle('updater:install', () => service!.install())

  if (options.enabled) {
    setTimeout(() => { void service?.check() }, options.checkDelayMs ?? 5000)
  }
}
