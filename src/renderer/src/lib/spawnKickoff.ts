/**
 * spawnKickoff.ts
 *
 * The two decisions kickoffRequestedPane (App.vue) makes that nothing could
 * test: whether an attempt at typing a new pane's task settles or is typed
 * again, and reporting the verdict back to the cli_open_agent call waiting on
 * it. Both used to live inline in a 15K-line component the suite cannot mount,
 * so they were only ever asserted as source text.
 */

import { kickoffVerified, type EchoEvidence, type SubmitEvidence } from './injectEcho'

/** How a pane's spawn-time task injection ended. `unverified` is the honest
 *  middle: bytes written, nothing observed — which is also the state where a
 *  resend would submit two copies as one prompt. */
export type KickoffVerdict = 'sent' | 'unverified' | 'failed'

export interface KickoffAttemptInput {
  /** injectPane's own answer: false when the bytes never went out. */
  injected: boolean
  echo: EchoEvidence | null
  submit: SubmitEvidence | null
  /** Whether the prompt-ready gate opened before typing — see kickoffVerified. */
  promptReady: boolean
  /** Is the composer holding the copy we just typed? Lazy: reading the screen
   *  costs a buffer scan, and only the retype decision needs the answer. */
  composerHolds: () => boolean
  attempt: number
  maxAttempts: number
}

export interface KickoffAttemptVerdict {
  outcome: KickoffVerdict
  /** `retype` types the payload again; `stop` settles on `outcome`. */
  next: 'stop' | 'retype'
  /** Settled failed only because every attempt came back unverified — as
   *  opposed to an injection that reported failure outright, which has already
   *  logged its own diagnostic. */
  retriedOut: boolean
}

/** What to do after one attempt at typing a new pane's task.
 *
 *  Order is load-bearing, and the composer question comes first — on the last
 *  attempt too. What the caller must do next is decided by whether our copy is
 *  sitting in the composer unsent, not by how many times we typed it: 'failed'
 *  tells cli_open_agent's caller to resend with cli_send, and a resend lands a
 *  second copy on top of the one already there, which the next Enter submits as
 *  one prompt. That is the same duplication the retype guard exists to prevent,
 *  arriving one step later. 'unverified' is the verdict that sends the caller
 *  to cli_get_status first, which is exactly right for a composer that is
 *  holding the task. Count only decides the blank-composer case: nothing left
 *  to protect, so say plainly that we typed it and never saw it. */
export function kickoffAttemptOutcome(input: KickoffAttemptInput): KickoffAttemptVerdict {
  if (!input.injected) return { outcome: 'failed', next: 'stop', retriedOut: false }
  if (kickoffVerified(input.echo, input.submit, input.promptReady)) {
    return { outcome: 'sent', next: 'stop', retriedOut: false }
  }
  // Retype only into a blank composer: a second copy typed on top of the first
  // is submitted with it as one prompt. Holding the first copy is why this
  // stays 'unverified' rather than becoming a failure — the same reason a
  // cli_send resend is the wrong cure for it.
  if (input.composerHolds()) return { outcome: 'unverified', next: 'stop', retriedOut: false }
  if (input.attempt >= input.maxAttempts) {
    return { outcome: 'failed', next: 'stop', retriedOut: true }
  }
  return { outcome: 'unverified', next: 'retype', retriedOut: false }
}

/** What one attempt at typing the task observed. Produced by the caller's
 *  `inject`, because only it can write to a PTY — the loop below only reads
 *  it. Each call returns its OWN evidence: reusing the previous attempt's was
 *  a live hazard while the loop lived inline, where one mutable `evidence`
 *  object was reset by hand at the top of every iteration. */
export interface KickoffAttemptEvidence {
  injected: boolean
  echo: EchoEvidence | null
  submit: SubmitEvidence | null
}

export interface KickoffLoopDeps {
  maxAttempts: number
  /** The prompt-ready gate's answer, sampled ONCE before the first attempt. A
   *  value rather than a callback on purpose: it describes the pane we started
   *  typing into, and re-reading it after we have typed would ask whether the
   *  pane is quiet while we are the reason it is not. */
  promptReady: boolean
  /** Type the payload. `attempt` is 1-based and is the loop's own counter. */
  inject: (attempt: number) => Promise<KickoffAttemptEvidence>
  composerHolds: () => boolean
  /** False once the pane is gone; the loop abandons rather than typing into
   *  a dead session. */
  paneAlive: () => boolean
  onRetry: (info: {
    attempt: number
    echo: EchoEvidence | null
    submit: SubmitEvidence | null
  }) => void
}

export type KickoffLoopResult =
  | { settled: false }
  | {
      settled: true
      outcome: KickoffVerdict
      retriedOut: boolean
      /** Of the attempt that settled it — never an earlier one. */
      echo: EchoEvidence | null
      submit: SubmitEvidence | null
    }

/** Type a new pane's task, and type it again if the first copy cannot be
 *  accounted for and the composer is empty.
 *
 *  The loop itself, not just the per-attempt decision: the decision was
 *  already testable and the loop around it was not, so passing the wrong
 *  variable into it — the previous attempt's evidence, a counter that never
 *  advanced, a gate answer re-read after we had typed — was invisible to the
 *  suite. Everything that touches the pane arrives as a dependency, which is
 *  what lets this run under test at all: kickoffRequestedPane lives in a
 *  15K-line component the suite cannot mount. */
export async function runKickoffAttempts(deps: KickoffLoopDeps): Promise<KickoffLoopResult> {
  let last: KickoffAttemptEvidence = { injected: false, echo: null, submit: null }
  for (let attempt = 1; attempt <= deps.maxAttempts; attempt++) {
    last = await deps.inject(attempt)
    const verdict = kickoffAttemptOutcome({
      injected: last.injected,
      echo: last.echo,
      submit: last.submit,
      promptReady: deps.promptReady,
      composerHolds: deps.composerHolds,
      attempt,
      maxAttempts: deps.maxAttempts,
    })
    if (verdict.next === 'stop') {
      return {
        settled: true,
        outcome: verdict.outcome,
        retriedOut: verdict.retriedOut,
        echo: last.echo,
        submit: last.submit,
      }
    }
    // Between the decision to retype and the retype itself: the pane can close
    // while a slow injection is in flight, and the caller reports the verdict
    // from its own `finally` in that case.
    if (!deps.paneAlive()) return { settled: false }
    deps.onRetry({ attempt, echo: last.echo, submit: last.submit })
  }
  // Not reachable: kickoffAttemptOutcome always answers 'stop' on the last
  // attempt. Kept so a future change to that rule cannot silently fall out of
  // the loop with no verdict at all.
  return { settled: true, outcome: 'failed', retriedOut: true, echo: last.echo, submit: last.submit }
}

/** One-shot reporter for the `agent_spawn.kickoff` event.
 *
 *  cli_open_agent blocks on exactly one verdict per request: a second is
 *  dropped by the backend (its future is already resolved) and a missing one
 *  costs the caller the full kickoff deadline. kickoffRequestedPane reports
 *  from whichever branch settles AND from its `finally`, so "at most once" has
 *  to be the reporter's guarantee rather than the caller's discipline.
 *
 *  `requestId` is empty on the SPAWN-block path, where no MCP call is waiting;
 *  the reporter then sends nothing. A send that throws still counts as
 *  reported — the tool call times out and says so, and a retry from the
 *  `finally` would only report the wrong verdict. */
export function createKickoffReporter(opts: {
  requestId: string | undefined
  paneId: string
  send: (payload: Record<string, unknown>) => void
}): (kickoff: KickoffVerdict, reason?: string) => void {
  let reported = false
  return (kickoff, reason) => {
    if (!opts.requestId || reported) return
    reported = true
    const payload: Record<string, unknown> = {
      request_id: opts.requestId,
      pane_id: opts.paneId,
      kickoff,
    }
    if (reason) payload.reason = reason
    try {
      opts.send(payload)
    } catch { /* the tool call times out and says so */ }
  }
}
