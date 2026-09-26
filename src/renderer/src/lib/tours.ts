// Guided tours: the engine behind a release announcement's walkthrough.
//
// A tour is not registered anywhere on its own — it is the `tour` field of a
// version's entry in lib/whatsNew.ts, next to that version's highlights, so a
// release announces what changed and shows where it lives in one edit. This
// file holds the step shape and the helpers; GuidedTour.vue walks the steps and
// App.vue runs each step's `prepare` (open a Settings tab, close Settings)
// before the step looks for its anchor. See docs/en-US/release-announcements.md.
//
// An anchor is a CSS selector. It may match nothing — no pane open, a Settings
// page not rendered yet, a feature hidden on this platform — and the step then
// shows as a centred card with the same text instead of failing the tour.

/** Something App.vue does before a step looks for its anchor. */
export type TourPrepare =
  | { kind: 'settings'; tab: 'channels' | 'voice' }
  | { kind: 'close-settings' }

export interface TourStep {
  /** Stable id, used by tests and as the Vue key. */
  id: string
  /** CSS selector of the element to spotlight; omitted = a centred card. */
  anchor?: string
  prepare?: TourPrepare
  /** i18n keys, under tourI18nNamespace(version) in all three locales. */
  titleKey: string
  bodyKey: string
  /**
   * Shown under the body when the anchor could not be found, saying where the
   * thing lives instead of pointing at it.
   */
  missingKey?: string
}

/** Settings key recording that a version's tour was taken to its last step. */
export function tourDoneKey(version: string): string {
  return `agentTeam.tour.v${version}.done`
}

/**
 * The i18n namespace a version's tour text must live under, e.g.
 * `tour.v0_2_10` for 0.2.10 — so a tour's strings can be found (and orphaned
 * ones caught) from the version alone.
 */
export function tourI18nNamespace(version: string): string {
  return `tour.v${version.replace(/\./g, '_')}`
}

/**
 * The first element matching `selector` that is actually laid out. Settings
 * pages are `v-show`n, so a hidden one still matches the selector — only a
 * non-empty box counts as found.
 */
export function findTourAnchor(selector: string, root: ParentNode = document): HTMLElement | null {
  let nodes: NodeListOf<Element>
  try {
    nodes = root.querySelectorAll(selector)
  } catch {
    return null
  }
  for (const node of nodes) {
    const rect = (node as HTMLElement).getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) return node as HTMLElement
  }
  return null
}
