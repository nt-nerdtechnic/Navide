import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseInstalledManifest,
  manifestToDescriptor,
  scanInstalledPlugins,
  InstalledPluginError,
} from './installedPlugins'

const VALID = { id: 'acme.demo', version: '1.2.3', entry: 'dist/main.js', requires: ['fs', 'git'] }

describe('parseInstalledManifest', () => {
  it('accepts a valid manifest', () => {
    const m = parseInstalledManifest(VALID)
    expect(m.id).toBe('acme.demo')
    expect(m.requires).toEqual(['fs', 'git'])
  })

  it('rejects a bad id', () => {
    expect(() => parseInstalledManifest({ ...VALID, id: 'NotValid' })).toThrow(InstalledPluginError)
  })

  it('rejects a non-semver version', () => {
    expect(() => parseInstalledManifest({ ...VALID, version: '1.0' })).toThrow(/semver/)
  })

  it('rejects a missing entry', () => {
    const { entry: _e, ...noEntry } = VALID
    expect(() => parseInstalledManifest(noEntry)).toThrow(/entry/)
  })

  it('rejects an unknown capability (scope over-reach)', () => {
    expect(() => parseInstalledManifest({ ...VALID, requires: ['fs', 'network'] })).toThrow(/network/)
  })
})

describe('manifestToDescriptor', () => {
  it('resolves entry against the plugin dir and empties devUrl', () => {
    const d = manifestToDescriptor(parseInstalledManifest(VALID), '/plugins/acme.demo')
    expect(d.id).toBe('acme.demo')
    expect(d.devUrl).toBe('')
    expect(d.entryFile).toBe('/plugins/acme.demo/dist/main.js')
    expect(d.requires).toEqual(['fs', 'git'])
  })
})

describe('scanInstalledPlugins', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plugins-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('returns [] for a non-existent root', () => {
    expect(scanInstalledPlugins(join(root, 'nope'))).toEqual([])
  })

  it('parses valid plugins and reports bad ones without throwing', () => {
    const good = join(root, 'acme.demo')
    mkdirSync(good)
    writeFileSync(join(good, 'manifest.json'), JSON.stringify(VALID))

    const bad = join(root, 'broken')
    mkdirSync(bad)
    writeFileSync(join(bad, 'manifest.json'), '{ not json')

    const scanned = scanInstalledPlugins(root)
    const ok = scanned.find((s) => s.descriptor?.id === 'acme.demo')
    const err = scanned.find((s) => s.error)
    expect(ok?.descriptor?.entryFile).toBe(join(good, 'dist/main.js'))
    expect(err?.error).toBeTruthy()
  })
})
