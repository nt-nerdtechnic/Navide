import { describe, expect, it } from 'vitest'
import {
  workspaceAliasKey,
  workspaceAliasOf,
  workspaceBasename,
  workspaceDisplayName,
} from '../workspaceAlias'

const A = '/Users/me/Desktop/alpha'

describe('workspaceAliasKey', () => {
  it('trims trailing slashes so one workspace has one key', () => {
    expect(workspaceAliasKey(`${A}/`)).toBe(A)
    expect(workspaceAliasKey(`${A}///`)).toBe(A)
  })

  it('keeps case — two folders differing only in case are two workspaces', () => {
    expect(workspaceAliasKey('/Users/me/Alpha')).not.toBe(workspaceAliasKey('/Users/me/alpha'))
  })
})

describe('workspaceBasename', () => {
  it('is the last segment', () => {
    expect(workspaceBasename(A)).toBe('alpha')
    expect(workspaceBasename(`${A}/`)).toBe('alpha')
  })
})

// The rename editor seeds from this, not from workspaceDisplayName: it has to
// tell "the user has not named this workspace" apart from "the user named it
// after its folder", because only the second is something to write back.
describe('workspaceAliasOf', () => {
  it('is empty when the workspace has no alias', () => {
    expect(workspaceAliasOf(A)).toBe('')
    expect(workspaceAliasOf(A, {})).toBe('')
  })

  it('does NOT fall back to the folder name', () => {
    expect(workspaceDisplayName(A)).toBe('alpha')
    expect(workspaceAliasOf(A)).toBe('')
  })

  it('is the alias, trimmed, when one is set', () => {
    expect(workspaceAliasOf(A, { [A]: '  Payments API ' })).toBe('Payments API')
    expect(workspaceAliasOf(`${A}/`, { [A]: 'Payments API' })).toBe('Payments API')
  })

  it('is empty for a blank alias — blank is not a name', () => {
    expect(workspaceAliasOf(A, { [A]: '   ' })).toBe('')
  })
})

describe('workspaceDisplayName', () => {
  it('falls back to the folder name with no alias table at all', () => {
    expect(workspaceDisplayName(A)).toBe('alpha')
    expect(workspaceDisplayName(A, {})).toBe('alpha')
  })

  it('prefers the alias when one is set', () => {
    expect(workspaceDisplayName(A, { [A]: 'Payments API' })).toBe('Payments API')
  })

  it('finds the alias through a trailing slash', () => {
    expect(workspaceDisplayName(`${A}/`, { [A]: 'Payments API' })).toBe('Payments API')
  })

  it('treats a blank alias as none — clearing must show the folder name', () => {
    expect(workspaceDisplayName(A, { [A]: '' })).toBe('alpha')
    expect(workspaceDisplayName(A, { [A]: '   ' })).toBe('alpha')
  })

  it('lets two workspaces share a display name', () => {
    const aliases = { [A]: 'api', '/Users/me/Git/beta': 'api' }
    expect(workspaceDisplayName(A, aliases)).toBe('api')
    expect(workspaceDisplayName('/Users/me/Git/beta', aliases)).toBe('api')
  })
})
