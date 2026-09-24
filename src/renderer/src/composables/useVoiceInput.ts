import { computed, reactive } from 'vue'
import type { VoiceCapture } from '../voice/micCapture'
import { int16ToBase64 } from '../voice/pcm'

/**
 * Hold-to-talk voice input for CLI panes.
 *
 * Press the hotkey → the focused CLI pane at that instant becomes the target,
 * and the mic opens at once while voice.start (which may have to load the
 * sidecar) runs alongside; ~250 ms s16le chunks are kept locally until the
 * session id arrives, then stream to the backend (voice.chunk) in order.
 * While recording, the backend's voice.partial events show the text so far in
 * the capsule. Release → RELEASE_TAIL_MS more audio, then voice.stop returns
 * the final transcript, which is typed into the target pane's input box like a
 * paste — never submitted: the user reviews it and presses Enter themselves
 * (see VoiceDeps.insert).
 *
 * Inert while the setting is off: every entry point checks `enabled()` first,
 * so no mic, no voice.* request and no listener runs.
 */

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
  | 'error'

export interface VoiceCapsuleState {
  phase: VoicePhase
  paneId: string | null
  /** Live transcript while recording/transcribing: `committed` only ever
   *  grows; `tentative` is the tail the recognizer may still revise. */
  committed: string
  tentative: string
  /** The take runs hands-free (locked by a quick tap, or toggle mode). */
  handsFree: boolean
  /** Wall-clock time the recording cap ends the take, while recording. */
  capEndsAt: number
  /** Input level 0..1 of the latest chunk, while recording. */
  level: number
  /** The chosen microphone was gone and the system default is recording. */
  deviceFallback: boolean
  /** i18n key under `voice.error.`, while phase === 'error'. `text` is a
   *  transcript the pane did not take: kept on screen until dismissed so it
   *  can be copied rather than lost. */
  error: { key: string; params?: Record<string, string | number>; text?: string } | null
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
  'insert-failed',
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
  | { ok: true }
  | { ok: false; reason: 'asleep' | 'not-cli' }

/** Payload of the backend's `voice.partial` event. */
export interface VoicePartial {
  sessionId?: string
  seq?: number
  committed?: string
  tentative?: string
}

export interface VoiceDeps {
  enabled: () => boolean
  /** Chinese script for the transcript, sent with voice.start (omitted: the
   *  sidecar leaves whisper's text as is). */
  script?: () => string
  request: <T>(type: string, payload: Record<string, unknown>, timeoutMs: number) => Promise<VoiceResponse<T>>
  /** macOS mic consent (granted elsewhere); `prompted` when this call showed
   *  the first-time system dialog. */
  askMicrophone: () => Promise<{ granted: boolean; prompted: boolean }>
  openCapture: (onChunk: (pcm: Int16Array) => void, onEnded: () => void) => Promise<VoiceCapture>
  /** Whether a pane can take dictated text right now. */
  resolveTarget: (paneId: string) => VoiceTarget
  /** Type `text` into the pane's input as a paste: no Enter, no messaging
   *  queue. False when the pane had nothing to type into. */
  insert: (paneId: string, text: string) => boolean
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
    committed: '',
    tentative: '',
    handsFree: false,
    capEndsAt: 0,
    level: 0,
    deviceFallback: false,
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
  let partialSeq = -1
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
    partialSeq = -1
    capture?.close()
    capture = null
    sessionId = null
    pending = []
    sessionWaiter?.(null)
    sessionWaiter = null
    stats = null
    state.phase = 'idle'
    state.paneId = null
    state.committed = ''
    state.tentative = ''
    state.handsFree = false
    state.capEndsAt = 0
    state.level = 0
    state.deviceFallback = false
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

  function fail(key: string, params?: Record<string, string | number>, text?: string): void {
    logTake(key)
    const paneId = state.paneId
    const sid = sessionId
    reset()
    if (sid) cancelSession(sid)
    take++
    state.phase = 'error'
    state.paneId = paneId
    state.error = text ? { key, params, text } : { key, params }
    if (text) return
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
    const script = deps.script?.()
    deps.request<StartResult>('voice.start', script ? { script } : {}, START_TIMEOUT_MS).then(
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
      // Dictation never sends, so a capped take (even a hands-free one nobody
      // is watching) is inserted like any other; the user reviews it.
      void finish(mine)
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

  async function finish(mine: number): Promise<void> {
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
    // One line: a line break reaches a PTY as CR, which a CLI not in
    // bracketed paste takes as Enter — and dictation never submits.
    const text = (res.payload.text ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim()
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
    // Re-checked: the pane may have closed or been reclaimed since key-down.
    const paneId = state.paneId ?? ''
    const target = deps.resolveTarget(paneId)
    if (!target.ok) return fail(target.reason === 'asleep' ? 'pane-asleep' : 'not-cli', undefined, text)
    if (!deps.insert(paneId, text)) return fail('insert-failed', undefined, text)
    logTake('text')
    take++
    reset()
  }

  /**
   * A voice.partial event: the text so far of the current take. Events for
   * another session, or older than one already shown, are ignored, and so is
   * one that would rewrite committed text — committed text never changes.
   */
  function partial(ev: VoicePartial): void {
    if (!sessionId || ev.sessionId !== sessionId) return
    if (state.phase !== 'recording' && state.phase !== 'transcribing') return
    const n = typeof ev.seq === 'number' ? ev.seq : -1
    if (n <= partialSeq) return
    const committed = ev.committed ?? ''
    if (!committed.startsWith(state.committed)) return
    partialSeq = n
    state.committed = committed
    state.tentative = ev.tentative ?? ''
  }

  /**
   * Esc. Only a take being recorded or transcribed owns it. An `error` capsule
   * can sit on screen for seconds, and Esc is how the user interrupts a busy
   * CLI, so there it is left alone: dismiss() is the capsule's own button.
   * Returns true when the key was the capsule's.
   */
  function cancel(): boolean {
    if (state.phase !== 'starting' && state.phase !== 'recording' && state.phase !== 'transcribing') return false
    logTake('cancelled')
    if (sessionId) cancelSession(sessionId)
    take++
    reset()
    return true
  }

  /** The capsule's close button on an error (it also times out on its own). */
  function dismiss(): void {
    if (state.phase === 'error') reset()
  }

  /** The setting went off (or the window is going away): drop any take. */
  function disable(): void {
    if (state.phase === 'idle') return
    logTake('disabled')
    if (sessionId) cancelSession(sessionId)
    take++
    reset()
  }

  return { state, visible, press, lock, release, partial, cancel, dismiss, disable }
}

export type VoiceInput = ReturnType<typeof useVoiceInput>
