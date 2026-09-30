import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginPackStore, type InstalledPackRecord } from './pluginPackStore'

const FILE = '.navide-plugin-packs.json'

const PACK: InstalledPackRecord = {
  id: 'acme.web-dev-pack',
  displayName: 'Web Dev Pack',
  version: '1.0.0',
  members: ['acme.hello', 'acme.lint'],
  installedByPack: ['acme.lint'],
}

function withRoot(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'navide-plugin-packs-'))
  try {
    run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('PluginPackStore', () => {
  it('starts empty', () => {
    withRoot((root) => {
      expect(new PluginPackStore(root).list()).toEqual([])
      expect(new PluginPackStore(root).get('acme.web-dev-pack')).toBeNull()
    })
  })

  it('writes atomically with owner-only permissions and reads the record back', () => {
    withRoot((root) => {
      new PluginPackStore(root).put(PACK)
      // No temporary file is left beside the store.
      expect(readdirSync(root)).toEqual([FILE])
      expect(JSON.parse(readFileSync(join(root, FILE), 'utf8'))).toEqual({ schemaVersion: 1, packs: [PACK] })
      if (process.platform !== 'win32') expect(statSync(join(root, FILE)).mode & 0o777).toBe(0o600)
      expect(new PluginPackStore(root).get(PACK.id)).toEqual(PACK)
    })
  })

  it('replaces a record on put and forgets it on remove', () => {
    withRoot((root) => {
      const store = new PluginPackStore(root)
      store.put(PACK)
      store.put({ ...PACK, version: '1.1.0', installedByPack: [] })
      expect(store.list()).toEqual([{ ...PACK, version: '1.1.0', installedByPack: [] }])
      expect(store.remove(PACK.id)?.version).toBe('1.1.0')
      expect(store.remove(PACK.id)).toBeNull()
      expect(store.list()).toEqual([])
    })
  })

  it('reads a record written before display names were kept', () => {
    withRoot((root) => {
      const legacy = { id: PACK.id, version: '1.0.0', members: ['acme.hello'], installedByPack: [] }
      writeFileSync(join(root, FILE), JSON.stringify({ schemaVersion: 1, packs: [legacy] }), { mode: 0o600 })
      expect(new PluginPackStore(root).list()).toEqual([legacy])
    })
  })

  it.each([
    ['not JSON', '{not-json'],
    ['a wrong schema version', JSON.stringify({ schemaVersion: 2, packs: [] })],
    ['a malformed record', JSON.stringify({ schemaVersion: 1, packs: [{ id: 'acme.x', version: '1.0.0', members: 'acme.a' }] })],
    ['a non-string display name', JSON.stringify({ schemaVersion: 1, packs: [{ ...PACK, displayName: 7 }] })],
  ])('treats a file with %s as empty and warns', (_label, content) => {
    withRoot((root) => {
      writeFileSync(join(root, FILE), content, { mode: 0o600 })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      expect(new PluginPackStore(root).list()).toEqual([])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('invalid extension pack records'))
      warn.mockRestore()
    })
  })

  it.skipIf(process.platform === 'win32')('refuses a store that is a symlink, even to a valid file', () => {
    withRoot((root) => {
      const target = join(root, 'elsewhere.json')
      writeFileSync(target, JSON.stringify({ schemaVersion: 1, packs: [PACK] }), { mode: 0o600 })
      symlinkSync(target, join(root, FILE))
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      expect(new PluginPackStore(root).list()).toEqual([])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('invalid extension pack records'))
      warn.mockRestore()
    })
  })
})
