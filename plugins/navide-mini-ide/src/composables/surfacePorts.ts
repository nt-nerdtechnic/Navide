import { createPluginCapabilityClient } from '@navide/plugin-sdk'
import { EDITOR_HOST_PREFERENCE_KEYS, EDITOR_WRITABLE_PREFERENCE_KEYS, type JsonValue } from '@navide/plugin-contracts'
import type { GitSurfacePorts, GitTransport } from '@navide/navide-git/composition'
import type { KeybindingsPort, SettingsBackend } from '@navide/plugin-ui/shared'
import { createMiniIdeGitAccountPort } from './gitAccounts'
import { native } from './native'
import { directoryGrant } from './selectionTargets'
import type { useBackend } from './useBackend'

type Backend = ReturnType<typeof useBackend>
const layoutKeys = ['ide-sidebar-width', 'ide-ai-panel-width', 'agentTeam.search.opts'] as const

export function createMiniIdeSettingsPort(backend: Backend): SettingsBackend {
  const client = createPluginCapabilityClient()
  return {
    status: backend.status,
    ownedKeys: [...layoutKeys, ...EDITOR_WRITABLE_PREFERENCE_KEYS, 'agentTeam.uiScale'],
    readOnlyKeys: EDITOR_HOST_PREFERENCE_KEYS,
    async getAll() {
      const { preferences } = await client.capabilities.invoke('ui.readEditorPreferences', {})
      const entries = await Promise.all(layoutKeys.map(async key => {
        const result = await client.capabilities.invoke('storage.get', { scope: 'plugin', key })
        return result.found ? [key, result.value] as const : null
      }))
      return { ...preferences, ...Object.fromEntries(entries.filter(entry => entry !== null)) }
    },
    async setMany(updates) {
      for (const [key, value] of Object.entries(updates)) {
        if (layoutKeys.includes(key as typeof layoutKeys[number])) {
          if (value === null) await client.capabilities.invoke('storage.delete', { scope: 'plugin', key })
          else await client.capabilities.invoke('storage.set', { scope: 'plugin', key, value: value as JsonValue })
        } else if (key === 'agentTeam.uiScale') {
          await native.setUiScale(Number(value))
        } else if (EDITOR_WRITABLE_PREFERENCE_KEYS.includes(key as typeof EDITOR_WRITABLE_PREFERENCE_KEYS[number])) {
          await client.capabilities.invoke('ui.writeEditorPreference', {
            key: key as typeof EDITOR_WRITABLE_PREFERENCE_KEYS[number], value: value as JsonValue,
          })
        }
      }
    },
    onChanged(callback) {
      const subscription = client.events.subscribe('ui.editorPreferencesChanged', ({ preferences }) => {
        callback({ source: 'host', settings: preferences })
      })
      const storage = client.events.subscribe('ui.pluginStorageChanged', event => {
        if (event.scope === 'plugin' && layoutKeys.includes(event.key as typeof layoutKeys[number])) {
          callback({ source: 'plugin-storage', settings: { [event.key]: event.deleted ? null : event.value } })
        }
      })
      return () => { subscription.dispose(); storage.dispose() }
    },
  }
}

export function createMiniIdeKeybindingsPort(): KeybindingsPort {
  return { read: native.readKeybindings, write: native.writeKeybindings, onChanged: native.onKeybindingsChanged }
}

export function createMiniIdeGitSurfacePorts(backend: Backend, gitTransport: GitTransport): GitSurfacePorts {
  const client = createPluginCapabilityClient()
  const ui: GitSurfacePorts['ui'] = {
    async openInEditor({ workspacePath, filepath, line }) {
      await native.openEditorWindow({ workspace_path: workspacePath, filepath, line })
    },
    async openExternal(url) { await native.openExternal(url) },
    async revealPath(path) { await native.revealPath(path) },
    pickFolder: native.pickWorkspace,
  }
  return {
    gitTransport,
    ui,
    fileAccess: {
      async readFile(workspacePath, relPath) {
        const response = await backend.send<{ ok: boolean; content: string; error?: string }>(
          'fs.read_file', { workspace_path: workspacePath, rel_path: relPath },
        )
        return { ok: response.ok && response.payload?.ok === true, content: response.payload?.content ?? '', error: response.payload?.error || response.error?.message }
      },
      async writeFile(workspacePath, relPath, content) {
        const response = await backend.send<{ ok: boolean; error?: string }>(
          'fs.write_file', { workspace_path: workspacePath, rel_path: relPath, content },
        )
        return { ok: response.ok && response.payload?.ok === true, error: response.payload?.error || response.error?.message }
      },
      async readImage(workspacePath, relPath) {
        const response = await backend.send<{ ok: boolean; data_url?: string }>(
          'fs.read_image', { workspace_path: workspacePath, rel_path: relPath },
        )
        return response.ok && response.payload?.ok ? response.payload.data_url ?? '' : ''
      },
    },
    paneUi: {
      ...ui,
      async openPath(path) { await native.openPath(path) },
      async openTempFile(name, content) { await native.openTempFile(name, content) },
      async pickWorkspace(defaultPath) {
        const path = await native.pickWorkspace(defaultPath)
        const grant = path ? directoryGrant(path) : undefined
        return path && grant ? { path, grant } : null
      },
      async openMainWindow(workspacePath) { await native.openMainWindow(workspacePath) },
      async openBranchDiffWindow(workspacePath, base) { await native.openBranchDiffWindow(workspacePath, base) },
      async openGitWindow(args) {
        await client.capabilities.invoke('ui.openGitWindow', {
          ...(args.filepath === undefined ? {} : { path: args.filepath }),
          ...(args.staged === undefined ? {} : { staged: args.staged }),
          ...(args.commit === undefined ? {} : { commit: args.commit }),
          ...(args.base === undefined ? {} : { base: args.base }),
          ...(args.compare === undefined ? {} : { compare: args.compare }),
        })
      },
      async openGitHistoryWindow(workspacePath) { await native.openGitHistoryWindow(workspacePath) },
    },
    accounts: createMiniIdeGitAccountPort(client.capabilities),
    branchDiff: {
      async load(workspacePath, base, compare) {
        const response = await backend.send<{ ok: boolean; diff: string; error?: string }>('git.diff_branches', {
          workspace_path: workspacePath, base, compare,
        })
        return { ok: response.ok && response.payload?.ok === true, diff: response.payload?.diff ?? '', error: response.payload?.error || response.error?.message }
      },
    },
    issues: {
      provider: workspacePath => backend.send('issues.provider', { workspace_path: workspacePath }),
      list: (workspacePath, limit) => backend.send('issues.list', { workspace_path: workspacePath, limit }, 30_000),
      get: (workspacePath, number) => backend.send('issues.get', { workspace_path: workspacePath, number }, 30_000),
      create: (workspacePath, title, body) => backend.send('issues.create', { workspace_path: workspacePath, title, body }, 30_000),
      comment: (workspacePath, number, body) => backend.send('issues.comment', { workspace_path: workspacePath, number, body }, 30_000),
      setState: (workspacePath, number, state) => backend.send('issues.set_state', { workspace_path: workspacePath, number, state }, 30_000),
    },
  }
}
