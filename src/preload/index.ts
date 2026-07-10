import { contextBridge, ipcRenderer, webUtils } from 'electron'

export interface BackendInfo {
  status: 'starting' | 'ready' | 'error'
  host?: string
  port?: number
  pid?: number
  shell?: string
  httpUrl?: string
  wsUrl?: string
  error?: string
}

export interface GitAccountPublic {
  id: string
  label: string
  host: string
  username: string
  tokenLast4: string
}

export interface GitAccountInput {
  label: string
  host: string
  username: string
  token: string
}

export interface GitCredential {
  username: string
  token: string
}

contextBridge.exposeInMainWorld('agentTeam', {
  appName: 'Agent-Team',
  version: __APP_VERSION__,
  getBackendInfo: (): Promise<BackendInfo> => ipcRenderer.invoke('backend:info'),
  restartBackend: (): Promise<BackendInfo> => ipcRenderer.invoke('backend:restart'),
  stopBackend: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('backend:stop'),
  onBackendChanged: (cb: (info: BackendInfo) => void): void => {
    ipcRenderer.on('backend:changed', (_event, info: BackendInfo) => cb(info))
  },
  pickWorkspace: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke('workspace:pick', defaultPath),
  newWorkspace: (): Promise<string | null> => ipcRenderer.invoke('workspace:new'),
  getHomeDir: (): Promise<string> => ipcRenderer.invoke('app:home-dir'),
  openPath: (target: string): Promise<{ ok: boolean; revealed?: boolean; error?: string }> =>
    ipcRenderer.invoke('shell:openPath', target),
  revealPath: (target: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('shell:revealPath', target),
  openTerminal: (command: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('shell:openTerminal', command),
  openTempFile: (filename: string, content: string): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('shell:openTempFile', filename, content),
  openMainWindow: (args?: { workspace_path?: string }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('window:openMain', args ?? {}),
  detachGroup: (args: { groupId: string; workspacePath: string; bounds?: { x: number; y: number; width: number; height: number } }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('window:detachGroup', args),
  getDetachedGroups: (): Promise<string[]> => ipcRenderer.invoke('window:getDetachedGroups'),
  onGroupDetached: (cb: (groupId: string) => void): void => {
    ipcRenderer.on('group:detached', (_event, arg: { groupId: string }) => cb(arg.groupId))
  },
  onGroupReattached: (cb: (groupId: string) => void): void => {
    ipcRenderer.on('group:reattached', (_event, arg: { groupId: string }) => cb(arg.groupId))
  },
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
    filepath?: string
    name?: string
    line?: number
    sidebar?: 'explorer' | 'search' | 'git'
  }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('window:openEditor', {
      workspace_path: args.workspace_path,
      ...(args.filepath ? { filepath: args.filepath, name: args.name ?? args.filepath } : {}),
      ...(args.line ? { line: String(args.line) } : {}),
      ...(args.sidebar ? { sidebar: args.sidebar } : {}),
    }),
  onSwitchEditorSidebar: (cb: (sidebar: string) => void): void => {
    ipcRenderer.on('editor:switchSidebar', (_event, sidebar: string) => cb(sidebar))
  },
  onOpenEditorDiff: (cb: (params: Record<string, string>) => void): void => {
    ipcRenderer.on('editor:openDiff', (_event, params: Record<string, string>) => cb(params))
  },
  openBranchDiffWindow: (args: {
    workspace_path: string
    base: string
    compare?: string
  }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('window:openBranchDiff', {
      workspace_path: args.workspace_path,
      branch_diff_base: args.base,
      branch_diff_compare: args.compare ?? '',
    }),
  onOpenEditorBranchDiff: (cb: (params: Record<string, string>) => void): void => {
    ipcRenderer.on('editor:openBranchDiff', (_event, params: Record<string, string>) => cb(params))
  },
  gitDiffHead: (args: {
    workspace_path: string
    base?: string
    compare?: string
  }): Promise<{ ok: boolean; diff: string; error?: string }> =>
    ipcRenderer.invoke('git:diff-head', args),
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
  pickFiles: (args?: {
    title?: string
    filters?: Array<{ name: string; extensions: string[] }>
    defaultPath?: string
  }): Promise<{ ok: boolean; paths?: string[]; canceled?: boolean }> =>
    ipcRenderer.invoke('dialog:pickFiles', args),
  openExternal: (url: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('shell:openExternal', url),
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  readKeybindings: (): Promise<{ ok: boolean; content?: string }> =>
    ipcRenderer.invoke('keybindings:read'),
  writeKeybindings: (content: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('keybindings:write', content),
  // Synchronous on purpose: seeds the renderer settings cache before first
  // paint (zero-flash theme/language). Returns the ui_settings.json text,
  // '{}' when missing/corrupt.
  getBootstrapSettings: (): string => ipcRenderer.sendSync('settings:bootstrap') as string,
  broadcastLanguageChange: (locale: string): void => {
    ipcRenderer.send('settings:language-changed', locale)
  },
  onLanguageChanged: (cb: (locale: string) => void): void => {
    ipcRenderer.on('settings:language-changed', (_event, locale: string) => cb(locale))
  },
  readHealthCheckTimeout: (): Promise<{ ok: boolean; timeoutSec?: number }> =>
    ipcRenderer.invoke('settings:health-timeout-read'),
  writeHealthCheckTimeout: (timeoutSec: number): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('settings:health-timeout-write', timeoutSec),
  notify: (args: { paneId?: string; title: string; body?: string }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('window:notify', args),
  onFocusPane: (cb: (paneId: string) => void): void => {
    ipcRenderer.on('notify:focusPane', (_event, paneId: string) => cb(paneId))
  },
  setBadgeCount: (count: number): void => {
    ipcRenderer.send('window:setBadgeCount', count)
  },
  reportWorkspace: (workspacePath: string): void => {
    ipcRenderer.send('window:reportWorkspace', workspacePath)
  },
  restore: {
    getPending: (): Promise<string[] | null> => ipcRenderer.invoke('restore:getPending'),
    apply: (): Promise<{ ok: boolean; opened: number }> => ipcRenderer.invoke('restore:apply'),
    dismiss: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('restore:dismiss'),
    getAutoRestore: (): Promise<boolean> => ipcRenderer.invoke('restore:getAutoRestore'),
    setAutoRestore: (value: boolean): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('restore:setAutoRestore', value),
  },
  updater: {
    check: (): Promise<unknown> => ipcRenderer.invoke('updater:check'),
    download: (): Promise<unknown> => ipcRenderer.invoke('updater:download'),
    install: (): void => { void ipcRenderer.invoke('updater:install') },
    onUpdateAvailable: (cb: (info: { version: string }) => void): void => {
      ipcRenderer.on('updater:update-available', (_e, info) => cb(info))
    },
    onDownloadProgress: (cb: (info: { percent: number }) => void): void => {
      ipcRenderer.on('updater:download-progress', (_e, info) => cb(info))
    },
    onUpdateDownloaded: (cb: (info: { version: string }) => void): void => {
      ipcRenderer.on('updater:update-downloaded', (_e, info) => cb(info))
    },
  },
  gitAccounts: {
    isAvailable: (): Promise<{ ok: boolean; available?: boolean; error?: string }> =>
      ipcRenderer.invoke('git-accounts:available'),
    list: (): Promise<{ ok: boolean; accounts?: GitAccountPublic[]; error?: string }> =>
      ipcRenderer.invoke('git-accounts:list'),
    add: (input: GitAccountInput): Promise<{ ok: boolean; account?: GitAccountPublic; error?: string }> =>
      ipcRenderer.invoke('git-accounts:add', input),
    update: (id: string, patch: Partial<GitAccountInput>): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('git-accounts:update', id, patch),
    remove: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('git-accounts:remove', id),
    bind: (workspacePath: string, accountId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('git-accounts:bind', workspacePath, accountId),
    unbind: (workspacePath: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('git-accounts:unbind', workspacePath),
    getBinding: (workspacePath: string): Promise<{ ok: boolean; accountId?: string | null; error?: string }> =>
      ipcRenderer.invoke('git-accounts:getBinding', workspacePath),
    getCredential: (
      workspacePath: string
    ): Promise<{ ok: boolean; credential?: GitCredential | null; error?: string }> =>
      ipcRenderer.invoke('git-accounts:getCredential', workspacePath),
  },
})
