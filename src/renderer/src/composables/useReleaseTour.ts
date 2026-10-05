import { computed, ref, shallowRef } from 'vue'
import { settingsGet, settingsSet } from '@navide/plugin-ui/shared'
import { whatsNewFor } from '../lib/whatsNew'
import { tourDoneKey, type TourStep } from '../lib/tours'

// The one running guided tour. A release tour belongs to a version's
// announcement (WhatsNewEntry.tour), and every place that shows the
// announcement — the post-update popup, Help → What's New…, the announcement
// centre's release row — starts it through here, so "done" means the same
// thing wherever it began. A named tour (the first-run welcome tour) brings its
// own steps and decides for itself what ending it records.
//
// Module-level so every caller sees the same tour: only one runs at a time.
const activeVersion = ref<string | null>(null)
// Set only while a named tour runs; a release tour reads its steps from the
// version's announcement instead.
const named = shallowRef<{
  steps: TourStep[]
  onEnd?: (completed: boolean) => void
  skipOnLast: boolean
  interactive: boolean
} | null>(null)

/** Whether `version`'s announcement carries a tour. */
export function hasReleaseTour(version: string): boolean {
  return (whatsNewFor(version)?.tour?.length ?? 0) > 0
}

export function useReleaseTour() {
  const steps = computed<TourStep[] | null>(() => {
    const version = activeVersion.value
    if (!version) return null
    return named.value ? named.value.steps : (whatsNewFor(version)?.tour ?? null)
  })
  /** Whether the running tour keeps Skip on its last step (GuidedTour's
   *  skipOnLast). Only a named tour can ask for it. */
  const skipOnLast = computed(() => named.value?.skipOnLast ?? false)
  /** Whether the running tour waits for actions (GuidedTour's interactive).
   *  Only a named tour can ask for it. */
  const interactive = computed(() => named.value?.interactive ?? false)

  /** Start `version`'s tour; false (and nothing starts) when it has none or
   *  another tour is running. */
  function start(version: string): boolean {
    if (activeVersion.value || !hasReleaseTour(version)) return false
    activeVersion.value = version
    return true
  }

  /** Start a tour that is not a release's. `id` stands in for the version in
   *  `activeVersion`; `onEnd` gets what `end` was called with, and nothing else
   *  is recorded. `skipOnLast` is for a tour that is one part of a longer
   *  one; `interactive` makes its action cards wait for the person. False
   *  when another tour is running. */
  function startNamed(
    id: string,
    tourSteps: TourStep[],
    onEnd?: (completed: boolean) => void,
    opts: { skipOnLast?: boolean; interactive?: boolean } = {},
  ): boolean {
    if (activeVersion.value || tourSteps.length === 0) return false
    named.value = {
      steps: tourSteps,
      onEnd,
      skipOnLast: opts.skipOnLast ?? false,
      interactive: opts.interactive ?? false,
    }
    activeVersion.value = id
    return true
  }

  /** End the running tour; only a release tour taken to its last step is
   *  recorded. */
  function end(completed: boolean): void {
    const version = activeVersion.value
    const ending = named.value
    activeVersion.value = null
    named.value = null
    if (ending) ending.onEnd?.(completed)
    else if (completed && version) settingsSet(tourDoneKey(version), true)
  }

  function isDone(version: string): boolean {
    return settingsGet<boolean>(tourDoneKey(version), false) === true
  }

  return { activeVersion, steps, skipOnLast, interactive, start, startNamed, end, isDone }
}
