import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { missingArtifactInputs } from '../support/publicPackagesSetup'

it('requires real public entrypoints and the staged Mini IDE before reusing a build', () => {
  const root = mkdtempSync(join(tmpdir(), 'navide-artifact-inputs-'))
  try {
    mkdirSync(join(root, 'packages/plugin-ui/dist'), { recursive: true })
    writeFileSync(join(root, 'packages/plugin-ui/dist/stale.txt'), 'unrelated artifact')
    expect(missingArtifactInputs(root)).toContain('packages/plugin-ui/dist/index.js')
    const inputs = [
      'packages/plugin-contracts/dist/index.js', 'packages/plugin-sdk/dist/index.js',
      'packages/plugin-ui/dist/index.js', 'packages/plugin-ui/dist/editor/index.js',
      'dist-plugins/navide-mini-ide/manifest.json',
      'dist-plugins/navide-mini-ide/frontend/window/index.html',
    ]
    for (const input of inputs) {
      mkdirSync(dirname(join(root, input)), { recursive: true })
      writeFileSync(join(root, input), 'built fixture')
    }
    expect(missingArtifactInputs(root)).toEqual([])
    rmSync(join(root, inputs[5]))
    expect(missingArtifactInputs(root)).toEqual([inputs[5]])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
