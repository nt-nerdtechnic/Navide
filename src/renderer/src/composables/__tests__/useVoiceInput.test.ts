import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, reactive } from 'vue'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  COUNTDOWN_MS,
  VOICE_ERROR_CODES,
  voiceErrorI18nKey,
  ERROR_VISIBLE_MS,
  MAX_RECORDING_MS,
  HANDS_FREE_MAX_MS,
  RELEASE_TAIL_MS,
  useVoiceInput,
  type DeliveredMessageView,
  type VoiceDeps,
  type VoiceTarget,
} from '../useVoiceInput'

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await nextTick()
}

interface Harness {
  deps: VoiceDeps
  requests: Array<{ type: string; payload: Record<string, unknown> }>
  delivered: Array<{ name: string; text: string }>
  rows: Record<number, DeliveredMessageView>
  cancelled: number[]
  onChunk: ((pcm: Int16Array) => void) | null
  onEnded: (() => void) | null
  captureClosed: number
  enabled: boolean
  stopText: string
  targets: Record<string, VoiceTarget>
  noted: string[]
  logs: string[]
  stopExtra: Record<string, unknown>
}

function harness(): Harness {
  const h: Harness = {
    requests: [],
    delivered: [],
    rows: reactive({}) as Record<number, DeliveredMessageView>,
    cancelled: [],
    onChunk: null,
    onEnded: null,
    captureClosed: 0,
    enabled: true,
    stopText: '幫我跑測試',
    targets: { p1: { ok: true, name: 'claude-1' } },
    noted: [],
    logs: [],
    stopExtra: {},
    deps: null as unknown as VoiceDeps,
  }
  let nextId = 100
  h.deps = {
    enabled: () => h.enabled,
    request: async (type, payload) => {
      h.requests.push({ type, payload })
      if (type === 'voice.start') return { ok: true, payload: { ok: true, sessionId: 's1' } as never }
      if (type === 'voice.stop') {
        return { ok: true, payload: { ok: true, text: h.stopText, ms: 10, durationMs: 900, peak: 3000, ...h.stopExtra } as never }
      }
      return { ok: true, payload: { ok: true } as never }
    },
    askMicrophone: async () => ({ granted: true, prompted: false }),
    openCapture: async (onChunk, onEnded) => {
      h.onChunk = onChunk
      h.onEnded = onEnded
      return {
        flush: async () => { onChunk(Int16Array.from([7, 8])) },
        close: () => { h.captureClosed++ },
      }
    },
    resolveTarget: (paneId) => h.targets[paneId] ?? { ok: false, reason: 'not-cli' },
    deliver: (name, text) => {
      h.delivered.push({ name, text })
      const id = nextId++
      h.rows[id] = { status: 'queued' }
      return id
    },
    messageView: (id) => h.rows[id],
    cancelMessage: (id) => {
      h.cancelled.push(id)
      h.rows[id] = { status: 'cancelled' }
      return true
    },
    onDelivered: (paneId) => h.noted.push(paneId),
    log: (line) => h.logs.push(line),
  }
  return h
}

const types = (h: Harness): string[] => h.requests.map((r) => r.type)

/** Let go of the key and let the release tail run out. */
async function releaseAndStop(v: ReturnType<typeof useVoiceInput>, reason?: string): Promise<void> {
  v.release(reason)
  vi.advanceTimersByTime(RELEASE_TAIL_MS)
  await settle()
}

describe('useVoiceInput — capsule state machine', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('press → recording → release → transcribing → countdown → delivered', async () => {
    const h = harness()
    const v = useVoiceInput(h.deps)
    expect(v.press('p1')).toBe(true)
    expect(v.state.phase).toBe('starting')
    expect(v.state.paneId).toBe('p1')
    await settle()
    expect(v.state.phase).toBe('recording')

    h.onChunk!(Int16Array.from([1, 2, 3]))
    v.release()
    // The tail keeps recording for a moment after the key is let go.
    expect(v.state.phase).toBe('recording')
    vi.advanceTimersByTime(RELEASE_TAIL_MS - 1)
    expect(v.state.phase).toBe('recording')
    vi.advanceTimersByTime(1)
    expect(v.state.phase).toBe('transcribing')
    await settle()
    expect(v.state.phase).toBe('countdown')
    expect(v.state.text).toBe('幫我跑測試')
    expect(h.captureClosed).toBe(1)

    const chunks = h.requests.filter((r) => r.type === 'voice.chunk')
    expect(chunks.map((c) => c.payload.seq)).toEqual([0, 1])
    expect(chunks.every((c) => c.payload.sessionId === 's1' && typeof c.payload.pcm === 'string')).toBe(true)
    // The flushed tail went out before voice.stop.
    expect(types(h).indexOf('voice.stop')).toBeGreaterThan(types(h).lastIndexOf('voice.chunk'))
    expect(h.requests.find((r) => r.type === 'voice.stop')!.payload).toEqual({ sessionId: 's1', language: 'zh' })

    // Not delivered until the countdown runs out.
    vi.advanceTimersByTime(COUNTDOWN_MS - 1)
    expect(h.delivered).toEqual([])
    vi.advanceTimersByTime(1)
    expect(h.delivered).toEqual([{ name: 'claude-1', text: '幫我跑測試' }])
    expect(v.state.phase).toBe('delivering')

    h.rows[100] = { status: 'delivered' }
    await nextTick()
    expect(v.state.phase).toBe('idle')
    expect(v.visible.value).toBe(false)
    expect(h.noted).toEqual(['p1'])
  })

  it('a microphone unplugged mid-take ends it with an error, not a silent listen', async () => {
    const h = harness()
    const v = useVoiceInput(h.deps)
    v.press('p1', { handsFree: true })
    await settle()
    expect(v.state.phase).toBe('recording')
    h.onEnded?.()
    expect(v.state.phase).toBe('error')
    expect(v.state.error?.key).toBe('mic-disconnected')
    expect(h.captureClosed).toBe(1)
    expect(h.requests.at(-1)).toEqual({ type: 'voice.cancel', payload: { sessionId: 's1' } })
  })

  it('Esc during the countdown drops the transcript', async () => {
    const h = harness()
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    await releaseAndStop(v)
    expect(v.state.phase).toBe('countdown')
    expect(v.cancel()).toBe(true)
    expect(v.state.phase).toBe('idle')
    vi.advanceTimersByTime(COUNTDOWN_MS * 2)
    expect(h.delivered).toEqual([])
  })

  it('Esc while recording cancels the backend session and frees the mic', async () => {
    const h = harness()
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    expect(v.cancel()).toBe(true)
    expect(v.state.phase).toBe('idle')
    expect(h.captureClosed).toBe(1)
    expect(h.requests.at(-1)).toEqual({ type: 'voice.cancel', payload: { sessionId: 's1' } })
    // A late release does nothing.
    await releaseAndStop(v)
    expect(types(h)).not.toContain('voice.stop')
  })

  it('Esc while transcribing discards the result when it lands', async () => {
    const h = harness()
    let answer!: (v: unknown) => void
    const base = h.deps.request
    h.deps.request = (type, payload, t) =>
      type === 'voice.stop'
        ? new Promise((r) => { answer = r as never; h.requests.push({ type, payload }) })
        : base(type, payload, t)
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    await releaseAndStop(v)
    expect(v.state.phase).toBe('transcribing')
    expect(v.cancel()).toBe(true)
    answer({ ok: true, payload: { ok: true, text: 'late' } })
    await settle()
    expect(v.state.phase).toBe('idle')
    vi.advanceTimersByTime(COUNTDOWN_MS * 2)
    expect(h.delivered).toEqual([])
  })

  it('a held message shows its hold; Esc leaves it alone, the withdraw button takes it back', async () => {
    const h = harness()
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    await releaseAndStop(v)
    vi.advanceTimersByTime(COUNTDOWN_MS)
    h.rows[100] = { status: 'queued', hold: { key: 'typing' } }
    await nextTick()
    expect(v.state.phase).toBe('held')
    expect(v.state.hold).toEqual({ key: 'typing' })
    // Esc belongs to the busy CLI here (it is how the user interrupts it).
    expect(v.cancel()).toBe(false)
    expect(h.cancelled).toEqual([])
    expect(v.state.phase).toBe('held')
    v.withdraw()
    expect(h.cancelled).toEqual([100])
    expect(v.state.phase).toBe('idle')
  })

  it('a refused send shows the messaging reason as an error', async () => {
    const h = harness()
    const deliver = h.deps.deliver
    h.deps.deliver = (name, text) => {
      const id = deliver(name, text)
      h.rows[id] = { status: 'failed', reason: { key: 'rate-limit', params: { max: 5, seconds: 60 } } }
      return id
    }
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    await releaseAndStop(v)
    vi.advanceTimersByTime(COUNTDOWN_MS)
    expect(v.state.phase).toBe('error')
    expect(v.state.error?.reason?.key).toBe('rate-limit')
    vi.advanceTimersByTime(ERROR_VISIBLE_MS)
    expect(v.state.phase).toBe('idle')
  })

  it('Esc is swallowed but changes nothing while the text is being typed in', async () => {
    const h = harness()
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    await releaseAndStop(v)
    vi.advanceTimersByTime(COUNTDOWN_MS)
    h.rows[100] = { status: 'delivering' }
    await nextTick()
    expect(v.state.phase).toBe('delivering')
    expect(v.cancel()).toBe(true)
    expect(v.state.phase).toBe('delivering')
    expect(h.cancelled).toEqual([])
  })

  it('Esc is not taken by an error capsule or by no capsule; the close button and the timeout clear it', async () => {
    const h = harness()
    h.targets.p1 = { ok: false, reason: 'asleep' }
    const v = useVoiceInput(h.deps)
    expect(v.cancel()).toBe(false)
    v.press('p1')
    expect(v.state.phase).toBe('error')
    expect(v.cancel()).toBe(false)
    expect(v.state.phase).toBe('error')
    v.dismiss()
    expect(v.state.phase).toBe('idle')
    v.press('p1')
    vi.advanceTimersByTime(ERROR_VISIBLE_MS)
    expect(v.state.phase).toBe('idle')
  })

  it('refuses a sleeping (placeholder) pane without touching the mic or backend', async () => {
    const h = harness()
    h.targets.p2 = { ok: false, reason: 'asleep' }
    let micAsked = false
    h.deps.askMicrophone = async () => { micAsked = true; return { granted: true, prompted: false } }
    const v = useVoiceInput(h.deps)
    expect(v.press('p2')).toBe(true)
    await settle()
    expect(v.state.phase).toBe('error')
    expect(v.state.paneId).toBe('p2')
    expect(v.state.error?.key).toBe('pane-asleep')
    expect(micAsked).toBe(false)
    expect(h.requests).toEqual([])
  })

  it('re-checks the target before delivering: a pane reclaimed during the countdown is refused', async () => {
    const h = harness()
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    await releaseAndStop(v)
    h.targets.p1 = { ok: false, reason: 'asleep' }
    vi.advanceTimersByTime(COUNTDOWN_MS)
    expect(h.delivered).toEqual([])
    expect(v.state.error?.key).toBe('pane-asleep')
  })

  it('release before the mic is open still ends the take once it opens (after the tail)', async () => {
    const h = harness()
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await releaseAndStop(v)
    expect(v.state.phase).toBe('recording')
    expect(types(h)).not.toContain('voice.stop')
    vi.advanceTimersByTime(RELEASE_TAIL_MS)
    await settle()
    expect(types(h)).toContain('voice.stop')
    expect(v.state.phase).toBe('countdown')
  })

  it('key repeat is swallowed', async () => {
    const h = harness()
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    expect(v.press('p1')).toBe(true)
    expect(types(h).filter((t) => t === 'voice.start')).toHaveLength(1)
  })

  it('empty transcript and backend refusals end in an error, not a delivery', async () => {
    const h = harness()
    h.stopText = '   '
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    await releaseAndStop(v)
    expect(v.state.error?.key).toBe('no-speech')

    const h2 = harness()
    h2.deps.request = async (type) =>
      ({ ok: true, payload: type === 'voice.start' ? { ok: false, reason: 'model-missing' } : { ok: true } }) as never
    const v2 = useVoiceInput(h2.deps)
    v2.press('p1')
    await settle()
    expect(v2.state.error?.key).toBe('start-model-missing')
  })

  it('mic denial stops before voice.start', async () => {
    const h = harness()
    h.deps.askMicrophone = async () => ({ granted: false, prompted: false })
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    expect(v.state.error?.key).toBe('mic-denied')
    expect(types(h)).not.toContain('voice.start')
  })

  it('stops by itself at the 60 s cap', async () => {
    const h = harness()
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    vi.advanceTimersByTime(MAX_RECORDING_MS)
    await settle()
    expect(types(h)).toContain('voice.stop')
    expect(v.state.phase).toBe('countdown')
  })

  it('disable() drops a running take', async () => {
    const h = harness()
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    v.disable()
    expect(v.state.phase).toBe('idle')
    expect(h.captureClosed).toBe(1)
    expect(types(h)).toContain('voice.cancel')
  })

  it('setting OFF: press declines and nothing runs', async () => {
    const h = harness()
    h.enabled = false
    let captured = false
    h.deps.openCapture = async () => { captured = true; throw new Error('no') }
    const v = useVoiceInput(h.deps)
    expect(v.press('p1')).toBe(false)
    await settle()
    expect(v.state.phase).toBe('idle')
    expect(h.requests).toEqual([])
    expect(captured).toBe(false)
  })
})

describe('useVoiceInput — capture during start-up, endings and diagnostics', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  const samples = (b64: unknown): number[] => {
    const buf = Buffer.from(String(b64), 'base64')
    return Array.from({ length: buf.length / 2 }, (_, i) => buf.readInt16LE(i * 2))
  }

  /** voice.start answers only when `answer` is called. */
  function slowStart(h: Harness): (reply?: Record<string, unknown>) => void {
    let answer!: (v: unknown) => void
    const base = h.deps.request
    h.deps.request = (type, payload, t) => {
      if (type !== 'voice.start') return base(type, payload, t)
      h.requests.push({ type, payload })
      return new Promise((r) => { answer = r as never })
    }
    return (reply = { ok: true, sessionId: 's1' }) => answer({ ok: true, payload: reply })
  }

  it('opens the mic before voice.start answers and flushes the early chunks in order', async () => {
    const h = harness()
    const answer = slowStart(h)
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    // Recording while the sidecar is still loading.
    expect(v.state.phase).toBe('recording')
    h.onChunk!(Int16Array.from([1, 1]))
    h.onChunk!(Int16Array.from([2, 2]))
    expect(types(h)).toEqual(['voice.start'])
    answer()
    await settle()
    h.onChunk!(Int16Array.from([3, 3]))
    const chunks = h.requests.filter((r) => r.type === 'voice.chunk')
    expect(chunks.map((c) => c.payload.seq)).toEqual([0, 1, 2])
    expect(chunks.map((c) => samples(c.payload.pcm))).toEqual([[1, 1], [2, 2], [3, 3]])
    expect(chunks.every((c) => c.payload.sessionId === 's1')).toBe(true)
  })

  it('a release while the sidecar is still loading sends the buffered audio and the tail, then stops', async () => {
    const h = harness()
    const answer = slowStart(h)
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    h.onChunk!(Int16Array.from([5]))
    await releaseAndStop(v)
    expect(v.state.phase).toBe('transcribing')
    expect(types(h)).toEqual(['voice.start'])
    answer()
    await settle()
    // Early chunk, the flushed tail, then stop.
    expect(types(h)).toEqual(['voice.start', 'voice.chunk', 'voice.chunk', 'voice.stop'])
    expect(v.state.phase).toBe('countdown')
  })

  it('a failed voice.start after the mic opened frees the mic', async () => {
    const h = harness()
    const answer = slowStart(h)
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    answer({ ok: false, reason: 'sidecar-failed' })
    await settle()
    expect(v.state.error?.key).toBe('start-sidecar-failed')
    expect(h.captureClosed).toBe(1)
  })

  it('an abandoned start is cancelled once it answers', async () => {
    const h = harness()
    const answer = slowStart(h)
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    expect(v.cancel()).toBe(true)
    answer()
    await settle()
    expect(h.requests.at(-1)).toEqual({ type: 'voice.cancel', payload: { sessionId: 's1' } })
  })

  it('silent input, no words and a slip of the key end three different ways', async () => {
    const silent = harness()
    silent.stopText = ''
    silent.stopExtra = { durationMs: 1500, peak: 0 }
    const v1 = useVoiceInput(silent.deps)
    v1.press('p1')
    await settle()
    await releaseAndStop(v1)
    expect(v1.state.error?.key).toBe('mic-silent')

    const quiet = harness()
    quiet.stopText = ''
    quiet.stopExtra = { durationMs: 1500, peak: 900 }
    const v2 = useVoiceInput(quiet.deps)
    v2.press('p1')
    await settle()
    await releaseAndStop(v2)
    expect(v2.state.error?.key).toBe('no-speech')

    const short = harness()
    short.stopText = ''
    short.stopExtra = { durationMs: 120, peak: 0 }
    const v3 = useVoiceInput(short.deps)
    v3.press('p1')
    await settle()
    await releaseAndStop(v3)
    expect(v3.state.phase).toBe('idle')
    expect(v3.state.error).toBeNull()
    expect(short.logs.at(-1)).toContain('outcome=too-short')
  })

  it('the press that showed the first-time mic dialog only authorises', async () => {
    const h = harness()
    h.deps.askMicrophone = async () => ({ granted: true, prompted: true })
    let opened = false
    h.deps.openCapture = async () => { opened = true; throw new Error('no') }
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    expect(v.state.phase).toBe('error')
    expect(v.state.error?.key).toBe('mic-authorized')
    expect(h.requests).toEqual([])
    expect(opened).toBe(false)
  })

  it('lock() turns a held take hands-free with the long cap; release then ends it', async () => {
    const h = harness()
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    expect(v.lock()).toBe(true)
    expect(v.state.handsFree).toBe(true)
    vi.advanceTimersByTime(MAX_RECORDING_MS + 1_000)
    await settle()
    expect(v.state.phase).toBe('recording')
    await releaseAndStop(v, 'toggle')
    expect(v.state.phase).toBe('countdown')
    expect(h.logs.at(-1)).toContain('end=toggle')
    expect(h.logs.at(-1)).toContain('mode=hands-free')
  })

  it('a hands-free take stops by itself at the 5 minute cap', async () => {
    const h = harness()
    const v = useVoiceInput(h.deps)
    v.press('p1', { handsFree: true })
    await settle()
    expect(v.state.capEndsAt - Date.now()).toBe(HANDS_FREE_MAX_MS)
    vi.advanceTimersByTime(HANDS_FREE_MAX_MS - 1)
    await settle()
    expect(v.state.phase).toBe('recording')
    vi.advanceTimersByTime(1)
    await settle()
    expect(v.state.phase).toBe('countdown')
    expect(h.logs.at(-1)).toContain('end=cap')
  })

  it('a capped hands-free transcript waits to be sent; the next press sends it and records nothing', async () => {
    const h = harness()
    const v = useVoiceInput(h.deps)
    v.press('p1', { handsFree: true })
    await settle()
    vi.advanceTimersByTime(HANDS_FREE_MAX_MS)
    await settle()
    expect(v.state.phase).toBe('countdown')
    expect(v.state.awaitingSend).toBe(true)
    vi.advanceTimersByTime(COUNTDOWN_MS * 10)
    await settle()
    expect(h.delivered).toEqual([])
    // Esc stays the CLI's while it waits.
    expect(v.cancel()).toBe(false)
    const starts = types(h).filter((t) => t === 'voice.start').length
    expect(v.press('p1')).toBe(true)
    expect(h.delivered).toEqual([{ name: 'claude-1', text: '幫我跑測試' }])
    expect(v.state.phase).toBe('delivering')
    await settle()
    expect(types(h).filter((t) => t === 'voice.start')).toHaveLength(starts)
  })

  it('the capsule sends or discards a capped transcript', async () => {
    const h = harness()
    const v = useVoiceInput(h.deps)
    v.press('p1', { handsFree: true })
    await settle()
    vi.advanceTimersByTime(HANDS_FREE_MAX_MS)
    await settle()
    v.dismiss()
    expect(v.state.phase).toBe('idle')
    expect(h.delivered).toEqual([])
    v.press('p1', { handsFree: true })
    await settle()
    vi.advanceTimersByTime(HANDS_FREE_MAX_MS)
    await settle()
    v.send()
    expect(h.delivered).toEqual([{ name: 'claude-1', text: '幫我跑測試' }])
  })

  it('a held take at its 60 s cap still sends after the countdown', async () => {
    const h = harness()
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    vi.advanceTimersByTime(MAX_RECORDING_MS)
    await settle()
    expect(v.state.awaitingSend).toBe(false)
    vi.advanceTimersByTime(COUNTDOWN_MS)
    await settle()
    expect(h.delivered).toEqual([{ name: 'claude-1', text: '幫我跑測試' }])
  })

  it('says so while the system default stands in for a missing chosen microphone', async () => {
    const h = harness()
    h.deps.openCapture = async () => ({ flush: async () => {}, close: () => {}, fellBack: true })
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    expect(v.state.phase).toBe('recording')
    expect(v.state.deviceFallback).toBe(true)
    v.cancel()
    expect(v.state.deviceFallback).toBe(false)
  })

  it('logs one line per take with timings, end reason, audio length and peak', async () => {
    const h = harness()
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    h.onChunk!(Int16Array.from({ length: 1600 }, (_, i) => (i === 3 ? -1234 : 10)))
    await releaseAndStop(v, 'keyup:KeyM')
    expect(h.logs).toHaveLength(1)
    const line = h.logs[0]
    expect(line).toMatch(/^\[voice\] outcome=text end=keyup:KeyM mode=hold mic=\d+ms capture=\d+ms session=\d+ms release=\d+ms stop=\d+ms /)
    // 1600 samples + the 2-sample flush at 16 kHz.
    expect(line).toContain('audio=100ms')
    expect(line).toContain('peak=1234')
    vi.advanceTimersByTime(COUNTDOWN_MS)
    expect(h.logs).toHaveLength(1)
  })

  it('shows the input level while recording', async () => {
    const h = harness()
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    expect(v.state.level).toBe(0)
    h.onChunk!(Int16Array.from({ length: 400 }, () => 8000))
    expect(v.state.level).toBeGreaterThan(0.5)
    h.onChunk!(Int16Array.from({ length: 400 }, () => 0))
    expect(v.state.level).toBe(0)
  })
})

describe('voice error sentences', () => {
  const locales = ['en-US', 'ja-JP', 'zh-TW'].map((l) => ({
    l,
    data: JSON.parse(
      readFileSync(join(process.cwd(), `packages/plugin-ui/src/foundation/i18n/locales/${l}.json`), 'utf-8'),
    ) as { voice: { error: Record<string, string> } },
  }))

  // Reasons each handler can answer with, read from the backend source so a
  // new reason there fails here instead of showing a bare code to the user.
  function backendReasons(fn: string): string[] {
    const src = readFileSync(join(process.cwd(), 'backend/agent_team_backend/voice_handlers.py'), 'utf-8')
    const start = src.indexOf(`async def ${fn}(`)
    const end = src.indexOf('\nasync def ', start + 1)
    const body = src.slice(start, end === -1 ? undefined : end)
    return [...body.matchAll(/"([a-z]+(?:-[a-z]+)*)"/g)]
      .map((m) => m[1])
      .filter((r) => body.includes(`"reason": "${r}"`) || body.includes(`"${r}" if`) || body.includes(`else "${r}"`))
  }

  it('covers every reason voice.start and voice.stop can return', () => {
    const start = backendReasons('voice_start')
    const stop = backendReasons('voice_stop')
    expect(start).toEqual(expect.arrayContaining(['sidecar-missing', 'model-missing', 'busy', 'sidecar-failed']))
    expect(stop).toEqual(expect.arrayContaining(['no-session', 'sidecar-failed', 'transcribe-failed']))
    for (const r of start) expect(voiceErrorI18nKey(`start-${r}`)).toBe(`voice.error.start-${r}`)
    for (const r of stop) expect(voiceErrorI18nKey(`stop-${r}`)).toBe(`voice.error.stop-${r}`)
  })

  it('has a sentence in every locale for every known code, plus the generic fallback', () => {
    for (const { l, data } of locales) {
      for (const code of [...VOICE_ERROR_CODES, 'generic']) {
        expect(data.voice.error[code], `${l}: voice.error.${code}`).toBeTruthy()
      }
      expect(data.voice.error.generic).toContain('{code}')
    }
  })

  it('an unknown reason falls back to the generic sentence', () => {
    expect(voiceErrorI18nKey('stop-something-new')).toBe('voice.error.generic')
  })
})
