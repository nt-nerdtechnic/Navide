import { MINI_IDE_STORAGE_KEYS } from '../../shared/miniIdePreferences'
import type { HostStorageSnapshotIdentity, PluginStorageStore } from './pluginStorage'

/** Fixed preference overlay for the retained installed-version recovery
 * renderer. The Host selects an exact readable snapshot; missing values must
 * not resurrect legacy seeds. All other settings retain their existing owner. */
export function createMiniIdeLegacyPreferences(store: PluginStorageStore, snapshot: HostStorageSnapshotIdentity) {
  if (snapshot.pluginId !== 'navide.mini-ide' || snapshot.tier !== 'active' || !snapshot.packageVersion) {
    throw new Error('Invalid miniIDE recovery snapshot')
  }
  return {
    async read(settings: Record<string, unknown>): Promise<Record<string, unknown>> {
      await store.assertSnapshotReadable(snapshot)
      const result = { ...settings }
      for (const key of MINI_IDE_STORAGE_KEYS) {
        delete result[key]
        const stored = await store.execute({
          address: 'storage.get', args: { scope: 'plugin', key },
          partition: { pluginId: snapshot.pluginId, workspaceId: null, key }, snapshot,
        }) as { found: boolean; value: unknown }
        if (stored.found && typeof stored.value === 'string') result[key] = stored.value
      }
      return result
    },
    async write(updates: Record<string, unknown>): Promise<Record<string, unknown>> {
      for (const key of MINI_IDE_STORAGE_KEYS) {
        if (Object.hasOwn(updates, key) && typeof updates[key] !== 'string') {
          throw new Error('Invalid miniIDE recovery preference')
        }
      }
      await store.assertSnapshotReadable(snapshot)
      const remaining = { ...updates }
      for (const key of MINI_IDE_STORAGE_KEYS) {
        if (!Object.hasOwn(updates, key)) continue
        const value = updates[key] as string
        await store.execute({
          address: 'storage.set', args: { scope: 'plugin', key, value },
          partition: { pluginId: snapshot.pluginId, workspaceId: null, key }, snapshot,
        })
        delete remaining[key]
      }
      return remaining
    },
  }
}

export type MiniIdeLegacyPreferences = ReturnType<typeof createMiniIdeLegacyPreferences>
