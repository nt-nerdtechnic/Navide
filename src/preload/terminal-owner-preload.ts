import { contextBridge, ipcRenderer } from 'electron'
import type { TerminalStorageOwnerRequest, TerminalStorageOwnerState } from '../shared/terminalStorageOwner'

contextBridge.exposeInMainWorld('navideTerminalOwner', {
  serve(handler: (request: TerminalStorageOwnerRequest) => TerminalStorageOwnerState | null): void {
    ipcRenderer.on('terminal-owner:request', (_event, id: string, request: TerminalStorageOwnerRequest) => {
      try {
        ipcRenderer.send('terminal-owner:response', { id, ok: true, value: handler(request) })
      } catch {
        ipcRenderer.send('terminal-owner:response', { id, ok: false })
      }
    })
    ipcRenderer.send('terminal-owner:ready')
  },
})
