import { describe, expect, it } from 'vitest'
import {
  assertEngineCompatible,
  engineRequirement,
  isEngineCompatible,
  minNavideVersion,
} from './pluginEngineCompat'

describe('pluginEngineCompat', () => {
  it.each([
    ['^0.2.9', '0.2.9'],
    ['~0.2.9', '0.2.9'],
    ['>=0.3.0', '0.3.0'],
    ['>= 0.3.0', '0.3.0'],
    ['0.2.9', '0.2.9'],
    ['*', '0.0.0'],
    ['^1.0.0-beta.1', '1.0.0-beta.1'],
    ['latest', null],
    ['^0.2', null],
    ['<1.0.0', null],
    [undefined, null],
    [42, null],
  ])('reads %s as the floor %s', (requirement, floor) => {
    expect(minNavideVersion(requirement)).toBe(floor)
  })

  it('treats a 0.x caret as a floor so the official ^0.1.0 packages stay installable', () => {
    expect(isEngineCompatible('^0.1.0', '0.2.13')).toBe(true)
  })

  it('reports the three states', () => {
    expect(isEngineCompatible('>=0.3.0', '0.2.13')).toBe(false)
    expect(isEngineCompatible('^0.2.13', '0.2.13')).toBe(true)
    expect(isEngineCompatible('^0.3.0', '0.3.0-beta.1')).toBe(false)
    expect(isEngineCompatible(null, '0.2.13')).toBeNull()
    expect(isEngineCompatible('garbage', '0.2.13')).toBeNull()
  })

  it('reads engines.navide from a manifest-shaped value', () => {
    expect(engineRequirement({ engines: { navide: '^0.2.0' } })).toBe('^0.2.0')
    expect(engineRequirement({ engines: {} })).toBeNull()
    expect(engineRequirement({})).toBeNull()
    expect(engineRequirement(null)).toBeNull()
  })

  it('refuses only a known-incompatible requirement', () => {
    expect(() =>
      assertEngineCompatible('acme.demo', '2.0.0', { engines: { navide: '>=0.3.0' } }, '0.2.13')
    ).toThrow('acme.demo 2.0.0 requires Navide 0.3.0 or newer; this is Navide 0.2.13')
    expect(() => assertEngineCompatible('acme.demo', '1.0.0', { engines: { navide: '^0.1.0' } }, '0.2.13')).not.toThrow()
    expect(() => assertEngineCompatible('acme.demo', '1.0.0', {}, '0.2.13')).not.toThrow()
  })
})
