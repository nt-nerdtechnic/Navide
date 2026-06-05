// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest'
import { KeyResolver } from '../keyResolver'
import type { KeybindingRule } from '../types'
import { defaults } from '../defaults'

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

  it('does not enter chord mode when all chord when-clauses fail', () => {
    // Resolver with ONLY a when-gated chord — no unconditional chord.
    const gated = new KeyResolver([
      { key: 'ctrl+k ctrl+c', command: 'editor.comment', when: 'editorFocus' },
      { key: 'ctrl+s', command: 'editor.save' },
    ])
    // ctx has editorFocus=false — chord should NOT be entered
    const first = gated.resolve(mkEvent('k', { ctrlKey: true }), { editorFocus: false })
    // Returns null because neither chord nor single matches
    expect(first).toBeNull()
    // Next ctrl+s should resolve as a normal single key (chord state was not set)
    const second = gated.resolve(mkEvent('s', { ctrlKey: true }), { editorFocus: false })
    expect(second?.command).toBe('editor.save')
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

describe('KeyResolver – defaults integration (new shortcuts)', () => {
  let dr: KeyResolver
  beforeEach(() => { dr = new KeyResolver(defaults) })

  it('shift+alt+down → duplicateLineDown (editorTextFocus)', () => {
    const rule = dr.resolve(mkEvent('ArrowDown', { shiftKey: true, altKey: true }), { editorTextFocus: true })
    expect(rule?.command).toBe('editor.action.duplicateLineDown')
  })

  it('shift+alt+up → duplicateLineUp (editorTextFocus)', () => {
    const rule = dr.resolve(mkEvent('ArrowUp', { shiftKey: true, altKey: true }), { editorTextFocus: true })
    expect(rule?.command).toBe('editor.action.duplicateLineUp')
  })

  it('alt+down → moveLineDown, shift+alt+down → duplicateLineDown (no confusion)', () => {
    const ctx = { editorTextFocus: true }
    expect(dr.resolve(mkEvent('ArrowDown', { altKey: true }), ctx)?.command).toBe('editor.action.moveLineDown')
    expect(dr.resolve(mkEvent('ArrowDown', { shiftKey: true, altKey: true }), ctx)?.command).toBe('editor.action.duplicateLineDown')
  })

  it('cmd+shift+| → jumpToBracket (editorTextFocus)', () => {
    const rule = dr.resolve(mkEvent('|', { metaKey: true, shiftKey: true }), { editorTextFocus: true })
    expect(rule?.command).toBe('editor.action.jumpToBracket')
  })

  it('jumpToBracket requires editorTextFocus', () => {
    expect(dr.resolve(mkEvent('|', { metaKey: true, shiftKey: true }), {})).toBeNull()
  })

  it('duplicateLineDown/Up require editorTextFocus', () => {
    expect(dr.resolve(mkEvent('ArrowDown', { shiftKey: true, altKey: true }), {})).toBeNull()
    expect(dr.resolve(mkEvent('ArrowUp', { shiftKey: true, altKey: true }), {})).toBeNull()
  })

  it('cmd+] → indentLines (editorTextFocus)', () => {
    expect(dr.resolve(mkEvent(']', { metaKey: true }), { editorTextFocus: true })?.command).toBe('editor.action.indentLines')
  })

  it('cmd+[ → outdentLines (editorTextFocus)', () => {
    expect(dr.resolve(mkEvent('[', { metaKey: true }), { editorTextFocus: true })?.command).toBe('editor.action.outdentLines')
  })

  it('cmd+up → cursorTop (editorTextFocus)', () => {
    expect(dr.resolve(mkEvent('ArrowUp', { metaKey: true }), { editorTextFocus: true })?.command).toBe('editor.action.cursorTop')
  })

  it('cmd+down → cursorBottom (editorTextFocus)', () => {
    expect(dr.resolve(mkEvent('ArrowDown', { metaKey: true }), { editorTextFocus: true })?.command).toBe('editor.action.cursorBottom')
  })

  it('indent/dedent/cursorTop/cursorBottom require editorTextFocus', () => {
    expect(dr.resolve(mkEvent(']', { metaKey: true }), {})).toBeNull()
    expect(dr.resolve(mkEvent('[', { metaKey: true }), {})).toBeNull()
    expect(dr.resolve(mkEvent('ArrowUp', { metaKey: true }), {})).toBeNull()
    expect(dr.resolve(mkEvent('ArrowDown', { metaKey: true }), {})).toBeNull()
  })

  it('cmd+d → addSelectionToNextFindMatch (editorTextFocus)', () => {
    expect(dr.resolve(mkEvent('d', { metaKey: true }), { editorTextFocus: true })?.command)
      .toBe('editor.action.addSelectionToNextFindMatch')
  })

  it('cmd+p → quickOpen (no when clause)', () => {
    expect(dr.resolve(mkEvent('p', { metaKey: true }), {})?.command)
      .toBe('workbench.action.quickOpen')
  })

  it('cmd+shift+t → reopenClosedEditor (no when clause)', () => {
    expect(dr.resolve(mkEvent('T', { metaKey: true, shiftKey: true }), {})?.command)
      .toBe('workbench.action.reopenClosedEditor')
  })

  it('f1 → showCommands', () => {
    expect(dr.resolve(mkEvent('F1'), {})?.command).toBe('workbench.action.showCommands')
  })

  it('cmd+shift+o → gotoSymbol (editorOpen)', () => {
    expect(dr.resolve(mkEvent('O', { metaKey: true, shiftKey: true }), { editorOpen: true })?.command)
      .toBe('workbench.action.gotoSymbol')
  })

  it('gotoSymbol requires editorOpen', () => {
    expect(dr.resolve(mkEvent('O', { metaKey: true, shiftKey: true }), {})).toBeNull()
  })

  it('cmd+k cmd+c → addLineComment chord (editorTextFocus)', () => {
    dr.resolve(mkEvent('k', { metaKey: true }), { editorTextFocus: true })
    expect(dr.resolve(mkEvent('c', { metaKey: true }), { editorTextFocus: true })?.command)
      .toBe('editor.action.addLineComment')
  })

  it('cmd+k cmd+u → removeLineComment chord (editorTextFocus)', () => {
    dr.resolve(mkEvent('k', { metaKey: true }), { editorTextFocus: true })
    expect(dr.resolve(mkEvent('u', { metaKey: true }), { editorTextFocus: true })?.command)
      .toBe('editor.action.removeLineComment')
  })

  it('addLineComment chord null without editorTextFocus when clause', () => {
    // cmd+k enters chord mode because cmd+k cmd+w has no when-clause (always eligible).
    dr.resolve(mkEvent('k', { metaKey: true }), {})
    // cmd+k cmd+c resolves to null because editorTextFocus is false
    expect(dr.resolve(mkEvent('c', { metaKey: true }), {})).toBeNull()
  })

  it('f3 → nextMatch (findOpen)', () => {
    expect(dr.resolve(mkEvent('F3'), { findOpen: true })?.command)
      .toBe('editor.action.nextMatch')
  })

  it('shift+f3 → prevMatch (findOpen)', () => {
    expect(dr.resolve(mkEvent('F3', { shiftKey: true }), { findOpen: true })?.command)
      .toBe('editor.action.prevMatch')
  })

  it('f3/shift+f3 require findOpen', () => {
    expect(dr.resolve(mkEvent('F3'), {})).toBeNull()
    expect(dr.resolve(mkEvent('F3', { shiftKey: true }), {})).toBeNull()
  })

  it('cmd+n → newFile (no when clause)', () => {
    expect(dr.resolve(mkEvent('n', { metaKey: true }), {})?.command)
      .toBe('workbench.action.newFile')
  })

  it('escape → closeModal (modalOpen)', () => {
    expect(dr.resolve(mkEvent('Escape'), { modalOpen: true })?.command)
      .toBe('workbench.action.closeModal')
  })

  it('escape does nothing without modalOpen', () => {
    expect(dr.resolve(mkEvent('Escape'), {})).toBeNull()
  })

  it('ctrl+up → scrollLineUp (editorTextFocus)', () => {
    expect(dr.resolve(mkEvent('ArrowUp', { ctrlKey: true }), { editorTextFocus: true })?.command)
      .toBe('editor.action.scrollLineUp')
  })

  it('ctrl+down → scrollLineDown (editorTextFocus)', () => {
    expect(dr.resolve(mkEvent('ArrowDown', { ctrlKey: true }), { editorTextFocus: true })?.command)
      .toBe('editor.action.scrollLineDown')
  })

  it('ctrl+up/down require editorTextFocus', () => {
    expect(dr.resolve(mkEvent('ArrowUp', { ctrlKey: true }), {})).toBeNull()
    expect(dr.resolve(mkEvent('ArrowDown', { ctrlKey: true }), {})).toBeNull()
  })

  it('cmd+k cmd+m → changeLanguageMode chord (editorOpen)', () => {
    dr.resolve(mkEvent('k', { metaKey: true }), { editorOpen: true })
    expect(dr.resolve(mkEvent('m', { metaKey: true }), { editorOpen: true })?.command)
      .toBe('workbench.action.changeLanguageMode')
  })

  it('changeLanguageMode chord null without editorOpen when-clause', () => {
    // cmd+k enters chord because cmd+k cmd+w (closeAllEditors) has no when-clause
    dr.resolve(mkEvent('k', { metaKey: true }), {})
    expect(dr.resolve(mkEvent('m', { metaKey: true }), {})).toBeNull()
  })

  it('cmd+= → fontZoomIn (editorOpen)', () => {
    expect(dr.resolve(mkEvent('=', { metaKey: true }), { editorOpen: true })?.command)
      .toBe('editor.action.fontZoomIn')
  })

  it('cmd+- → fontZoomOut (editorOpen)', () => {
    expect(dr.resolve(mkEvent('-', { metaKey: true }), { editorOpen: true })?.command)
      .toBe('editor.action.fontZoomOut')
  })

  it('cmd+0 → fontZoomReset (editorOpen)', () => {
    expect(dr.resolve(mkEvent('0', { metaKey: true }), { editorOpen: true })?.command)
      .toBe('editor.action.fontZoomReset')
  })

  it('zoom shortcuts require editorOpen', () => {
    expect(dr.resolve(mkEvent('=', { metaKey: true }), {})).toBeNull()
    expect(dr.resolve(mkEvent('-', { metaKey: true }), {})).toBeNull()
    expect(dr.resolve(mkEvent('0', { metaKey: true }), {})).toBeNull()
  })

  it('cmd+k cmd+s → openKeyboardShortcuts chord (no when)', () => {
    dr.resolve(mkEvent('k', { metaKey: true }), {})
    expect(dr.resolve(mkEvent('s', { metaKey: true }), {})?.command)
      .toBe('workbench.action.openKeyboardShortcuts')
  })

  it('cmd+k cmd+t → selectTheme chord (no when)', () => {
    dr.resolve(mkEvent('k', { metaKey: true }), {})
    expect(dr.resolve(mkEvent('t', { metaKey: true }), {})?.command)
      .toBe('workbench.action.selectTheme')
  })

  it('cmd+w → closeActiveEditor (editorOpen && !modalOpen)', () => {
    expect(dr.resolve(mkEvent('w', { metaKey: true }), { editorOpen: true, modalOpen: false })?.command)
      .toBe('workbench.action.closeActiveEditor')
  })

  it('cmd+w blocked when modalOpen', () => {
    expect(dr.resolve(mkEvent('w', { metaKey: true }), { editorOpen: true, modalOpen: true })).toBeNull()
  })

  it('cmd+w blocked when editorOpen false', () => {
    expect(dr.resolve(mkEvent('w', { metaKey: true }), { editorOpen: false })).toBeNull()
  })

  it('cmd+shift+s → saveAll (editorOpen)', () => {
    expect(dr.resolve(mkEvent('S', { metaKey: true, shiftKey: true }), { editorOpen: true })?.command)
      .toBe('workbench.action.saveAll')
  })

  it('cmd+shift+s requires editorOpen', () => {
    expect(dr.resolve(mkEvent('S', { metaKey: true, shiftKey: true }), {})).toBeNull()
  })
})
