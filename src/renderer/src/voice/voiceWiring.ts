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
import { NOTICE_SENDER, type useAgentMessaging } from '../composables/useAgentMessaging'
import type { useBackend } from '../composables/useBackend'
import { useVoiceInput, type VoiceDeps, type VoiceTarget } from '../composables/useVoiceInput'
import { speakWithSynthesis, useVoiceReadback } from '../composables/useVoiceReadback'
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
  backend: Pick<ReturnType<typeof useBackend>, 'send'>
  messaging: Pick<
    ReturnType<typeof useAgentMessaging>,
    'sendMessage' | 'messages' | 'cancelMessage' | 'pump' | 'paneIdOf'
  >
  /** The focused CLI pane right now, if any. */
  focusedPaneId: () => string | null
  /** A pane's messaging handle and whether a CLI is running behind it. */
  paneInfo: (paneId: string) => { realized: boolean; messagingName?: string } | undefined
  /** Display name for the readback fallback line. */
  paneLabel: (paneId: string) => string
}

/**
 * Voice input for the main window: hotkey, capture, delivery and readback.
 *
 * Delivery is a bare-text system message on the ordinary messaging queue —
 * the same path, gates and verbatim injection a Navide `notice` takes (idle
 * gate, typing hold, echo verification) — so the transcript is typed into the
 * pane exactly as the user would have typed it, with no envelope.
 *
 * With the setting off: the `voiceInput` context is false, so the hotkey rule
 * never matches and the chord reaches the PTY as before; the command handler
 * declines; no key or focus listener is installed; nothing talks to the
 * backend (bar the one voice.shutdown sent at the moment it is switched off).
 */
export function setupVoiceInput(host: VoiceWiringHost) {
  const settings = useVoiceSettings()

  const readback = useVoiceReadback({
    enabled: () => settings.voiceReadbackEnabled.value,
    speak: (text) => speakWithSynthesis(text, String(i18n.global.locale.value)),
    doneLine: (paneId) => i18n.global.t('voice.readback.done', { name: host.paneLabel(paneId) }),
  })

  const deps: VoiceDeps = {
    enabled: () => settings.voiceInputEnabled.value,
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
    openCapture: (onChunk) => openMicCapture(onChunk, settings.voiceInputDeviceId.value),
    resolveTarget: (paneId): VoiceTarget => {
      const pane = host.paneInfo(paneId)
      if (!pane || !pane.messagingName) return { ok: false, reason: 'not-cli' }
      // An idle-reclaimed or cold-restored placeholder has no CLI to type into.
      // Refused rather than woken: realizing takes tens of seconds and may ask
      // which session to resume — not something to start from a key press.
      if (!pane.realized) return { ok: false, reason: 'asleep' }
      if (host.messaging.paneIdOf(pane.messagingName) !== paneId) return { ok: false, reason: 'not-cli' }
      return { ok: true, name: pane.messagingName }
    },
    deliver: (name, text) => {
      const msg = host.messaging.sendMessage(NOTICE_SENDER, name, text, { kind: 'notice' })
      host.messaging.pump()
      return msg.id
    },
    messageView: (id) => host.messaging.messages.value.find((m) => m.id === id),
    cancelMessage: (id) => host.messaging.cancelMessage(id),
    onDelivered: (paneId) => readback.noteVoiceDelivered(paneId),
  }
  const voice = useVoiceInput(deps)

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

  // ── Esc during a take ───────────────────────────────────────────────────────
  // Listened for only in the short-lived phases (see useVoiceInput.cancel). A
  // held or failed capsule leaves Esc to the CLI — it is how a busy pane is
  // interrupted — and offers its own buttons instead.
  function onEsc(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || e.isComposing) return
    if (!voice.cancel()) return
    e.preventDefault()
    e.stopImmediatePropagation()
    disarm()
  }
  const ESC_PHASES = new Set(['starting', 'recording', 'transcribing', 'countdown', 'delivering'])
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
  function prewarm(): void {
    lastPrewarm = Date.now()
    void host.backend.send('voice.prewarm', {}, PREWARM_TIMEOUT_MS).catch(() => {})
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
    disarm()
    window.removeEventListener('focus', onFocus)
    window.removeEventListener('keydown', onEsc, true)
    voice.disable()
  })

  return {
    state: voice.state,
    withdraw: voice.withdraw,
    dismiss: voice.dismiss,
    /** Feed every turn_complete here; only voice-driven panes are read out. */
    onTurnComplete: readback.onTurnComplete,
  }
}
