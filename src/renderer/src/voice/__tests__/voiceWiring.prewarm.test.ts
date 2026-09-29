// @vitest-environment happy-dom
// Pre-warm timing against the backend socket: the window sets up before the
// socket is open, so the pre-warm must wait for it and re-run on reconnect and
// when the speech model finishes downloading.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref, type Ref } from 'vue'
import { useVoiceSettings } from '../voiceSettings'

vi.mock('../micCapture', () => ({ openMicCapture: vi.fn() }))

import { setupVoiceInput } from '../voiceWiring'

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await nextTick()
}

describe('voice wiring — pre-warm vs backend readiness', () => {
  const settings = useVoiceSettings()
  let sent: string[]
  let listeners: Map<string, (payload: unknown) => void>
  let status: Ref<string>
  let scope: ReturnType<typeof effectScope>

  beforeEach(() => {
    vi.useFakeTimers()
    settings.setVoiceInputEnabled(false)
    sent = []
    listeners = new Map()
    status = ref<string>('connecting')
    scope = effectScope()
  })
  afterEach(() => {
    scope.stop()
    settings.setVoiceInputEnabled(false)
    vi.useRealTimers()
  })

  function setup(): void {
    scope.run(() =>
      setupVoiceInput({
        backend: {
          send: (async (type: string) => {
            sent.push(type)
            return { id: 'x', type, ok: true, payload: { ok: true }, error: null, timestamp: '' }
          }) as never,
          on: (type: string, cb: (payload: unknown) => void) => {
            listeners.set(type, cb)
            return () => listeners.delete(type)
          },
          status,
        },
        focusedPaneId: () => null,
        paneInfo: () => undefined,
        insertText: () => false,
      }),
    )
  }

  it('enabled at launch, socket not open yet: nothing is sent until it connects, then one pre-warm', async () => {
    settings.setVoiceInputEnabled(true)
    setup()
    await settle()
    expect(sent).toEqual([])
    status.value = 'connected'
    await settle()
    expect(sent).toEqual(['voice.prewarm'])
  })

  it('a reconnect (restarted backend, no sidecar) pre-warms again; going down does not', async () => {
    settings.setVoiceInputEnabled(true)
    status.value = 'connected'
    setup()
    await settle()
    expect(sent).toEqual(['voice.prewarm'])
    status.value = 'disconnected'
    await settle()
    expect(sent).toHaveLength(1)
    status.value = 'connected'
    await settle()
    expect(sent).toEqual(['voice.prewarm', 'voice.prewarm'])
  })

  it('setting off: a connect sends nothing', async () => {
    setup()
    status.value = 'connected'
    await settle()
    expect(sent).toEqual([])
  })

  it('the model finishing its download pre-warms; progress and failures do not', async () => {
    settings.setVoiceInputEnabled(true)
    status.value = 'connected'
    setup()
    await settle()
    sent.length = 0
    const progress = listeners.get('voice.model.progress')!
    progress({ bytes: 10, total: 100, done: false })
    progress({ bytes: 10, total: 100, done: true, error: 'HTTP 403' })
    await settle()
    expect(sent).toEqual([])
    progress({ bytes: 100, total: 100, done: true })
    await settle()
    expect(sent).toEqual(['voice.prewarm'])
  })
})
