import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FrontendPluginManager } from './frontendPluginManager'
import { activateInstalledMiniIdeRecovery } from './miniIdePackage'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function manager(options: {
  selected?: unknown
  installed?: Array<{ id: string }>
} = {}): FrontendPluginManager {
  return {
    getDescriptor: vi.fn(() => options.selected),
    listInstalledPackages: vi.fn(() => options.installed ?? []),
    replaceBuiltinForRecovery: vi.fn(),
  } as unknown as FrontendPluginManager
}

function recoverySource(root: string) {
  return { isPackaged: true, resourcesPath: root, artifactVersion: '0.1.0' }
}

describe('Mini-IDE legacy recovery package guard', () => {
  it('cannot recover a removed or absent IDE when no installed package is in inventory', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-mini-ide-package-'))
    roots.push(root)
    const result = activateInstalledMiniIdeRecovery(
      manager({ selected: { id: 'navide.mini-ide' }, installed: [] }),
      recoverySource(root),
    )

    expect(result).toEqual({ registered: false, reason: 'IDE plugin is not installed' })
  })

  it('selects only the verified old artifact for an installed package failure', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-mini-ide-package-'))
    roots.push(root)
    const oldArtifact = join(root, 'plugins', 'mini-ide')
    mkdirSync(oldArtifact, { recursive: true })
    writeFileSync(join(oldArtifact, 'manifest.json'), JSON.stringify({
      id: 'navide.mini-ide', version: '1.0.0', requires: [], entry: 'index.html',
    }))
    writeFileSync(join(oldArtifact, 'index.html'), '<!doctype html>')
    // A differently-named bundle is a decoy: recovery must never scan a parent
    // directory and guess that it is the retained artifact.
    const decoy = join(root, 'plugins', 'navide-mini-ide')
    mkdirSync(decoy, { recursive: true })
    writeFileSync(join(decoy, 'manifest.json'), JSON.stringify({
      id: 'navide.mini-ide', version: '9.9.9', requires: [], entry: 'index.html',
    }))
    writeFileSync(join(decoy, 'index.html'), '<!doctype html>')

    const host = manager({ selected: { id: 'navide.mini-ide', packageVersion: '2.0.0' }, installed: [{ id: 'navide.mini-ide' }] })
    const result = activateInstalledMiniIdeRecovery(host, recoverySource(root))

    expect(result).toEqual({ registered: true })
    expect(host.replaceBuiltinForRecovery).toHaveBeenCalledOnce()
    expect(host.replaceBuiltinForRecovery).toHaveBeenCalledWith(expect.objectContaining({
      id: 'navide.mini-ide',
      packageDir: oldArtifact,
      entryFile: join(oldArtifact, 'index.html'),
    }))
  })

  it('fails closed when the selected package is installed but its exact old artifact is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-mini-ide-package-'))
    roots.push(root)
    const decoy = join(root, 'plugins', 'navide-mini-ide')
    mkdirSync(decoy, { recursive: true })
    writeFileSync(join(decoy, 'manifest.json'), JSON.stringify({
      id: 'navide.mini-ide', version: '9.9.9', requires: [], entry: 'index.html',
    }))
    writeFileSync(join(decoy, 'index.html'), '<!doctype html>')

    const host = manager({ selected: { id: 'navide.mini-ide' }, installed: [{ id: 'navide.mini-ide' }] })
    const result = activateInstalledMiniIdeRecovery(host, recoverySource(root))

    expect(result).toEqual({ registered: false, reason: 'installed IDE recovery artifact is unavailable' })
    expect(host.replaceBuiltinForRecovery).not.toHaveBeenCalled()
  })
})
