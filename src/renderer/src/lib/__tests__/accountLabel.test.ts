import { describe, it, expect } from 'vitest'
import {
  DEFAULT_PROFILE_ID,
  UNKNOWN_PROFILE_ID,
  accountKey,
  accountLabel,
  accountRemoved,
  accountTint,
  normalizeProfileId,
} from '../accountLabel'

const t = (key: string): string => `<${key}>`

function source(opts: { emails?: Record<string, string | null>; names?: Record<string, string> } = {}) {
  return {
    identityFor: (_agent: string, profileId: string | null) => {
      const slot = profileId ?? DEFAULT_PROFILE_ID
      return slot in (opts.emails ?? {}) ? { email: opts.emails![slot] } : null
    },
    findProfile: (id: string | null | undefined) => (id && opts.names?.[id] ? { name: opts.names[id] } : undefined),
  }
}

describe('accountLabel', () => {
  it('normalises the pre-pin ids to unknown', () => {
    expect(normalizeProfileId('')).toBe(UNKNOWN_PROFILE_ID)
    expect(normalizeProfileId(null)).toBe(UNKNOWN_PROFILE_ID)
    expect(normalizeProfileId(undefined)).toBe(UNKNOWN_PROFILE_ID)
    expect(normalizeProfileId('slot-a')).toBe('slot-a')
    expect(accountKey('claude', '')).toBe('claude/unknown')
    expect(accountKey('claude', 'slot-a')).toBe('claude/slot-a')
  })

  it('resolves in order: email → profile name → Default → unknown → shortened id as removed', () => {
    const src = source({ emails: { 'slot-a': 'a@x.dev', [DEFAULT_PROFILE_ID]: 'me@x.dev', 'slot-n': null }, names: { 'slot-a': 'Work', 'slot-n': 'Named' } })
    expect(accountLabel(src, 'claude', 'slot-a', t)).toBe('a@x.dev')
    expect(accountLabel(src, 'claude', 'slot-n', t)).toBe('Named')
    expect(accountLabel(src, 'claude', DEFAULT_PROFILE_ID, t)).toBe('me@x.dev')
    expect(accountLabel(source(), 'claude', DEFAULT_PROFILE_ID, t)).toBe('<account-dim.default>')
    expect(accountLabel(src, 'claude', UNKNOWN_PROFILE_ID, t)).toBe('<account-dim.unknown>')
    expect(accountLabel(src, 'claude', '', t)).toBe('<account-dim.unknown>')
    expect(accountLabel(src, 'claude', '0123456789abcdef', t)).toBe('01234567 · <account-dim.removed>')
  })

  it('works without a source at all', () => {
    expect(accountLabel(undefined, 'claude', DEFAULT_PROFILE_ID, t)).toBe('<account-dim.default>')
    expect(accountLabel(null, 'claude', 'slot-a', t)).toBe('slot-a · <account-dim.removed>')
  })

  it('accountRemoved is true only for an id no profile carries', () => {
    const src = source({ names: { 'slot-a': 'Work' } })
    expect(accountRemoved(src, 'slot-a')).toBe(false)
    expect(accountRemoved(src, 'gone')).toBe(true)
    expect(accountRemoved(src, DEFAULT_PROFILE_ID)).toBe(false)
    expect(accountRemoved(src, UNKNOWN_PROFILE_ID)).toBe(false)
  })

  it('accountTint is stable per id, a CSS variable, and muted for the reserved ids', () => {
    expect(accountTint('slot-a')).toBe(accountTint('slot-a'))
    expect(accountTint('slot-a')).toMatch(/^var\(--/)
    expect(accountTint(UNKNOWN_PROFILE_ID)).toBe('var(--text-disabled)')
    expect(accountTint(DEFAULT_PROFILE_ID)).toBe('var(--text-muted)')
    expect(accountTint('')).toBe('var(--text-disabled)')
  })
})
