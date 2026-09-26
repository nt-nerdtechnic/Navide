import { describe, expect, it } from 'vitest'
import { canonicalizeKeySpec } from '@navide/plugin-ui/shared'
import { holdToTalkKeyProblem, reservedChordAction, suggestHoldToTalkKeys } from '../holdToTalkKey'
import { VOICE_RECORDING_MODES } from '../voiceSettings'

describe('holdToTalkKeyProblem', () => {
  it('accepts function keys, a lone modifier other than ⌘, other non-printing keys and ⌃/⌥ combinations in every mode', () => {
    for (const mode of VOICE_RECORDING_MODES) {
      for (const spec of ['f13', 'f19', 'f1', 'f24', 'rightalt', 'leftalt', 'rightctrl', 'rightshift', 'home', 'pagedown', 'arrowup', 'ctrl+alt+m', 'alt+space', 'ctrl+enter', 'shift+f5']) {
        expect(holdToTalkKeyProblem(spec, mode), `${spec} ${mode}`).toBeNull()
      }
    }
  })

  it('refuses keys that type or edit, also with ⇧', () => {
    for (const spec of ['a', 'm', '5', 'space', '/', ',', 'enter', 'tab', 'backspace', 'delete', 'escape', 'shift+a', 'shift+enter']) {
      expect(holdToTalkKeyProblem(spec, 'toggle'), spec).toBe('typing-key')
    }
  })

  it('refuses a ⌘ chord in hold and hold-tap, accepts it in toggle', () => {
    for (const spec of ['cmd+shift+d', 'cmd+alt+m', 'cmd+f13', 'cmd+j']) {
      expect(holdToTalkKeyProblem(spec, 'hold'), spec).toBe('meta')
      expect(holdToTalkKeyProblem(spec, 'hold-tap'), spec).toBe('meta')
      expect(holdToTalkKeyProblem(spec, 'toggle'), spec).toBeNull()
    }
  })

  it('accepts ⌘ by itself, either side, in every mode (its take waits for a solo hold)', () => {
    for (const mode of VOICE_RECORDING_MODES) {
      expect(holdToTalkKeyProblem('rightcmd', mode)).toBeNull()
      expect(holdToTalkKeyProblem('leftcmd', mode)).toBeNull()
    }
  })

  it('refuses chords macOS keeps for itself, naming what they do', () => {
    for (const [spec, action] of [['cmd+q', 'quit'], ['cmd+w', 'close-window'], ['cmd+h', 'hide'], ['cmd+m', 'minimize'], ['cmd+tab', 'app-switcher'], ['cmd+space', 'spotlight'], ['cmd+`', 'window-cycle'], ['cmd+,', 'settings'], ['shift+cmd+4', 'screenshot']]) {
      expect(holdToTalkKeyProblem(spec, 'toggle'), spec).toBe('macos-reserved')
      expect(reservedChordAction(spec), spec).toBe(action)
    }
    expect(reservedChordAction('cmd+shift+d')).toBeNull()
  })
})

describe('suggestHoldToTalkKeys', () => {
  it('offers ⌘ chords near the refused one in toggle mode, skipping taken and reserved keys', () => {
    const taken = new Set([canonicalizeKeySpec('cmd+ctrl+d')])
    const out = suggestHoldToTalkKeys('cmd+shift+d', 'toggle', taken)
    // cmd+ctrl+d is taken, cmd+alt+d shows the Dock (macOS-reserved).
    expect(out).toEqual(['cmd+alt+shift+d', 'cmd+ctrl+shift+d', 'ctrl+alt+d'])
  })

  it('never offers a ⌘ chord in hold modes, and falls back to function keys', () => {
    for (const mode of ['hold', 'hold-tap'] as const) {
      const taken = new Set(['ctrl+alt+d', 'ctrl+alt+shift+d', 'f13'])
      const out = suggestHoldToTalkKeys('cmd+shift+d', mode, taken)
      expect(out).toEqual(['ctrl+shift+d', 'f14', 'f15'])
      for (const s of out) expect(holdToTalkKeyProblem(s, mode), s).toBeNull()
    }
  })

  it('offers only keys that are free and valid in the mode', () => {
    const taken = new Set(['f13', 'f14', 'f15', 'f16', 'f17', 'f18'])
    for (const mode of VOICE_RECORDING_MODES) {
      for (const s of suggestHoldToTalkKeys('cmd+q', mode, taken)) {
        expect(taken.has(s), s).toBe(false)
        expect(holdToTalkKeyProblem(s, mode), `${s} ${mode}`).toBeNull()
      }
    }
  })
})
