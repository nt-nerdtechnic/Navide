import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginPrereleaseStore } from './pluginPrereleaseStore'

const FILE = '.navide-plugin-prereleases.json'

function withRoot(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'navide-plugin-prereleases-'))
  try {
    run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('PluginPrereleaseStore', () => {
  it('defaults every extension to stable', () => {
    withRoot((root) => {
      const store = new PluginPrereleaseStore(root)
      expect(store.list()).toEqual([])
      expect(store.has('acme.demo')).toBe(false)
    })
  })

  it('persists a per-extension opt-in and turns it off again', () => {
    withRoot((root) => {
      new PluginPrereleaseStore(root).set('acme.demo', true)
      new PluginPrereleaseStore(root).set('acme.other', true)
      new PluginPrereleaseStore(root).set('acme.demo', true)
      expect(new PluginPrereleaseStore(root).list()).toEqual(['acme.demo', 'acme.other'])
      new PluginPrereleaseStore(root).set('acme.demo', false)
      expect(new PluginPrereleaseStore(root).has('acme.demo')).toBe(false)
      expect(new PluginPrereleaseStore(root).has('acme.other')).toBe(true)
      expect(JSON.parse(readFileSync(join(root, FILE), 'utf8'))).toEqual({
        schemaVersion: 1,
        pluginIds: ['acme.other'],
      })
      if (process.platform !== 'win32') expect(statSync(join(root, FILE)).mode & 0o777).toBe(0o600)
    })
  })

  it('treats a malformed file as all-stable and repairs it on the next change', () => {
    withRoot((root) => {
      writeFileSync(join(root, FILE), '{not-json', { mode: 0o600 })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const store = new PluginPrereleaseStore(root)
      expect(store.has('acme.demo')).toBe(false)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('invalid pre-release preferences'))
      store.set('acme.demo', true)
      expect(new PluginPrereleaseStore(root).list()).toEqual(['acme.demo'])
      warn.mockRestore()
    })
  })
})
