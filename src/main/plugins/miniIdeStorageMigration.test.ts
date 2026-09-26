import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { StorageExecution } from './pluginStorage'
import { PluginStorageStore } from './pluginStorage'
import { migrateMiniIdePreferences } from './miniIdeStorageMigration'

const pluginId = 'navide.mini-ide'
const version = '0.2.0'
const roots: string[] = []
const keys = ['ide-sidebar-width', 'ide-ai-panel-width', 'agentTeam.search.opts'] as const
const sourceVersion = '0.1.0'

function read(key: string, packageVersion = version, id = pluginId): StorageExecution {
  return {
    address: 'storage.get', args: { scope: 'plugin', key },
    partition: { pluginId: id, workspaceId: null, key },
    snapshot: { pluginId: id, packageVersion, tier: 'active' },
  }
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('miniIDE preference migration', () => {
  it('copies only allowlisted string preferences and preserves legacy seeds', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-mini-ide-storage-')); roots.push(root)
    const store = new PluginStorageStore(root)
    const legacySettings: Record<string, unknown> = {
      'ide-sidebar-width': '240', 'ide-ai-panel-width': '360', 'agentTeam.search.opts': '{"regex":true}',
      'terminal-font-size': '14', 'ide-ai-panel-width.agent': 'claude', pty: { id: 'pty' },
      scrollback: 'old', session: { id: 'session' }, 'agent-team:theme': 'dark', unrelated: 'keep',
    }
    await expect(migrateMiniIdePreferences(store, { packageVersion: version, legacySettings }))
      .resolves.toEqual({ completed: true, written: [...keys] })
    for (const key of keys) await expect(store.execute(read(key))).resolves.toEqual({ found: true, value: legacySettings[key] })
    expect(legacySettings).toHaveProperty('terminal-font-size', '14')
    await expect(store.execute(read('terminal-font-size'))).resolves.toEqual({ found: false, value: null })
    await expect(store.execute(read('unrelated'))).resolves.toEqual({ found: false, value: null })
    await expect(store.execute(read('ide-ai-panel-width.agent'))).resolves.toEqual({ found: false, value: null })
  })

  it('keeps plugin edits on retry and resumes after an interrupted write', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-mini-ide-retry-')); roots.push(root)
    const store = new PluginStorageStore(root)
    const options = { packageVersion: version, legacySettings: {
      'ide-sidebar-width': '240', 'ide-ai-panel-width': '360', 'agentTeam.search.opts': 'old',
    } }
    await migrateMiniIdePreferences(store, options)
    await store.execute({ address: 'storage.set', args: { scope: 'plugin', key: 'ide-sidebar-width', value: 'user-edit' }, partition: { pluginId, workspaceId: null, key: 'ide-sidebar-width' }, snapshot: { pluginId, packageVersion: version, tier: 'active' } })
    await expect(migrateMiniIdePreferences(store, { ...options, legacySettings: { ...options.legacySettings, 'agentTeam.search.opts': 'new' } })).resolves.toMatchObject({ completed: true })
    await expect(store.execute(read('ide-sidebar-width'))).resolves.toEqual({ found: true, value: 'user-edit' })
    await expect(store.execute(read('agentTeam.search.opts'))).resolves.toEqual({ found: true, value: 'old' })
  })

  it('copies only present source snapshot values on update and preserves deletions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-mini-ide-source-')); roots.push(root)
    const store = new PluginStorageStore(root)
    const source = { pluginId, packageVersion: sourceVersion, tier: 'active' as const }
    await store.execute({ address: 'storage.set', args: { scope: 'plugin', key: 'ide-sidebar-width', value: '220' }, partition: { pluginId, workspaceId: null, key: 'ide-sidebar-width' }, snapshot: source })
    await store.execute({ address: 'storage.set', args: { scope: 'plugin', key: 'agentTeam.search.opts', value: 'source' }, partition: { pluginId, workspaceId: null, key: 'agentTeam.search.opts' }, snapshot: source })
    await expect(migrateMiniIdePreferences(store, {
      packageVersion: version, sourceSnapshot: source,
      legacySettings: { 'ide-sidebar-width': 'legacy', 'ide-ai-panel-width': 'legacy', 'agentTeam.search.opts': 'legacy' },
    })).resolves.toEqual({ completed: true, written: ['ide-sidebar-width', 'agentTeam.search.opts'] })
    await expect(store.execute(read('ide-sidebar-width'))).resolves.toEqual({ found: true, value: '220' })
    await expect(store.execute(read('ide-ai-panel-width'))).resolves.toEqual({ found: false, value: null })
    await expect(store.execute(read('agentTeam.search.opts'))).resolves.toEqual({ found: true, value: 'source' })
  })

  it('fails closed for missing, corrupt, or wrong source snapshots', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-mini-ide-source-invalid-')); roots.push(root)
    const store = new PluginStorageStore(root)
    const invalid = { pluginId, packageVersion: 'missing', tier: 'active' as const }
    await expect(migrateMiniIdePreferences(store, { packageVersion: version, sourceSnapshot: invalid, legacySettings: { 'ide-sidebar-width': 'legacy' } })).resolves.toEqual({ completed: false, written: [] })
    await expect(migrateMiniIdePreferences(store, { packageVersion: version, sourceSnapshot: { pluginId: 'other', packageVersion: sourceVersion, tier: 'active' }, legacySettings: {} })).resolves.toEqual({ completed: false, written: [] })
    await expect(migrateMiniIdePreferences(store, { packageVersion: version, sourceSnapshot: { pluginId, packageVersion: sourceVersion, tier: 'workspace' as never }, legacySettings: {} })).resolves.toEqual({ completed: false, written: [] })
  })

  it('reports incomplete work and resumes missing keys after an interrupted migration', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-mini-ide-interrupt-')); roots.push(root)
    const store = new PluginStorageStore(root)
    const options = { packageVersion: version, legacySettings: {
      'ide-sidebar-width': '240', 'ide-ai-panel-width': '360', 'agentTeam.search.opts': 'old',
    } }
    const original = store.setIfAbsent.bind(store)
    let interrupted = false
    store.setIfAbsent = async (execution) => {
      if (!interrupted) { interrupted = true; throw new Error('simulated interruption') }
      return original(execution)
    }
    await expect(migrateMiniIdePreferences(store, options)).resolves.toMatchObject({ completed: false, written: [] })
    await expect(migrateMiniIdePreferences(store, options)).resolves.toMatchObject({ completed: true, written: [...keys] })
    for (const key of keys) await expect(store.execute(read(key))).resolves.toMatchObject({ found: true })
  })

  it('serializes simultaneous migrations and isolates other plugin/workspace storage', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-mini-ide-concurrent-')); roots.push(root)
    const store = new PluginStorageStore(root)
    const options = { packageVersion: version, legacySettings: { 'ide-sidebar-width': '240' } }
    await expect(Promise.all([migrateMiniIdePreferences(store, options), migrateMiniIdePreferences(store, options)])).resolves.toHaveLength(2)
    await expect(store.execute(read('ide-sidebar-width'))).resolves.toEqual({ found: true, value: '240' })
    await expect(store.execute(read('ide-sidebar-width', version, 'other.plugin'))).resolves.toEqual({ found: false, value: null })
    await expect(store.execute({
      ...read('ide-sidebar-width'),
      args: { scope: 'workspace', key: 'ide-sidebar-width' },
      partition: { pluginId, workspaceId: 'workspace-1', key: 'ide-sidebar-width' },
      snapshot: { pluginId, packageVersion: version, tier: 'active' },
    })).resolves.toEqual({ found: false, value: null })
  })
})
