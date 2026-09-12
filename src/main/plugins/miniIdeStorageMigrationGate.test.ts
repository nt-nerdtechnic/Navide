import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginStorageStore } from './pluginStorage'
import { MiniIdeStorageLifecycleSelector } from './miniIdeStorageLifecycle'
import { createMiniIdeStorageMigrationGate } from './miniIdeStorageMigrationGate'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('MiniIde storage migration admission', () => {
  it('allows first install, then is idempotent for the current marker', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mini-ide-gate-')); roots.push(root)
    const store = new PluginStorageStore(join(root, 'storage'))
    const lifecycle = new MiniIdeStorageLifecycleSelector(join(root, 'lifecycle.json'))
    const onReady = vi.fn()
    const ensure = createMiniIdeStorageMigrationGate({ store, lifecycle, readLegacySettings: () => ({ 'ide-sidebar-width': '240' }), onReady })
    await expect(ensure('1.0.0')).resolves.toEqual({ status: 'ready' })
    await expect(ensure('1.0.0')).resolves.toEqual({ status: 'ready' })
    expect(onReady).toHaveBeenCalledTimes(2)
    expect(lifecycle.sourceFor('1.0.0')).toBeNull()
  })

  it('uses only the exact readable previous snapshot and fails closed when it is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mini-ide-gate-')); roots.push(root)
    const store = new PluginStorageStore(join(root, 'storage'))
    const lifecycle = new MiniIdeStorageLifecycleSelector(join(root, 'lifecycle.json'))
    expect(lifecycle.rememberActive('1.0.0')).toBe(true)
    const onReady = vi.fn()
    const ensure = createMiniIdeStorageMigrationGate({ store, lifecycle, readLegacySettings: () => ({ 'ide-sidebar-width': 'legacy' }), onReady })
    await expect(ensure('2.0.0')).resolves.toEqual({ status: 'unavailable' })
    expect(onReady).not.toHaveBeenCalled()
  })
})
