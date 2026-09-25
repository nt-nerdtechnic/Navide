// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { canonicalizeKeySpec, defaults, executeCommand, getContext, parseKeySpec } from '@navide/plugin-ui/shared'
import { _resetMessagingForTest, useAgentMessaging } from '../../composables/useAgentMessaging'
import { HANDS_FREE_MAX_MS, RELEASE_TAIL_MS } from '../../composables/useVoiceInput'
import { useVoiceSettings } from '../voiceSettings'

const openMicCapture = vi.fn()
vi.mock('../micCapture', () => ({ openMicCapture: (...a: unknown[]) => openMicCapture(...a) }))

import { TAP_LOCK_MS, isChordKeyUp, setupVoiceInput } from '../voiceWiring'

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await nextTick()
}

describe('voice wiring', () => {
  let sent: Array<{ type: string; payload: Record<string, unknown> }>
  let delivered: Array<{ paneId: string; text: string }>
  let inserted: Array<{ paneId: string; text: string }>
  /** `submit` of every insertText call. */
  let submits: boolean[]
  let stopBody: Record<string, unknown>
  /** What the pane reports about a requested Enter. */
  let enterWent: boolean
  let listeners: Map<string, (payload: unknown) => void>
  let idle: boolean
  let prewarmBody: Record<string, unknown>
  let hints: string[]
  let focused: string
  let scope: ReturnType<typeof effectScope>
  let voice: ReturnType<typeof setupVoiceInput>
  const messaging = useAgentMessaging()
  const settings = useVoiceSettings()

  beforeEach(() => {
    vi.useFakeTimers()
    _resetMessagingForTest()
    settings.setVoiceInputEnabled(false)
    settings.setVoiceRecordingMode('hold')
    sent = []
    delivered = []
    inserted = []
    submits = []
    enterWent = true
    stopBody = { ok: true, text: '列出所有測試', ms: 5, durationMs: 800 }
    listeners = new Map()
    idle = true
    prewarmBody = { ok: true }
    hints = []
    focused = 'pane-a'
    openMicCapture.mockReset()
    openMicCapture.mockImplementation(async (onChunk: (pcm: Int16Array) => void) => ({
      flush: async () => { onChunk(Int16Array.from([1, 2])) },
      close: () => {},
    }))
    messaging.configureMessaging({
      now: () => Date.now(),
      deliver: async (paneId, text) => {
        delivered.push({ paneId, text })
        return true
      },
      isPaneIdle: () => idle,
      idleHoldKey: () => 'busy',
    })
    // The messaging queue is set up only to prove dictation never uses it.
    messaging.registerPane('pane-a', 'claude', 'claude-1')
    scope = effectScope()
    voice = scope.run(() =>
      setupVoiceInput({
        backend: {
          send: (async (type: string, payload: Record<string, unknown> = {}) => {
            sent.push({ type, payload })
            const body =
              type === 'voice.start' ? { ok: true, sessionId: 'S' }
              : type === 'voice.stop' ? stopBody
              : type === 'voice.prewarm' ? prewarmBody
              : { ok: true }
            return { id: 'x', type: `${type}.result`, ok: true, payload: body, error: null, timestamp: '' }
          }) as never,
          on: (type: string, cb: (payload: unknown) => void) => {
            listeners.set(type, cb)
            return () => listeners.delete(type)
          },
        },
        focusedPaneId: () => focused,
        paneInfo: (id) => (id === 'pane-a' ? { realized: true, messagingName: 'claude-1' } : { realized: false, messagingName: 'sleepy' }),
        insertText: (paneId, text, opts) => {
          submits.push(opts.submit)
          const went = enterWent
          if (opts.submit) queueMicrotask(() => opts.onSubmit?.(went))
          inserted.push({ paneId, text })
          return true
        },
        hint: (text) => hints.push(text),
      }),
    )!
  })

  afterEach(() => {
    scope.stop()
    settings.setVoiceInputEnabled(false)
    vi.useRealTimers()
  })

  it('setting OFF: context false, hotkey command declines, no mic, no backend, no listeners', async () => {
    const add = vi.spyOn(window, 'addEventListener')
    expect(getContext().voiceInput).toBe(false)
    expect(executeCommand('workbench.action.holdToTalk')).toBe(false)
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'm' }))
    vi.advanceTimersByTime(RELEASE_TAIL_MS)
    await settle()
    expect(sent).toEqual([])
    expect(openMicCapture).not.toHaveBeenCalled()
    expect(add.mock.calls.filter(([t]) => ['keyup', 'keydown', 'blur', 'focus'].includes(t as string))).toEqual([])
    window.dispatchEvent(new Event('focus'))
    await settle()
    expect(sent).toEqual([])
    expect(voice.state.phase).toBe('idle')
    add.mockRestore()
  })

  it('setting ON: hold → live partials → release → text typed into the pane, no Enter, no messaging queue', async () => {
    settings.setVoiceInputEnabled(true)
    await nextTick()
    expect(getContext().voiceInput).toBe(true)

    expect(executeCommand('workbench.action.holdToTalk')).toBe(true)
    await settle()
    expect(voice.state.phase).toBe('recording')
    // Key repeat while held is swallowed and starts nothing new.
    expect(executeCommand('workbench.action.holdToTalk')).toBe(true)

    listeners.get('voice.partial')!({ sessionId: 'S', seq: 0, committed: '列出', tentative: '所有' })
    expect(voice.state.committed).toBe('列出')
    expect(voice.state.tentative).toBe('所有')
    listeners.get('voice.partial')!({ sessionId: 'other', seq: 1, committed: '別人的', tentative: '' })
    expect(voice.state.committed).toBe('列出')

    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'm' }))
    vi.advanceTimersByTime(RELEASE_TAIL_MS)
    await settle()
    expect(sent.map((s) => s.type)).toEqual(['voice.prewarm', 'voice.start', 'voice.chunk', 'voice.stop'])
    // At once, no countdown; exactly what was said, with no CR to submit it.
    expect(inserted).toEqual([{ paneId: 'pane-a', text: '列出所有測試' }])
    expect(inserted[0].text).not.toContain('\r')
    expect(voice.state.phase).toBe('idle')
    vi.advanceTimersByTime(10_000)
    messaging.pump()
    await settle()
    expect(messaging.messages.value).toEqual([])
    expect(delivered).toEqual([])
  })

  it('opens the microphone the user chose in settings', async () => {
    settings.setVoiceInputEnabled(true)
    settings.setVoiceInputDevice('mic-usb', 'USB Mic')
    await nextTick()
    executeCommand('workbench.action.holdToTalk')
    await settle()
    expect(openMicCapture).toHaveBeenCalledTimes(1)
    expect(openMicCapture.mock.calls[0][1]).toBe('mic-usb')
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'm' }))
    vi.advanceTimersByTime(RELEASE_TAIL_MS)
    await settle()

    settings.setVoiceInputDevice('', '')
    executeCommand('workbench.action.holdToTalk')
    await settle()
    expect(openMicCapture.mock.calls.at(-1)![1]).toBe('')
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'm' }))
    vi.advanceTimersByTime(RELEASE_TAIL_MS)
    await settle()
    expect(voice.state.phase).toBe('idle')
    expect(inserted).toHaveLength(2)
  })

  it('a busy pane still receives the text: nothing waits for the CLI to go idle', async () => {
    settings.setVoiceInputEnabled(true)
    await nextTick()
    idle = false
    executeCommand('workbench.action.holdToTalk')
    await settle()
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control' }))
    vi.advanceTimersByTime(RELEASE_TAIL_MS)
    await settle()
    expect(inserted).toEqual([{ paneId: 'pane-a', text: '列出所有測試' }])
    expect(voice.state.phase).toBe('idle')
    expect(messaging.messages.value).toEqual([])
    // Esc after the take belongs to the CLI (it is how a busy pane is interrupted).
    const esc = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    window.dispatchEvent(esc)
    expect(esc.defaultPrevented).toBe(false)
  })

  it('a sleeping (placeholder) pane is refused with a message: no mic, no backend, nothing typed', async () => {
    settings.setVoiceInputEnabled(true)
    await nextTick()
    focused = 'pane-b'
    expect(executeCommand('workbench.action.holdToTalk')).toBe(true)
    await settle()
    expect(voice.state.phase).toBe('error')
    expect(voice.state.error?.key).toBe('pane-asleep')
    expect(openMicCapture).not.toHaveBeenCalled()
    expect(sent.map((s) => s.type)).toEqual(['voice.prewarm'])
    expect(inserted).toEqual([])
  })

  it('Esc while recording is taken and cancels the take', async () => {
    settings.setVoiceInputEnabled(true)
    await nextTick()
    executeCommand('workbench.action.holdToTalk')
    await settle()
    expect(voice.state.phase).toBe('recording')
    const esc = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    window.dispatchEvent(esc)
    await settle()
    expect(esc.defaultPrevented).toBe(true)
    expect(voice.state.phase).toBe('idle')
    expect(sent.at(-1)?.type).toBe('voice.cancel')
  })

  it('turning the setting off mid-take cancels it', async () => {
    settings.setVoiceInputEnabled(true)
    await nextTick()
    executeCommand('workbench.action.holdToTalk')
    await settle()
    expect(voice.state.phase).toBe('recording')
    settings.setVoiceInputEnabled(false)
    await nextTick()
    expect(voice.state.phase).toBe('idle')
    expect(sent.slice(-2).map((s) => s.type)).toEqual(['voice.cancel', 'voice.shutdown'])
    expect(getContext().voiceInput).toBe(false)
  })

  async function start(): Promise<void> {
    settings.setVoiceInputEnabled(true)
    await nextTick()
    expect(executeCommand('workbench.action.holdToTalk')).toBe(true)
    await settle()
  }
  const keyup = (init: KeyboardEventInit): KeyboardEvent => {
    const e = new KeyboardEvent('keyup', { cancelable: true, ...init })
    window.dispatchEvent(e)
    return e
  }
  const types = (): string[] => sent.map((s) => s.type).filter((t) => t !== 'voice.prewarm')

  it('an unrelated keyup does not end a held take; letting go of a chord modifier does, after the tail', async () => {
    await start()
    expect(voice.state.phase).toBe('recording')
    const other = keyup({ key: 'x', code: 'KeyX', ctrlKey: true, altKey: true })
    await settle()
    expect(other.defaultPrevented).toBe(false)
    expect(voice.state.phase).toBe('recording')
    const alt = keyup({ key: 'Alt', code: 'AltLeft', ctrlKey: true })
    expect(alt.defaultPrevented).toBe(true)
    await settle()
    expect(voice.state.phase).toBe('recording')
    vi.advanceTimersByTime(RELEASE_TAIL_MS)
    await settle()
    expect(inserted).toHaveLength(1)
  })

  it('blur is ignored while the take is starting (the mic dialog), and ends it once recording', async () => {
    let grant!: (v: { granted: boolean; status: string }) => void
    vi.stubGlobal('agentTeam', { media: { askMicrophone: () => new Promise((r) => { grant = r }) } })
    try {
      await start()
      expect(voice.state.phase).toBe('starting')
      window.dispatchEvent(new Event('blur'))
      await settle()
      expect(voice.state.phase).toBe('starting')
      grant({ granted: true, status: 'granted' })
      await settle()
      expect(voice.state.phase).toBe('recording')
      window.dispatchEvent(new Event('blur'))
      vi.advanceTimersByTime(RELEASE_TAIL_MS)
      await settle()
      expect(inserted).toHaveLength(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('a held take that starts recording in an unfocused window ends at once', async () => {
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    let grant!: (v: { granted: boolean; status: string }) => void
    vi.stubGlobal('agentTeam', { media: { askMicrophone: () => new Promise((r) => { grant = r }) } })
    try {
      await start()
      window.dispatchEvent(new Event('blur'))
      grant({ granted: true, status: 'granted' })
      await settle()
      vi.advanceTimersByTime(RELEASE_TAIL_MS)
      await settle()
      expect(inserted).toEqual([{ paneId: 'pane-a', text: '列出所有測試' }])
      expect(voice.state.phase).toBe('idle')
    } finally {
      focus.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('the press that showed the first-time mic dialog only authorises', async () => {
    vi.stubGlobal('agentTeam', { media: { askMicrophone: async () => ({ granted: true, status: 'granted', prompted: true }) } })
    try {
      await start()
      expect(voice.state.error?.key).toBe('mic-authorized')
      expect(types()).toEqual([])
      expect(openMicCapture).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('hold-tap: a quick tap locks hands-free until the next press', async () => {
    settings.setVoiceRecordingMode('hold-tap')
    await start()
    vi.advanceTimersByTime(TAP_LOCK_MS - 100)
    keyup({ key: 'm', code: 'KeyM' })
    vi.advanceTimersByTime(RELEASE_TAIL_MS * 4)
    await settle()
    expect(voice.state.phase).toBe('recording')
    expect(voice.state.handsFree).toBe(true)
    // Hands-free ignores blur and further keyups.
    window.dispatchEvent(new Event('blur'))
    keyup({ key: 'Control' })
    await settle()
    expect(voice.state.phase).toBe('recording')
    expect(executeCommand('workbench.action.holdToTalk')).toBe(true)
    vi.advanceTimersByTime(RELEASE_TAIL_MS)
    await settle()
    expect(inserted).toHaveLength(1)
    expect(types()).toEqual(['voice.start', 'voice.chunk', 'voice.stop'])
  })

  it('hold-tap: a real hold is push-to-talk', async () => {
    settings.setVoiceRecordingMode('hold-tap')
    await start()
    vi.advanceTimersByTime(TAP_LOCK_MS + 200)
    keyup({ key: 'm', code: 'KeyM', ctrlKey: true, altKey: true })
    vi.advanceTimersByTime(RELEASE_TAIL_MS)
    await settle()
    expect(inserted).toHaveLength(1)
    expect(voice.state.handsFree).toBe(false)
  })

  it('toggle: press starts hands-free, key repeat and keyups do nothing, the next press stops', async () => {
    settings.setVoiceRecordingMode('toggle')
    await start()
    expect(voice.state.handsFree).toBe(true)
    expect(voice.state.capEndsAt - Date.now()).toBe(HANDS_FREE_MAX_MS)
    // Key repeat of the starting press: with no keyup seen yet the command
    // cannot tell it from a fresh press, so it declines and the armed keydown
    // listener, which sees `repeat`, swallows it.
    expect(executeCommand('workbench.action.holdToTalk')).toBe(false)
    const repeat = new KeyboardEvent('keydown', { key: 'µ', code: 'KeyM', ctrlKey: true, altKey: true, repeat: true, cancelable: true })
    window.dispatchEvent(repeat)
    expect(repeat.defaultPrevented).toBe(true)
    await settle()
    expect(voice.state.phase).toBe('recording')
    vi.advanceTimersByTime(5_000)
    keyup({ key: 'm', code: 'KeyM' })
    keyup({ key: 'Control' })
    vi.advanceTimersByTime(RELEASE_TAIL_MS)
    await settle()
    expect(voice.state.phase).toBe('recording')
    executeCommand('workbench.action.holdToTalk')
    vi.advanceTimersByTime(RELEASE_TAIL_MS)
    await settle()
    expect(inserted).toHaveLength(1)
  })

  it('toggle: Esc cancels the take', async () => {
    settings.setVoiceRecordingMode('toggle')
    await start()
    const esc = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    window.dispatchEvent(esc)
    await settle()
    expect(esc.defaultPrevented).toBe(true)
    expect(voice.state.phase).toBe('idle')
    expect(types().at(-1)).toBe('voice.cancel')
    // The next press starts a fresh take.
    executeCommand('workbench.action.holdToTalk')
    await settle()
    expect(voice.state.phase).toBe('recording')
  })

  const keydown = (init: KeyboardEventInit): KeyboardEvent => {
    const e = new KeyboardEvent('keydown', { cancelable: true, ...init })
    window.dispatchEvent(e)
    return e
  }

  it('toggle: Enter while recording ends the take and sends the text; Enter after it is the CLI\'s', async () => {
    settings.setVoiceRecordingMode('toggle')
    await start()
    expect(keydown({ key: 'Enter' }).defaultPrevented).toBe(true)
    vi.advanceTimersByTime(RELEASE_TAIL_MS)
    await settle()
    expect(inserted).toEqual([{ paneId: 'pane-a', text: '列出所有測試' }])
    expect(submits).toEqual([true])
    expect(voice.state.phase).toBe('idle')
    // Straight to the pane: never the messaging queue.
    messaging.pump()
    await settle()
    expect(delivered).toEqual([])
    expect(keydown({ key: 'Enter' }).defaultPrevented).toBe(false)
    expect(submits).toEqual([true])
  })

  it('an Enter the pane could not press shows "not sent" on the capsule, and Enter is the CLI\'s again', async () => {
    settings.setVoiceRecordingMode('toggle')
    enterWent = false
    await start()
    keydown({ key: 'Enter' })
    vi.advanceTimersByTime(RELEASE_TAIL_MS)
    await settle()
    expect(inserted).toEqual([{ paneId: 'pane-a', text: '列出所有測試' }])
    expect(voice.state.phase).toBe('error')
    expect(voice.state.error?.key).toBe('not-sent')
    expect(i18n.global.t('voice.error.not-sent')).not.toBe('voice.error.not-sent')
    // The user's own Enter now sends what is in the box.
    expect(keydown({ key: 'Enter' }).defaultPrevented).toBe(false)
  })

  it('hold: Enter while the chord is still held sends the take too', async () => {
    await start()
    expect(keydown({ key: 'Enter' }).defaultPrevented).toBe(true)
    // The chord's later keyup is no longer followed.
    keyup({ key: 'm', code: 'KeyM' })
    vi.advanceTimersByTime(RELEASE_TAIL_MS)
    await settle()
    expect(submits).toEqual([true])
  })

  it('Enter while transcribing is taken and sends the text once it lands', async () => {
    await start()
    keyup({ key: 'm', code: 'KeyM' })
    vi.advanceTimersByTime(RELEASE_TAIL_MS)
    expect(voice.state.phase).toBe('transcribing')
    expect(keydown({ key: 'Enter' }).defaultPrevented).toBe(true)
    await settle()
    expect(submits).toEqual([true])
  })

  it('Enter while the take is still starting ends it once the mic opens, then sends', async () => {
    settings.setVoiceRecordingMode('toggle')
    let opened!: () => void
    openMicCapture.mockImplementationOnce((onChunk: (pcm: Int16Array) => void) =>
      new Promise((r) => { opened = () => r({ flush: async () => { onChunk(Int16Array.from([1, 2])) }, close: () => {} }) }))
    settings.setVoiceInputEnabled(true)
    await nextTick()
    executeCommand('workbench.action.holdToTalk')
    await settle()
    expect(voice.state.phase).toBe('starting')
    expect(keydown({ key: 'Enter' }).defaultPrevented).toBe(true)
    opened()
    await settle()
    vi.advanceTimersByTime(RELEASE_TAIL_MS)
    await settle()
    expect(submits).toEqual([true])
  })

  it('a take ended with the shortcut is inserted without sending; Esc still cancels', async () => {
    settings.setVoiceRecordingMode('toggle')
    await start()
    keyup({ key: 'm', code: 'KeyM' })
    executeCommand('workbench.action.holdToTalk')
    vi.advanceTimersByTime(RELEASE_TAIL_MS)
    await settle()
    expect(submits).toEqual([false])
    executeCommand('workbench.action.holdToTalk')
    await settle()
    expect(keydown({ key: 'Escape' }).defaultPrevented).toBe(true)
    await settle()
    expect(voice.state.phase).toBe('idle')
    expect(submits).toEqual([false])
  })

  it('no speech or a silent mic sends nothing', async () => {
    settings.setVoiceRecordingMode('toggle')
    for (const extra of [{ peak: 900 }, { peak: 0 }]) {
      stopBody = { ok: true, text: '', durationMs: 1500, ...extra }
      await start()
      keydown({ key: 'Enter' })
      vi.advanceTimersByTime(RELEASE_TAIL_MS)
      await settle()
      expect(voice.state.phase).toBe('error')
      expect(voice.state.error?.key).toBe(extra.peak ? 'no-speech' : 'mic-silent')
      voice.dismiss()
    }
    expect(submits).toEqual([])
  })

  it('an Enter confirming an IME candidate, or with a modifier, is left alone', async () => {
    settings.setVoiceRecordingMode('toggle')
    await start()
    expect(keydown({ key: 'Enter', isComposing: true }).defaultPrevented).toBe(false)
    expect(keydown({ key: 'Enter', keyCode: 229 }).defaultPrevented).toBe(false)
    for (const mod of ['shiftKey', 'ctrlKey', 'altKey', 'metaKey']) {
      expect(keydown({ key: 'Enter', [mod]: true }).defaultPrevented).toBe(false)
    }
    vi.advanceTimersByTime(RELEASE_TAIL_MS)
    await settle()
    expect(voice.state.phase).toBe('recording')
    expect(inserted).toEqual([])
  })

  it('Enter in another pane stays that pane\'s', async () => {
    settings.setVoiceRecordingMode('toggle')
    await start()
    focused = 'pane-c'
    expect(keydown({ key: 'Enter' }).defaultPrevented).toBe(false)
    vi.advanceTimersByTime(RELEASE_TAIL_MS)
    await settle()
    expect(voice.state.phase).toBe('recording')
  })

  it('setting OFF or no take: Enter is never taken', async () => {
    expect(keydown({ key: 'Enter' }).defaultPrevented).toBe(false)
    settings.setVoiceInputEnabled(true)
    await nextTick()
    expect(keydown({ key: 'Enter' }).defaultPrevented).toBe(false)
    expect(inserted).toEqual([])
  })

  it('pre-warms only while the setting is on: at switch-on and on focus (throttled); switching off shuts down', async () => {
    window.dispatchEvent(new Event('focus'))
    await settle()
    expect(sent).toEqual([])
    settings.setVoiceInputEnabled(true)
    await nextTick()
    expect(sent.map((s) => s.type)).toEqual(['voice.prewarm'])
    window.dispatchEvent(new Event('focus'))
    expect(sent).toHaveLength(1)
    vi.advanceTimersByTime(60_000)
    window.dispatchEvent(new Event('focus'))
    expect(sent.map((s) => s.type)).toEqual(['voice.prewarm', 'voice.prewarm'])
    settings.setVoiceInputEnabled(false)
    await nextTick()
    expect(sent.at(-1)?.type).toBe('voice.shutdown')
    vi.advanceTimersByTime(60_000)
    window.dispatchEvent(new Event('focus'))
    await settle()
    expect(sent.at(-1)?.type).toBe('voice.shutdown')
    expect(sent).toHaveLength(3)
  })

  it('toggle: a take stopped by the cap is inserted, never sent', async () => {
    settings.setVoiceRecordingMode('toggle')
    await start()
    vi.advanceTimersByTime(HANDS_FREE_MAX_MS)
    await settle()
    expect(inserted).toEqual([{ paneId: 'pane-a', text: '列出所有測試' }])
    expect(voice.state.phase).toBe('idle')
    messaging.pump()
    await settle()
    expect(delivered).toEqual([])
  })

  it('says once, without a modal, that a pre-warm failed; a later success re-arms it', async () => {
    i18n.global.locale.value = 'en-US'
    prewarmBody = { ok: false, reason: 'model-missing' }
    settings.setVoiceInputEnabled(true)
    await settle()
    expect(hints).toEqual(['Voice input is not ready: Speech model not downloaded — Settings → General → Voice input'])
    vi.advanceTimersByTime(60_000)
    window.dispatchEvent(new Event('focus'))
    await settle()
    expect(hints).toHaveLength(1)
    prewarmBody = { ok: true }
    vi.advanceTimersByTime(60_000)
    window.dispatchEvent(new Event('focus'))
    await settle()
    prewarmBody = { ok: false, reason: 'model-missing' }
    vi.advanceTimersByTime(60_000)
    window.dispatchEvent(new Event('focus'))
    await settle()
    expect(hints).toHaveLength(2)
  })

  it('a pre-warm answered "disabled" (switched off while loading) is not a failure', async () => {
    prewarmBody = { ok: false, reason: 'disabled' }
    settings.setVoiceInputEnabled(true)
    await settle()
    expect(hints).toEqual([])
  })
})

describe('hold-to-talk default binding', () => {
  it('is gated on a positive voiceInput context and collides with no other default', () => {
    const rule = defaults.find((r) => r.command === 'workbench.action.holdToTalk')!
    expect(rule.when?.split('&&').map((t) => t.trim())).toContain('voiceInput')
    const key = canonicalizeKeySpec(rule.key)
    const clashes = defaults.filter((r) => r !== rule && r.key.split(/\s+/).some((seg) => canonicalizeKeySpec(seg) === key))
    expect(clashes).toEqual([])
    expect(key).not.toContain('cmd')
  })
})

describe('isChordKeyUp', () => {
  const chord = parseKeySpec('ctrl+alt+m')
  const up = (init: KeyboardEventInit) => new KeyboardEvent('keyup', init)

  it('matches the main key (also as Option+letter), its modifiers, and a missed modifier', () => {
    expect(isChordKeyUp(up({ key: 'µ', code: 'KeyM', ctrlKey: true, altKey: true }), chord)).toBe(true)
    expect(isChordKeyUp(up({ key: 'Control', altKey: true }), chord)).toBe(true)
    expect(isChordKeyUp(up({ key: 'Alt', ctrlKey: true }), chord)).toBe(true)
    // Shift is not in the chord; x with the chord still down is unrelated.
    expect(isChordKeyUp(up({ key: 'Shift', ctrlKey: true, altKey: true }), chord)).toBe(false)
    expect(isChordKeyUp(up({ key: 'x', code: 'KeyX', ctrlKey: true, altKey: true }), chord)).toBe(false)
    // x arriving with Ctrl already up: Ctrl's own keyup was missed.
    expect(isChordKeyUp(up({ key: 'x', code: 'KeyX', altKey: true }), chord)).toBe(true)
  })

  it('follows a rebinding', () => {
    const rebound = parseKeySpec('shift+f5')
    expect(isChordKeyUp(up({ key: 'F5', shiftKey: true }), rebound)).toBe(true)
    expect(isChordKeyUp(up({ key: 'Shift' }), rebound)).toBe(true)
    expect(isChordKeyUp(up({ key: 'Control', shiftKey: true }), rebound)).toBe(false)
  })
})
