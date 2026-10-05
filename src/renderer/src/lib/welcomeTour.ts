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
/** How long a first-run bubble waits for a missing control before showing in
 *  the middle, saying so, with Next — never sitting unseen. */
export const COACH_MISSING_CENTRE_MS = 2_000
/** How often a bubble re-finds its control (it may move, appear or go). */
export const COACH_TICK_MS = 250
/** How long a bubble stays out of the way once the person presses the
 *  control it points at (a menu it opens would sit under the bubble). */
export const COACH_ASIDE_MS = 15_000

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

export type WelcomeTourMove = 'stop' | 'wait' | 'cancel' | 'check' | 'mark-eligible' | 'start'

/** Where the first-install check stands this session. */
export type WelcomeTourDecision = 'unchecked' | 'checking' | 'first-install' | 'not-first-install'

/**
 * Whether this is a first install, judged by the window as the check began:
 * no workspace open then, and no recent workspace opened before then. A
 * folder picked while the answer was on its way — at launch it can take a
 * while — is the person starting the tour's first step, not a record against
 * them. A record that cannot be dated counts against them, to be safe.
 */
export function isFirstInstall(s: {
  workspaceOpenAtStart: boolean
  recents: readonly { last_opened_at?: string }[]
  checkStartedAt: number
}): boolean {
  if (s.workspaceOpenAtStart) return false
  return s.recents.every((r) => {
    const at = r.last_opened_at ? Date.parse(r.last_opened_at) : NaN
    return Number.isFinite(at) && at >= s.checkStartedAt
  })
}

/** How many times the first-install check asks for the recent list. */
export const WELCOME_RECORD_TRIES = 3
/** The wait before each retry; it grows, since a launch-time backend is busy. */
const WELCOME_RECORD_BACKOFF_MS = [2_000, 5_000]

/**
 * Ask for the recent-workspace list and judge "first install" from it (see
 * isFirstInstall), retrying a failed or thrown answer with a growing wait. One
 * slow launch-time request must not call the tour off for good: only when every
 * try fails is it given up on — safely, as "not a first install" — and logged.
 * The window is judged as the first try began, however late the answer.
 */
export async function decideFirstInstall(s: {
  workspaceOpenAtStart: boolean
  checkStartedAt: number
  fetchRecents: () => Promise<{ ok: boolean; recent?: { last_opened_at?: string }[] }>
  sleep: (ms: number) => Promise<void>
  warn: (message: string) => void
}): Promise<'first-install' | 'not-first-install'> {
  for (let attempt = 1; ; attempt++) {
    try {
      const resp = await s.fetchRecents()
      if (resp.ok) {
        return isFirstInstall({
          workspaceOpenAtStart: s.workspaceOpenAtStart,
          recents: resp.recent ?? [],
          checkStartedAt: s.checkStartedAt,
        })
          ? 'first-install'
          : 'not-first-install'
      }
    } catch {
      // Retried below, like a refused answer.
    }
    if (attempt >= WELCOME_RECORD_TRIES) {
      s.warn(`[welcome-tour] the recent-workspace list failed ${attempt} times; leaving the first-run tour off`)
      return 'not-first-install'
    }
    await s.sleep(WELCOME_RECORD_BACKOFF_MS[attempt - 1] ?? WELCOME_RECORD_BACKOFF_MS.at(-1)!)
  }
}

/**
 * What App's poll does next for the first-run tour. "First install" is
 * decided first and once — before anything on screen can hold the tour up —
 * and the answer is kept (`eligible`); after that only a clear screen is
 * waited for.
 */
export function nextWelcomeTourMove(s: {
  pending: boolean
  active: boolean
  /** Onboarding has really finished (not a fail-open guess). */
  settled: boolean
  eligible: boolean
  decision: WelcomeTourDecision
  /** A modal or the CLI health guide is up. */
  blocked: boolean
}): WelcomeTourMove {
  if (!s.pending) return 'stop'
  if (s.active || !s.settled) return 'wait'
  if (!s.eligible) {
    switch (s.decision) {
      case 'unchecked':
        return 'check'
      case 'checking':
        return 'wait'
      case 'first-install':
        return 'mark-eligible'
      case 'not-first-install':
        return 'cancel'
    }
  }
  return s.blocked ? 'wait' : 'start'
}
