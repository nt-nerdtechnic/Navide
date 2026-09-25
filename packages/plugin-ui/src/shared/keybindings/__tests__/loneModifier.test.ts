// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { KeyResolver } from '../keyResolver'
import { defaults } from '../defaults'
import { eventLoneModifier, validateKeySpec } from '../parseKey'
import { formatKeySpec } from '../keyDisplay'
import type { KeybindingRule } from '../types'

const down = (key: string, init: KeyboardEventInit = {}) => new KeyboardEvent('keydown', { key, ...init })

describe('a modifier as a key of its own', () => {
  it('validates sided lone modifiers, alone only', () => {
    for (const k of ['rightalt', 'leftalt', 'rightctrl', 'leftctrl', 'rightshift', 'leftshift', 'rightcmd', 'leftcmd']) {
      expect(validateKeySpec(k)).toEqual({ ok: true })
    }
    expect(validateKeySpec('ctrl+rightalt').ok).toBe(false)
    expect(validateKeySpec('ctrl+k rightalt').ok).toBe(false)
    expect(validateKeySpec('alt').ok).toBe(false) // a modifier without a side is still "modifiers only"
  })

  it('reads the key from e.code, and only with no other modifier held', () => {
    expect(eventLoneModifier(down('Alt', { code: 'AltRight', altKey: true }), true)).toBe('rightalt')
    expect(eventLoneModifier(down('Alt', { code: 'AltLeft', altKey: true }), true)).toBe('leftalt')
    expect(eventLoneModifier(down('Alt', { code: 'AltRight', altKey: true, ctrlKey: true }), true)).toBeNull()
    // keyup: the key's own flag is already down
    expect(eventLoneModifier(new KeyboardEvent('keyup', { key: 'Alt', code: 'AltRight' }), false)).toBe('rightalt')
    expect(eventLoneModifier(down('m', { code: 'KeyM', altKey: true }), true)).toBeNull()
  })

  it('the resolver fires a lone-modifier rule on that side only', () => {
    const rules: KeybindingRule[] = [{ key: 'rightalt', command: 'voice.hold' }]
    const r = new KeyResolver(rules)
    expect(r.resolve(down('Alt', { code: 'AltRight', altKey: true }), {})?.command).toBe('voice.hold')
    expect(r.resolve(down('Alt', { code: 'AltLeft', altKey: true }), {})).toBeNull()
    expect(r.resolve(down('Alt', { code: 'AltRight', altKey: true, ctrlKey: true }), {})).toBeNull()
    // Right Option + E is a combination, not the lone key.
    expect(r.resolve(down('´', { code: 'KeyE', altKey: true }), {})).toBeNull()
  })

  it('a modifier press still never matches an ordinary rule, nor disturbs a pending chord', () => {
    const r = new KeyResolver(defaults)
    const ctx = { editorFocus: true, editorOpen: true }
    for (const code of ['MetaLeft', 'ControlLeft', 'AltLeft', 'ShiftLeft', 'AltRight']) {
      const key = code.replace(/(Left|Right)$/, '')
      const flag = { Meta: 'metaKey', Control: 'ctrlKey', Alt: 'altKey', Shift: 'shiftKey' }[key]!
      expect(r.resolve(down(key, { code, [flag]: true }), ctx)).toBeNull()
    }
    // ⌘K, then ⌘ goes down again for the second key: the chord survives.
    expect(r.resolve(down('k', { code: 'KeyK', metaKey: true }), ctx)).toBeNull()
    expect(r.hasPendingChord()).toBe(true)
    expect(r.resolve(down('Meta', { code: 'MetaLeft', metaKey: true }), ctx)).toBeNull()
    expect(r.hasPendingChord()).toBe(true)
    expect(r.resolve(down('s', { code: 'KeyS', metaKey: true }), ctx)?.command).toBe('workbench.action.openKeyboardShortcuts')
  })

  it('displays with its side', () => {
    expect(formatKeySpec('rightalt', true)).toBe('Right ⌥')
    expect(formatKeySpec('leftctrl', false)).toBe('Left Ctrl')
    expect(formatKeySpec('f13', true)).toBe('F13')
  })
})
