import { computed, ref } from 'vue'
import { settingsGet, settingsSet } from '@navide/plugin-ui/shared'
import { whatsNewFor } from '../lib/whatsNew'
import { tourDoneKey, type TourStep } from '../lib/tours'

// The one running release tour. A tour belongs to a version's announcement
// (WhatsNewEntry.tour), and every place that shows the announcement — the
// post-update popup, Help → What's New…, the announcement centre's release row
// — starts it through here, so "done" means the same thing wherever it began.
//
// Module-level so every caller sees the same tour: only one runs at a time.
const activeVersion = ref<string | null>(null)

/** Whether `version`'s announcement carries a tour. */
export function hasReleaseTour(version: string): boolean {
  return (whatsNewFor(version)?.tour?.length ?? 0) > 0
}

export function useReleaseTour() {
  const steps = computed<TourStep[] | null>(() => {
    const version = activeVersion.value
    return version ? (whatsNewFor(version)?.tour ?? null) : null
  })

  /** Start `version`'s tour; false (and nothing starts) when it has none. */
  function start(version: string): boolean {
    if (!hasReleaseTour(version)) return false
    activeVersion.value = version
    return true
  }

  /** End the running tour; only a tour taken to its last step is recorded. */
  function end(completed: boolean): void {
    const version = activeVersion.value
    activeVersion.value = null
    if (completed && version) settingsSet(tourDoneKey(version), true)
  }

  function isDone(version: string): boolean {
    return settingsGet<boolean>(tourDoneKey(version), false) === true
  }

  return { activeVersion, steps, start, end, isDone }
}
