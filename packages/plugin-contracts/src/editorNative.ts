export interface EditorFileSelection {
  path: string
  grant: string
}

export interface EditorNativeParams {
  /** The contribution key selects an installed resource, never caller identity.
   * Paths are relative to the authenticated workspace or an exact-file grant. */
  'ui.openPluginWindow': { contributionKey: string; path?: string; line?: number; grant?: string }
  'ui.pickFile': { title?: string }
  'ui.pickWorkspace': { defaultPath?: string }
  'ui.resolvePath': { path: string; grant?: string }
  'ui.revealPath': { path: string; grant?: string }
  'ui.openPath': { path: string; grant?: string }
  'ui.openTempFile': { name: string; content: string }
  'ui.listEditors': { refresh?: boolean }
  'ui.openFolderInEditor': { path: string; editorId?: string; grant?: string }
  'ui.openEditorWindow': { path?: string; line?: number; sidebar?: string; grant?: string }
  'ui.openMainWindow': { path?: string; grant?: string }
  'ui.openBranchDiffWindow': { base: string; repositoryPath?: string }
  'ui.openGitWindow': { path?: string; name?: string; staged?: boolean; commit?: string; base?: string; compare?: string; repositoryPath?: string }
  'ui.openGitHistoryWindow': { repositoryPath?: string }
  'ui.readKeybindings': Record<string, never>
  'ui.writeKeybindings': { content: string }
  'ui.setUiScale': { scale: number }
}

export interface EditorNativeResults {
  'ui.openPluginWindow': { ok: true } | { ok: false; error: 'PLUGIN_NOT_INSTALLED' | 'PLUGIN_UNAVAILABLE'; message: string }
  'ui.pickFile': EditorFileSelection | null
  'ui.pickWorkspace': EditorFileSelection | null
  'ui.resolvePath': string
  'ui.revealPath': { ok: boolean }
  'ui.openPath': { ok: boolean }
  'ui.openTempFile': { ok: boolean }
  'ui.listEditors': Array<{ id: string; label: string; available: boolean }>
  'ui.openFolderInEditor': { ok: boolean }
  'ui.openEditorWindow': { ok: boolean }
  'ui.openMainWindow': { ok: boolean }
  'ui.openBranchDiffWindow': { ok: boolean }
  'ui.openGitWindow': { ok: boolean }
  'ui.openGitHistoryWindow': { ok: boolean }
  'ui.readKeybindings': { ok: boolean; content?: string; error?: string }
  'ui.writeKeybindings': { ok: boolean; error?: string }
  'ui.setUiScale': number
}

export interface EditorNativeEvents {
  'ui.keybindingsChanged': { content: string }
}
