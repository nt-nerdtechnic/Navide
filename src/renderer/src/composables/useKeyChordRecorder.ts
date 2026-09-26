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

export function useKeyChordRecorder(options: KeyChordRecorderOptions = {}) {
  const maxSegments = options.maxSegments ?? 2
  const active = ref(false)
  const segments = ref<string[]>([])
  // The modifier that went down by itself and has not been combined yet.
  let loneDown: string | null = null

  function record(segment: string): void {
    // Past the segment limit a chord would parse but never match, so cycle
    // back to a fresh single key instead of silently dead-ending.
    segments.value = segments.value.length >= maxSegments ? [segment] : [...segments.value, segment]
  }

  function onKeyup(e: KeyboardEvent): void {
    const key = eventLoneModifier(e, false)
    if (key && key === loneDown) record(key)
    loneDown = null
  }

  function onKeydown(e: KeyboardEvent): void {
    // The recorder swallows the event outright rather than letting the dispatcher
    // see it, so nothing it captures can fire a command mid-recording.
    e.preventDefault()
    e.stopImmediatePropagation()
    if (e.isComposing) return
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
      return
    }
    loneDown = null
    const segment = eventToKeyString(e)
    if (!segment) return // no identifiable key: keep waiting
    record(segment)
  }

  function start(allowLoneModifier = options.allowLoneModifier): void {
    stop()
    active.value = true
    setKeyCaptureActive(true)
    window.addEventListener('keydown', onKeydown, { capture: true })
    if (allowLoneModifier) window.addEventListener('keyup', onKeyup, { capture: true })
  }

  function stop(): void {
    if (!active.value) return
    window.removeEventListener('keydown', onKeydown, { capture: true })
    window.removeEventListener('keyup', onKeyup, { capture: true })
    loneDown = null
    setKeyCaptureActive(false)
    active.value = false
    segments.value = []
  }

  function clear(): void {
    segments.value = []
  }

  onScopeDispose(stop)

  return {
    active,
    /** The chord recorded so far ('' before the first key). */
    spec: computed(() => segments.value.join(' ')),
    start,
    stop,
    clear,
  }
}
