// The first-run welcome tour: what it shows, and when a pane is ready for it.
//
// Its job is to leave a new user able to do one thing end to end: pick a
// workspace, open the first agent, give it a first instruction and watch it
// answer. Three short parts, each where the person actually is at that point
// of that path — the Welcome screen, the first main screen, the first pane
// once it is waiting for input — and every card names the action to take
// next. Anything off the path is a line on the last card, not a card of its
// own. Only a fresh install gets the tour (useWelcomeTour.ts records that),
// and Help → First-Run Tour… replays all three parts.
//
// No step has a `prepare`: the tour only points, it never opens, closes or
// types into anything. Anchors are dedicated `data-tour` attributes so a
// restyle cannot silently move them; welcomeTour.test.ts pins each to the file
// that renders it. The text names no ⌘ shortcut — off macOS ⌘ resolves to the
// Win/Super key (docs/en-US/keybindings.md), so a Windows user would press the
// wrong thing.

import type { TourStep } from './tours'

const T = 'tour.welcome'

/** On Welcome: why a folder comes first, then pick one. */
export const WELCOME_START_STEPS: TourStep[] = [
  {
    id: 'why-folder',
    anchor: '[data-tour="welcome-open"]',
    titleKey: `${T}.whyFolder.title`,
    bodyKey: `${T}.whyFolder.body`,
    missingKey: `${T}.whyFolder.missing`,
  },
  {
    id: 'pick-folder',
    anchor: '[data-tour="welcome-open-buttons"]',
    waitFor: 'workspace-open',
    titleKey: `${T}.pickFolder.title`,
    bodyKey: `${T}.pickFolder.body`,
    missingKey: `${T}.pickFolder.missing`,
    primaryKey: `${T}.pickFolder.go`,
  },
]

/** On the first main screen: open the first agent. */
export const WELCOME_MAIN_STEPS: TourStep[] = [
  {
    id: 'open-agent',
    anchor: '[data-tour="open-agent"]',
    waitFor: 'agent-pane',
    titleKey: `${T}.openAgent.title`,
    bodyKey: `${T}.openAgent.body`,
    missingKey: `${T}.openAgent.missing`,
    primaryKey: `${T}.openAgent.go`,
  },
]

/** On the first pane once it waits for input: the first instruction, the two
 *  ways to have one agent work with another, the quota and account, then what
 *  to try next. */
export const WELCOME_PANE_STEPS: TourStep[] = [
  {
    id: 'first-command',
    anchor: '.xterm-host[data-pane-id]',
    waitFor: 'first-command',
    titleKey: `${T}.firstCommand.title`,
    bodyKey: `${T}.firstCommand.body`,
    missingKey: `${T}.firstCommand.missing`,
  },
  {
    id: 'open-second',
    anchor: '[data-tour="open-agent"]',
    waitFor: 'second-pane',
    titleKey: `${T}.openSecond.title`,
    bodyKey: `${T}.openSecond.body`,
    missingKey: `${T}.openSecond.missing`,
  },
  {
    id: 'talk-mention',
    anchor: '.xterm-host[data-pane-id]',
    waitFor: 'mention',
    titleKey: `${T}.talkMention.title`,
    bodyKey: `${T}.talkMention.body`,
    missingKey: `${T}.talkMention.missing`,
  },
  {
    id: 'talk-drag',
    // The whole stage: the drag starts on one pane's title bar and ends on
    // another's terminal, and both have to be inside the spotlight to take it.
    anchor: '[data-tour="pane-stage"]',
    waitFor: 'drop',
    titleKey: `${T}.talkDrag.title`,
    bodyKey: `${T}.talkDrag.body`,
    missingKey: `${T}.talkDrag.missing`,
  },
  {
    id: 'usage-account',
    anchor: '[data-tour="usage-badge"]',
    waitFor: 'usage',
    skipIfMissing: true,
    titleKey: `${T}.usageAccount.title`,
    bodyKey: `${T}.usageAccount.body`,
    missingKey: `${T}.usageAccount.missing`,
  },
  {
    id: 'more',
    titleKey: `${T}.more.title`,
    bodyKey: `${T}.more.body`,
  },
]

/** Help → First-Run Tour…: all three parts as one walk. */
export const WELCOME_REPLAY_STEPS: TourStep[] = [
  ...WELCOME_START_STEPS,
  ...WELCOME_MAIN_STEPS,
  ...WELCOME_PANE_STEPS,
]

export type WelcomeStage = 'off' | 'start' | 'main' | 'pane'

/** Which part is due: none unless a first run left the tour pending, then
 *  each part once the one before it is done. */
export function welcomeStage(state: { pending: boolean; startDone: boolean; mainDone: boolean }): WelcomeStage {
  if (!state.pending) return 'off'
  if (!state.startDone) return 'start'
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

/** What the first-run tour knows about the window, for its action cards. */
export interface WelcomeFacts {
  workspaceOpen: boolean
  /** Agent panes on stage: no plain terminals, placeholders or login panes. */
  agentPanes: number
  /** Last keystroke on an agent pane whose CLI is now working (0 = none). */
  commandAt: number
  /** Someone has typed into an agent pane before. */
  everCommanded: boolean
  /** When the person last picked an @ address, dropped a pane on another,
   *  or opened the quota badge (0 = never). */
  mentionAt: number
  dropAt: number
  usageAt: number
}

/** Whether a card's action (its `waitFor`) happened since `since`. */
export function welcomeActionDone(action: string, f: WelcomeFacts, since: number): boolean {
  switch (action) {
    case 'workspace-open':
      return f.workspaceOpen
    case 'agent-pane':
      return f.agentPanes >= 1
    case 'second-pane':
      return f.agentPanes >= 2
    case 'first-command':
      return f.commandAt > since
    case 'mention':
      return f.mentionAt > since
    case 'drop':
      return f.dropAt > since
    case 'usage':
      return f.usageAt > since
    default:
      return false
  }
}

/** Whether a card's action was done before the card came up, so the card is
 *  passed over. The two ways agents talk to each other are never passed
 *  over: everyone should try them once. */
export function welcomeActionAlreadyDone(action: string, f: WelcomeFacts): boolean {
  switch (action) {
    case 'workspace-open':
      return f.workspaceOpen
    case 'agent-pane':
      return f.agentPanes >= 1
    case 'second-pane':
      return f.agentPanes >= 2
    case 'first-command':
      return f.everCommanded
    default:
      return false
  }
}
