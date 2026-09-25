import { describe, expect, it } from 'vitest'
import { holdToTalkKeyProblem } from '../holdToTalkKey'

describe('holdToTalkKeyProblem', () => {
  it('accepts function keys, a lone modifier other than ⌘, other non-printing keys and ⌃/⌥ combinations', () => {
    for (const spec of ['f13', 'f19', 'f1', 'f24', 'rightalt', 'leftalt', 'rightctrl', 'rightshift', 'home', 'pagedown', 'arrowup', 'ctrl+alt+m', 'alt+space', 'ctrl+enter', 'shift+f5']) {
      expect(holdToTalkKeyProblem(spec), spec).toBeNull()
    }
  })

  it('refuses keys that type or edit, also with ⇧', () => {
    for (const spec of ['a', 'm', '5', 'space', '/', ',', 'enter', 'tab', 'backspace', 'delete', 'escape', 'shift+a', 'shift+enter']) {
      expect(holdToTalkKeyProblem(spec), spec).toBe('typing-key')
    }
  })

  it('refuses ⌘, with its own reason when it is alone', () => {
    expect(holdToTalkKeyProblem('cmd+alt+m')).toBe('meta')
    expect(holdToTalkKeyProblem('cmd+f13')).toBe('meta')
    expect(holdToTalkKeyProblem('rightcmd')).toBe('meta-alone')
    expect(holdToTalkKeyProblem('leftcmd')).toBe('meta-alone')
  })
})
