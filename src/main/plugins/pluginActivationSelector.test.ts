import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  immutablePluginPackageDir,
  PluginActivationSelector,
} from './pluginActivationSelector'
import { currentPluginHostTarget } from './pluginTarget'

// Many real fsyncs per test that no assertion can observe; see tests/support/noFsync.ts.
vi.mock('node:fs', async (importOriginal) =>
  (await import('../../../tests/support/noFsync')).withoutFsyncSync(await importOriginal()))
vi.mock('node:fs/promises', async (importOriginal) =>
  (await import('../../../tests/support/noFsync')).withoutHandleSync(await importOriginal()))

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

  it('re-promotes the exact full-shell B identity after rollback and selector reload', () => {
    const { root, selector } = fixture()
    const grantB = {
      packageVersion: second.packageVersion,
      system: ['aiCli'] as const,
      shell: 'full' as const,
      highRiskShellConfirmed: true as const,
      storage: true as const,
    }

    selector.stageCandidate('acme.demo', first)
    selector.activateCandidate('acme.demo')
    selector.completeActivation('acme.demo')
    selector.stageCandidate('acme.demo', second, {
      candidateGrant: { selection: second, grant: grantB },
    })
    expect(selector.read('acme.demo')).toMatchObject({ candidate: second, candidateGrant: grantB })
    selector.beginActivation('acme.demo')
    selector.activateCandidate('acme.demo')
    selector.completeActivation('acme.demo', { activeGrant: grantB })

    selector.beginRollback('acme.demo')
    selector.activatePrevious('acme.demo')
    selector.completeRollback('acme.demo')

    const reloaded = new PluginActivationSelector(root)
    expect(reloaded.read('acme.demo')).toMatchObject({
      active: first,
      candidate: second,
      candidateGrant: grantB,
    })
    reloaded.beginActivation('acme.demo')
    reloaded.activateCandidate('acme.demo')
    expect(reloaded.completeActivation('acme.demo', { activeGrant: grantB })).toMatchObject({
      active: second,
      previous: first,
      activeGrant: grantB,
    })
    expect(reloaded.read('acme.demo')?.active).toEqual(second)
    expect(reloaded.read('acme.demo')?.active).not.toEqual({
      ...second,
      packageVersion: '2.0.1',
    })
    expect(reloaded.read('acme.demo')?.active).not.toEqual({
      ...second,
      artifactDigest: 'c'.repeat(64),
    })

    reloaded.clear('acme.demo')
    const changed = {
      packageVersion: second.packageVersion,
      target: currentPluginHostTarget(),
      artifactDigest: 'c'.repeat(64),
    } as const
    expect(() => reloaded.stageCandidate('acme.demo', changed, {
      candidateGrant: {
        selection: second,
        grant: grantB,
      },
    })).toThrow(/candidate grant does not match/)
    reloaded.stageCandidate('acme.demo', changed, {
      candidateGrant: { selection: changed, grant: grantB },
    })
    expect(reloaded.read('acme.demo')).toMatchObject({
      candidate: {
        packageVersion: second.packageVersion,
        target: currentPluginHostTarget(),
        artifactDigest: 'c'.repeat(64),
      },
    })
    expect(reloaded.read('acme.demo')).toHaveProperty('candidateGrant', grantB)
    expect(reloaded.read('acme.demo')).not.toHaveProperty('candidateFullShellConfirmed')
  })

  it('returns a factory-replacing package to a retained candidate on factory rollback', () => {
    const { root, selector } = fixture()
    const grant = { packageVersion: first.packageVersion, system: [], storage: true as const }
    selector.stageCandidate('acme.demo', first, { candidateGrant: { selection: first, grant } })
    selector.beginActivation('acme.demo')
    selector.activateCandidate('acme.demo')
    selector.completeActivation('acme.demo', { activeGrant: grant })

    const expected = { schemaVersion: 1, pluginId: 'acme.demo', candidate: first, candidateGrant: grant }
    selector.beginFactoryRollback('acme.demo')
    expect(selector.demoteActiveToCandidate('acme.demo')).toEqual(expected)
    expect(new PluginActivationSelector(root).read('acme.demo')).toEqual(expected)
    // The retained candidate re-activates through the ordinary restart path.
    expect(selector.activateCandidate('acme.demo')).toEqual({
      schemaVersion: 1,
      pluginId: 'acme.demo',
      active: first,
      activeGrant: grant,
    })
  })

  it('refuses factory rollback while a previous package or another transition is retained', () => {
    const { selector } = fixture()
    expect(() => selector.beginFactoryRollback('acme.demo')).toThrow(/no active package/)
    selector.stageCandidate('acme.demo', first)
    expect(() => selector.beginFactoryRollback('acme.demo')).toThrow(/no active package/)
    selector.activateCandidate('acme.demo')
    selector.stageCandidate('acme.demo', second)
    expect(() => selector.beginFactoryRollback('acme.demo')).toThrow(/another lifecycle transition/)
    selector.activateCandidate('acme.demo')
    expect(() => selector.beginFactoryRollback('acme.demo')).toThrow(/retains a previous package/)
    // Only a journaled factory rollback may hand the id back to the factory package.
    expect(() => selector.demoteActiveToCandidate('acme.demo')).toThrow(/no prepared factory rollback/)
  })

  it('journals a factory rollback so a crash before the factory package is selected keeps the active package', () => {
    const { root, selector } = fixture()
    const grant = { packageVersion: first.packageVersion, system: [], storage: true as const }
    selector.stageCandidate('acme.demo', first, { candidateGrant: { selection: first, grant } })
    selector.activateCandidate('acme.demo')
    const selected = { schemaVersion: 1, pluginId: 'acme.demo', active: first, activeGrant: grant }
    expect(selector.read('acme.demo')).toEqual(selected)

    // The drain and factory load happen between these two writes; the process
    // dies there, so demoteActiveToCandidate never runs.
    selector.beginFactoryRollback('acme.demo')

    const restarted = new PluginActivationSelector(root)
    expect(restarted.read('acme.demo')).toEqual({
      ...selected,
      activation: { kind: 'factory-rollback', phase: 'prepared' },
    })
    // An interrupted rollback is not an ordinary state other transitions build on.
    expect(() => restarted.beginFactoryRollback('acme.demo')).toThrow(/another lifecycle transition/)
  })

  it('recovers an interrupted factory rollback to the package it was displacing', () => {
    const { root, selector } = fixture()
    const grant = { packageVersion: first.packageVersion, system: [], storage: true as const }
    selector.stageCandidate('acme.demo', first, { candidateGrant: { selection: first, grant } })
    selector.activateCandidate('acme.demo')
    selector.beginFactoryRollback('acme.demo')

    const restarted = new PluginActivationSelector(root)
    const recovered = { schemaVersion: 1, pluginId: 'acme.demo', active: first, activeGrant: grant }
    expect(restarted.recoverInterruptedActivation('acme.demo')).toEqual(recovered)
    expect(new PluginActivationSelector(root).read('acme.demo')).toEqual(recovered)
    // Recovery leaves an ordinary selection a later factory rollback can start from.
    expect(() => new PluginActivationSelector(root).beginFactoryRollback('acme.demo')).not.toThrow()
  })

  it('rejects a factory rollback journal that does not keep its active package', () => {
    const { root, selector } = fixture()
    selector.stageCandidate('acme.demo', first)
    selector.activateCandidate('acme.demo')
    selector.beginFactoryRollback('acme.demo')
    const file = join(root, '.navide-lifecycle', 'acme.demo.json')
    const record = JSON.parse(readFileSync(file, 'utf8'))
    writeFileSync(file, JSON.stringify({ ...record, activation: { kind: 'factory-rollback', phase: 'promoted' } }))
    expect(() => selector.read('acme.demo')).toThrow(/invalid plugin lifecycle selector/)
    const { active: _active, ...withoutActive } = record
    writeFileSync(file, JSON.stringify({ ...withoutActive, candidate: first }))
    expect(() => selector.read('acme.demo')).toThrow(/invalid plugin lifecycle selector/)
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

  it.each([
    ['candidate activation without candidate', {
      schemaVersion: 1, pluginId: 'acme.demo', activation: { kind: 'candidate', phase: 'promoted' },
    }],
    ['rollback prepared without active and previous', {
      schemaVersion: 1, pluginId: 'acme.demo', activation: { kind: 'rollback', phase: 'prepared' },
    }],
    ['rollback promoted without candidate', {
      schemaVersion: 1, pluginId: 'acme.demo', active: first,
      activation: { kind: 'rollback', phase: 'promoted' },
    }],
    ['unknown activation kind', {
      schemaVersion: 1, pluginId: 'acme.demo', candidate: first,
      activation: { kind: 'replacement', phase: 'prepared' },
    }],
    ['unknown activation phase', {
      schemaVersion: 1, pluginId: 'acme.demo', candidate: first,
      activation: { kind: 'candidate', phase: 'committed' },
    }],
  ])('fails closed for impossible lifecycle record: %s', (_name, record) => {
    const { root } = fixture()
    mkdirSync(join(root, '.navide-lifecycle'), { recursive: true })
    writeFileSync(join(root, '.navide-lifecycle', 'acme.demo.json'), JSON.stringify(record))
    expect(() => new PluginActivationSelector(root).read('acme.demo')).toThrow(/plugin lifecycle/)
  })

  it.each([
    ['first-install prepared', {
      schemaVersion: 1, pluginId: 'acme.demo', candidate: first,
      activation: { kind: 'candidate', phase: 'prepared' },
    }],
    ['candidate interrupted after promotion', {
      schemaVersion: 1, pluginId: 'acme.demo', active: second, candidate: second, previous: first,
      activation: { kind: 'candidate', phase: 'promoted' },
    }],
    ['rollback interrupted before promotion', {
      schemaVersion: 1, pluginId: 'acme.demo', active: second, previous: first,
      activation: { kind: 'rollback', phase: 'prepared' },
    }],
    ['rollback interrupted after promotion', {
      schemaVersion: 1, pluginId: 'acme.demo', active: first, candidate: second,
      activation: { kind: 'rollback', phase: 'promoted' },
    }],
  ])('reads and deterministically recovers valid lifecycle record: %s', (_name, record) => {
    const { root } = fixture()
    mkdirSync(join(root, '.navide-lifecycle'), { recursive: true })
    writeFileSync(join(root, '.navide-lifecycle', 'acme.demo.json'), JSON.stringify(record))
    const selector = new PluginActivationSelector(root)
    expect(selector.read('acme.demo')).toMatchObject(record)
    const recovered = selector.recoverInterruptedActivation('acme.demo')
    expect(recovered).not.toBeNull()
    expect(new PluginActivationSelector(root).recoverInterruptedActivation('acme.demo')).toBeNull()
  })
})
