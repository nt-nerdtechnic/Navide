// Reliable stage-completion judgement for multi-slot stages.
//
// A slot is "finished" only on a *factual* signal — never an LLM guess:
//   • sentinel — the agent printed the stage's done-marker, or
//   • turn_complete — the CLI reported its turn ended (Claude Stop hook = 100%,
//     or JSONL turn-end for Codex/Gemini), captured AFTER the watcher armed so
//     a stale signal from a prior stage/turn is never reused.
//
// These are pure so they can be unit-tested without the App.vue watcher.

export interface SlotSignal {
  /** The stage sentinel was detected in this slot's buffer. */
  sentinelSeen: boolean
  /** Wall-clock ms of the latest turn_complete for this slot's pane (0 = none). */
  turnCompleteAt: number
  /** Wall-clock ms when this slot's watcher armed (start of the current stage). */
  armedAt: number
}

/** True when this slot has produced a reliable finish signal for the current
 *  stage. turn_complete only counts if it landed after the watcher armed. */
export function slotFinished(s: SlotSignal): boolean {
  return s.sentinelSeen || (s.turnCompleteAt > 0 && s.turnCompleteAt > s.armedAt)
}

/** True when every slot in the stage has finished. Empty input is never "done"
 *  (a stage always has ≥1 slot; an empty list means we have no signals yet). */
export function allSlotsFinished(signals: SlotSignal[]): boolean {
  return signals.length > 0 && signals.every(slotFinished)
}

export interface TurnCompleteState {
  /** Wall-clock ms of the latest turn_complete for this pane (0 = none). */
  turnCompleteAt: number
  /** Wall-clock ms of the latest agent_active for this pane (0 = none). */
  lastActiveAt: number
  /** Wall-clock ms when this pane's watcher armed (current stage start). */
  armedAt: number
  /** Now, ms. */
  now: number
  /** How long turn_complete must stay the LATEST signal before it counts, so
   *  the buffer's question text (which can lag the event) has time to render
   *  and be caught by question detection first. */
  settleMs: number
}

/** The CLI-state completion verdict: the turn ended and the CLI is sitting at
 *  the prompt. True only when ALL hold:
 *   • turn_complete landed after the watcher armed (not a stale prior signal),
 *   • it is the LATEST signal — no agent_active came after it (else the CLI is
 *     working again, e.g. revived by an injected handoff/answer),
 *   • it has been the latest signal for at least settleMs (so a turn that ended
 *     to ask a QUESTION is caught as a question first, never as completion). */
export function turnCompleteDone(s: TurnCompleteState): boolean {
  return (
    s.turnCompleteAt > s.armedAt &&
    s.turnCompleteAt >= s.lastActiveAt &&
    s.now - s.turnCompleteAt >= s.settleMs
  )
}
