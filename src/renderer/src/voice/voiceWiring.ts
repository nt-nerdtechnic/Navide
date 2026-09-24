import { onScopeDispose, watch } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import {
  canonicalizeKeySpec,
  defaults,
  getUserRules,
  isRemovalRule,
  parseKeySpec,
  registerCommand,
  removalTarget,
  setContext,
  type ParsedKey,
} from '@navide/plugin-ui/shared'
import type { useBackend } from '../composables/useBackend'
import { useVoiceInput, voiceErrorI18nKey, type VoiceDeps, type VoicePartial, type VoiceTarget } from '../composables/useVoiceInput'
import { openMicCapture } from './micCapture'
import { useVoiceSettings } from './voiceSettings'

const HOLD_TO_TALK = 'workbench.action.holdToTalk'
/** A press let go sooner than this is a tap: in hold-tap mode it locks the take hands-free. */
export const TAP_LOCK_MS = 350
const PREWARM_TIMEOUT_MS = 125_000
const PREWARM_FOCUS_INTERVAL_MS = 60_000

/** The keys (last chord segment) currently bound to hold-to-talk. */
function holdToTalkChords(): ParsedKey[] {
  const rules = [...defaults, ...getUserRules()]
  const removed = new Set(
    rules.filter((r) => isRemovalRule(r) && removalTarget(r) === HOLD_TO_TALK).map((r) => canonicalizeKeySpec(r.key)),
  )
  return rules
    .filter((r) => r.command === HOLD_TO_TALK && !removed.has(canonicalizeKeySpec(r.key)))
    .map((r) => parseKeySpec(r.key).at(-1)!)
}

const MODIFIER_OF: Record<string, 'ctrl' | 'alt' | 'shift' | 'meta'> = {
  Control: 'ctrl',
  Alt: 'alt',
  Shift: 'shift',
  Meta: 'meta',
}

function isMainKey(key: string, e: KeyboardEvent): boolean {
  if (e.key.toLowerCase() === key) return true
  // Option+letter reports a special character on macOS; digits may be hidden by an IME.
  if (/^[a-z]$/.test(key)) return e.code === `Key${key.toUpperCase()}`
  if (/^[0-9]$/.test(key)) return e.code === `Digit${key}` || e.code === `Numpad${key}`
  return false
}

/**
 * Whether a keyup lets go of a hold-to-talk chord: its main key, one of its
 * modifiers, or any key arriving with one of its modifiers already up (that
 * modifier's own keyup was missed, e.g. while the window was blurred). With no
 * binding (invoked some other way) any keyup counts.
 */
export function isChordKeyUp(e: KeyboardEvent, chords: readonly ParsedKey[]): boolean {
  if (chords.length === 0) return true
  const mod = MODIFIER_OF[e.key]
  return chords.some((c) => {
    if (mod) return c[mod]
    if (isMainKey(c.key, e)) return true
    return (c.ctrl && !e.ctrlKey) || (c.alt && !e.altKey) || (c.shift && !e.shiftKey) || (c.meta && !e.metaKey)
  })
}

/** What the main window must hand over to wire voice input. */
export interface VoiceWiringHost {
  backend: Pick<ReturnType<typeof useBackend>, 'send' | 'on'>
  /** The focused CLI pane right now, if any. */
  focusedPaneId: () => string | null
  /** A pane's messaging handle and whether a CLI is running behind it. */
  paneInfo: (paneId: string) => { realized: boolean; messagingName?: string } | undefined
  /** Type text into a pane's input the way a ⌘V paste does (never submits);
   *  false when the pane has no terminal to type into. */
  insertText: (paneId: string, text: string) => boolean
  /** A non-blocking notice (a toast), for a pre-warm that failed. */
  hint?: (text: string) => void
}

/**
 * Voice input for the main window: hotkey, capture, live text and insertion.
 *
 * Dictation: the final transcript is pasted into the target pane's input box
 * through the pane's own paste path — the one ⌘V uses — so it lands like text
 * the user typed: no envelope, no messaging queue or idle gate (a busy CLI
 * still takes it), and no Enter. The user submits it themselves.
 *
 * With the setting off: the `voiceInput` context is false, so the hotkey rule
 * never matches and the chord reaches the PTY as before; the command handler
 * declines; no key or focus listener is installed; nothing talks to the
 * backend (bar the one voice.shutdown sent at the moment it is switched off).
 */
export function setupVoiceInput(host: VoiceWiringHost) {
  const settings = useVoiceSettings()

  const deps: VoiceDeps = {
    enabled: () => settings.voiceInputEnabled.value,
    script: () => settings.voiceScript.value,
    request: async (type, payload, timeoutMs) => {
      const res = await host.backend.send(type, payload, timeoutMs)
      return { ok: res.ok, payload: res.payload as never }
    },
    askMicrophone: async () => {
      const media = window.agentTeam?.media
      if (!media) return { granted: true, prompted: false }
      const res = await media.askMicrophone()
      return { granted: res.granted, prompted: res.prompted === true }
    },
    openCapture: (onChunk, onEnded) => openMicCapture(onChunk, settings.voiceInputDeviceId.value, onEnded),
    resolveTarget: (paneId): VoiceTarget => {
      const pane = host.paneInfo(paneId)
      if (!pane || !pane.messagingName) return { ok: false, reason: 'not-cli' }
      // An idle-reclaimed or cold-restored placeholder has no CLI to type into.
      // Refused rather than woken: realizing takes tens of seconds and may ask
      // which session to resume — not something to start from a key press.
      if (!pane.realized) return { ok: false, reason: 'asleep' }
      return { ok: true }
    },
    insert: (paneId, text) => host.insertText(paneId, text),
  }
  const voice = useVoiceInput(deps)
  // Pushed only to the window that is recording; the take checks the session.
  const offPartial = host.backend.on('voice.partial', (raw) => voice.partial(raw as VoicePartial))

  // ── Hotkey ──────────────────────────────────────────────────────────────────
  // The key resolver only sees keydown, so the rest of a press is followed
  // here, and only while a take is starting or recording. The take ends when
  // the chord is let go: a keyup of its main key or of one of its modifiers
  // (read from the live binding — it is rebindable). Other keyups are left
  // alone. By mode:
  //   hold-tap  held → push-to-talk; let go within TAP_LOCK_MS → hands-free
  //             until the next press
  //   hold      push-to-talk only
  //   toggle    every take hands-free: press to start, press again to stop
  // Blur ends a held take (a keyup that happens elsewhere never arrives here),
  // except while it is still starting — the first-time macOS mic dialog takes
  // focus — and never a hands-free one.
  let armed = false
  let chordUp = false
  let pressedAt = 0
  let chords: ParsedKey[] = []

  function onKeyUp(e: KeyboardEvent): void {
    if (chordUp || !isChordKeyUp(e, chords)) return
    e.preventDefault()
    e.stopImmediatePropagation()
    chordUp = true
    if (voice.state.handsFree) return
    if (settings.voiceRecordingMode.value === 'hold-tap' && Date.now() - pressedAt < TAP_LOCK_MS && voice.lock()) return
    disarm()
    voice.release(`keyup:${e.code || e.key}`)
  }
  function onBlur(): void {
    if (voice.state.handsFree || voice.state.phase === 'starting') return
    disarm()
    voice.release('blur')
  }
  function disarm(): void {
    if (!armed) return
    armed = false
    window.removeEventListener('keyup', onKeyUp, true)
    window.removeEventListener('blur', onBlur)
  }

  registerCommand(HOLD_TO_TALK, () => {
    if (!settings.voiceInputEnabled.value) return false
    if (armed) {
      // A fresh press of a hands-free take stops it; anything else is key repeat.
      if (voice.state.handsFree && chordUp) {
        disarm()
        voice.release('toggle')
      }
      return true
    }
    const consumed = voice.press(host.focusedPaneId(), { handsFree: settings.voiceRecordingMode.value === 'toggle' })
    if (!consumed) return false
    if (voice.state.phase === 'starting') {
      armed = true
      chordUp = false
      pressedAt = Date.now()
      chords = holdToTalkChords()
      window.addEventListener('keyup', onKeyUp, true)
      window.addEventListener('blur', onBlur)
    }
    return true
  })

  // Listeners live exactly as long as the take records (the cap, Esc or a
  // failure can end it without a key).
  watch(
    () => voice.state.phase === 'starting' || voice.state.phase === 'recording',
    (live) => {
      if (!live) disarm()
    },
  )
  // A blur while starting was let through (the mic dialog), but a held take
  // that reaches recording in a window that is still unfocused lost its keyup
  // for good: without this it records until the cap and then inserts.
  watch(
    () => voice.state.phase,
    (phase, prev) => {
      if (phase !== 'recording' || prev !== 'starting' || !armed || voice.state.handsFree) return
      if (document.hasFocus()) return
      disarm()
      voice.release('blur')
    },
  )

  // ── Esc during a take ───────────────────────────────────────────────────────
  // Listened for only while a take records or transcribes (see
  // useVoiceInput.cancel). A failed capsule leaves Esc to the CLI — it is how
  // a busy pane is interrupted — and offers its own button instead.
  function onEsc(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || e.isComposing) return
    if (!voice.cancel()) return
    e.preventDefault()
    e.stopImmediatePropagation()
    disarm()
  }
  const ESC_PHASES = new Set(['starting', 'recording', 'transcribing'])
  watch(
    () => ESC_PHASES.has(voice.state.phase),
    (owned) => {
      if (owned) window.addEventListener('keydown', onEsc, true)
      else window.removeEventListener('keydown', onEsc, true)
    },
  )

  // ── Pre-warm ────────────────────────────────────────────────────────────────
  // Loading the sidecar takes seconds (up to a minute cold), so it is started
  // ahead of the first press: when the setting is on at launch, when it is
  // switched on, and when the window regains focus (the sidecar exits after
  // ten idle minutes). Switching the setting off stops it.
  let lastPrewarm = 0
  // Said once per reason: focus re-runs the pre-warm every minute, and the
  // same failure every minute would be noise. A success clears it.
  let hinted = ''
  function prewarmFailed(code: string): void {
    if (code === hinted || !settings.voiceInputEnabled.value) return
    hinted = code
    host.hint?.(i18n.global.t('voice.prewarm-failed', { reason: i18n.global.t(voiceErrorI18nKey(code), { code }) }))
  }
  function prewarm(): void {
    lastPrewarm = Date.now()
    host.backend.send('voice.prewarm', {}, PREWARM_TIMEOUT_MS).then(
      (res) => {
        const body = res.payload as { ok?: boolean; reason?: string } | null
        if (res.ok && body?.ok) hinted = ''
        // Switched off while it loaded: not a failure.
        else if (body?.reason !== 'disabled') prewarmFailed(`start-${body?.reason ?? 'failed'}`)
      },
      () => prewarmFailed('backend'),
    )
  }
  function onFocus(): void {
    if (Date.now() - lastPrewarm >= PREWARM_FOCUS_INTERVAL_MS) prewarm()
  }

  watch(
    settings.voiceInputEnabled,
    (on, was) => {
      setContext('voiceInput', on)
      if (on) {
        prewarm()
        window.addEventListener('focus', onFocus)
        return
      }
      window.removeEventListener('focus', onFocus)
      disarm()
      voice.disable()
      if (was) void host.backend.send('voice.shutdown', {}, 10_000).catch(() => {})
    },
    { immediate: true },
  )

  onScopeDispose(() => {
    offPartial()
    disarm()
    window.removeEventListener('focus', onFocus)
    window.removeEventListener('keydown', onEsc, true)
    voice.disable()
  })

  return {
    state: voice.state,
    dismiss: voice.dismiss,
  }
}
