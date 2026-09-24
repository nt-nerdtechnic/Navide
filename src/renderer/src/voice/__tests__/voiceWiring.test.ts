// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { canonicalizeKeySpec, defaults, executeCommand, getContext, parseKeySpec } from '@navide/plugin-ui/shared'
import {
  NOTICE_SENDER,
  _resetMessagingForTest,
  useAgentMessaging,
} from '../../composables/useAgentMessaging'
import { COUNTDOWN_MS, HANDS_FREE_MAX_MS, RELEASE_TAIL_MS } from '../../composables/useVoiceInput'
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
  let idle: boolean
  let prewarmBody: Record<string, unknown>
  let hints: string[]
  let scope: ReturnType<typeof effectScope>
  let voice: ReturnType<typeof setupVoiceInput>
  const messaging = useAgentMessaging()
  const settings = useVoiceSettings()

  beforeEach(() => {
    vi.useFakeTimers()
    _resetMessagingForTest()
    settings.setVoiceInputEnabled(false)
    settings.setVoiceReadbackEnabled(false)
    settings.setVoiceRecordingMode('hold')
    sent = []
    delivered = []
    idle = true
    prewarmBody = { ok: true }
    hints = []
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
    messaging.registerPane('pane-a', 'claude', 'claude-1')
    scope = effectScope()
    voice = scope.run(() =>
      setupVoiceInput({
        backend: {
          send: (async (type: string, payload: Record<string, unknown> = {}) => {
            sent.push({ type, payload })
            const body =
              type === 'voice.start' ? { ok: true, sessionId: 'S' }
              : type === 'voice.stop' ? { ok: true, text: '列出所有測試', ms: 5, durationMs: 800 }
              : type === 'voice.prewarm' ? prewarmBody
              : { ok: true }
            return { id: 'x', type: `${type}.result`, ok: true, payload: body, error: null, timestamp: '' }
          }) as never,
        },
        messaging,
        focusedPaneId: () => 'pane-a',
        paneInfo: (id) => (id === 'pane-a' ? { realized: true, messagingName: 'claude-1' } : { realized: false, messagingName: 'sleepy' }),
        paneLabel: (id) => id,
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

  it('setting ON: hold → release → countdown → bare text through the messaging queue', async () => {
    settings.setVoiceInputEnabled(true)
    await nextTick()
    expect(getContext().voiceInput).toBe(true)

    expect(executeCommand('workbench.action.holdToTalk')).toBe(true)
    await settle()
    expect(voice.state.phase).toBe('recording')
    // Key repeat while held is swallowed and starts nothing new.
    expect(executeCommand('workbench.action.holdToTalk')).toBe(true)

    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'm' }))
    vi.advanceTimersByTime(RELEASE_TAIL_MS)
    await settle()
    expect(voice.state.phase).toBe('countdown')
    expect(sent.map((s) => s.type)).toEqual(['voice.prewarm', 'voice.start', 'voice.chunk', 'voice.stop'])

    vi.advanceTimersByTime(COUNTDOWN_MS)
    await settle()
    const row = messaging.messages.value.at(-1)!
    expect(row.from).toBe(NOTICE_SENDER)
    expect(row.to).toBe('claude-1')
    expect(row.kind).toBe('notice')
    // Verbatim: no envelope, no correlation id, exactly what was said.
    expect(delivered).toEqual([{ paneId: 'pane-a', text: '列出所有測試' }])
    expect(row.status).toBe('delivered')
    expect(voice.state.phase).toBe('idle')
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
    vi.advanceTimersByTime(COUNTDOWN_MS)
    await settle()
    executeCommand('workbench.action.holdToTalk')
    await settle()
    expect(openMicCapture.mock.calls.at(-1)![1]).toBe('')
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'm' }))
    vi.advanceTimersByTime(RELEASE_TAIL_MS)
    await settle()
    vi.advanceTimersByTime(COUNTDOWN_MS)
    await settle()
    expect(voice.state.phase).toBe('idle')
  })

  it('a busy pane holds the message; Esc passes through to the CLI, the withdraw button takes it back', async () => {
    settings.setVoiceInputEnabled(true)
    await nextTick()
    idle = false
    executeCommand('workbench.action.holdToTalk')
    await settle()
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control' }))
    vi.advanceTimersByTime(RELEASE_TAIL_MS)
    await settle()
    vi.advanceTimersByTime(COUNTDOWN_MS)
    await settle()
    messaging.pump()
    await settle()
    expect(voice.state.phase).toBe('held')
    expect(voice.state.hold?.key).toBe('busy')

    const esc = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    window.dispatchEvent(esc)
    await settle()
    expect(esc.defaultPrevented).toBe(false)
    expect(voice.state.phase).toBe('held')
    expect(messaging.messages.value.at(-1)!.status).toBe('queued')

    voice.withdraw()
    await settle()
    expect(voice.state.phase).toBe('idle')
    expect(messaging.messages.value.at(-1)!.status).toBe('cancelled')
    idle = true
    messaging.pump()
    await settle()
    expect(delivered).toEqual([])
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
    expect(voice.state.phase).toBe('countdown')
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
      expect(voice.state.phase).toBe('countdown')
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
      expect(voice.state.phase).toBe('countdown')
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
    expect(voice.state.phase).toBe('countdown')
    expect(types()).toEqual(['voice.start', 'voice.chunk', 'voice.stop'])
  })

  it('hold-tap: a real hold is push-to-talk', async () => {
    settings.setVoiceRecordingMode('hold-tap')
    await start()
    vi.advanceTimersByTime(TAP_LOCK_MS + 200)
    keyup({ key: 'm', code: 'KeyM', ctrlKey: true, altKey: true })
    vi.advanceTimersByTime(RELEASE_TAIL_MS)
    await settle()
    expect(voice.state.phase).toBe('countdown')
    expect(voice.state.handsFree).toBe(false)
  })

  it('toggle: press starts hands-free, key repeat and keyups do nothing, the next press stops', async () => {
    settings.setVoiceRecordingMode('toggle')
    await start()
    expect(voice.state.handsFree).toBe(true)
    expect(voice.state.capEndsAt - Date.now()).toBe(HANDS_FREE_MAX_MS)
    // Key repeat of the starting press.
    expect(executeCommand('workbench.action.holdToTalk')).toBe(true)
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
    expect(voice.state.phase).toBe('countdown')
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

  it('toggle: a take stopped by the cap waits for a press to send it, and leaves Esc to the CLI', async () => {
    settings.setVoiceRecordingMode('toggle')
    await start()
    vi.advanceTimersByTime(HANDS_FREE_MAX_MS)
    await settle()
    expect(voice.state.phase).toBe('countdown')
    vi.advanceTimersByTime(COUNTDOWN_MS * 5)
    await settle()
    expect(delivered).toEqual([])
    const esc = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    window.dispatchEvent(esc)
    expect(esc.defaultPrevented).toBe(false)
    expect(voice.state.phase).toBe('countdown')
    expect(executeCommand('workbench.action.holdToTalk')).toBe(true)
    await settle()
    expect(delivered).toEqual([{ paneId: 'pane-a', text: '列出所有測試' }])
    expect(types().filter((t) => t === 'voice.start')).toHaveLength(1)
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

  it('readback speaks only after a voice message reached the pane', async () => {
    const speak = vi.fn()
    vi.stubGlobal('speechSynthesis', { cancel: vi.fn(), speak })
    vi.stubGlobal('SpeechSynthesisUtterance', class { lang = ''; constructor(public text: string) {} })
    settings.setVoiceInputEnabled(true)
    settings.setVoiceReadbackEnabled(true)
    await nextTick()
    voice.onTurnComplete('pane-a', 'Nothing voiced yet.')
    expect(speak).not.toHaveBeenCalled()

    executeCommand('workbench.action.holdToTalk')
    await settle()
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'm' }))
    vi.advanceTimersByTime(RELEASE_TAIL_MS)
    await settle()
    vi.advanceTimersByTime(COUNTDOWN_MS)
    await settle()
    voice.onTurnComplete('pane-a', 'All tests pass. 12 files changed.')
    expect(speak).toHaveBeenCalledTimes(1)
    expect((speak.mock.calls[0][0] as { text: string }).text).toBe('All tests pass. 12 files changed.')
    vi.unstubAllGlobals()
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
