// The first-run welcome tour: its steps, and how to tell each was done.
//
// The tour is coach marks, not slides: a small bubble beside the real control
// says the one thing to do there, the whole window stays usable, and once the
// person has done it the bubble moves on to the next control (CoachMark.vue).
// Its job is to leave a new user able to do one thing end to end: pick a
// workspace, open the first agent, give it a first instruction and watch it
// answer — then have two agents work together and see the quota. Only a
// fresh install gets it (useWelcomeTour.ts records that), and Help →
// First-Run Tour… replays it.
//
// Anchors are dedicated `data-tour` attributes so a restyle cannot silently
// move them; welcomeTour.test.ts pins each to the file that renders it. The
// text names no ⌘ shortcut — off macOS ⌘ resolves to the Win/Super key
// (docs/en-US/keybindings.md), so a Windows user would press the wrong thing.

export type WelcomeAction = 'workspace-open' | 'agent-pane' | 'first-command' | 'mention' | 'drop' | 'usage'

/** What the tour knows about the window, for deciding a step is done. */
export interface WelcomeFacts {
  workspaceOpen: boolean
  /** Agent panes on stage: no plain terminals, placeholders or login panes. */
  agentPanes: number
  /** Last keystroke on an agent pane whose CLI is now working (0 = none). */
  commandAt: number
  /** An agent pane has finished a turn before. */
  everCommanded: boolean
  /** When the person last picked an @ address, dropped a pane on another,
   *  or opened the quota badge (0 = never). */
  mentionAt: number
  dropAt: number
  usageAt: number
}

export interface CoachStep {
  id: string
  /** CSS selector of the control the bubble sits beside; may depend on the
   *  window (the @ step points at + until there is a second pane). */
  anchor: (facts: WelcomeFacts) => string
  /** i18n key of the bubble's one line. */
  textKey: string
  /** The action that ends the step. */
  waitFor: WelcomeAction
  /** Pass over the step when its control stays away (a CLI with no quota
   *  data shows no badge). Other steps wait for their control. */
  skipIfMissing?: boolean
}

const T = 'tour.welcome'
const OPEN_AGENT = '[data-tour="open-agent"]'
const TERMINAL = '.xterm-host[data-pane-id]'

export const WELCOME_STEPS: CoachStep[] = [
  {
    id: 'pick-folder',
    anchor: () => '[data-tour="welcome-open-buttons"]',
    textKey: `${T}.pickFolder`,
    waitFor: 'workspace-open',
  },
  { id: 'open-agent', anchor: () => OPEN_AGENT, textKey: `${T}.openAgent`, waitFor: 'agent-pane' },
  { id: 'first-command', anchor: () => TERMINAL, textKey: `${T}.firstCommand`, waitFor: 'first-command' },
  {
    id: 'talk-mention',
    // One pane: it needs a partner first, so the bubble sits at +.
    anchor: (f) => (f.agentPanes < 2 ? OPEN_AGENT : TERMINAL),
    textKey: `${T}.talkMention`,
    waitFor: 'mention',
  },
  {
    id: 'talk-drag',
    // The whole stage: a drag starts on one pane's title bar and ends on
    // another's terminal.
    anchor: () => '[data-tour="pane-stage"]',
    textKey: `${T}.talkDrag`,
    waitFor: 'drop',
  },
  {
    id: 'usage-account',
    anchor: () => '[data-tour="usage-badge"]',
    textKey: `${T}.usageAccount`,
    waitFor: 'usage',
    skipIfMissing: true,
  },
]

/** How long a bubble shows "done" before moving on. */
export const COACH_DONE_MS = 800
/** How long a skipIfMissing step waits for its control before passing over. */
export const COACH_MISSING_SKIP_MS = 3_000
/** How often a bubble re-finds its control (it may move, appear or go). */
export const COACH_TICK_MS = 250

/** Whether a step's action happened since `since`. */
export function welcomeActionDone(action: WelcomeAction, f: WelcomeFacts, since: number): boolean {
  switch (action) {
    case 'workspace-open':
      return f.workspaceOpen
    case 'agent-pane':
      return f.agentPanes >= 1
    case 'first-command':
      return f.commandAt > since
    case 'mention':
      return f.mentionAt > since
    case 'drop':
      return f.dropAt > since
    case 'usage':
      return f.usageAt > since
  }
}

/** Whether a step's action was done before the step came up, so it is passed
 *  over. The two ways agents talk to each other and the quota are never
 *  passed over: everyone should try them once. */
export function welcomeActionAlreadyDone(action: WelcomeAction, f: WelcomeFacts): boolean {
  switch (action) {
    case 'workspace-open':
      return f.workspaceOpen
    case 'agent-pane':
      return f.agentPanes >= 1
    case 'first-command':
      return f.everCommanded
    default:
      return false
  }
}

export type WelcomeTourMove = 'stop' | 'wait' | 'cancel' | 'check-records' | 'mark-eligible' | 'start'

/**
 * What App's poll does next for the first-run tour. "First install" (no
 * workspace open, an empty recent list) is decided first and once — before
 * anything on screen can hold the tour up — and the answer is kept
 * (`eligible`). Deciding it later read the folder the person picked while a
 * modal held the tour back as a record against them, and called it off.
 */
export function nextWelcomeTourMove(s: {
  pending: boolean
  active: boolean
  /** Onboarding has really finished (not a fail-open guess). */
  settled: boolean
  eligible: boolean
  workspaceOpen: boolean
  /** The recent-workspace list was empty; null = not checked yet. */
  recordsEmpty: boolean | null
  /** A modal or the CLI health guide is up. */
  blocked: boolean
}): WelcomeTourMove {
  if (!s.pending) return 'stop'
  if (s.active || !s.settled) return 'wait'
  if (!s.eligible) {
    if (s.workspaceOpen || s.recordsEmpty === false) return 'cancel'
    return s.recordsEmpty === null ? 'check-records' : 'mark-eligible'
  }
  return s.blocked ? 'wait' : 'start'
}
