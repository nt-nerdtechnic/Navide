// Reads a key chord straight off the keyboard for a shortcut editor: the
// Settings → Shortcuts table and the Voice Input shortcut row share it, so a
// chord recorded in either place is captured the same way.
import { computed, onScopeDispose, ref } from 'vue'
import { eventToKeyString, setKeyCaptureActive } from '@navide/plugin-ui/shared'

export interface KeyChordRecorderOptions {
  /** Segments a chord may have. Two is the resolver's limit; a key that must
   *  be held (hold-to-talk) takes one. */
  maxSegments?: number
  /** Bare Escape abandoned the recording. */
  onCancel?: () => void
}

export function useKeyChordRecorder(options: KeyChordRecorderOptions = {}) {
  const maxSegments = options.maxSegments ?? 2
  const active = ref(false)
  const segments = ref<string[]>([])

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
    const segment = eventToKeyString(e)
    if (!segment) return // modifiers alone: keep waiting
    // Past the segment limit a chord would parse but never match, so cycle
    // back to a fresh single key instead of silently dead-ending.
    segments.value = segments.value.length >= maxSegments ? [segment] : [...segments.value, segment]
  }

  function start(): void {
    stop()
    active.value = true
    setKeyCaptureActive(true)
    window.addEventListener('keydown', onKeydown, { capture: true })
  }

  function stop(): void {
    if (!active.value) return
    window.removeEventListener('keydown', onKeydown, { capture: true })
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
