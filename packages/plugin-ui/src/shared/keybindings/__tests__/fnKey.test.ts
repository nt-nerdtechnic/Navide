// @vitest-environment happy-dom
// 'fn' — the fn (🌐) key pressed by itself — as a rule key: valid only on its
// own, never matched by a page event (only the native helper presses it), and
// shown as the Mac key cap reads.
import { describe, expect, it } from 'vitest'
import { canonicalizeKeySpec, FN_KEY, isFnKey, matchesEvent, parseKeySpec, validateKeySpec } from '../parseKey'
import { formatKeySpec, keySpecToTokens } from '../keyDisplay'
import { KeyResolver } from '../keyResolver'

describe('the fn key as a rule key', () => {
  it('is valid on its own and canonical as "fn"', () => {
    expect(FN_KEY).toBe('fn')
    expect(isFnKey('fn')).toBe(true)
    expect(validateKeySpec('fn')).toEqual({ ok: true })
    expect(validateKeySpec('FN')).toEqual({ ok: true })
    expect(canonicalizeKeySpec('fn')).toBe('fn')
  })

  it.each(['ctrl+fn', 'cmd+fn', 'shift+fn', 'fn f13', 'cmd+k fn'])('is refused combined or in a chord (%s)', (spec) => {
    expect(validateKeySpec(spec).ok).toBe(false)
  })

  it('no KeyboardEvent matches it, not even one reporting key "Fn"', () => {
    const [fn] = parseKeySpec('fn')
    expect(matchesEvent(fn, new KeyboardEvent('keydown', { key: 'Fn', code: 'Fn' }))).toBe(false)
    expect(matchesEvent(fn, new KeyboardEvent('keydown', { key: 'f', code: 'KeyF' }))).toBe(false)
    const resolver = new KeyResolver([{ key: 'fn', command: 'x' }])
    expect(resolver.resolve(new KeyboardEvent('keydown', { key: 'Fn', code: 'Fn' }), {})).toBeNull()
  })

  it('reads "fn 🌐" on a Mac and "Fn" elsewhere', () => {
    expect(formatKeySpec('fn', true)).toBe('fn 🌐')
    expect(keySpecToTokens('fn', true)).toEqual([['fn 🌐']])
    expect(formatKeySpec('fn', false)).toBe('Fn')
  })
})
