import { contextBridge, ipcRenderer } from 'electron'

export interface BackendInfo {
  status: 'starting' | 'ready'
  host?: string
  port?: number
  httpUrl?: string
  wsUrl?: string
}

contextBridge.exposeInMainWorld('agentTeam', {
  appName: 'Agent-Team',
  version: '0.0.1',
  getBackendInfo: (): Promise<BackendInfo> => ipcRenderer.invoke('backend:info'),
  pickWorkspace: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke('workspace:pick', defaultPath),
  openPath: (target: string): Promise<{ ok: boolean; revealed?: boolean; error?: string }> =>
    ipcRenderer.invoke('shell:openPath', target),
  openRolesWindow: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('window:openRoles'),
  openStagesWindow: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('window:openStages'),
  saveJson: (args: {
    defaultName?: string
    content: string
    title?: string
  }): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> =>
    ipcRenderer.invoke('dialog:saveJson', args),
  openJson: (args?: {
    title?: string
  }): Promise<{ ok: boolean; path?: string; content?: string; canceled?: boolean; error?: string }> =>
    ipcRenderer.invoke('dialog:openJson', args),
  readFileFrom: (filePath: string, fromByte: number): Promise<{ ok: boolean; content: string; newOffset: number }> =>
    ipcRenderer.invoke('fs:readFrom', filePath, fromByte),
  pickFile: (args?: {
    title?: string
    filters?: Array<{ name: string; extensions: string[] }>
    defaultPath?: string
  }): Promise<{ ok: boolean; path?: string; canceled?: boolean }> =>
    ipcRenderer.invoke('dialog:pickFile', args),
})
