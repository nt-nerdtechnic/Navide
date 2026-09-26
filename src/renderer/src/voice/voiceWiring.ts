import { onScopeDispose, ref, watch } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import {
  evaluateWhen,
  eventLoneModifier,
  getContext,
  isFnKey,
  isKeyCaptureActive,
  isLoneModifierKey,
  LONE_MODIFIER_KEYS,
  matchesEvent,
  onKeydownSeen,
  onUserRulesChanged,
  parseKeySpec,
  registerCommand,
  setContext,
  type ParsedKey,
} from '@navide/plugin-ui/shared'
import type { useBackend } from '../composables/useBackend'
import { useVoiceInput, voiceErrorI18nKey, type VoiceDeps, type VoicePartial, type VoiceTarget } from '../composables/useVoiceInput'
import { openMicCapture } from './micCapture'
import { HOLD_TO_TALK_COMMAND as HOLD_TO_TALK, useVoiceSettings } from './voiceSettings'
import { holdToTalkFnRules, holdToTalkRules } from './holdToTalkKey'
import type { FnKeyApi } from '../../../shared/fnKey'

/** A press let go sooner than this is a tap: in hold-tap mode it locks the take hands-free. */
export const TAP_LOCK_MS = 350
/**
 * How long a lone modifier that starts other shortcuts (⌘, ⌃ — see
 * needsSoloHold) must be held by itself before its take starts: ⌘C, ⌃C and
 * every such shortcut begin with that same keydown, and typed at speed must
 * not open the mic.
 */
export const SOLO_HOLD_MS = 300
const SOLO_HOLD_FLAGS: ReadonlySet<string> = new Set(['meta', 'ctrl'])
const PREWARM_TIMEOUT_MS = 125_000
const PREWARM_FOCUS_INTERVAL_MS = 60_000

/** The keyboard keys (last chord segment) currently bound to hold-to-talk. */
function holdToTalkChords(): ParsedKey[] {
  return holdToTalkRules()
    .map((r) => parseKeySpec(r.key).at(-1)!)
    .filter((k) => !isFnKey(k.key))
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

/** Whether a lone-modifier key ('leftcmd', 'rightctrl'...) waits SOLO_HOLD_MS before its take starts. */
export function needsSoloHold(key: string): boolean {
  const lone = LONE_MODIFIER_KEYS[key]
  return !!lone && SOLO_HOLD_FLAGS.has(lone.flag)
}

/** What the main window must hand over to wire voice input. */
export interface VoiceWiringHost {
  backend: Pick<ReturnType<typeof useBackend>, 'send' | 'on'>
  /** The focused CLI pane right now, if any. */
  focusedPaneId: () => string | null
  /** A pane's messaging handle and whether a CLI is running behind it. */
  paneInfo: (paneId: string) => { realized: boolean; messagingName?: string } | undefined
  /** Type text into a pane's input the way a ⌘V paste does, then press Enter
   *  when `submit` and tell `onSubmit` whether it went; false when the pane
   *  has no terminal to type into. */
  insertText: (paneId: string, text: string, opts: { submit: boolean; onSubmit?: (sent: boolean) => void }) => boolean
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
  // A lone ⌘ or ⌃ (needsSoloHold) waits instead: its keydown is left alone
  // and only arms a solo hold. Held by itself for SOLO_HOLD_MS, it presses as
  // above; let go sooner, it is a tap (hold-tap: lock hands-free, toggle:
  // start / stop, hold: nothing). Any other keydown first — ⌘C, ⌘Tab, the
  // ⌘K of a chord, a menu accelerator — or a blur drops the hold and the key
  // goes through untouched; the next try needs a fresh press of the modifier
  // (its repeats never start one). Once such a take runs, blur while it is
  // held cancels it quietly rather than inserting — ⌘Tab leaves that way.
  //
  // A hands-free take whose chord was let go is stopped by the next press.
  // Until a keyup shows that, a keydown of the chord may be key repeat or a
  // fresh press: with a ⌘ chord (allowed in toggle mode) macOS withholds the
  // letter's keyup while ⌘ is held, so ⌘⇧D, then D again, never shows one.
  // The resolver hands its command no event, so the command declines then,
  // and onArmedKeyDown, which sees `e.repeat`, stops the take on a fresh
  // press. That chord is still held after the stop, so a repeat guard keeps
  // its repeats from starting the next take until a key of it is let go.
  //
  // fn (macOS), when hold-to-talk is bound to it, presses and releases the
  // same way, but its events come from the main process, which sees fn
  // system-wide: a press is taken only while this window has focus, its rule's
  // `when` holds (no dialog open) and no shortcut recorder is listening, and
  // its release is fn's own up (keyups and blur are not followed). A CHORD
  // (fn+arrow...) drops the take.
  let armed = false
  let chordUp = false
  let pressedAt = 0
  let chords: ParsedKey[] = []
  let source: 'key' | 'fn' = 'key'
  // The take was started by a solo hold (a lone ⌘ or ⌃).
  let soloTake = false

  function onKeyUp(e: KeyboardEvent): void {
    if (chordUp || !isChordKeyUp(e, chords)) return
    e.preventDefault()
    e.stopImmediatePropagation()
    letGo(`keyup:${e.code || e.key}`)
  }
  function onArmedKeyDown(e: KeyboardEvent): void {
    if (voice.state.handsFree && !chordUp && chords.some((c) => matchesEvent(c, e))) {
      e.preventDefault()
      e.stopImmediatePropagation()
      if (e.repeat) return
      disarm()
      voice.release('toggle')
      startRepeatGuard()
      return
    }
    if (chordUp || !isLoneModifierCombo(e, chords)) return
    // Left alone: the combination is the user's, not ours.
    disarm()
    voice.cancel()
  }
  function onBlur(): void {
    if (voice.state.handsFree || voice.state.phase === 'starting') return
    disarm()
    if (soloTake) voice.cancel()
    else voice.release('blur')
  }
  function disarm(): void {
    if (!armed) return
    armed = false
    window.removeEventListener('keyup', onKeyUp, true)
    window.removeEventListener('keydown', onArmedKeyDown, true)
    window.removeEventListener('blur', onBlur)
  }

  let repeatGuard = false
  function onGuardKeyDown(e: KeyboardEvent): void {
    if (!chords.some((c) => matchesEvent(c, e))) return
    e.preventDefault()
    e.stopImmediatePropagation()
    if (e.repeat) return
    endRepeatGuard()
    press('key')
  }
  function onGuardKeyUp(e: KeyboardEvent): void {
    if (isChordKeyUp(e, chords)) endRepeatGuard()
  }
  function startRepeatGuard(): void {
    repeatGuard = true
    window.addEventListener('keydown', onGuardKeyDown, true)
    window.addEventListener('keyup', onGuardKeyUp, true)
    window.addEventListener('blur', endRepeatGuard)
  }
  function endRepeatGuard(): void {
    if (!repeatGuard) return
    repeatGuard = false
    window.removeEventListener('keydown', onGuardKeyDown, true)
    window.removeEventListener('keyup', onGuardKeyUp, true)
    window.removeEventListener('blur', endRepeatGuard)
  }

  // ── Solo hold (a lone ⌘ or ⌃) ───────────────────────────────────────────────
  let solo: { key: ParsedKey; downAt: number; timer: ReturnType<typeof setTimeout> } | null = null
  // Seen through the dispatcher, ahead of every command: ⌘S is consumed by
  // Save before a window listener of ours would run. A take a solo hold
  // started is dropped the same way (onArmedKeyDown misses consumed keys).
  const offKeydownSeen = onKeydownSeen((e) => {
    if (solo) {
      // Anything but the modifier's own repeat is a shortcut: not ours.
      if (!(e.repeat && eventLoneModifier(e, true) === solo.key.key)) endSolo()
      return
    }
    if (!armed || !soloTake || chordUp || !isLoneModifierCombo(e, chords)) return
    disarm()
    voice.cancel()
  })
  function onSoloKeyUp(e: KeyboardEvent): void {
    if (!solo || !isChordKeyUp(e, [solo.key])) return
    endSolo()
    // A tap. Hold mode has no use for one.
    if (settings.voiceRecordingMode.value === 'hold') return
    const wasArmed = armed
    press('key', true)
    // A new take: the key is already up (hold-tap locks it, toggle keeps it).
    if (!wasArmed && armed) letGo('tap')
  }
  function startSolo(key: string, repeat: boolean): boolean {
    if (!settings.voiceInputEnabled.value || repeat || solo || repeatGuard) return false
    const downAt = Date.now()
    solo = {
      key: parseKeySpec(key)[0],
      downAt,
      timer: setTimeout(() => {
        endSolo()
        const wasArmed = armed
        press('key', true)
        // A tap is measured from the key going down, not from the hold.
        if (!wasArmed && armed) pressedAt = downAt
      }, SOLO_HOLD_MS),
    }
    window.addEventListener('keyup', onSoloKeyUp, true)
    window.addEventListener('blur', endSolo)
    // The modifier's keydown stays the page's.
    return false
  }
  function endSolo(): void {
    if (!solo) return
    clearTimeout(solo.timer)
    solo = null
    window.removeEventListener('keyup', onSoloKeyUp, true)
    window.removeEventListener('blur', endSolo)
  }

  /** The hotkey's command: `e` is the keydown that resolved to it. */
  function onHotkey(e?: KeyboardEvent): boolean {
    const lone = e ? eventLoneModifier(e, true) : null
    if (lone && needsSoloHold(lone)) return startSolo(lone, e!.repeat)
    return press('key')
  }

  /** The hotkey or fn went down. False: not consumed. */
  function press(from: 'key' | 'fn', fromSolo = false): boolean {
    if (!settings.voiceInputEnabled.value) return false
    // onGuardKeyDown owns the chord's keydowns until it is let go.
    if (from === 'key' && repeatGuard) return false
    if (armed) {
      // onArmedKeyDown owns this keydown (it can see whether it is a repeat).
      if (from === 'key' && source === 'key' && voice.state.handsFree && !chordUp && chords.length > 0) return false
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
      soloTake = fromSolo
      chords = from === 'key' ? holdToTalkChords() : []
      if (from === 'key') {
        window.addEventListener('keyup', onKeyUp, true)
        window.addEventListener('blur', onBlur)
        window.addEventListener('keydown', onArmedKeyDown, true)
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

  registerCommand(HOLD_TO_TALK, (_args, e) => onHotkey(e))

  // ── fn (🌐) key ─────────────────────────────────────────────────────────────
  // Subscribed only while voice input is on and hold-to-talk is bound to fn:
  // the main process runs its helper only while someone is subscribed.
  const rulesTick = ref(0)
  const offRulesChanged = onUserRulesChanged(() => rulesTick.value++)
  function fnPressAllowed(): boolean {
    if (!document.hasFocus() || isKeyCaptureActive()) return false
    const ctx = getContext()
    return holdToTalkFnRules(settings.voiceFnKeyEnabled.value).some((r) => !r.when || evaluateWhen(r.when, ctx))
  }
  let offFnEvent: (() => void) | null = null
  function onFnEvent(type: 'down' | 'up' | 'chord'): void {
    if (type === 'down') {
      if (fnPressAllowed()) press('fn')
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
    () => {
      void rulesTick.value
      return settings.voiceInputEnabled.value && holdToTalkFnRules(settings.voiceFnKeyEnabled.value).length > 0
    },
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
      if (soloTake) voice.cancel()
      else voice.release('blur')
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
      endSolo()
      disarm()
      endRepeatGuard()
      voice.disable()
      if (was) void host.backend.send('voice.shutdown', {}, 10_000).catch(() => {})
    },
    { immediate: true },
  )

  onScopeDispose(() => {
    offPartial()
    offRulesChanged()
    fnListen(false)
    offKeydownSeen()
    endSolo()
    disarm()
    endRepeatGuard()
    window.removeEventListener('focus', onFocus)
    window.removeEventListener('keydown', onTakeKey, true)
    voice.disable()
  })

  return {
    state: voice.state,
    dismiss: voice.dismiss,
  }
}
