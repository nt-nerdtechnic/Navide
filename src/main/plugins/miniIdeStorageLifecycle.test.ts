import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MiniIdeStorageLifecycleSelector, UnreadableMiniIdeLifecycleRecordError } from './miniIdeStorageLifecycle'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('MiniIde storage lifecycle selector', () => {
  it('returns the exact previous active selection and never scans arbitrary versions', () => {
    const root = mkdtempSync(join(tmpdir(), 'mini-ide-lifecycle-')); roots.push(root)
    const selector = new MiniIdeStorageLifecycleSelector(join(root, 'lifecycle.json'))
    expect(selector.rememberActive('1.0.0')).toBe(true)
    expect(selector.rememberActive('2.0.0')).toBe(true)
    expect(selector.sourceFor('2.0.0')).toEqual({ pluginId: 'navide.mini-ide', packageVersion: '1.0.0', tier: 'active' })
    expect(selector.sourceFor('3.0.0')).toEqual({ pluginId: 'navide.mini-ide', packageVersion: '2.0.0', tier: 'active' })
  })

  it('treats absent lifecycle as first install but fails closed on corrupt records', () => {
    const root = mkdtempSync(join(tmpdir(), 'mini-ide-lifecycle-')); roots.push(root)
    const path = join(root, 'lifecycle.json')
    const selector = new MiniIdeStorageLifecycleSelector(path)
    expect(selector.sourceFor('1.0.0')).toBeNull()
    writeFileSync(path, '{broken')
    expect(() => selector.sourceFor('1.0.0')).toThrow(UnreadableMiniIdeLifecycleRecordError)
  })

  it('clears only lifecycle metadata and retains storage snapshots and legacy seeds', () => {
    const root = mkdtempSync(join(tmpdir(), 'mini-ide-lifecycle-clear-')); roots.push(root)
    const lifecyclePath = join(root, 'lifecycle.json')
    const storageSnapshot = join(root, 'plugin-storage-v2', 'active', 'plugin.json')
    const legacySeed = join(root, 'legacy-settings.json')
    mkdirSync(join(root, 'plugin-storage-v2', 'active'), { recursive: true })
    writeFileSync(storageSnapshot, '{"snapshot":"retain"}')
    writeFileSync(legacySeed, '{"terminal":"retain"}')
    const selector = new MiniIdeStorageLifecycleSelector(lifecyclePath)
    expect(selector.rememberActive('2.0.0', '1.0.0')).toBe(true)

    selector.clear()

    expect(existsSync(lifecyclePath)).toBe(false)
    expect(readFileSync(storageSnapshot, 'utf8')).toBe('{"snapshot":"retain"}')
    expect(readFileSync(legacySeed, 'utf8')).toBe('{"terminal":"retain"}')
    expect(selector.sourceFor('2.0.0')).toBeNull()
  })
})
