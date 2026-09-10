import { describe, it, expect } from 'vitest'
import { evaluateManagerStage, fullAutoStallAction } from '../managerStageWatchdog'

const HOUR = 60 * 60_000

describe('evaluateManagerStage', () => {
  it('is ok while the Manager pane is alive and inside the cap', () => {
    expect(evaluateManagerStage({
      managerPaneId: 'mgr', managerPaneAlive: true,
      armedAt: 1_000, now: 1_000 + 60_000, maxDurationMs: HOUR,
    })).toBe('ok')
  })

  // The only "not spawned yet" the watchdog accepts: the router exists (a worker
  // slot wired it) but its poll has not armed, so activateStage is still working
  // through the slots. Past the arm the same shape means the commander never
  // spawned — see the R2 cases below.
  it('is ok before the router poll has armed', () => {
    expect(evaluateManagerStage({
      managerPaneId: '', managerPaneAlive: false,
      armedAt: 0, now: 10 * HOUR, maxDurationMs: HOUR,
    })).toBe('ok')
  })

  // The #1 hang: the Manager pane is gone, so ---STAGE-DONE--- can never be
  // printed and the router polls an empty buffer forever.
  it('reports manager-gone when the Manager pane disappeared', () => {
    expect(evaluateManagerStage({
      managerPaneId: 'mgr', managerPaneAlive: false,
      armedAt: 1_000, now: 2_000, maxDurationMs: HOUR,
    })).toBe('manager-gone')
  })

  it('prefers manager-gone over timeout when both hold', () => {
    expect(evaluateManagerStage({
      managerPaneId: 'mgr', managerPaneAlive: false,
      armedAt: 1_000, now: 1_000 + 2 * HOUR, maxDurationMs: HOUR,
    })).toBe('manager-gone')
  })

  // Manager mode skips the per-pane watcher, so the stage cap has to be
  // evaluated here or it never fires at all.
  it('reports timeout past the stage cap', () => {
    expect(evaluateManagerStage({
      managerPaneId: 'mgr', managerPaneAlive: true,
      armedAt: 1_000, now: 1_000 + HOUR + 1, maxDurationMs: HOUR,
    })).toBe('timeout')
  })

  it('does not time out exactly at the cap', () => {
    expect(evaluateManagerStage({
      managerPaneId: 'mgr', managerPaneAlive: true,
      armedAt: 1_000, now: 1_000 + HOUR, maxDurationMs: HOUR,
    })).toBe('ok')
  })

  it('does not time out before the stage was armed', () => {
    expect(evaluateManagerStage({
      managerPaneId: 'mgr', managerPaneAlive: true,
      armedAt: 0, now: 10 * HOUR, maxDurationMs: HOUR,
    })).toBe('ok')
  })

  // R2: the commander slot's agentKey is no longer in agentSpecs, so spawnPane
  // returned null and router.managerPaneId was never assigned. startRouterPoll
  // runs only after Promise.all over every slot spawn has resolved, so past the
  // arm an empty id is a permanent fact, not a slot still on its way.
  it('does not call a stage healthy when the commander never spawned', () => {
    expect(evaluateManagerStage({
      managerPaneId: '', managerPaneAlive: false,
      armedAt: 1_000, now: 5_000, maxDurationMs: HOUR,
    })).not.toBe('ok')
  })

  it('reports a never-spawned commander the same way as a dead one', () => {
    // Same standing fact — nothing can print ---STAGE-DONE--- — so it takes the
    // existing stall path rather than a verdict nothing is wired to handle.
    expect(evaluateManagerStage({
      managerPaneId: '', managerPaneAlive: false,
      armedAt: 1_000, now: 5_000, maxDurationMs: HOUR,
    })).toBe('manager-gone')
  })

  it('says so even when the cap is disabled, which is the only other backstop', () => {
    expect(evaluateManagerStage({
      managerPaneId: '', managerPaneAlive: false,
      armedAt: 1_000, now: 10 * HOUR, maxDurationMs: 0,
    })).toBe('manager-gone')
  })

  it('treats a non-positive cap as disabled', () => {
    expect(evaluateManagerStage({
      managerPaneId: 'mgr', managerPaneAlive: true,
      armedAt: 1, now: 10 * HOUR, maxDurationMs: 0,
    })).toBe('ok')
  })
})

describe('fullAutoStallAction', () => {
  const never = (): boolean => {
    throw new Error('slotsFinished must not be consulted here')
  }

  it('force-advances a gone Manager instead of waiting for a signal that cannot come', () => {
    // The regression this exists for: holding here leaves the run at
    // state='running' with the prompt dismissed, the watchdog latched, and
    // nobody watching — silent forever, under the mode whose whole promise is
    // that it does not need anybody.
    expect(fullAutoStallAction({
      managerVerdict: 'manager-gone', multiSlot: true, slotsFinished: never,
    })).toBe('force-advance')
  })

  it('does not even ask the slot gate for a gone Manager', () => {
    // Manager mode arms no per-pane watcher, so the gate is structurally false
    // for such a stage — asking it can only produce the wrong answer slowly.
    let asked = 0
    fullAutoStallAction({
      managerVerdict: 'manager-gone',
      multiSlot: true,
      slotsFinished: () => { asked++; return false },
    })
    expect(asked).toBe(0)
  })

  it('does not gate a Manager-mode cap on the slot signals either', () => {
    // This used to answer 'keep-waiting' on a false gate, on the theory that the
    // cap would simply re-raise later. It does not: continueWaitingStall restarts
    // armedAt and clears the latch, so "later" is another full cap away and the
    // answer is the same false gate again — an unbounded loop with no prompt on
    // screen. The gate cannot be true for a Manager stage, so it is not asked.
    expect(fullAutoStallAction({
      managerVerdict: 'timeout', multiSlot: true, slotsFinished: never,
    })).toBe('force-advance')
  })

  // R3: the slot gate is structurally unanswerable for a Manager stage, so asking
  // it on a cap returned 'keep-waiting' forever — and continueWaitingStall
  // restarts armedAt and clears the watchdog latch, so the next cap was another
  // full hour away, with no prompt on screen and nobody watching.
  it('force-advances a Manager-mode cap instead of asking an unanswerable question', () => {
    expect(fullAutoStallAction({
      managerVerdict: 'timeout', multiSlot: true, slotsFinished: () => false,
    })).toBe('force-advance')
  })

  it('never consults the slot gate for ANY Manager verdict', () => {
    for (const verdict of ['manager-gone', 'timeout'] as const) {
      let asked = 0
      const action = fullAutoStallAction({
        managerVerdict: verdict,
        multiSlot: true,
        slotsFinished: () => { asked++; return false },
      })
      expect(asked, verdict).toBe(0)
      expect(action, verdict).toBe('force-advance')
    }
  })

  it('keeps single-slot behaviour exactly as it was: blind force-advance', () => {
    expect(fullAutoStallAction({
      multiSlot: false, slotsFinished: never,
    })).toBe('force-advance')
  })

  it('keeps the multi-slot watcher stall gated on N/N', () => {
    expect(fullAutoStallAction({
      multiSlot: true, slotsFinished: () => false,
    })).toBe('keep-waiting')
    expect(fullAutoStallAction({
      multiSlot: true, slotsFinished: () => true,
    })).toBe('force-advance')
  })

  it('asks the gate at most once', () => {
    let asked = 0
    fullAutoStallAction({
      multiSlot: true, slotsFinished: () => { asked++; return false },
    })
    expect(asked).toBe(1)
  })
})
