import { createPluginCapabilityClient } from '@navide/plugin-sdk'
import { EDITOR_HOST_PREFERENCE_KEYS, EDITOR_WRITABLE_PREFERENCE_KEYS, type JsonValue } from '@navide/plugin-contracts'
import type { KeybindingsPort, SettingsBackend } from '@navide/plugin-ui/shared'
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

