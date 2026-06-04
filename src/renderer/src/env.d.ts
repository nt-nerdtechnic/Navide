/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

interface BackendInfo {
  status: 'starting' | 'ready'
  host?: string
  port?: number
  httpUrl?: string
  wsUrl?: string
}

declare global {
  // Build tag injected by electron.vite.config.ts (git short-hash + dirty + time).
  const __APP_BUILD__: string
  interface Window {
    agentTeam?: {
      appName: string
      version: string
      getBackendInfo: () => Promise<BackendInfo>
      pickWorkspace: (defaultPath?: string) => Promise<string | null>
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
        filepath: string
        name?: string
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
    }
  }
}

export {}
