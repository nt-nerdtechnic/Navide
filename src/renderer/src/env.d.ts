/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

interface BackendInfo {
  status: 'starting' | 'ready' | 'error'
  host?: string
  port?: number
  pid?: number
  shell?: string
  httpUrl?: string
  wsUrl?: string
  error?: string
}

declare global {
  // Build tag injected by electron.vite.config.ts (git short-hash + dirty + time).
  const __APP_BUILD__: string
  interface Window {
    agentTeam?: {
      appName: string
      version: string
      getBackendInfo: () => Promise<BackendInfo>
      restartBackend: () => Promise<BackendInfo>
      stopBackend: () => Promise<{ ok: boolean }>
      onBackendChanged: (cb: (info: BackendInfo) => void) => void
      pickWorkspace: (defaultPath?: string) => Promise<string | null>
      newWorkspace: () => Promise<string | null>
      openPath: (target: string) => Promise<{ ok: boolean; revealed?: boolean; error?: string }>
      revealPath: (target: string) => Promise<{ ok: boolean; error?: string }>
      openTerminal: (command: string) => Promise<{ ok: boolean; error?: string }>
      openTempFile: (filename: string, content: string) => Promise<{ ok: boolean; path?: string; error?: string }>
      openRolesWindow: () => Promise<{ ok: boolean }>
      openStagesWindow: () => Promise<{ ok: boolean }>
      openDiffWindow: (args: {
        workspace_path: string
        filepath: string
        staged: boolean
        name?: string
      }) => Promise<{ ok: boolean }>
      openEditorWindow: (args: {
        workspace_path: string
        filepath?: string
        name?: string
        line?: number
        sidebar?: 'explorer' | 'search' | 'git'
      }) => Promise<{ ok: boolean }>
      saveJson: (args: {
        defaultName?: string
        content: string
        title?: string
      }) => Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>
      openJson: (args?: {
        title?: string
      }) => Promise<{ ok: boolean; path?: string; content?: string; canceled?: boolean; error?: string }>
      readFileFrom: (filePath: string, fromByte: number) => Promise<{ ok: boolean; content: string; newOffset: number }>
      pickFile: (args?: {
        title?: string
        filters?: Array<{ name: string; extensions: string[] }>
        defaultPath?: string
      }) => Promise<{ ok: boolean; path?: string; canceled?: boolean }>
      getPathForFile: (file: File) => string
      openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>
      onSwitchEditorSidebar: (cb: (sidebar: string) => void) => void
      onOpenEditorDiff: (cb: (params: Record<string, string>) => void) => void
      readKeybindings: () => Promise<{ ok: boolean; content?: string }>
      writeKeybindings: (content: string) => Promise<{ ok: boolean; error?: string }>
      broadcastLanguageChange: (locale: string) => void
      onLanguageChanged: (cb: (locale: string) => void) => void
      notify: (args: { paneId?: string; title: string; body?: string }) => Promise<{ ok: boolean }>
      onFocusPane: (cb: (paneId: string) => void) => void
      setBadgeCount: (count: number) => void
      reportWorkspace: (workspacePath: string) => void
      restore?: {
        getPending: () => Promise<string[] | null>
        apply: () => Promise<{ ok: boolean; opened: number }>
        dismiss: () => Promise<{ ok: boolean }>
      }
      updater?: {
        check: () => Promise<unknown>
        download: () => Promise<unknown>
        install: () => void
        onUpdateAvailable: (cb: (info: { version: string }) => void) => void
        onDownloadProgress: (cb: (info: { percent: number }) => void) => void
        onUpdateDownloaded: (cb: (info: { version: string }) => void) => void
      }
    }
  }
}

export {}
