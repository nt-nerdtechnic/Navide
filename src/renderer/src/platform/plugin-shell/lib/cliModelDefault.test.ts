import { describe, expect, it } from 'vitest'
import {
  cliModelKey,
  parseCliModelDefault,
  serializeCliModelDefault,
} from './cliModelDefault'

describe('cliModelKey', () => {
  it('mirrors the existing per-vendor key shape', () => {
    // Same family as agentTeam.cliPermission.<key> / agentTeam.cliBinary.<key>;
    // a different shape here would make the three read as unrelated settings.
    expect(cliModelKey('claude')).toBe('agentTeam.cliModel.claude')
    expect(cliModelKey('codex')).toBe('agentTeam.cliModel.codex')
  })
})

describe('parseCliModelDefault', () => {
  it('reads an unset vendor as "nothing requested"', () => {
    // The regression that matters: every vendor is unset the day this ships,
    // and each must spawn exactly as it did before the setting existed.
    expect(parseCliModelDefault(null)).toEqual({ model: '', effort: '' })
    expect(parseCliModelDefault(undefined)).toEqual({ model: '', effort: '' })
  })

  it('reads back a stored pair', () => {
    expect(parseCliModelDefault({ model: 'opus-5', effort: 'high' }))
      .toEqual({ model: 'opus-5', effort: 'high' })
  })

  it('keeps the half of a pair that is present', () => {
    // A model with no effort is the normal case for the seven vendors that
    // declare modelArgs and no effortArgs.
    expect(parseCliModelDefault({ model: 'opus-5' })).toEqual({ model: 'opus-5', effort: '' })
    expect(parseCliModelDefault({ effort: 'high' })).toEqual({ model: '', effort: 'high' })
  })

  it('rejects anything that is not a string, rather than stringifying it', () => {
    // A number or object reaching the command line would be "[object Object]"
    // after interpolation — a flag the CLI cannot parse, on a pane the user
    // thinks they configured.
    expect(parseCliModelDefault({ model: 5, effort: ['high'] })).toEqual({ model: '', effort: '' })
    expect(parseCliModelDefault('opus-5')).toEqual({ model: '', effort: '' })
  })

  it('treats whitespace as no pick', () => {
    expect(parseCliModelDefault({ model: '  ', effort: '\t' })).toEqual({ model: '', effort: '' })
    expect(parseCliModelDefault({ model: ' opus-5 ', effort: '' })).toEqual({
      model: 'opus-5',
      effort: '',
    })
  })
})

describe('serializeCliModelDefault', () => {
  it('clears the key when nothing is picked', () => {
    // So "never touched" and "reset to the vendor default" are the same stored
    // state, and neither leaves an empty object in the settings file.
    expect(serializeCliModelDefault({ model: '', effort: '' })).toBeNull()
    expect(serializeCliModelDefault({ model: ' ', effort: ' ' })).toBeNull()
  })

  it('stores a trimmed pair when either half is picked', () => {
    expect(serializeCliModelDefault({ model: ' opus-5 ', effort: '' }))
      .toEqual({ model: 'opus-5', effort: '' })
    expect(serializeCliModelDefault({ model: '', effort: 'high' }))
      .toEqual({ model: '', effort: 'high' })
  })
})
