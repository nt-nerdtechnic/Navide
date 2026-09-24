import { computed, reactive, watch, type WatchStopHandle } from 'vue'
import type { MessageHold, MessageReason, MessageStatus } from './useAgentMessaging'
import type { VoiceCapture } from '../voice/micCapture'
import { int16ToBase64 } from '../voice/pcm'

/**
 * Hold-to-talk voice input for CLI panes.
 *
 * Press the hotkey → the focused CLI pane at that instant becomes the target,
 * and the mic opens at once while voice.start (which may have to load the
 * sidecar) runs alongside; ~250 ms s16le chunks are kept locally until the
 * session id arrives, then stream to the backend (voice.chunk) in order.
 * Release → RELEASE_TAIL_MS more audio, then voice.stop returns the
 * transcript, which sits in a capsule on the target pane for COUNTDOWN_MS so
 * Esc can still drop it, and is then handed to the ordinary messaging queue as
 * bare text (see VoiceDeps.deliver).
 *
 * Inert while the setting is off: every entry point checks `enabled()` first,
 * so no mic, no voice.* request and no listener runs.
 */

export const COUNTDOWN_MS = 1_500
/** Cap of a held take. */
export const MAX_RECORDING_MS = 60_000
/** Cap of a hands-free take (quick-tap lock or toggle mode). */
export const HANDS_FREE_MAX_MS = 300_000
/** The capsule counts down the last stretch before a hands-free cap. */
export const CAP_WARNING_MS = 10_000
/** Audio kept after the key is let go, so the last syllable is not clipped. */
export const RELEASE_TAIL_MS = 250
/** Shorter than this holds no word: dropped quietly, no "nothing heard". */
export const MIN_SPEECH_MS = 300
/** Whole-take s16 peak below this is a mic delivering silence (mirrors the
 *  backend's SILENT_PEAK). */
export const SILENT_PEAK = 64
/** How long an error or "nothing heard" capsule stays up on its own. */
export const ERROR_VISIBLE_MS = 4_000
// Past the backend's 120 s sidecar READY timeout, so a cold start always
// answers (and frees its claim) before the window gives up on it.
const START_TIMEOUT_MS = 125_000
const STOP_TIMEOUT_MS = 120_000
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
  /** The take runs hands-free (locked by a quick tap, or toggle mode). */
  handsFree: boolean
  /** Wall-clock time the recording cap ends the take, while recording. */
  capEndsAt: number
  /** Input level 0..1 of the latest chunk, while recording. */
  level: number
  /** The chosen microphone was gone and the system default is recording. */
  deviceFallback: boolean
  /** A hands-free take hit its cap: the transcript waits in `countdown` with
   *  no timer until the user sends it (the shortcut or the capsule's send
   *  button) or drops it (the capsule's discard button). */
  awaitingSend: boolean
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
  'mic-authorized',
  'mic-failed',
  'mic-disconnected',
  'mic-silent',
  'backend',
  'no-speech',
  'start-sidecar-missing',
  'start-model-missing',
  'start-sidecar-failed',
  'start-busy',
  'start-disabled',
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
  /** macOS mic consent (granted elsewhere); `prompted` when this call showed
   *  the first-time system dialog. */
  askMicrophone: () => Promise<{ granted: boolean; prompted: boolean }>
  openCapture: (onChunk: (pcm: Int16Array) => void, onEnded: () => void) => Promise<VoiceCapture>
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
  /** One diagnostic line per take (default console.info). */
  log?: (line: string) => void
}

interface StartResult { ok?: boolean; sessionId?: string; reason?: string }
interface StopResult { ok?: boolean; text?: string; reason?: string; durationMs?: number; peak?: number }

/** Per-take timings (ms since the press) and capture figures for the log line. */
interface TakeStats {
  t0: number
  mic?: number
  capture?: number
  session?: number
  release?: number
  stop?: number
  end: string
  samples: number
  peak: number
  chunks: number
}

/** Chunk RMS → 0..1 on a -60..0 dBFS scale, for the capsule's level meter. */
export function levelOf(rms: number): number {
  if (rms <= 0) return 0
  const db = 20 * Math.log10(rms / 32768)
  return Math.max(0, Math.min(1, (db + 60) / 60))
}

export function useVoiceInput(deps: VoiceDeps) {
  const now = deps.now ?? (() => Date.now())
  const log = deps.log ?? ((line: string) => console.info(line))
  const state = reactive<VoiceCapsuleState>({
    phase: 'idle',
    paneId: null,
    text: '',
    countdownEndsAt: 0,
    hold: null,
    handsFree: false,
    capEndsAt: 0,
    level: 0,
    deviceFallback: false,
    awaitingSend: false,
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
  // Chunks captured before voice.start answered, sent in order once it does.
  let pending: Int16Array[] = []
  let sessionWaiter: ((sid: string | null) => void) | null = null
  let sessionReady: Promise<string | null> = Promise.resolve(null)
  let recordingSince = 0
  let stats: TakeStats | null = null
  let messageId: number | null = null
  let stopWatch: WatchStopHandle | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let maxTimer: ReturnType<typeof setTimeout> | null = null
  let tailTimer: ReturnType<typeof setTimeout> | null = null

  function clearTimer(): void {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  function clearTakeTimers(): void {
    if (maxTimer !== null) clearTimeout(maxTimer)
    maxTimer = null
    if (tailTimer !== null) clearTimeout(tailTimer)
    tailTimer = null
  }

  function reset(): void {
    clearTimer()
    clearTakeTimers()
    stopWatch?.()
    stopWatch = null
    messageId = null
    capture?.close()
    capture = null
    sessionId = null
    pending = []
    sessionWaiter?.(null)
    sessionWaiter = null
    stats = null
    state.phase = 'idle'
    state.paneId = null
    state.text = ''
    state.countdownEndsAt = 0
    state.hold = null
    state.handsFree = false
    state.capEndsAt = 0
    state.level = 0
    state.deviceFallback = false
    state.awaitingSend = false
    state.error = null
  }

  function mark(key: 'mic' | 'capture' | 'session' | 'release' | 'stop'): void {
    if (stats) stats[key] = now()
  }

  /** The take's one diagnostic line; later calls for the same take are no-ops. */
  function logTake(outcome: string): void {
    const s = stats
    if (!s) return
    stats = null
    const at = (t: number | undefined): string => (t === undefined ? '-' : `${Math.round(t - s.t0)}ms`)
    log(
      `[voice] outcome=${outcome} end=${s.end || '-'} mode=${state.handsFree ? 'hands-free' : 'hold'}` +
        ` mic=${at(s.mic)} capture=${at(s.capture)} session=${at(s.session)} release=${at(s.release)}` +
        ` stop=${at(s.stop)} audio=${Math.round(s.samples / 16)}ms chunks=${s.chunks} peak=${s.peak}`,
    )
  }

  function cancelSession(sid: string): void {
    void deps.request('voice.cancel', { sessionId: sid }, CANCEL_TIMEOUT_MS).catch(() => {})
  }

  function fail(key: string, params?: Record<string, string | number>, reason?: MessageReason): void {
    logTake(key)
    const paneId = state.paneId
    const sid = sessionId
    reset()
    if (sid) cancelSession(sid)
    take++
    state.phase = 'error'
    state.paneId = paneId
    state.error = { key, params, reason }
    timer = setTimeout(() => {
      if (state.phase === 'error') reset()
    }, ERROR_VISIBLE_MS)
  }

  function sendChunk(pcm: Int16Array, sid: string): void {
    if (stats) stats.chunks++
    void deps
      .request('voice.chunk', { sessionId: sid, seq: seq++, pcm: int16ToBase64(pcm) }, CHUNK_TIMEOUT_MS)
      .catch(() => {})
  }

  function onChunk(mine: number, pcm: Int16Array): void {
    if (mine !== take || pcm.length === 0) return
    let peak = 0
    let sq = 0
    for (let i = 0; i < pcm.length; i++) {
      const x = pcm[i]
      const a = x < 0 ? -x : x
      if (a > peak) peak = a
      sq += x * x
    }
    if (stats) {
      stats.samples += pcm.length
      stats.peak = Math.max(stats.peak, peak)
    }
    if (state.phase === 'recording') state.level = levelOf(Math.sqrt(sq / pcm.length))
    if (sessionId) sendChunk(pcm, sessionId)
    else pending.push(pcm)
  }

  /**
   * Hotkey pressed. Returns true when the press was consumed. Key repeat while
   * a take is already running is consumed and ignored. `handsFree` starts the
   * take locked (toggle mode): it runs until the next press, up to
   * HANDS_FREE_MAX_MS.
   */
  function press(paneId: string | null, opts: { handsFree?: boolean } = {}): boolean {
    if (!deps.enabled()) return false
    if (state.phase === 'starting' || state.phase === 'recording' || state.phase === 'transcribing') return true
    if (!paneId) return false
    // A capped hands-free transcript waiting to be sent: this press sends it,
    // and starts nothing — the user was asked to send, not to record again.
    if (state.phase === 'countdown' && state.awaitingSend) {
      deliverNow()
      return true
    }
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
    stats = { t0: now(), end: '', samples: 0, peak: 0, chunks: 0 }
    state.phase = 'starting'
    state.paneId = paneId
    state.handsFree = opts.handsFree === true
    void begin(mine)
    return true
  }

  async function begin(mine: number): Promise<void> {
    let mic: { granted: boolean; prompted: boolean }
    try {
      mic = await deps.askMicrophone()
    } catch {
      mic = { granted: false, prompted: false }
    }
    if (mine !== take) return
    mark('mic')
    if (!mic.granted) return fail('mic-denied')
    // The press went into answering the system dialog, and the key is long
    // up: recording now would only ever hear nothing.
    if (mic.prompted) return fail('mic-authorized')

    // The mic opens at once; voice.start (possibly loading the sidecar) runs
    // alongside, and what is said meanwhile waits in `pending`.
    sessionReady = new Promise((resolve) => { sessionWaiter = resolve })
    deps.request<StartResult>('voice.start', {}, START_TIMEOUT_MS).then(
      (res) => onStarted(mine, res),
      () => { if (mine === take) fail('backend') },
    )

    let cap: VoiceCapture
    try {
      cap = await deps.openCapture(
        (pcm) => onChunk(mine, pcm),
        // Unplugged mid-take: a hands-free take would otherwise sit on
        // "listening" to nothing until its 5-minute cap.
        () => {
          if (mine === take && (state.phase === 'starting' || state.phase === 'recording')) {
            fail('mic-disconnected')
          }
        },
      )
    } catch (err) {
      if (mine === take) fail('mic-failed', { error: err instanceof Error ? err.message : String(err) })
      return
    }
    if (mine !== take) {
      cap.close()
      return
    }
    capture = cap
    state.deviceFallback = cap.fellBack === true
    mark('capture')
    recordingSince = now()
    state.phase = 'recording'
    armCap(mine)
    if (released) tailTimer = setTimeout(() => void finish(mine), RELEASE_TAIL_MS)
  }

  function onStarted(mine: number, res: VoiceResponse<StartResult>): void {
    const sid = res.payload?.sessionId
    if (mine !== take) {
      if (sid) cancelSession(sid)
      return
    }
    if (!res.ok || !res.payload?.ok || !sid) return fail(`start-${res.payload?.reason ?? 'failed'}`)
    sessionId = sid
    mark('session')
    const early = pending
    pending = []
    for (const pcm of early) sendChunk(pcm, sid)
    sessionWaiter?.(sid)
    sessionWaiter = null
  }

  /** (Re)arm the recording cap for the take's current mode. */
  function armCap(mine: number): void {
    if (maxTimer !== null) clearTimeout(maxTimer)
    state.capEndsAt = recordingSince + (state.handsFree ? HANDS_FREE_MAX_MS : MAX_RECORDING_MS)
    maxTimer = setTimeout(() => {
      maxTimer = null
      if (mine !== take || state.phase !== 'recording') return
      if (stats && !stats.end) stats.end = 'cap'
      // A hands-free take can run for minutes with nobody watching: its
      // transcript waits to be sent instead of going out on its own.
      void finish(mine, !state.handsFree)
    }, Math.max(0, state.capEndsAt - now()))
  }

  /** A quick tap: keep the take running hands-free until the next press. */
  function lock(): boolean {
    if ((state.phase !== 'starting' && state.phase !== 'recording') || released) return false
    if (state.handsFree) return true
    state.handsFree = true
    if (state.phase === 'recording') armCap(take)
    return true
  }

  /** Hotkey released (or pressed again hands-free): stop after the tail.
   *  `reason` goes into the take's log line. */
  function release(reason = 'release'): void {
    if (state.phase !== 'starting' && state.phase !== 'recording') return
    if (released) return
    released = true
    if (stats) stats.end = reason
    mark('release')
    if (state.phase === 'recording') {
      const mine = take
      tailTimer = setTimeout(() => void finish(mine), RELEASE_TAIL_MS)
    }
  }

  async function finish(mine: number, autoSend = true): Promise<void> {
    const cap = capture
    if (mine !== take || state.phase !== 'recording' || !cap) return
    clearTakeTimers()
    state.phase = 'transcribing'
    state.level = 0
    mark('stop')
    await cap.flush()
    cap.close()
    if (capture === cap) capture = null
    if (mine !== take) return
    const sid = sessionId ?? (await sessionReady)
    if (mine !== take || !sid) return

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
    if (!text) {
      const durationMs = res.payload.durationMs ?? Math.round((stats?.samples ?? 0) / 16)
      const peak = res.payload.peak ?? stats?.peak ?? 0
      if (durationMs < MIN_SPEECH_MS) {
        // A slip of the key: nothing to say about it.
        logTake('too-short')
        take++
        return reset()
      }
      return fail(peak < SILENT_PEAK ? 'mic-silent' : 'no-speech')
    }
    logTake('text')
    state.text = text
    state.phase = 'countdown'
    if (!autoSend) {
      state.awaitingSend = true
      return
    }
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
        // A capped transcript can wait for minutes, like `held`: Esc stays
        // the CLI's, and the capsule's own buttons send or discard it.
        if (state.awaitingSend) return false
        break
      case 'starting':
      case 'recording':
      case 'transcribing':
        logTake('cancelled')
        if (sessionId) cancelSession(sessionId)
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

  /** The capsule's close button on an error (it also times out on its own),
   *  or its discard button on a capped transcript waiting to be sent. */
  function dismiss(): void {
    if (state.phase === 'error') return reset()
    if (state.phase === 'countdown' && state.awaitingSend) {
      take++
      reset()
    }
  }

  /** The capsule's send button on a capped transcript. */
  function send(): void {
    if (state.phase === 'countdown' && state.awaitingSend) deliverNow()
  }

  /** The setting went off (or the window is going away): drop any take. */
  function disable(): void {
    if (state.phase === 'idle') return
    logTake('disabled')
    if (sessionId) cancelSession(sessionId)
    take++
    reset()
  }

  return { state, visible, press, lock, release, cancel, withdraw, dismiss, send, disable }
}

export type VoiceInput = ReturnType<typeof useVoiceInput>
