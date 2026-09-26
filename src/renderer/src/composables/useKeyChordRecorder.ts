// Reads a key chord straight off the keyboard for a shortcut editor: the
// Settings → Shortcuts table and the Voice Input shortcut row share it, so a
// chord recorded in either place is captured the same way.
import { computed, onScopeDispose, ref } from 'vue'
import { eventLoneModifier, eventToKeyString, MODIFIER_KEYS, setKeyCaptureActive } from '@navide/plugin-ui/shared'

export interface KeyChordRecorderOptions {
  /** Segments a chord may have. Two is the resolver's limit; a key that must
   *  be held (hold-to-talk) takes one. */
  maxSegments?: number
  /** Bare Escape abandoned the recording. */
  onCancel?: () => void
  /** Record a modifier pressed and released by itself ('rightalt'). Only for
   *  a key that is held (hold-to-talk): as a command key it would fire on
   *  every combination that modifier starts. start() may override it per
   *  recording (the Shortcuts table allows it on the hold-to-talk row). */
  allowLoneModifier?: boolean
}

/**
 * Why the last key press recorded nothing, so the recorder never looks dead:
 *   'composing'     an input method is composing; its keys are its own
 *   'unidentified'  the key reports no usable name or code
 *   'modifier-held' a modifier is down: add a key, or (where a modifier by
 *                   itself is allowed) let go to record it alone
 *   'modifier-only' a modifier was pressed and released by itself where that
 *                   is not a key (every command row but hold-to-talk)
 */
export type KeyRecorderNoticeReason = 'composing' | 'unidentified' | 'modifier-held' | 'modifier-only'

export interface KeyRecorderNotice {
  reason: KeyRecorderNoticeReason
  /** The rule spelling of the key concerned ('rightalt'), when there is one. */
  key?: string
  /** Whether a modifier by itself can be recorded in this recording. */
  loneAllowed: boolean
}

export function useKeyChordRecorder(options: KeyChordRecorderOptions = {}) {
  const maxSegments = options.maxSegments ?? 2
  const active = ref(false)
  const segments = ref<string[]>([])
  const notice = ref<KeyRecorderNotice | null>(null)
  // The modifier that went down by itself and has not been combined yet.
  let loneDown: string | null = null
  let loneAllowed = false

  function record(segment: string): void {
    notice.value = null
    // Past the segment limit a chord would parse but never match, so cycle
    // back to a fresh single key instead of silently dead-ending.
    segments.value = segments.value.length >= maxSegments ? [segment] : [...segments.value, segment]
  }

  function note(reason: KeyRecorderNoticeReason, key?: string | null): void {
    notice.value = { reason, loneAllowed, ...(key ? { key } : {}) }
  }

  function onKeyup(e: KeyboardEvent): void {
    const key = eventLoneModifier(e, false)
    if (key && key === loneDown) {
      if (loneAllowed) record(key)
      else note('modifier-only', key)
    } else if (notice.value?.reason === 'modifier-held') {
      // Let go after a combination (or a second modifier): nothing is pending.
      notice.value = null
    }
    loneDown = null
  }

  function onKeydown(e: KeyboardEvent): void {
    // The recorder swallows the event outright rather than letting the dispatcher
    // see it, so nothing it captures can fire a command mid-recording.
    e.preventDefault()
    e.stopImmediatePropagation()
    if (e.isComposing) {
      note('composing')
      return
    }
    // Bare Escape abandons the recording — the convention every editor follows.
    // Without it the recorder has no keyboard exit at all: Escape, Tab and Enter
    // are all swallowed, leaving keyboard-only users stuck until they reach for
    // the mouse. Modified Escape (⇧Esc and the like) stays recordable, and plain
    // Escape can still be bound by hand in keybindings.json if someone wants it.
    if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      stop()
      options.onCancel?.()
      return
    }
    if (MODIFIER_KEYS.has(e.key)) {
      // Recorded on its keyup, if nothing is combined with it before then.
      loneDown = e.repeat ? loneDown : eventLoneModifier(e, true)
      if (!e.repeat) note('modifier-held', loneDown)
      return
    }
    loneDown = null
    const segment = eventToKeyString(e)
    if (!segment) {
      // No identifiable key: keep waiting, but say so.
      note('unidentified')
      return
    }
    record(segment)
  }

  function start(allowLoneModifier = options.allowLoneModifier): void {
    stop()
    active.value = true
    loneAllowed = !!allowLoneModifier
    setKeyCaptureActive(true)
    window.addEventListener('keydown', onKeydown, { capture: true })
    // Followed either way: a lone modifier that cannot be recorded still says why.
    window.addEventListener('keyup', onKeyup, { capture: true })
  }

  /** Records a key no KeyboardEvent carries (fn, from the native helper) as the whole chord. */
  function recordKey(spec: string): void {
    if (!active.value) return
    loneDown = null
    notice.value = null
    segments.value = [spec]
  }

  function stop(): void {
    if (!active.value) return
    window.removeEventListener('keydown', onKeydown, { capture: true })
    window.removeEventListener('keyup', onKeyup, { capture: true })
    loneDown = null
    setKeyCaptureActive(false)
    active.value = false
    segments.value = []
    notice.value = null
  }

  function clear(): void {
    segments.value = []
    notice.value = null
  }

  onScopeDispose(stop)

  return {
    active,
    /** The chord recorded so far ('' before the first key). */
    spec: computed(() => segments.value.join(' ')),
    /** Why the last press recorded nothing (null once a key is recorded). */
    notice,
    start,
    recordKey,
    stop,
    clear,
  }
}
