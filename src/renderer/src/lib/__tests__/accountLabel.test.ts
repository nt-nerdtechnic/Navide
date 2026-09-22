import { describe, it, expect } from 'vitest'
import {
  DEFAULT_PROFILE_ID,
  UNKNOWN_PROFILE_ID,
  accountChipLabel,
  accountKey,
  accountLabel,
  accountRemoved,
  accountTint,
  emailLocalPart,
  normalizeProfileId,
} from '../accountLabel'

const t = (key: string): string => `<${key}>`

function source(
  opts: {
    emails?: Record<string, string | null>
    names?: Record<string, string>
    /** Slot id (or DEFAULT_PROFILE_ID) -> the name the user gave it. */
    aliases?: Record<string, string>
  } = {},
) {
  return {
    identityFor: (_agent: string, profileId: string | null) => {
      const slot = profileId ?? DEFAULT_PROFILE_ID
      return slot in (opts.emails ?? {}) ? { email: opts.emails![slot] } : null
    },
    findProfile: (id: string | null | undefined) => (id && opts.names?.[id] ? { name: opts.names[id] } : undefined),
    aliasFor: (_agent: string, profileId: string | null) =>
      opts.aliases?.[profileId ?? DEFAULT_PROFILE_ID],
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

  it('puts the user\'s alias first, for the built-in Default too', () => {
    const src = source({
      emails: { 'slot-a': 'a@x.dev', [DEFAULT_PROFILE_ID]: 'me@x.dev' },
      names: { 'slot-a': 'Account 2' },
      aliases: { 'slot-a': 'Work', [DEFAULT_PROFILE_ID]: 'Main' },
    })
    expect(accountLabel(src, 'claude', 'slot-a', t)).toBe('Work')
    expect(accountLabel(src, 'claude', DEFAULT_PROFILE_ID, t)).toBe('Main')
    // No alias: the order the badge has always used is unchanged.
    expect(accountLabel(source({ emails: { 'slot-a': 'a@x.dev' } }), 'claude', 'slot-a', t)).toBe('a@x.dev')
  })

  it('defaultLabel replaces the generic "Default" only for the built-in slot', () => {
    expect(accountLabel(source(), 'claude', DEFAULT_PROFILE_ID, t, { defaultLabel: 'Default (built-in)' })).toBe(
      'Default (built-in)',
    )
    // An alias still wins over it.
    const named = source({ aliases: { [DEFAULT_PROFILE_ID]: 'Main' } })
    expect(accountLabel(named, 'claude', DEFAULT_PROFILE_ID, t, { defaultLabel: 'Default (built-in)' })).toBe('Main')
  })
})

describe('accountChipLabel', () => {
  it('resolves alias → the email\'s local part → the generated name → Default', () => {
    const aliased = source({ emails: { 'slot-a': 'neil@nerdtechnic.com' }, aliases: { 'slot-a': '工作' } })
    expect(accountChipLabel(aliased, 'claude', 'slot-a', t)).toBe('工作')

    // No alias: the @-suffix is dropped — the full address does not fit a
    // 9px pane header, and stays in the tooltip instead.
    const emailed = source({ emails: { 'slot-a': 'neil@nerdtechnic.com' } })
    expect(accountChipLabel(emailed, 'claude', 'slot-a', t)).toBe('neil')

    // A vendor with no identity at all (kilo): the generated name is all
    // there is until the user names it.
    const named = source({ names: { 'slot-a': 'Account 2' } })
    expect(accountChipLabel(named, 'claude', 'slot-a', t)).toBe('Account 2')

    expect(accountChipLabel(source(), 'claude', DEFAULT_PROFILE_ID, t)).toBe('<account-dim.default>')
    expect(accountChipLabel(source(), 'claude', DEFAULT_PROFILE_ID, t, { defaultLabel: 'Default (built-in)' })).toBe(
      'Default (built-in)',
    )
    expect(accountChipLabel(source(), 'claude', '', t)).toBe('<account-dim.unknown>')
    expect(accountChipLabel(source(), 'claude', '0123456789abcdef', t)).toBe('01234567 · <account-dim.removed>')
  })

  it('emailLocalPart keeps a string that is not an address', () => {
    expect(emailLocalPart('neil@x.dev')).toBe('neil')
    expect(emailLocalPart('neil')).toBe('neil')
    expect(emailLocalPart('@x.dev')).toBe('@x.dev')
  })
})
