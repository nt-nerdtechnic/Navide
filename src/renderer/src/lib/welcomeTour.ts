// The first-run welcome tour: what it shows, and when a pane is ready for it.
//
// Two short parts walked by GuidedTour.vue. The main-screen part shows where a
// CLI pane is opened once the first workspace is open; the pane part explains
// a pane once the first one has come to rest. Only a fresh install gets them
// (useWelcomeTour.ts records that), and Help → First-Run Tour… replays both.
//
// No step has a `prepare`: the tour only points, it never opens, closes or
// types into anything. Anchors are dedicated `data-tour` attributes so a
// restyle cannot silently move them; welcomeTour.test.ts pins each to the file
// that renders it. The text names no ⌘ shortcut — off macOS ⌘ resolves to the
// Win/Super key (docs/en-US/keybindings.md), so a Windows user would press the
// wrong thing.

import type { TourStep } from './tours'

const T = 'tour.welcome'

export const WELCOME_MAIN_STEPS: TourStep[] = [
  {
    id: 'open-agent',
    anchor: '[data-tour="open-agent"]',
    titleKey: `${T}.openAgent.title`,
    bodyKey: `${T}.openAgent.body`,
    missingKey: `${T}.openAgent.missing`,
  },
  {
    id: 'sidebar-views',
    anchor: '[data-tour="sidebar-views"]',
    titleKey: `${T}.sidebarViews.title`,
    bodyKey: `${T}.sidebarViews.body`,
    missingKey: `${T}.sidebarViews.missing`,
  },
  {
    id: 'settings',
    anchor: '[data-tour="settings"]',
    titleKey: `${T}.settings.title`,
    bodyKey: `${T}.settings.body`,
    missingKey: `${T}.settings.missing`,
  },
]

export const WELCOME_PANE_STEPS: TourStep[] = [
  {
    id: 'pane-name',
    anchor: '[data-tour="pane-title"]',
    titleKey: `${T}.paneName.title`,
    bodyKey: `${T}.paneName.body`,
    missingKey: `${T}.paneName.missing`,
  },
  {
    id: 'typing',
    anchor: '.xterm-host[data-pane-id]',
    titleKey: `${T}.typing.title`,
    bodyKey: `${T}.typing.body`,
    missingKey: `${T}.typing.missing`,
  },
  {
    id: 'usage',
    anchor: '[data-tour="usage-badge"]',
    titleKey: `${T}.usage.title`,
    bodyKey: `${T}.usage.body`,
    missingKey: `${T}.usage.missing`,
  },
  {
    id: 'groups',
    anchor: '[data-tour="stage-tabs"]',
    titleKey: `${T}.groups.title`,
    bodyKey: `${T}.groups.body`,
    missingKey: `${T}.groups.missing`,
  },
  {
    id: 'more',
    titleKey: `${T}.more.title`,
    bodyKey: `${T}.more.body`,
  },
]

/** Help → First-Run Tour…: both parts as one walk. */
export const WELCOME_REPLAY_STEPS: TourStep[] = [...WELCOME_MAIN_STEPS, ...WELCOME_PANE_STEPS]

export type WelcomeStage = 'off' | 'main' | 'pane'

/** Which part is due: none unless a first run left the tour pending. */
export function welcomeStage(state: { pending: boolean; mainDone: boolean }): WelcomeStage {
  if (!state.pending) return 'off'
  return state.mainDone ? 'pane' : 'main'
}

/** A keystroke this recent means someone is typing into the pane. */
export const PANE_TOUR_TYPING_QUIET_MS = 5_000
/** A pane busy this long since it was first seen gets the tour anyway. Every
 *  CLI reaches 'idle' the same way — 10s of clean silence after its first
 *  output (useTerminal.ts displayStatus) — so this only catches one that keeps
 *  printing; the replay in the Help menu covers the rest. */
export const PANE_TOUR_RUNNING_FALLBACK_MS = 120_000

export interface WelcomePaneProbe {
  agentKey: string
  /** False for a restore placeholder, which has no terminal yet. */
  realized: boolean
  /** A throwaway sign-in pane that closes itself once the login lands. */
  loginPane: boolean
  /** TerminalPane's displayStatus. */
  status: string | undefined
  hasDraft: boolean
  msSinceLastKey: number
  /** Since the poll first saw this pane. */
  msSinceSeen: number
}

/** Whether the pane part may start over this pane now. */
export function paneTourReady(p: WelcomePaneProbe): boolean {
  if (p.agentKey === 'terminal' || !p.realized || p.loginPane) return false
  if (p.hasDraft || p.msSinceLastKey < PANE_TOUR_TYPING_QUIET_MS) return false
  if (p.status === 'idle') return true
  return p.status === 'running' && p.msSinceSeen >= PANE_TOUR_RUNNING_FALLBACK_MS
}
