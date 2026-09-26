// @vitest-environment happy-dom
// A lone ⌘ or ⌃ as the dictation key: the take starts only once the modifier
// has been held by itself for SOLO_HOLD_MS, and every shortcut that starts
// with it keeps working. Driven through the real keydown dispatcher, since
// the point is how dictation and the other commands share the keyboard.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, effectScope, h, nextTick } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { registerCommand, setContext, setKeyCaptureActive, setUserRules, useKeybindings } from '@navide/plugin-ui/shared'
import { RELEASE_TAIL_MS } from '../../composables/useVoiceInput'
import { useVoiceSettings, HOLD_TO_TALK_COMMAND, type VoiceRecordingMode } from '../voiceSettings'

const openMicCapture = vi.fn()
vi.mock('../micCapture', () => ({ openMicCapture: (...a: unknown[]) => openMicCapture(...a) }))

import { SOLO_HOLD_MS, needsSoloHold, setupVoiceInput } from '../voiceWiring'

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await nextTick()
}

const Host = defineComponent({
  setup() {
    useKeybindings()
    return () => h('div')
  },
})

const LEFT_CMD = { key: 'Meta', code: 'MetaLeft' }
const RIGHT_CMD = { key: 'Meta', code: 'MetaRight' }

describe('voice wiring: a lone ⌘ / ⌃ waits for a solo hold', () => {
  let sent: string[]
  let inserted: string[]
  let scope: ReturnType<typeof effectScope>
  let voice: ReturnType<typeof setupVoiceInput>
  let wrapper: VueWrapper
  // Keydowns that got past the dispatcher (what the terminal and menu see).
  let passed: KeyboardEvent[]
  const probe = (e: KeyboardEvent): void => { passed.push(e) }
  const settings = useVoiceSettings()

  /** Binds hold-to-talk to `keys` alone (the default ⌃⌥M removed). */
  function bind(...keys: string[]): void {
    setUserRules([
      { key: 'ctrl+alt+m', command: `-${HOLD_TO_TALK_COMMAND}` },
      ...keys.map((key) => ({ key, command: HOLD_TO_TALK_COMMAND, when: 'paneStage && voiceInput && !modalOpen' })),
    ])
  }
  async function setup(mode: VoiceRecordingMode, ...keys: string[]): Promise<void> {
    settings.setVoiceRecordingMode(mode)
    bind(...keys)
    settings.setVoiceInputEnabled(true)
    await settle()
  }

  function keydown(init: KeyboardEventInit): KeyboardEvent {
    const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
    window.dispatchEvent(e)
    return e
  }
  function keyup(init: KeyboardEventInit): KeyboardEvent {
    const e = new KeyboardEvent('keyup', { bubbles: true, cancelable: true, ...init })
    window.dispatchEvent(e)
    return e
  }
  const cmdDown = (side = LEFT_CMD) => keydown({ ...side, metaKey: true })
  const cmdUp = (side = LEFT_CMD) => keyup(side)
  /** ⌘ + `key`, as macOS reports it while ⌘ is held. */
  const withCmd = (key: string, code: string) => keydown({ key, code, metaKey: true })

  async function wait(ms: number): Promise<void> {
    vi.advanceTimersByTime(ms)
    await settle()
  }
  const started = () => sent.includes('voice.start')

  beforeEach(() => {
    vi.useFakeTimers()
    settings.setVoiceInputEnabled(false)
    settings.setVoiceFnKeyEnabled(false)
    sent = []
    inserted = []
    openMicCapture.mockReset()
    openMicCapture.mockImplementation(async (onChunk: (pcm: Int16Array) => void) => ({
      flush: async () => {
        onChunk(Int16Array.from([1, 2]))
      },
      close: () => {},
    }))
    setContext('paneStage', true)
    setContext('modalOpen', false)
    setContext('editorOpen', true)
    setContext('terminalFocus', false)
    wrapper = mount(Host)
    passed = []
    window.addEventListener('keydown', probe)
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
      }),
    )!
  })

  afterEach(() => {
    scope.stop()
    window.removeEventListener('keydown', probe)
    wrapper.unmount()
    settings.setVoiceInputEnabled(false)
    setUserRules([])
    setContext('paneStage', false)
    setContext('editorOpen', false)
    vi.useRealTimers()
  })

  it('applies to a lone ⌘ or ⌃ of either side, not to ⌥, ⇧ or other keys', () => {
    for (const k of ['leftcmd', 'rightcmd', 'leftctrl', 'rightctrl']) expect(needsSoloHold(k), k).toBe(true)
    for (const k of ['leftalt', 'rightalt', 'leftshift', 'rightshift', 'f13', 'm']) expect(needsSoloHold(k), k).toBe(false)
    expect(SOLO_HOLD_MS).toBe(300)
  })

  it('hold: nothing starts before SOLO_HOLD_MS; then the take starts, and ⌘ up ends and inserts it', async () => {
    await setup('hold', 'leftcmd')
    const down = cmdDown()
    // The modifier's keydown is left to the page.
    expect(down.defaultPrevented).toBe(false)
    expect(passed).toContain(down)
    await wait(SOLO_HOLD_MS - 1)
    expect(voice.state.phase).toBe('idle')
    expect(started()).toBe(false)
    expect(openMicCapture).not.toHaveBeenCalled()
    await wait(1)
    expect(voice.state.phase).toBe('recording')
    expect(openMicCapture).toHaveBeenCalledTimes(1)
    cmdUp()
    await wait(RELEASE_TAIL_MS)
    expect(inserted).toEqual(['hello'])
  })

  for (const [name, key, code] of [
    ['⌘C (copy, a menu role)', 'c', 'KeyC'],
    ['⌘Z (undo, a menu accelerator)', 'z', 'KeyZ'],
    ['⌘Tab', 'Tab', 'Tab'],
    ['⌘V', 'v', 'KeyV'],
  ] as const) {
    it(`${name} before the hold: goes through untouched, nothing starts, and letting go of ⌘ is no tap`, async () => {
      await setup('hold-tap', 'leftcmd')
      cmdDown()
      await wait(100)
      const e = withCmd(key, code)
      expect(e.defaultPrevented).toBe(false)
      expect(passed).toContain(e)
      await wait(SOLO_HOLD_MS * 3)
      cmdUp()
      await wait(SOLO_HOLD_MS * 3)
      expect(voice.state.phase).toBe('idle')
      expect(started()).toBe(false)
      expect(inserted).toEqual([])
    })
  }

  it('⌘C after the take started: it is dropped quietly and the key still goes through', async () => {
    await setup('hold', 'leftcmd')
    cmdDown()
    await wait(SOLO_HOLD_MS + 50)
    expect(voice.state.phase).toBe('recording')
    const e = withCmd('c', 'KeyC')
    expect(e.defaultPrevented).toBe(false)
    expect(passed).toContain(e)
    await settle()
    expect(voice.state.phase).toBe('idle')
    cmdUp()
    await wait(RELEASE_TAIL_MS * 2)
    expect(inserted).toEqual([])
    expect(voice.state.phase).toBe('idle')
    expect(sent).not.toContain('voice.stop')
  })

  it('⌘S, consumed by Save, still drops a pending hold and a running take; Save runs', async () => {
    await setup('hold', 'leftcmd')
    const save = vi.fn()
    registerCommand('editor.action.save', save)
    cmdDown()
    await wait(100)
    expect(withCmd('s', 'KeyS').defaultPrevented).toBe(true)
    expect(save).toHaveBeenCalledTimes(1)
    await wait(SOLO_HOLD_MS * 3)
    expect(started()).toBe(false)
    cmdUp()

    cmdDown()
    await wait(SOLO_HOLD_MS)
    expect(voice.state.phase).toBe('recording')
    withCmd('s', 'KeyS')
    expect(save).toHaveBeenCalledTimes(2)
    await settle()
    expect(voice.state.phase).toBe('idle')
    cmdUp()
    await wait(RELEASE_TAIL_MS * 2)
    expect(inserted).toEqual([])
  })

  it('the ⌘K ⌘S chord still opens Keyboard Shortcuts and starts nothing', async () => {
    await setup('toggle', 'leftcmd')
    const open = vi.fn()
    registerCommand('workbench.action.openKeyboardShortcuts', open)
    cmdDown()
    withCmd('k', 'KeyK')
    withCmd('s', 'KeyS')
    expect(open).toHaveBeenCalledTimes(1)
    await wait(SOLO_HOLD_MS * 3)
    cmdUp()
    await wait(SOLO_HOLD_MS)
    expect(started()).toBe(false)
    // Also with ⌘ let go and pressed again between the two keys.
    cmdDown()
    withCmd('k', 'KeyK')
    cmdUp()
    cmdDown()
    withCmd('s', 'KeyS')
    cmdUp()
    expect(open).toHaveBeenCalledTimes(2)
    await wait(SOLO_HOLD_MS * 3)
    expect(started()).toBe(false)
  })

  it('a repeat of ⌘ after a shortcut does not start a hold: ⌘ has to be let go first', async () => {
    await setup('hold', 'leftctrl')
    keydown({ key: 'Control', code: 'ControlLeft', ctrlKey: true })
    keydown({ key: 'c', code: 'KeyC', ctrlKey: true })
    // Windows repeats a held modifier.
    keydown({ key: 'Control', code: 'ControlLeft', ctrlKey: true, repeat: true })
    await wait(SOLO_HOLD_MS * 3)
    expect(started()).toBe(false)
    keyup({ key: 'Control', code: 'ControlLeft' })
    keydown({ key: 'Control', code: 'ControlLeft', ctrlKey: true })
    await wait(SOLO_HOLD_MS)
    expect(voice.state.phase).toBe('recording')
  })

  it('⌘Tab away (blur) before the hold: nothing starts', async () => {
    await setup('hold', 'leftcmd')
    cmdDown()
    window.dispatchEvent(new Event('blur'))
    await wait(SOLO_HOLD_MS * 3)
    expect(started()).toBe(false)
  })

  it('⌘Tab away (blur) during the take: cancelled quietly, nothing inserted', async () => {
    await setup('hold', 'leftcmd')
    cmdDown()
    await wait(SOLO_HOLD_MS + 100)
    expect(voice.state.phase).toBe('recording')
    window.dispatchEvent(new Event('blur'))
    await wait(RELEASE_TAIL_MS * 2)
    expect(voice.state.phase).toBe('idle')
    expect(inserted).toEqual([])
    expect(sent).not.toContain('voice.stop')
  })

  it('hold mode: a tap does nothing', async () => {
    await setup('hold', 'leftcmd')
    cmdDown()
    await wait(100)
    cmdUp()
    await wait(SOLO_HOLD_MS * 3)
    expect(started()).toBe(false)
    expect(voice.state.phase).toBe('idle')
  })

  it('hold-tap mode: a tap locks a hands-free take; the next tap stops it and inserts', async () => {
    await setup('hold-tap', 'leftcmd')
    cmdDown()
    await wait(100)
    cmdUp()
    await settle()
    expect(voice.state.phase).toBe('recording')
    expect(voice.state.handsFree).toBe(true)
    // Shortcuts meanwhile leave the hands-free take alone.
    cmdDown()
    withCmd('c', 'KeyC')
    cmdUp()
    await wait(SOLO_HOLD_MS * 3)
    expect(voice.state.phase).toBe('recording')
    cmdDown()
    await wait(100)
    cmdUp()
    await wait(RELEASE_TAIL_MS)
    expect(inserted).toEqual(['hello'])
  })

  it('hold-tap mode: let go just after the hold began (within the tap window) still locks', async () => {
    await setup('hold-tap', 'leftcmd')
    cmdDown()
    await wait(SOLO_HOLD_MS + 20)
    expect(voice.state.phase).toBe('recording')
    cmdUp()
    await settle()
    expect(voice.state.handsFree).toBe(true)
    expect(voice.state.phase).toBe('recording')
  })

  it('toggle mode: a tap starts, the next tap stops', async () => {
    await setup('toggle', 'leftcmd')
    cmdDown()
    await wait(50)
    cmdUp()
    await settle()
    expect(voice.state.phase).toBe('recording')
    expect(voice.state.handsFree).toBe(true)
    cmdDown()
    await wait(50)
    cmdUp()
    await wait(RELEASE_TAIL_MS)
    expect(inserted).toEqual(['hello'])
  })

  it('Left ⌘ bound: Right ⌘ does nothing', async () => {
    await setup('hold', 'leftcmd')
    cmdDown(RIGHT_CMD)
    await wait(SOLO_HOLD_MS * 3)
    expect(started()).toBe(false)
  })

  it('Right ⌘ bound: Left ⌘ does nothing, Right ⌘ dictates', async () => {
    await setup('hold', 'rightcmd')
    cmdDown(LEFT_CMD)
    await wait(SOLO_HOLD_MS * 3)
    expect(started()).toBe(false)
    cmdUp(LEFT_CMD)
    cmdDown(RIGHT_CMD)
    await wait(SOLO_HOLD_MS)
    expect(voice.state.phase).toBe('recording')
    cmdUp(RIGHT_CMD)
    await wait(RELEASE_TAIL_MS)
    expect(inserted).toEqual(['hello'])
  })

  it('both sides bound (either ⌘): each one dictates', async () => {
    await setup('hold', 'leftcmd', 'rightcmd')
    for (const side of [LEFT_CMD, RIGHT_CMD]) {
      cmdDown(side)
      await wait(SOLO_HOLD_MS)
      expect(voice.state.phase, side.code).toBe('recording')
      cmdUp(side)
      await wait(RELEASE_TAIL_MS)
    }
    expect(inserted).toEqual(['hello', 'hello'])
  })

  it('Esc still cancels a take a solo hold started', async () => {
    await setup('hold-tap', 'leftcmd')
    cmdDown()
    await wait(50)
    cmdUp()
    await settle()
    expect(voice.state.phase).toBe('recording')
    expect(keydown({ key: 'Escape', code: 'Escape' }).defaultPrevented).toBe(true)
    expect(voice.state.phase).toBe('idle')
    expect(inserted).toEqual([])
  })

  it('an IME composition key while ⌘ is down counts as another key: the hold, or the take, is dropped', async () => {
    await setup('hold', 'leftcmd')
    cmdDown()
    await wait(100)
    keydown({ key: 'Process', code: 'KeyA', metaKey: true, isComposing: true })
    await wait(SOLO_HOLD_MS * 3)
    expect(started()).toBe(false)
    cmdUp()

    cmdDown()
    await wait(SOLO_HOLD_MS)
    expect(voice.state.phase).toBe('recording')
    keydown({ key: 'Process', code: 'KeyA', metaKey: true, isComposing: true })
    await settle()
    expect(voice.state.phase).toBe('idle')
    cmdUp()
    await wait(RELEASE_TAIL_MS * 2)
    expect(inserted).toEqual([])
  })

  it('while the shortcut recorder holds the keyboard, a lone ⌘ starts nothing', async () => {
    await setup('hold', 'leftcmd')
    setKeyCaptureActive(true)
    try {
      cmdDown()
      await wait(SOLO_HOLD_MS * 3)
      cmdUp()
      await wait(SOLO_HOLD_MS)
      expect(started()).toBe(false)
      // A hold armed just before recording starts is dropped by the first key recorded.
      setKeyCaptureActive(false)
      cmdDown()
      setKeyCaptureActive(true)
      withCmd('j', 'KeyJ')
      await wait(SOLO_HOLD_MS * 3)
      expect(started()).toBe(false)
    } finally {
      setKeyCaptureActive(false)
    }
  })

  it('voice input off: a lone ⌘ is only a key', async () => {
    await setup('hold', 'leftcmd')
    settings.setVoiceInputEnabled(false)
    await settle()
    cmdDown()
    await wait(SOLO_HOLD_MS * 3)
    cmdUp()
    expect(started()).toBe(false)
  })
})
