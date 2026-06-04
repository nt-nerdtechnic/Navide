import { contextBridge, ipcRenderer, webUtils } from 'electron'

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
  revealPath: (target: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('shell:revealPath', target),
  openTempFile: (filename: string, content: string): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('shell:openTempFile', filename, content),
  openRolesWindow: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('window:openRoles'),
  openStagesWindow: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('window:openStages'),
  openDiffWindow: (args: {
    workspace_path: string
    filepath: string
    staged: boolean
    name?: string
  }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('window:openDiff', {
      workspace_path: args.workspace_path,
      filepath: args.filepath,
      staged: String(args.staged),
      name: args.name ?? args.filepath,
    }),
  openEditorWindow: (args: {
    workspace_path: string
    filepath: string
    name?: string
  }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('window:openEditor', {
      workspace_path: args.workspace_path,
      filepath: args.filepath,
      name: args.name ?? args.filepath,
    }),
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
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
})
