import { MINI_IDE_STORAGE_KEYS, type MiniIdeStorageKey } from '../../shared/miniIdePreferences'
import type { HostStorageSnapshotIdentity, PluginStorageStore } from './pluginStorage'

const pluginId = 'navide.mini-ide'
const migrationMarker = '__navide_mini_ide_preferences_v2'

/** Seed only missing preferences in the Host-selected active version. The
 * store's atomic create-only operation also protects simultaneous windows and
 * retries after an interrupted migration. Neither legacy seeds nor existing
 * plugin values are overwritten. */
export async function migrateMiniIdePreferences(
  store: PluginStorageStore,
  options: { packageVersion: string; legacySettings: Record<string, unknown>; sourceSnapshot?: HostStorageSnapshotIdentity | null },
): Promise<{ completed: boolean; written: MiniIdeStorageKey[] }> {
  const written: MiniIdeStorageKey[] = []
  if (!options.packageVersion) return { completed: false, written }
  try {
    const snapshot = { pluginId, packageVersion: options.packageVersion, tier: 'active' as const }
    const marker = await store.execute({
      address: 'storage.get', args: { scope: 'plugin', key: migrationMarker },
      partition: { pluginId, workspaceId: null, key: migrationMarker }, snapshot,
    }) as { found: boolean; value: unknown }
    if (marker.found && marker.value === true) return { completed: true, written }
    const source = options.sourceSnapshot
    if (source) {
      if (source.pluginId !== pluginId || source.tier !== 'active' || source.packageVersion === options.packageVersion) {
        throw new Error('invalid miniIDE preference source identity')
      }
      await store.assertSnapshotReadable(source)
    }
    for (const key of MINI_IDE_STORAGE_KEYS) {
      const stored = source ? await store.execute({
        address: 'storage.get', args: { scope: 'plugin', key },
        partition: { pluginId, workspaceId: null, key }, snapshot: source,
      }) as { found: boolean; value: unknown } : null
      // An absent key in a selected plugin snapshot is an intentional absence;
      // never resurrect a legacy seed during an update or rollback.
      const value = source ? (stored?.found ? stored.value : undefined) : options.legacySettings[key]
      if (typeof value !== 'string') continue
      const created = await store.setIfAbsent({
        address: 'storage.set',
        args: { scope: 'plugin', key, value },
        partition: { pluginId: 'navide.mini-ide', workspaceId: null, key },
        snapshot: {
          pluginId: 'navide.mini-ide',
          packageVersion: options.packageVersion,
          tier: 'active',
        },
      })
      if (created) written.push(key)
    }
    await store.setIfAbsent({
      address: 'storage.set', args: { scope: 'plugin', key: migrationMarker, value: true },
      partition: { pluginId, workspaceId: null, key: migrationMarker }, snapshot,
    })
    return { completed: true, written }
  } catch (error) {
    console.warn('[mini-ide] preference migration incomplete:',
      error instanceof Error ? error.message : String(error))
    return { completed: false, written }
  }
}
