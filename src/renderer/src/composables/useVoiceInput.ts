import { computed, reactive, watch, type WatchStopHandle } from 'vue'
import type { MessageHold, MessageReason, MessageStatus } from './useAgentMessaging'
import type { VoiceCapture } from '../voice/micCapture'
import { int16ToBase64 } from '../voice/pcm'

/**
 * Hold-to-talk voice input for CLI panes.
 *
 * Press the hotkey → the focused CLI pane at that instant becomes the target,
 * the mic opens and ~250 ms s16le chunks stream to the backend (voice.chunk).
 * Release → voice.stop returns the transcript, which sits in a capsule on the
 * target pane for COUNTDOWN_MS so Esc can still drop it, and is then handed to
 * the ordinary messaging queue as bare text (see VoiceDeps.deliver).
 *
 * Inert while the setting is off: every entry point checks `enabled()` first,
 * so no mic, no voice.* request and no listener runs.
 */

export const COUNTDOWN_MS = 1_500
export const MAX_RECORDING_MS = 60_000
/** How long an error or "nothing heard" capsule stays up on its own. */
export const ERROR_VISIBLE_MS = 4_000
const START_TIMEOUT_MS = 30_000
const STOP_TIMEOUT_MS = 60_000
const CANCEL_TIMEOUT_MS = 5_000
/** voice.chunk has no reply; the request is only kept briefly before being dropped. */
const CHUNK_TIMEOUT_MS = 1_000

export type VoicePhase =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'transcribing'
  | 'countdown'
  | 'delivering'
  | 'held'
  | 'error'

export interface VoiceCapsuleState {
  phase: VoicePhase
  paneId: string | null
  /** The transcript, from `countdown` on. */
  text: string
  /** Wall-clock time the countdown ends, while phase === 'countdown'. */
  countdownEndsAt: number
  /** Why the message is still queued, while phase === 'held'. */
  hold: MessageHold | null
  /** i18n key under `voice.error.` (or a messaging reason), while phase === 'error'. */
  error: { key: string; params?: Record<string, string | number>; reason?: MessageReason } | null
}

/** The `voice.error.*` codes the capsule has a sentence for: target refusals,
 *  mic/backend failures, and `start-<reason>` / `stop-<reason>` for every
 *  reason voice.start / voice.stop can answer with. */
export const VOICE_ERROR_CODES = [
  'pane-asleep',
  'not-cli',
  'mic-denied',
  'mic-failed',
  'backend',
  'no-speech',
  'start-sidecar-missing',
  'start-model-missing',
  'start-sidecar-failed',
  'start-busy',
  'start-failed',
  'stop-no-session',
  'stop-sidecar-failed',
  'stop-transcribe-failed',
  'stop-failed',
] as const

/** i18n key for an error code; a reason this build does not know (a newer
 *  backend) falls back to the generic sentence, which names the code. */
export function voiceErrorI18nKey(code: string): string {
  return (VOICE_ERROR_CODES as readonly string[]).includes(code) ? `voice.error.${code}` : 'voice.error.generic'
}

export interface VoiceResponse<T> {
  ok: boolean
  payload: T | null
}

export type VoiceTarget =
  | { ok: true; name: string }
  | { ok: false; reason: 'asleep' | 'not-cli' }

export interface DeliveredMessageView {
  status: MessageStatus
  hold?: MessageHold
  reason?: MessageReason
}

export interface VoiceDeps {
  enabled: () => boolean
  request: <T>(type: string, payload: Record<string, unknown>, timeoutMs: number) => Promise<VoiceResponse<T>>
  /** macOS mic consent; true elsewhere. */
  askMicrophone: () => Promise<boolean>
  openCapture: (onChunk: (pcm: Int16Array) => void) => Promise<VoiceCapture>
  /** Whether a pane can take a voice message right now. */
  resolveTarget: (paneId: string) => VoiceTarget
  /** Queue `text` for `name` as bare text; returns the log row's id. */
  deliver: (name: string, text: string) => number
  /** Live view of a queued row (reactive), or undefined once it left the log. */
  messageView: (id: number) => DeliveredMessageView | undefined
  cancelMessage: (id: number) => boolean
  /** Called when a voice message reached its pane (readback bookkeeping). */
  onDelivered?: (paneId: string) => void
  now?: () => number
}

interface StartResult { ok?: boolean; sessionId?: string; reason?: string }
interface StopResult { ok?: boolean; text?: string; reason?: string }

export function useVoiceInput(deps: VoiceDeps) {
  const now = deps.now ?? (() => Date.now())
  const state = reactive<VoiceCapsuleState>({
    phase: 'idle',
    paneId: null,
    text: '',
    countdownEndsAt: 0,
    hold: null,
    error: null,
  })
  const visible = computed(() => state.phase !== 'idle')

  // One take at a time; `take` identifies it so a late async answer for an
  // abandoned take cannot touch the state of the next one.
  let take = 0
  let sessionId: string | null = null
  let capture: VoiceCapture | null = null
  let seq = 0
  let released = false
  let messageId: number | null = null
  let stopWatch: WatchStopHandle | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let maxTimer: ReturnType<typeof setTimeout> | null = null

  function clearTimer(): void {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  function reset(): void {
    clearTimer()
    if (maxTimer !== null) clearTimeout(maxTimer)
    maxTimer = null
    stopWatch?.()
    stopWatch = null
    messageId = null
    capture?.close()
    capture = null
    sessionId = null
    state.phase = 'idle'
    state.paneId = null
    state.text = ''
    state.countdownEndsAt = 0
    state.hold = null
    state.error = null
  }

  function fail(key: string, params?: Record<string, string | number>, reason?: MessageReason): void {
    const paneId = state.paneId
    const sid = sessionId
    reset()
    if (sid) void deps.request('voice.cancel', { sessionId: sid }, CANCEL_TIMEOUT_MS).catch(() => {})
    take++
    state.phase = 'error'
    state.paneId = paneId
    state.error = { key, params, reason }
    timer = setTimeout(() => {
      if (state.phase === 'error') reset()
    }, ERROR_VISIBLE_MS)
  }

  function sendChunk(pcm: Int16Array, sid: string): void {
    if (pcm.length === 0) return
    void deps
      .request('voice.chunk', { sessionId: sid, seq: seq++, pcm: int16ToBase64(pcm) }, CHUNK_TIMEOUT_MS)
      .catch(() => {})
  }

  /**
   * Hotkey pressed. Returns true when the press was consumed. Key repeat while
   * a take is already running is consumed and ignored.
   */
  function press(paneId: string | null): boolean {
    if (!deps.enabled()) return false
    if (state.phase === 'starting' || state.phase === 'recording' || state.phase === 'transcribing') return true
    if (!paneId) return false
    // A transcript still counting down goes out now rather than being lost to
    // the new take; a held one stays in its queue either way.
    if (state.phase === 'countdown') deliverNow()
    reset()
    const target = deps.resolveTarget(paneId)
    if (!target.ok) {
      state.paneId = paneId
      fail(target.reason === 'asleep' ? 'pane-asleep' : 'not-cli')
      return true
    }
    const mine = ++take
    released = false
    seq = 0
    state.phase = 'starting'
    state.paneId = paneId
    void begin(mine)
    return true
  }

  async function begin(mine: number): Promise<void> {
    let granted = false
    try {
      granted = await deps.askMicrophone()
    } catch {
      granted = false
    }
    if (mine !== take) return
    if (!granted) return fail('mic-denied')

    let res: VoiceResponse<StartResult>
    try {
      res = await deps.request<StartResult>('voice.start', {}, START_TIMEOUT_MS)
    } catch {
      if (mine === take) fail('backend')
      return
    }
    const sid = res.payload?.sessionId
    if (!res.ok || !res.payload?.ok || !sid) {
      if (mine === take) fail(`start-${res.payload?.reason ?? 'failed'}`)
      else if (sid) void deps.request('voice.cancel', { sessionId: sid }, CANCEL_TIMEOUT_MS).catch(() => {})
      return
    }
    if (mine !== take) {
      void deps.request('voice.cancel', { sessionId: sid }, CANCEL_TIMEOUT_MS).catch(() => {})
      return
    }
    sessionId = sid

    let cap: VoiceCapture
    try {
      cap = await deps.openCapture((pcm) => sendChunk(pcm, sid))
    } catch (err) {
      if (mine === take) fail('mic-failed', { error: err instanceof Error ? err.message : String(err) })
      else void deps.request('voice.cancel', { sessionId: sid }, CANCEL_TIMEOUT_MS).catch(() => {})
      return
    }
    if (mine !== take) {
      cap.close()
      return
    }
    capture = cap
    state.phase = 'recording'
    maxTimer = setTimeout(() => {
      if (mine === take && state.phase === 'recording') void finish(mine)
    }, MAX_RECORDING_MS)
    if (released) void finish(mine)
  }

  /** Hotkey released. */
  function release(): void {
    if (state.phase === 'starting') released = true
    else if (state.phase === 'recording') void finish(take)
  }

  async function finish(mine: number): Promise<void> {
    const sid = sessionId
    const cap = capture
    if (!sid || !cap) return
    if (maxTimer !== null) clearTimeout(maxTimer)
    maxTimer = null
    state.phase = 'transcribing'
    await cap.flush()
    cap.close()
    if (capture === cap) capture = null
    if (mine !== take) return

    let res: VoiceResponse<StopResult>
    try {
      res = await deps.request<StopResult>('voice.stop', { sessionId: sid, language: 'zh' }, STOP_TIMEOUT_MS)
    } catch {
      if (mine === take) fail('backend')
      return
    }
    if (mine !== take) return
    sessionId = null
    if (!res.ok || !res.payload?.ok) return fail(`stop-${res.payload?.reason ?? 'failed'}`)
    const text = (res.payload.text ?? '').trim()
    if (!text) return fail('no-speech')
    state.text = text
    state.phase = 'countdown'
    state.countdownEndsAt = now() + COUNTDOWN_MS
    timer = setTimeout(() => {
      if (mine === take && state.phase === 'countdown') deliverNow()
    }, COUNTDOWN_MS)
  }

  function deliverNow(): void {
    clearTimer()
    const paneId = state.paneId
    const text = state.text
    if (!paneId || !text) return reset()
    // Re-checked: the pane may have closed or been reclaimed since key-down.
    const target = deps.resolveTarget(paneId)
    if (!target.ok) return fail(target.reason === 'asleep' ? 'pane-asleep' : 'not-cli')
    const id = deps.deliver(target.name, text)
    const mine = take
    messageId = id
    state.phase = 'delivering'
    const view = (): DeliveredMessageView | undefined => {
      const m = deps.messageView(id)
      return m ? { status: m.status, hold: m.hold ? { ...m.hold } : undefined, reason: m.reason } : undefined
    }
    const apply = (m: DeliveredMessageView | undefined): void => {
      if (mine !== take || messageId !== id) return
      if (!m || m.status === 'cancelled') return reset()
      if (m.status === 'delivered') {
        deps.onDelivered?.(paneId)
        return reset()
      }
      if (m.status === 'failed') return fail('delivery', undefined, m.reason)
      if (m.status === 'queued' && m.hold) {
        state.phase = 'held'
        state.hold = m.hold
      } else {
        state.phase = 'delivering'
        state.hold = null
      }
    }
    // Applied once up front: a send can be refused on the spot (rate limit,
    // queue cap), and a row that settled here needs no watcher at all.
    apply(view())
    if (messageId === id) stopWatch = watch(view, apply, { deep: true })
  }

  /**
   * Esc. Only the short-lived states own it: a take being recorded or
   * transcribed, a transcript counting down, and a transcript being typed in
   * (eaten there without effect — an Esc reaching the CLI mid-injection would
   * interrupt it). `held` and `error` can sit on screen for minutes while the
   * pane is busy, and Esc is how the user interrupts a busy CLI, so there it is
   * left alone: withdraw() and dismiss() are the capsule's own buttons.
   * Returns true when the key was the capsule's.
   */
  function cancel(): boolean {
    switch (state.phase) {
      case 'delivering':
        return true
      case 'countdown':
        break
      case 'starting':
      case 'recording':
      case 'transcribing':
        if (sessionId) void deps.request('voice.cancel', { sessionId }, CANCEL_TIMEOUT_MS).catch(() => {})
        break
      default:
        return false
    }
    take++
    reset()
    return true
  }

  /** The capsule's withdraw button: take a held message back out of the queue. */
  function withdraw(): void {
    if (state.phase !== 'held') return
    if (messageId !== null) deps.cancelMessage(messageId)
    take++
    reset()
  }

  /** The capsule's close button on an error (it also times out on its own). */
  function dismiss(): void {
    if (state.phase === 'error') reset()
  }

  /** The setting went off (or the window is going away): drop any take. */
  function disable(): void {
    if (state.phase === 'idle') return
    if (sessionId) void deps.request('voice.cancel', { sessionId }, CANCEL_TIMEOUT_MS).catch(() => {})
    take++
    reset()
  }

  return { state, visible, press, release, cancel, withdraw, dismiss, disable }
}

export type VoiceInput = ReturnType<typeof useVoiceInput>
