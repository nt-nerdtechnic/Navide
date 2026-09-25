// @vitest-environment happy-dom
// Single-key hold-to-talk bindings (a lone modifier, a function key) and the
// fn (🌐) key relay, driven through the real key resolver and voiceWiring.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick } from 'vue'
import { defaults, executeCommand, getContext, getUserRules, KeyResolver, parseKeySpec, setUserRules } from '@navide/plugin-ui/shared'
import { RELEASE_TAIL_MS } from '../../composables/useVoiceInput'
import { useVoiceSettings, HOLD_TO_TALK_COMMAND } from '../voiceSettings'
import type { FnKeyApi, FnKeyEventType } from '../../../../shared/fnKey'

const openMicCapture = vi.fn()
vi.mock('../micCapture', () => ({ openMicCapture: (...a: unknown[]) => openMicCapture(...a) }))

import { TAP_LOCK_MS, isChordKeyUp, isLoneModifierCombo, setupVoiceInput } from '../voiceWiring'

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await nextTick()
}

function fakeFnKey() {
  let handler: ((e: { type: FnKeyEventType }) => void) | null = null
  const api = {
    subscribe: vi.fn(async () => ({ phase: 'ready' as const, fnUsage: 0 })),
    unsubscribe: vi.fn(async () => {}),
    status: vi.fn(async () => ({ phase: 'off' as const, fnUsage: null })),
    requestPermission: vi.fn(async () => ({ phase: 'ready' as const, fnUsage: 0 })),
    openSettings: vi.fn(async () => ({ ok: true })),
    onEvent: vi.fn((h: (e: { type: FnKeyEventType }) => void) => {
      handler = h
      return () => {
        handler = null
      }
    }),
    onStatus: vi.fn(() => () => {}),
  } satisfies FnKeyApi
  return { api, emit: (type: FnKeyEventType) => handler?.({ type }), listening: () => handler !== null }
}

describe('voice wiring: single keys and the fn key', () => {
  let sent: string[]
  let inserted: string[]
  let scope: ReturnType<typeof effectScope>
  let voice: ReturnType<typeof setupVoiceInput>
  let fn: ReturnType<typeof fakeFnKey>
  const settings = useVoiceSettings()

  /** Rebinds hold-to-talk to `key` alone (the default ⌃⌥M removed). */
  function bind(key: string): void {
    setUserRules([
      { key: 'ctrl+alt+m', command: `-${HOLD_TO_TALK_COMMAND}` },
      { key, command: HOLD_TO_TALK_COMMAND, when: 'paneStage && voiceInput && !modalOpen' },
    ])
  }

  /** A keydown through the resolver and, when a rule matches, its command. */
  function press(key: string, init: KeyboardEventInit): { consumed: boolean; event: KeyboardEvent } {
    const event = new KeyboardEvent('keydown', { key, ...init, cancelable: true })
    const rule = new KeyResolver([...defaults, ...getUserRules()]).resolve(event, { ...getContext(), paneStage: true })
    const consumed = rule ? executeCommand(rule.command, rule.args) : false
    window.dispatchEvent(event)
    return { consumed, event }
  }
  function keyup(init: KeyboardEventInit): KeyboardEvent {
    const e = new KeyboardEvent('keyup', { ...init, cancelable: true })
    window.dispatchEvent(e)
    return e
  }

  beforeEach(() => {
    vi.useFakeTimers()
    settings.setVoiceInputEnabled(false)
    settings.setVoiceFnKeyEnabled(false)
    settings.setVoiceRecordingMode('hold')
    sent = []
    inserted = []
    fn = fakeFnKey()
    openMicCapture.mockReset()
    openMicCapture.mockImplementation(async (onChunk: (pcm: Int16Array) => void) => ({
      flush: async () => {
        onChunk(Int16Array.from([1, 2]))
      },
      close: () => {},
    }))
    scope = effectScope()
    voice = scope.run(() =>
      setupVoiceInput({
        backend: {
          send: (async (type: string) => {
            sent.push(type)
            const body =
              type === 'voice.start' ? { ok: true, sessionId: 'S' }
              : type === 'voice.stop' ? { ok: true, text: 'hello', ms: 5, durationMs: 800 }
              : { ok: true }
            return { id: 'x', type: `${type}.result`, ok: true, payload: body, error: null, timestamp: '' }
          }) as never,
          on: () => () => {},
        },
        focusedPaneId: () => 'pane-a',
        paneInfo: () => ({ realized: true, messagingName: 'claude-1' }),
        insertText: (_paneId, text) => {
          inserted.push(text)
          return true
        },
        fnKey: fn.api,
      }),
    )!
  })

  afterEach(() => {
    scope.stop()
    settings.setVoiceInputEnabled(false)
    settings.setVoiceFnKeyEnabled(false)
    setUserRules([])
    vi.useRealTimers()
  })

  describe('a lone modifier (Right Option)', () => {
    beforeEach(async () => {
      bind('rightalt')
      settings.setVoiceInputEnabled(true)
      await settle()
    })

    it('held alone: its keydown starts the take, its own keyup ends it', async () => {
      expect(press('Alt', { code: 'AltRight', altKey: true }).consumed).toBe(true)
      await settle()
      expect(voice.state.phase).toBe('recording')
      // Windows repeats a held modifier's keydown: swallowed, nothing new.
      expect(press('Alt', { code: 'AltRight', altKey: true, repeat: true }).consumed).toBe(true)
      expect(voice.state.phase).toBe('recording')
      expect(keyup({ key: 'Alt', code: 'AltRight' }).defaultPrevented).toBe(true)
      vi.advanceTimersByTime(RELEASE_TAIL_MS)
      await settle()
      expect(inserted).toEqual(['hello'])
    })

    it('Left Option and the default ⌃⌥M do nothing', async () => {
      expect(press('Alt', { code: 'AltLeft', altKey: true }).consumed).toBe(false)
      expect(press('µ', { code: 'KeyM', ctrlKey: true, altKey: true }).consumed).toBe(false)
      await settle()
      expect(voice.state.phase).toBe('idle')
    })

    it('used for a combination (Right Option + E): the take is dropped quietly and the key goes through', async () => {
      press('Alt', { code: 'AltRight', altKey: true })
      await settle()
      expect(voice.state.phase).toBe('recording')
      const { event } = press('´', { code: 'KeyE', altKey: true })
      expect(event.defaultPrevented).toBe(false)
      await settle()
      expect(voice.state.phase).toBe('idle')
      expect(voice.state.error).toBeNull()
      keyup({ key: 'Alt', code: 'AltRight' })
      vi.advanceTimersByTime(RELEASE_TAIL_MS)
      await settle()
      expect(inserted).toEqual([])
      expect(sent).not.toContain('voice.stop')
    })

    it('hold-tap: a quick tap locks hands-free, and a later Option combination does not drop it', async () => {
      settings.setVoiceRecordingMode('hold-tap')
      press('Alt', { code: 'AltRight', altKey: true })
      await settle()
      vi.advanceTimersByTime(TAP_LOCK_MS - 100)
      keyup({ key: 'Alt', code: 'AltRight' })
      await settle()
      expect(voice.state.handsFree).toBe(true)
      press('´', { code: 'KeyE', altKey: true })
      await settle()
      expect(voice.state.phase).toBe('recording')
      press('Alt', { code: 'AltRight', altKey: true })
      vi.advanceTimersByTime(RELEASE_TAIL_MS)
      await settle()
      expect(inserted).toEqual(['hello'])
    })

    it('blur while held ends the take', async () => {
      press('Alt', { code: 'AltRight', altKey: true })
      await settle()
      window.dispatchEvent(new Event('blur'))
      vi.advanceTimersByTime(RELEASE_TAIL_MS)
      await settle()
      expect(inserted).toEqual(['hello'])
    })
  })

  describe('a function key (F13)', () => {
    beforeEach(async () => {
      bind('f13')
      settings.setVoiceInputEnabled(true)
      await settle()
    })

    it('press, repeat and release', async () => {
      expect(press('F13', { code: 'F13' }).consumed).toBe(true)
      await settle()
      expect(press('F13', { code: 'F13', repeat: true }).consumed).toBe(true)
      expect(keyup({ key: 'x', code: 'KeyX' }).defaultPrevented).toBe(false)
      expect(voice.state.phase).toBe('recording')
      expect(keyup({ key: 'F13', code: 'F13' }).defaultPrevented).toBe(true)
      vi.advanceTimersByTime(RELEASE_TAIL_MS)
      await settle()
      expect(inserted).toEqual(['hello'])
    })

    it('another key while F13 is held does not drop the take (only a lone modifier does that)', async () => {
      press('F13', { code: 'F13' })
      await settle()
      press('a', { code: 'KeyA' })
      await settle()
      expect(voice.state.phase).toBe('recording')
    })
  })

  describe('the fn (🌐) key', () => {
    it('setting OFF (or voice input off): no subscription, no helper, no listener', async () => {
      settings.setVoiceInputEnabled(true)
      await settle()
      expect(fn.api.subscribe).not.toHaveBeenCalled()
      expect(fn.listening()).toBe(false)
      settings.setVoiceInputEnabled(false)
      settings.setVoiceFnKeyEnabled(true)
      await settle()
      expect(fn.api.subscribe).not.toHaveBeenCalled()
      expect(fn.listening()).toBe(false)
    })

    it('subscribes while both are on and unsubscribes when either goes off', async () => {
      settings.setVoiceInputEnabled(true)
      settings.setVoiceFnKeyEnabled(true)
      await settle()
      expect(fn.api.subscribe).toHaveBeenCalledTimes(1)
      expect(fn.listening()).toBe(true)
      settings.setVoiceFnKeyEnabled(false)
      await settle()
      expect(fn.api.unsubscribe).toHaveBeenCalledTimes(1)
      expect(fn.listening()).toBe(false)
      settings.setVoiceFnKeyEnabled(true)
      await settle()
      settings.setVoiceInputEnabled(false)
      await settle()
      expect(fn.api.unsubscribe).toHaveBeenCalledTimes(2)
    })

    describe('with the setting on', () => {
      beforeEach(async () => {
        settings.setVoiceInputEnabled(true)
        settings.setVoiceFnKeyEnabled(true)
        await settle()
      })

      it('down / up is push-to-talk; keyboard keyups and blur do not end it', async () => {
        const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
        fn.emit('down')
        await settle()
        expect(voice.state.phase).toBe('recording')
        keyup({ key: 'm', code: 'KeyM' })
        keyup({ key: 'Alt', code: 'AltLeft' })
        await settle()
        expect(voice.state.phase).toBe('recording')
        fn.emit('up')
        vi.advanceTimersByTime(RELEASE_TAIL_MS)
        await settle()
        expect(inserted).toEqual(['hello'])
        focus.mockRestore()
      })

      it('hold-tap: a quick tap locks hands-free; the next fn press stops it', async () => {
        settings.setVoiceRecordingMode('hold-tap')
        const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
        fn.emit('down')
        await settle()
        vi.advanceTimersByTime(TAP_LOCK_MS - 100)
        fn.emit('up')
        await settle()
        expect(voice.state.handsFree).toBe(true)
        vi.advanceTimersByTime(RELEASE_TAIL_MS * 4)
        await settle()
        expect(voice.state.phase).toBe('recording')
        fn.emit('down')
        vi.advanceTimersByTime(RELEASE_TAIL_MS)
        await settle()
        expect(inserted).toEqual(['hello'])
        focus.mockRestore()
      })

      it('fn used as a modifier (chord) drops the take quietly', async () => {
        const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
        fn.emit('down')
        await settle()
        fn.emit('chord')
        await settle()
        expect(voice.state.phase).toBe('idle')
        expect(voice.state.error).toBeNull()
        vi.advanceTimersByTime(RELEASE_TAIL_MS)
        await settle()
        expect(inserted).toEqual([])
        focus.mockRestore()
      })

      it('switching the fn setting off mid-take ends the take (its up can no longer arrive)', async () => {
        const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
        fn.emit('down')
        await settle()
        vi.advanceTimersByTime(TAP_LOCK_MS + 100)
        settings.setVoiceFnKeyEnabled(false)
        await settle()
        vi.advanceTimersByTime(RELEASE_TAIL_MS)
        await settle()
        expect(inserted).toEqual(['hello'])
        focus.mockRestore()
      })

      it('a press while another app is in front is ignored', async () => {
        const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
        fn.emit('down')
        await settle()
        expect(voice.state.phase).toBe('idle')
        expect(sent).not.toContain('voice.start')
        focus.mockRestore()
      })

      it('an up or chord with no fn take does nothing to a keyboard take', async () => {
        const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
        expect(executeCommand(HOLD_TO_TALK_COMMAND)).toBe(true)
        await settle()
        fn.emit('up')
        fn.emit('chord')
        await settle()
        expect(voice.state.phase).toBe('recording')
        focus.mockRestore()
      })
    })

    it('the scope going away unsubscribes', async () => {
      settings.setVoiceInputEnabled(true)
      settings.setVoiceFnKeyEnabled(true)
      await settle()
      scope.stop()
      expect(fn.api.unsubscribe).toHaveBeenCalledTimes(1)
      expect(fn.listening()).toBe(false)
    })
  })
})

describe('isChordKeyUp / isLoneModifierCombo for a lone modifier', () => {
  const chord = parseKeySpec('rightalt')
  it('its own keyup, or any keyup with Option already up, lets go', () => {
    expect(isChordKeyUp(new KeyboardEvent('keyup', { key: 'Alt', code: 'AltRight' }), chord)).toBe(true)
    expect(isChordKeyUp(new KeyboardEvent('keyup', { key: 'x', code: 'KeyX' }), chord)).toBe(true)
    expect(isChordKeyUp(new KeyboardEvent('keyup', { key: 'x', code: 'KeyX', altKey: true }), chord)).toBe(false)
    expect(isChordKeyUp(new KeyboardEvent('keyup', { key: 'Alt', code: 'AltLeft', altKey: true }), chord)).toBe(false)
  })
  it('any other keydown is a combination; its own repeat is not', () => {
    expect(isLoneModifierCombo(new KeyboardEvent('keydown', { key: 'Alt', code: 'AltRight', altKey: true, repeat: true }), chord)).toBe(false)
    expect(isLoneModifierCombo(new KeyboardEvent('keydown', { key: '´', code: 'KeyE', altKey: true }), chord)).toBe(true)
    expect(isLoneModifierCombo(new KeyboardEvent('keydown', { key: 'Shift', code: 'ShiftLeft', altKey: true, shiftKey: true }), chord)).toBe(true)
    expect(isLoneModifierCombo(new KeyboardEvent('keydown', { key: 'a' }), parseKeySpec('f13'))).toBe(false)
    expect(isLoneModifierCombo(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', altKey: true }), chord)).toBe(false)
    expect(isLoneModifierCombo(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', altKey: true }), chord)).toBe(false)
  })
})
