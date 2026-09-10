/** Watchdog verdict for a Manager-mode stage.
 *
 *  In Manager mode the per-pane stage watchers are deliberately skipped — the
 *  stage ends when the Manager prints ---STAGE-DONE---, which the router poll
 *  reads out of the Manager pane's buffer. That leaves three ways for the stage
 *  to hang with no signal at all:
 *    • the commander slot never gets a pane (its agentKey is gone from
 *      agentSpecs, so spawnPane returns null): the router is wired by the worker
 *      slots and polls a Manager that does not exist;
 *    • the Manager pane goes away (closed, CLI crash, exit 127): the router
 *      keeps polling an empty buffer forever;
 *    • nothing ever prints the sentinel: the hard cap that backstops normal
 *      stages lives inside the skipped watcher, so it never fires either.
 *
 *  All three are decided here as a pure function so the rule is testable outside
 *  App.vue's <script setup> closure.
 */

export type ManagerStageVerdict = 'ok' | 'manager-gone' | 'timeout' | 'quota'

export interface ManagerStageProbe {
  /** Empty until the Manager pane has been spawned — and permanently empty when
   *  the commander slot never produced one. `armedAt` is what tells the two
   *  apart. */
  managerPaneId: string
  /** The Manager pane exists AND is realized (a placeholder is not alive). */
  managerPaneAlive: boolean
  /** When the stage's router poll started (0 = not armed yet). */
  armedAt: number
  now: number
  /** Stage hard cap; <= 0 disables the timeout arm. */
  maxDurationMs: number
  /** The Manager pane's CLI has announced it is out of quota (see
   *  lib/cliUsageLimit). Its own arm of the verdict, rather than being folded
   *  into the cap, because the cap says nothing about WHY the silence started
   *  and takes an hour to say even that.
   *
   *  Optional so the eleven existing call sites in the tests keep compiling
   *  untouched — the arm below is skipped when it is absent, which is exactly
   *  the behaviour they were written against. */
  managerQuotaBlocked?: boolean
}

/** What Full auto does when the stall prompt's grace period expires.
 *
 *  Full auto means "do not ask me", so every branch that ends in waiting has to
 *  be a wait something can still end. For a Manager-mode stage none is:
 *
 *   • A Manager-mode stage always has at least two slots (a lone slot is never
 *     a commander), so `multiSlot` is always true for one.
 *   • Manager mode skips startStageWatcher for every pane of the stage, and the
 *     early return happens before the pane's arm time is recorded — so each
 *     worker reads back an arm time of "never", nothing is ever added to the
 *     stage tracker's `done`, and `allSlotsFinished` is structurally false for a
 *     Manager stage no matter how much work actually finished.
 *   • With no live Manager pane, nothing can print the stage sentinel either.
 *
 *  So the gate below can never pass under any Manager verdict. Consulting it
 *  anyway is what produced the second hang: 'keep-waiting' sends the caller into
 *  continueWaitingStall, which restarts the stage clock and clears the watchdog
 *  latch, so the identical question comes back a full cap later — forever, with
 *  no prompt on screen and nobody watching. Force-advancing is the only branch
 *  that is still a decision rather than a hang.
 *
 *  Manual mode is deliberately different and is NOT decided here: a person is
 *  looking at the prompt, so they get to choose. Their "keep waiting" on a cap
 *  restarts the clock and re-arms the latch, so the prompt returns one cap
 *  later; on 'manager-gone' the latch stands, because the verdict is a standing
 *  fact and re-raising it every 4s would be noise, not information.
 */
export interface FullAutoStallProbe {
  /** Set only when the Manager-mode watchdog raised this stall. */
  managerVerdict?: ManagerStageVerdict
  /** Any pane of this stage has announced it is out of quota.
   *
   *  Needed on its own arm because the single-slot branch below force-advances
   *  blind: without this, a one-slot stage whose CLI ran out of quota is pushed
   *  straight into the next stage, which is the cascade this whole change
   *  exists to stop. The multi-slot branch is already covered — `slotsFinished`
   *  reads SlotSignal.quotaBlocked — but this arm answers before that thunk is
   *  consulted, which is cheaper (reading it walks every pane's buffer). */
  quotaBlocked?: boolean
  /** The stage has more than one slot. */
  multiSlot: boolean
  /** Whether every slot has a reliable finish signal. Called at most once, and
   *  not at all when the answer cannot change the outcome — reading it walks
   *  every pane's buffer. */
  slotsFinished: () => boolean
}

export function fullAutoStallAction(
  probe: FullAutoStallProbe
): 'force-advance' | 'keep-waiting' {
  // A quota block is the one Manager verdict that is a wait something can end:
  // the window resets on its own, which is exactly the property the rule above
  // demands. Force-advancing here is not a decision but a cascade — the next
  // stage's panes are very likely the same exhausted account, and the Manager's
  // limit message would be handed on as if it were the stage's output.
  //
  // Known residual: waiting restarts the stage clock, and nothing re-drives the
  // Manager once its quota returns, so the stage still needs a person (or a
  // later stall prompt) to move. That is a worse wait than a working handoff
  // and a better outcome than a false completion.
  if (probe.managerVerdict === 'quota' || probe.quotaBlocked === true) return 'keep-waiting'
  // Any other Manager verdict: the gate below is structurally unanswerable for
  // such a stage (see the note above), so asking it can only hang the run.
  if (probe.managerVerdict) return 'force-advance'
  // Single-slot stages keep the original blind force-advance.
  if (!probe.multiSlot) return 'force-advance'
  return probe.slotsFinished() ? 'force-advance' : 'keep-waiting'
}

export function evaluateManagerStage(probe: ManagerStageProbe): ManagerStageVerdict {
  // Not armed yet — activateStage is still wiring the stage up, and nothing
  // below has a clock to measure against.
  if (probe.armedAt <= 0) return 'ok'
  // Past the arm an empty id is NOT "not spawned yet": startRouterPoll runs only
  // after Promise.all over every slot spawn has resolved, so the commander slot
  // never produced a pane and never will. Nothing can print ---STAGE-DONE---,
  // which is the same standing fact as a dead Manager, so it takes the same
  // verdict and the same stall path. Checked before the cap for the same reason
  // a dead Manager is: it is the actionable cause, and it is true an hour before
  // the cap would notice the silence.
  if (!probe.managerPaneId || !probe.managerPaneAlive) return 'manager-gone'
  // Before the cap, and after manager-gone. Before, because the Manager going
  // quiet on an exhausted quota is the actionable cause and it is true an hour
  // before the cap would report the symptom. After, because a dead Manager is
  // not coming back whether or not it had quota left.
  if (probe.managerQuotaBlocked === true) return 'quota'
  if (probe.maxDurationMs > 0 && probe.now - probe.armedAt > probe.maxDurationMs) {
    return 'timeout'
  }
  return 'ok'
}
