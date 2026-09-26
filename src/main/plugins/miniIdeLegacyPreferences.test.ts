import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HostStorageSnapshotIdentity, StorageExecution } from './pluginStorage'
import { MissingStorageSnapshotError, PluginStorageStore } from './pluginStorage'
import { createMiniIdeLegacyPreferences } from './miniIdeLegacyPreferences'

const pluginId = 'navide.mini-ide'
const snapshot: HostStorageSnapshotIdentity = { pluginId, packageVersion: '1.0.0', tier: 'active' }
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function execution(
  address: 'storage.get' | 'storage.set',
  key: string,
  value: unknown = undefined,
  identity = snapshot,
): StorageExecution {
  return {
    address,
    args: address === 'storage.set' ? { scope: 'plugin', key, value } : { scope: 'plugin', key },
    partition: { pluginId: identity.pluginId, workspaceId: null, key },
    snapshot: identity,
  }
}

async function storeFixture(): Promise<{ root: string; store: PluginStorageStore }> {
  const root = mkdtempSync(join(tmpdir(), 'navide-mini-ide-recovery-'))
  roots.push(root)
  return { root, store: new PluginStorageStore(root) }
}

async function setValues(store: PluginStorageStore, values: Record<string, unknown>, identity = snapshot): Promise<void> {
  for (const [key, value] of Object.entries(values)) await store.execute(execution('storage.set', key, value, identity))
}

async function getValue(store: PluginStorageStore, key: string, identity = snapshot): Promise<unknown> {
  return (await store.execute(execution('storage.get', key, undefined, identity)) as { found: boolean; value: unknown }).value
}

describe('Mini-IDE legacy preference overlay', () => {
  it('replaces the three snapshot keys, removes absent legacy seeds, and preserves other settings', async () => {
    const { store } = await storeFixture()
    await setValues(store, {
      'ide-sidebar-width': '280',
      'agentTeam.search.opts': '{"regex":true}',
    })
    const settings = {
      'ide-sidebar-width': 'legacy-sidebar',
      'ide-ai-panel-width': 'legacy-ai',
      'agentTeam.search.opts': 'legacy-search',
      'terminal.fontSize': '14',
      unrelated: { keep: true },
    }

    await expect(createMiniIdeLegacyPreferences(store, snapshot).read(settings)).resolves.toEqual({
      'ide-sidebar-width': '280',
      'agentTeam.search.opts': '{"regex":true}',
      'terminal.fontSize': '14',
      unrelated: { keep: true },
    })
    expect(settings['ide-ai-panel-width']).toBe('legacy-ai')
  })

  it('writes only the three snapshot keys and returns remaining Host-owned updates', async () => {
    const { store } = await storeFixture()
    await setValues(store, { 'host-owned': 'old' })
    const updates = {
      'ide-sidebar-width': '300',
      'ide-ai-panel-width': '420',
      'agentTeam.search.opts': '{"smart":false}',
      'host-owned': 'new',
    }

    await expect(createMiniIdeLegacyPreferences(store, snapshot).write(updates)).resolves.toEqual({
      'host-owned': 'new',
    })
    await expect(getValue(store, 'ide-sidebar-width')).resolves.toBe('300')
    await expect(getValue(store, 'ide-ai-panel-width')).resolves.toBe('420')
    await expect(getValue(store, 'agentTeam.search.opts')).resolves.toBe('{"smart":false}')
    await expect(getValue(store, 'host-owned')).resolves.toBe('old')
  })

  it('prevalidates all three overlay values before performing any write', async () => {
    const { store } = await storeFixture()
    await setValues(store, { 'ide-sidebar-width': 'old-sidebar', 'ide-ai-panel-width': 'old-ai' })
    const updates = {
      'ide-sidebar-width': 'new-sidebar',
      'ide-ai-panel-width': 420,
      'agentTeam.search.opts': 'new-search',
    }

    await expect(createMiniIdeLegacyPreferences(store, snapshot).write(updates)).rejects.toThrow(
      'Invalid miniIDE recovery preference'
    )
    await expect(getValue(store, 'ide-sidebar-width')).resolves.toBe('old-sidebar')
    await expect(getValue(store, 'ide-ai-panel-width')).resolves.toBe('old-ai')
    await expect(getValue(store, 'agentTeam.search.opts')).resolves.toBeNull()
  })

  it('requires the exact Mini-IDE active snapshot and fails closed when it is missing or corrupt', async () => {
    const { root, store } = await storeFixture()
    expect(() => createMiniIdeLegacyPreferences(store, {
      pluginId: 'other.plugin', packageVersion: snapshot.packageVersion, tier: 'active',
    })).toThrow('Invalid miniIDE recovery snapshot')
    expect(() => createMiniIdeLegacyPreferences(store, {
      pluginId, packageVersion: snapshot.packageVersion, tier: 'candidate',
    })).toThrow('Invalid miniIDE recovery snapshot')

    const missing = createMiniIdeLegacyPreferences(store, snapshot)
    await expect(missing.read({ 'ide-sidebar-width': 'legacy' })).rejects.toBeInstanceOf(MissingStorageSnapshotError)

    const directory = join(root, createHash('sha256').update(pluginId, 'utf8').digest('hex'), createHash('sha256').update(snapshot.packageVersion, 'utf8').digest('hex'), snapshot.tier)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'plugin.json'), '{corrupt')
    await expect(missing.read({ 'ide-sidebar-width': 'legacy' })).rejects.toThrow()
  })
})
