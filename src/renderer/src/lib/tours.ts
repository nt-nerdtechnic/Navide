// Guided tours: short, step-by-step walkthroughs that point at the real UI.
//
// A tour is data — a list of steps, each naming the element it points at and
// the i18n keys of its text — so a release can add one without touching the
// GuidedTour component. A What's New entry offers a tour by id (its `tour`
// field); App.vue runs each step's `prepare` (open a Settings tab, close
// Settings) before the step looks for its anchor.
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
  /** i18n keys (packages/plugin-ui/.../locales, `tour.*`). */
  titleKey: string
  bodyKey: string
  /**
   * Shown under the body when the anchor could not be found, saying where the
   * thing lives instead of pointing at it.
   */
  missingKey?: string
}

export const TOURS: Record<string, TourStep[]> = {
  'v0.2.10': [
    {
      id: 'welcome',
      prepare: { kind: 'close-settings' },
      titleKey: 'tour.v0_2_10.welcome.title',
      bodyKey: 'tour.v0_2_10.welcome.body',
    },
    {
      id: 'channels-settings',
      prepare: { kind: 'settings', tab: 'channels' },
      anchor: '[data-settings-section="channels"]',
      titleKey: 'tour.v0_2_10.channelsSettings.title',
      bodyKey: 'tour.v0_2_10.channelsSettings.body',
      missingKey: 'tour.v0_2_10.channelsSettings.missing',
    },
    {
      id: 'channels-pane',
      prepare: { kind: 'close-settings' },
      anchor: '[data-testid="channel-connect"], [data-testid="channel-chip"]',
      titleKey: 'tour.v0_2_10.channelsPane.title',
      bodyKey: 'tour.v0_2_10.channelsPane.body',
      missingKey: 'tour.v0_2_10.channelsPane.missing',
    },
    {
      id: 'voice-settings',
      prepare: { kind: 'settings', tab: 'voice' },
      anchor: '[data-settings-section="voice"]',
      titleKey: 'tour.v0_2_10.voiceSettings.title',
      bodyKey: 'tour.v0_2_10.voiceSettings.body',
      missingKey: 'tour.v0_2_10.voiceSettings.missing',
    },
    {
      id: 'voice-dictate',
      prepare: { kind: 'close-settings' },
      anchor: '.xterm-host[data-pane-id]',
      titleKey: 'tour.v0_2_10.voiceDictate.title',
      bodyKey: 'tour.v0_2_10.voiceDictate.body',
      missingKey: 'tour.v0_2_10.voiceDictate.missing',
    },
    {
      id: 'done',
      titleKey: 'tour.v0_2_10.done.title',
      bodyKey: 'tour.v0_2_10.done.body',
    },
  ],
}

/** Settings key recording that a tour was taken to its last step. */
export function tourDoneKey(id: string): string {
  return `agentTeam.tour.${id}.done`
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
