import { onScopeDispose, watch } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import {
  canonicalizeKeySpec,
  defaults,
  eventLoneModifier,
  getUserRules,
  isLoneModifierKey,
  isRemovalRule,
  LONE_MODIFIER_KEYS,
  parseKeySpec,
  registerCommand,
  removalTarget,
  setContext,
  type ParsedKey,
} from '@navide/plugin-ui/shared'
import type { useBackend } from '../composables/useBackend'
import { useVoiceInput, voiceErrorI18nKey, type VoiceDeps, type VoicePartial, type VoiceTarget } from '../composables/useVoiceInput'
import { openMicCapture } from './micCapture'
import { HOLD_TO_TALK_COMMAND as HOLD_TO_TALK, useVoiceSettings } from './voiceSettings'
import type { FnKeyApi } from '../../../shared/fnKey'

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
 * modifier's own keyup was missed, e.g. while the window was blurred). A lone
 * modifier ('rightalt') is let go by its own keyup, or by any keyup arriving
 * with its modifier already up. With no binding (invoked some other way) any
 * keyup counts.
 */
export function isChordKeyUp(e: KeyboardEvent, chords: readonly ParsedKey[]): boolean {
  if (chords.length === 0) return true
  const mod = MODIFIER_OF[e.key]
  return chords.some((c) => {
    const lone = LONE_MODIFIER_KEYS[c.key]
    if (lone) return e.code === lone.code || !modifierHeld(e, lone.flag)
    if (mod) return c[mod]
    if (isMainKey(c.key, e)) return true
    return (c.ctrl && !e.ctrlKey) || (c.alt && !e.altKey) || (c.shift && !e.shiftKey) || (c.meta && !e.metaKey)
  })
}

function modifierHeld(e: KeyboardEvent, flag: 'ctrl' | 'alt' | 'shift' | 'meta'): boolean {
  return flag === 'ctrl' ? e.ctrlKey : flag === 'alt' ? e.altKey : flag === 'shift' ? e.shiftKey : e.metaKey
}

/**
 * Whether a keydown during a take held by a lone modifier shows that modifier
 * is being used for a combination (Right Option + E), not held to dictate.
 * The modifier's own repeats do not count, nor do Enter and Esc, which
 * belong to the take itself: dropping it would lose what was said.
 */
export function isLoneModifierCombo(e: KeyboardEvent, chords: readonly ParsedKey[]): boolean {
  const lone = chords.filter((c) => isLoneModifierKey(c.key))
  if (lone.length === 0 || e.key === 'Enter' || e.key === 'Escape') return false
  return !lone.some((c) => eventLoneModifier(e, true) === c.key)
}

/** What the main window must hand over to wire voice input. */
export interface VoiceWiringHost {
  backend: Pick<ReturnType<typeof useBackend>, 'send' | 'on'>
  /** The focused CLI pane right now, if any. */
  focusedPaneId: () => string | null
  /** A pane's messaging handle and whether a CLI is running behind it. */
  paneInfo: (paneId: string) => { realized: boolean; messagingName?: string } | undefined
  /** Type text into a pane's input the way a ⌘V paste does, then press Enter
   *  when `submit`; false when the pane has no terminal to type into. */
  insertText: (paneId: string, text: string, opts: { submit: boolean }) => boolean
  /** A non-blocking notice (a toast), for a pre-warm that failed. */
  hint?: (text: string) => void
  /** The fn (🌐) key relay (macOS); absent where there is none. */
  fnKey?: FnKeyApi
}

/**
 * Voice input for the main window: hotkey, capture, live text and insertion.
 *
 * Dictation: the final transcript is pasted into the target pane's input box
 * through the pane's own paste path — the one ⌘V uses — so it lands like text
 * the user typed: no envelope, no messaging queue or idle gate (a busy CLI
 * still takes it), and no Enter — unless the take was ended with Enter, which
 * then submits it the way a typed Enter would.
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
    savedDeviceLabel: () => (settings.voiceInputDeviceId.value ? settings.voiceInputDeviceLabel.value : ''),
    resolveTarget: (paneId): VoiceTarget => {
      const pane = host.paneInfo(paneId)
      if (!pane || !pane.messagingName) return { ok: false, reason: 'not-cli' }
      // An idle-reclaimed or cold-restored placeholder has no CLI to type into.
      // Refused rather than woken: realizing takes tens of seconds and may ask
      // which session to resume — not something to start from a key press.
      if (!pane.realized) return { ok: false, reason: 'asleep' }
      return { ok: true }
    },
    insert: (paneId, text, opts) => host.insertText(paneId, text, opts),
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
  //
  // A lone modifier (Right Option) cannot know on keydown whether it will be
  // held alone or used for a combination, so the take starts at once and is
  // dropped, quietly, as soon as another key goes down while it is held.
  //
  // The fn key (optional, macOS) presses and releases the same way, but its
  // events come from the main process, which sees fn system-wide: a press is
  // taken only while this window has focus, and its release is fn's own up
  // (keyups and blur are not followed). A CHORD (fn+arrow...) drops the take.
  let armed = false
  let chordUp = false
  let pressedAt = 0
  let chords: ParsedKey[] = []
  let source: 'key' | 'fn' = 'key'

  function onKeyUp(e: KeyboardEvent): void {
    if (chordUp || !isChordKeyUp(e, chords)) return
    e.preventDefault()
    e.stopImmediatePropagation()
    letGo(`keyup:${e.code || e.key}`)
  }
  function onHeldKeyDown(e: KeyboardEvent): void {
    if (chordUp || !isLoneModifierCombo(e, chords)) return
    // Left alone: the combination is the user's, not ours.
    disarm()
    voice.cancel()
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
    window.removeEventListener('keydown', onHeldKeyDown, true)
    window.removeEventListener('blur', onBlur)
  }

  /** The hotkey or fn went down. False: not consumed. */
  function press(from: 'key' | 'fn'): boolean {
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
      source = from
      chords = from === 'key' ? holdToTalkChords() : []
      if (from === 'key') {
        window.addEventListener('keyup', onKeyUp, true)
        window.addEventListener('blur', onBlur)
        if (chords.some((c) => isLoneModifierKey(c.key))) window.addEventListener('keydown', onHeldKeyDown, true)
      }
    }
    return true
  }

  /** The hotkey or fn was let go. */
  function letGo(reason: string): void {
    chordUp = true
    if (voice.state.handsFree) return
    if (settings.voiceRecordingMode.value === 'hold-tap' && Date.now() - pressedAt < TAP_LOCK_MS && voice.lock()) return
    disarm()
    voice.release(reason)
  }

  registerCommand(HOLD_TO_TALK, () => press('key'))

  // ── fn (🌐) key ─────────────────────────────────────────────────────────────
  // Subscribed only while voice input and the fn setting are both on: the
  // main process runs its helper only while someone is subscribed.
  let offFnEvent: (() => void) | null = null
  function onFnEvent(type: 'down' | 'up' | 'chord'): void {
    if (type === 'down') {
      if (document.hasFocus()) press('fn')
      return
    }
    if (!armed || source !== 'fn' || chordUp) return
    if (type === 'up') {
      letGo('fn-up')
      return
    }
    disarm()
    voice.cancel()
  }
  function fnListen(on: boolean): void {
    const api = host.fnKey
    if (!api || on === (offFnEvent !== null)) return
    if (on) {
      offFnEvent = api.onEvent((e) => onFnEvent(e.type))
      void api.subscribe().catch(() => {})
      return
    }
    offFnEvent?.()
    offFnEvent = null
    void api.unsubscribe().catch(() => {})
    // Its up can no longer arrive.
    if (armed && source === 'fn' && !chordUp) letGo('fn-off')
  }
  watch(
    () => settings.voiceInputEnabled.value && settings.voiceFnKeyEnabled.value,
    (on) => fnListen(on),
    { immediate: true },
  )

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

  // ── Esc / Enter during a take ───────────────────────────────────────────────
  // Listened for only while a take records or transcribes (see
  // useVoiceInput.cancel / submit). A failed capsule leaves Esc to the CLI —
  // it is how a busy pane is interrupted — and offers its own button instead.
  // Enter ends the take and sends its text; it is taken only bare, outside an
  // IME composition (Enter confirms a candidate there), and only while the
  // take's own pane has focus — Enter in another pane stays that pane's.
  // Once the text is in and the take is over, Enter reaches the CLI as usual.
  function onTakeKey(e: KeyboardEvent): void {
    if (e.isComposing) return
    if (e.key === 'Escape') {
      if (!voice.cancel()) return
    } else if (e.key === 'Enter') {
      if (e.keyCode === 229 || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return
      if (host.focusedPaneId() !== voice.state.paneId || !voice.submit()) return
    } else {
      return
    }
    e.preventDefault()
    e.stopImmediatePropagation()
    disarm()
  }
  const TAKE_PHASES = new Set(['starting', 'recording', 'transcribing'])
  watch(
    () => TAKE_PHASES.has(voice.state.phase),
    (owned) => {
      if (owned) window.addEventListener('keydown', onTakeKey, true)
      else window.removeEventListener('keydown', onTakeKey, true)
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
    fnListen(false)
    disarm()
    window.removeEventListener('focus', onFocus)
    window.removeEventListener('keydown', onTakeKey, true)
    voice.disable()
  })

  return {
    state: voice.state,
    dismiss: voice.dismiss,
  }
}
