import { createPluginCapabilityClient } from '@navide/plugin-sdk'
import { directoryGrant, fileGrant, rememberSelection, targetPath } from './selectionTargets'

const client = createPluginCapabilityClient()
const invoke = client.capabilities.invoke
const workspacePath = new URLSearchParams(window.location.search).get('workspace_path') ?? ''
const pathArgs = (path: string) => ({ path, ...(fileGrant(path) ? { grant: fileGrant(path) } : {}) })

interface WindowControls {
  minimize(): Promise<void>
  close(): Promise<void>
  toggleMaximize(): Promise<{ maximized: boolean }>
  isMaximized(): Promise<{ maximized: boolean }>
  onMaximizeChanged(listener: (maximized: boolean) => void): () => void
}

export const native = {
  // Plugin contribution windows retain their native system frame off macOS.
  windowControls: undefined as WindowControls | undefined,
  realpath: (path: string) => invoke('ui.resolvePath', pathArgs(path)),
  async pickFile(options: { title?: string } = {}) {
    const selection = await invoke('ui.pickFile', options)
    if (selection) rememberSelection(selection, 'file')
    return selection ? { ok: true, path: selection.path } : { ok: false, path: '' }
  },
  async pickWorkspace(defaultPath?: string) {
    const selection = await invoke('ui.pickWorkspace', { ...(defaultPath ? { defaultPath } : {}) })
    if (selection) rememberSelection(selection, 'directory')
    return selection?.path ?? null
  },
  openExternal: (url: string) => invoke('ui.openExternal', { url }),
  revealPath: (path: string) => invoke('ui.revealPath', pathArgs(path)),
  openPath: (path: string) => invoke('ui.openPath', pathArgs(path)),
  openTempFile: (name: string, content: string) => invoke('ui.openTempFile', { name, content }),
  listEditors: (refresh?: boolean) => invoke('ui.listEditors', { ...(refresh === undefined ? {} : { refresh }) }),
  openFolderInEditor: (path: string, editorId?: string) => invoke('ui.openFolderInEditor', {
    path, ...(editorId ? { editorId } : {}), ...(directoryGrant(path) ? { grant: directoryGrant(path) } : {}),
  }),
  openEditorWindow(args: { workspace_path: string; filepath?: string; file_ws?: string; line?: number; sidebar?: string; name?: string }) {
    const path = args.filepath === undefined ? undefined : targetPath(args.file_ws ?? args.workspace_path, args.filepath)
    const grant = path ? fileGrant(path) : directoryGrant(args.workspace_path)
    if (!path && targetPath('', args.workspace_path) !== targetPath('', workspacePath) && !grant) {
      return Promise.reject(new Error('workspace lacks a Host picker grant'))
    }
    return invoke('ui.openEditorWindow', {
      ...(path ? { path } : {}), ...(grant ? { grant } : {}),
      ...(args.line === undefined ? {} : { line: args.line }), ...(args.sidebar ? { sidebar: args.sidebar } : {}),
    })
  },
  openDiffWindow(args: { workspace_path: string; filepath: string; staged?: boolean; name?: string }) {
    return invoke('ui.openGitWindow', {
      path: args.filepath,
      repositoryPath: args.workspace_path,
      ...(args.name === undefined ? {} : { name: args.name }),
      ...(args.staged === undefined ? {} : { staged: args.staged }),
    })
  },
  openMainWindow: (path: string) => invoke('ui.openMainWindow', { path, ...(directoryGrant(path) ? { grant: directoryGrant(path) } : {}) }),
  openBranchDiffWindow: (repositoryPath: string, base: string) => invoke('ui.openBranchDiffWindow', { repositoryPath, base }),
  openGitHistoryWindow: (repositoryPath: string) => invoke('ui.openGitHistoryWindow', { repositoryPath }),
  readKeybindings: () => invoke('ui.readKeybindings', {}),
  writeKeybindings: (content: string) => invoke('ui.writeKeybindings', { content }),
  onKeybindingsChanged: (listener: (content: string) => void) => {
    const subscription = client.events.subscribe('ui.keybindingsChanged', event => listener(event.content))
    return () => subscription.dispose()
  },
  setUiScale: (scale: number) => invoke('ui.setUiScale', { scale }),
}

export const revealPath = native.revealPath
