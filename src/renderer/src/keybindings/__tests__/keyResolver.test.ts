// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest'
import { KeyResolver } from '../keyResolver'
import type { KeybindingRule } from '../types'

function mkEvent(
  key: string,
  opts: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {},
): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, bubbles: true, ...opts })
}

const rules: KeybindingRule[] = [
  { key: 'cmd+s',       command: 'editor.save' },
  { key: 'cmd+shift+f', command: 'workbench.findInFiles' },
  { key: 'escape',      command: 'workbench.closeModal', when: 'modalOpen' },
  { key: 'ctrl+k ctrl+s', command: 'workbench.keybindingPage' },
]

let resolver: KeyResolver

beforeEach(() => {
  resolver = new KeyResolver(rules)
})

describe('KeyResolver – single key', () => {
  it('matches cmd+s', () => {
    const rule = resolver.resolve(mkEvent('s', { metaKey: true }), {})
    expect(rule?.command).toBe('editor.save')
  })

  it('matches cmd+shift+f', () => {
    const rule = resolver.resolve(mkEvent('F', { metaKey: true, shiftKey: true }), {})
    expect(rule?.command).toBe('workbench.findInFiles')
  })

  it('returns null when no rule matches', () => {
    expect(resolver.resolve(mkEvent('x'), {})).toBeNull()
  })

  it('skips rule when when-clause is false', () => {
    const ctx = { modalOpen: false }
    expect(resolver.resolve(mkEvent('Escape'), ctx)).toBeNull()
  })

  it('matches rule when when-clause is true', () => {
    const ctx = { modalOpen: true }
    const rule = resolver.resolve(mkEvent('Escape'), ctx)
    expect(rule?.command).toBe('workbench.closeModal')
  })

  it('ignores bare modifier key presses', () => {
    expect(resolver.resolve(mkEvent('Meta'), {})).toBeNull()
    expect(resolver.resolve(mkEvent('Control'), {})).toBeNull()
    expect(resolver.resolve(mkEvent('Shift'), {})).toBeNull()
  })
})

describe('KeyResolver – chord', () => {
  it('returns null on first chord key (waiting)', () => {
    const first = resolver.resolve(mkEvent('k', { ctrlKey: true }), {})
    expect(first).toBeNull()
  })

  it('resolves chord on second key', () => {
    resolver.resolve(mkEvent('k', { ctrlKey: true }), {})
    const rule = resolver.resolve(mkEvent('s', { ctrlKey: true }), {})
    expect(rule?.command).toBe('workbench.keybindingPage')
  })

  it('chord state clears after resolution', () => {
    resolver.resolve(mkEvent('k', { ctrlKey: true }), {})
    resolver.resolve(mkEvent('s', { ctrlKey: true }), {})
    // Next single key should resolve normally
    const rule = resolver.resolve(mkEvent('s', { metaKey: true }), {})
    expect(rule?.command).toBe('editor.save')
  })

  it('chord with wrong second key returns null and clears state', () => {
    resolver.resolve(mkEvent('k', { ctrlKey: true }), {})
    const rule = resolver.resolve(mkEvent('z', { ctrlKey: true }), {})
    expect(rule).toBeNull()
    // State cleared: next key should work as single
    const next = resolver.resolve(mkEvent('s', { metaKey: true }), {})
    expect(next?.command).toBe('editor.save')
  })
})

describe('KeyResolver – priority (later rule wins)', () => {
  it('later rule overrides earlier for same key', () => {
    const r = new KeyResolver([
      { key: 'cmd+s', command: 'old.command' },
      { key: 'cmd+s', command: 'new.command' },
    ])
    const rule = r.resolve(mkEvent('s', { metaKey: true }), {})
    expect(rule?.command).toBe('new.command')
  })
})
