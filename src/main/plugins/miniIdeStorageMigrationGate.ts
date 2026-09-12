import type { PluginStorageStore } from './pluginStorage'
import { MINI_IDE_PLUGIN_ID, type MiniIdeStorageLifecycleSelector } from './miniIdeStorageLifecycle'
import { migrateMiniIdePreferences } from './miniIdeStorageMigration'

export interface MiniIdeStorageAvailability {
  status: 'ready' | 'recovery' | 'unavailable'
}

/** Reuse the existing Host migration gate: publish no runtime snapshot until
 * both the preferences and the selected lifecycle record are durable. */
export function createMiniIdeStorageMigrationGate(options: {
  store: PluginStorageStore
  lifecycle: MiniIdeStorageLifecycleSelector
  readLegacySettings(): Record<string, unknown>
  onReady(packageVersion: string, previousPackageVersion: string | null): void
}): (packageVersion: string) => Promise<MiniIdeStorageAvailability> {
  const migrations = new Map<string, Promise<MiniIdeStorageAvailability>>()
  return packageVersion => {
    const existing = migrations.get(packageVersion)
    if (existing) return existing
    const promise = Promise.resolve().then(async (): Promise<MiniIdeStorageAvailability> => {
      try {
        const sourceSnapshot = options.lifecycle.sourceFor(packageVersion)
        const migration = await migrateMiniIdePreferences(options.store, {
          packageVersion, sourceSnapshot, legacySettings: options.readLegacySettings(),
        })
        if (!migration.completed) throw new Error('miniIDE preference migration did not complete')
        await options.store.assertSnapshotReadable({ pluginId: MINI_IDE_PLUGIN_ID, packageVersion, tier: 'active' })
        if (!options.lifecycle.rememberActive(packageVersion, sourceSnapshot?.packageVersion ?? null)) {
          throw new Error('miniIDE storage lifecycle could not be persisted')
        }
        options.onReady(packageVersion, sourceSnapshot?.packageVersion ?? null)
        return { status: 'ready' }
      } catch {
        try {
          const source = options.lifecycle.sourceFor(packageVersion)
          if (source) {
            await options.store.assertSnapshotReadable(source)
            return { status: 'recovery' }
          }
        } catch { /* No trusted readable recovery snapshot. */ }
        return { status: 'unavailable' }
      }
    }).finally(() => {
      if (migrations.get(packageVersion) === promise) migrations.delete(packageVersion)
    })
    migrations.set(packageVersion, promise)
    return promise
  }
}
