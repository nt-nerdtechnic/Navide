// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick } from 'vue'
import { canonicalizeKeySpec, defaults, executeCommand, getContext } from '@navide/plugin-ui/shared'
import {
  NOTICE_SENDER,
  _resetMessagingForTest,
  useAgentMessaging,
} from '../../composables/useAgentMessaging'
import { COUNTDOWN_MS } from '../../composables/useVoiceInput'
import { useVoiceSettings } from '../voiceSettings'

const openMicCapture = vi.fn()
vi.mock('../micCapture', () => ({ openMicCapture: (...a: unknown[]) => openMicCapture(...a) }))

import { setupVoiceInput } from '../voiceWiring'

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await nextTick()
}

describe('voice wiring', () => {
  let sent: Array<{ type: string; payload: Record<string, unknown> }>
  let delivered: Array<{ paneId: string; text: string }>
  let idle: boolean
  let scope: ReturnType<typeof effectScope>
  let voice: ReturnType<typeof setupVoiceInput>
  const messaging = useAgentMessaging()
  const settings = useVoiceSettings()

  beforeEach(() => {
    vi.useFakeTimers()
    _resetMessagingForTest()
    settings.setVoiceInputEnabled(false)
    settings.setVoiceReadbackEnabled(false)
    sent = []
    delivered = []
    idle = true
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
              : { ok: true }
            return { id: 'x', type: `${type}.result`, ok: true, payload: body, error: null, timestamp: '' }
          }) as never,
        },
        messaging,
        focusedPaneId: () => 'pane-a',
        paneInfo: (id) => (id === 'pane-a' ? { realized: true, messagingName: 'claude-1' } : { realized: false, messagingName: 'sleepy' }),
        paneLabel: (id) => id,
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
    await settle()
    expect(sent).toEqual([])
    expect(openMicCapture).not.toHaveBeenCalled()
    expect(add.mock.calls.filter(([t]) => t === 'keyup' || t === 'keydown')).toEqual([])
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
    await settle()
    expect(voice.state.phase).toBe('countdown')
    expect(sent.map((s) => s.type)).toEqual(['voice.start', 'voice.chunk', 'voice.stop'])

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

  it('a busy pane holds the message; Esc passes through to the CLI, the withdraw button takes it back', async () => {
    settings.setVoiceInputEnabled(true)
    await nextTick()
    idle = false
    executeCommand('workbench.action.holdToTalk')
    await settle()
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control' }))
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
    expect(sent.at(-1)?.type).toBe('voice.cancel')
    expect(getContext().voiceInput).toBe(false)
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
