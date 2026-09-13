import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  immutablePluginPackageDir,
  PluginActivationSelector,
} from './pluginActivationSelector'

const roots: string[] = []

function fixture(): { root: string; selector: PluginActivationSelector } {
  const root = mkdtempSync(join(tmpdir(), 'navide-plugin-lifecycle-'))
  roots.push(root)
  return { root, selector: new PluginActivationSelector(root) }
}

const first = {
  packageVersion: '1.0.0',
  target: 'universal',
  artifactDigest: 'a'.repeat(64),
} as const
const second = {
  packageVersion: '2.0.0',
  target: 'universal',
  artifactDigest: 'b'.repeat(64),
} as const

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('PluginActivationSelector', () => {
  it('stages a candidate without selecting a production package', () => {
    const { selector } = fixture()
    expect(selector.stageCandidate('acme.demo', first)).toEqual({
      schemaVersion: 1,
      pluginId: 'acme.demo',
      candidate: first,
    })
    expect(selector.read('acme.demo')).toEqual({
      schemaVersion: 1,
      pluginId: 'acme.demo',
      candidate: first,
    })
  })

  it('promotes one candidate atomically while retaining the exact old active identity as previous', () => {
    const { selector } = fixture()
    selector.stageCandidate('acme.demo', first)
    selector.activateCandidate('acme.demo')
    selector.stageCandidate('acme.demo', second)

    expect(selector.activateCandidate('acme.demo')).toEqual({
      schemaVersion: 1,
      pluginId: 'acme.demo',
      active: second,
      previous: first,
    })
  })

  it('recovers a cold-start interruption after promotion by restoring the verified prior selection', () => {
    const { root, selector } = fixture()
    selector.stageCandidate('acme.demo', first)
    selector.beginActivation('acme.demo')
    selector.activateCandidate('acme.demo')

    expect(selector.read('acme.demo')).toMatchObject({
      active: first,
      candidate: first,
      activation: { kind: 'candidate', phase: 'promoted' },
    })

    const coldSelector = new PluginActivationSelector(root)
    expect(coldSelector.recoverInterruptedActivation('acme.demo')).toEqual({
      schemaVersion: 1,
      pluginId: 'acme.demo',
      candidate: first,
    })
    expect(coldSelector.read('acme.demo')).toEqual({
      schemaVersion: 1,
      pluginId: 'acme.demo',
      candidate: first,
    })
    // A second cold start is idempotent and does not invent an active package.
    expect(new PluginActivationSelector(root).recoverInterruptedActivation('acme.demo')).toBeNull()
  })

  it('keeps the active selection when a cold start interrupted before candidate promotion', () => {
    const { selector } = fixture()
    selector.stageCandidate('acme.demo', first)
    selector.activateCandidate('acme.demo')
    selector.completeActivation('acme.demo')
    selector.stageCandidate('acme.demo', second)
    selector.beginActivation('acme.demo')

    expect(selector.recoverInterruptedActivation('acme.demo')).toEqual({
      schemaVersion: 1,
      pluginId: 'acme.demo',
      active: first,
      candidate: second,
    })
  })

  it('retains the displaced package as a candidate after an explicit rollback', () => {
    const { selector } = fixture()
    selector.stageCandidate('acme.demo', first)
    selector.activateCandidate('acme.demo')
    selector.stageCandidate('acme.demo', second)
    selector.activateCandidate('acme.demo')

    selector.beginRollback('acme.demo')
    expect(selector.activatePrevious('acme.demo')).toMatchObject({
      active: first,
      candidate: second,
      activation: { kind: 'rollback', phase: 'promoted' },
    })
    expect(selector.completeRollback('acme.demo')).toEqual({
      schemaVersion: 1,
      pluginId: 'acme.demo',
      active: first,
      candidate: second,
    })
  })

  it('retains the active package grant through promotion so rollback never recreates consent', () => {
    const { selector } = fixture()
    const grant = {
      packageVersion: '1.0.0',
      system: ['aiCli'] as const,
      shell: 'full' as const,
      highRiskShellConfirmed: true as const,
      storage: true as const,
    }
    selector.stageCandidate('acme.demo', first)
    selector.activateCandidate('acme.demo')
    selector.stageCandidate('acme.demo', second)
    selector.beginActivation('acme.demo', { previousGrant: grant })
    selector.activateCandidate('acme.demo')

    expect(selector.completeActivation('acme.demo')).toMatchObject({
      active: second,
      previous: first,
      previousGrant: grant,
    })
  })

  it('rejects a second candidate instead of overwriting a staged package', () => {
    const { selector } = fixture()
    selector.stageCandidate('acme.demo', first)
    expect(() => selector.stageCandidate('acme.demo', second)).toThrow(/staged candidate/)
  })

  it('projects valid staged records and clears only an explicit uninstall record', () => {
    const { selector } = fixture()
    selector.stageCandidate('acme.demo', first)
    expect(selector.list()).toEqual([{
      schemaVersion: 1,
      pluginId: 'acme.demo',
      candidate: first,
    }])
    selector.clear('acme.demo')
    expect(selector.read('acme.demo')).toBeNull()
  })

  it('uses only the canonical target-specific immutable package directory', () => {
    const { root } = fixture()
    expect(immutablePluginPackageDir(root, 'acme.demo', '1.0.0', 'universal')).toBe(
      join(root, 'acme.demo', '1.0.0', 'universal', 'package'),
    )
    expect(() => immutablePluginPackageDir(root, 'acme.demo', '../bad', 'universal')).toThrow(/identity/)
  })

  it('fails closed on a selector whose fields are malformed or duplicated', () => {
    const { root, selector } = fixture()
    const path = join(root, '.navide-lifecycle', 'acme.demo.json')
    selector.stageCandidate('acme.demo', first)
    writeFileSync(path, readFileSync(path, 'utf8').replace(
      '"pluginId":"acme.demo"',
      '"pluginId":"acme.demo","pluginId":"acme.demo"',
    ))
    expect(() => selector.read('acme.demo')).toThrow(/duplicate JSON object key/)
  })

  it('fails closed on a dot-segment package version instead of escaping the immutable package subtree', () => {
    const { root } = fixture()
    const path = join(root, '.navide-lifecycle', 'acme.demo.json')
    mkdirSync(join(root, '.navide-lifecycle'))
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      pluginId: 'acme.demo',
      active: { packageVersion: '..', target: 'universal', artifactDigest: 'a'.repeat(64) },
    }))

    expect(() => new PluginActivationSelector(root).read('acme.demo')).toThrow(/package selector/)
  })
})
