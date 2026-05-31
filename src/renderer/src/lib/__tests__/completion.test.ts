import { describe, it, expect } from 'vitest'
import { slotFinished, allSlotsFinished, turnCompleteDone, type SlotSignal } from '../completion'

// Fixed reference time for the watcher arming. turn_complete only counts when
// its timestamp is strictly AFTER this.
const ARMED = 1000

describe('slotFinished', () => {
  it('is true when the sentinel was seen, regardless of turn_complete', () => {
    expect(slotFinished({ sentinelSeen: true, turnCompleteAt: 0, armedAt: ARMED })).toBe(true)
  })

  it('sentinel wins even over a stale turn_complete', () => {
    expect(slotFinished({ sentinelSeen: true, turnCompleteAt: 500, armedAt: ARMED })).toBe(true)
  })

  it('is true when turn_complete landed after the watcher armed', () => {
    expect(slotFinished({ sentinelSeen: false, turnCompleteAt: 2000, armedAt: ARMED })).toBe(true)
  })

  it('is false when there is no signal at all', () => {
    expect(slotFinished({ sentinelSeen: false, turnCompleteAt: 0, armedAt: ARMED })).toBe(false)
  })

  it('ignores a stale turn_complete from a prior stage/turn', () => {
    expect(slotFinished({ sentinelSeen: false, turnCompleteAt: 500, armedAt: ARMED })).toBe(false)
  })

  it('ignores a turn_complete exactly at arm time (must be strictly after)', () => {
    expect(slotFinished({ sentinelSeen: false, turnCompleteAt: ARMED, armedAt: ARMED })).toBe(false)
  })
})

describe('allSlotsFinished', () => {
  const finished: SlotSignal = { sentinelSeen: true, turnCompleteAt: 0, armedAt: ARMED }
  const unfinished: SlotSignal = { sentinelSeen: false, turnCompleteAt: 0, armedAt: ARMED }

  it('is never true for an empty list (no signals yet)', () => {
    expect(allSlotsFinished([])).toBe(false)
  })

  it('is true when a single slot is finished', () => {
    expect(allSlotsFinished([finished])).toBe(true)
  })

  it('is true when every slot is finished (mixed signal kinds)', () => {
    const viaTurnComplete: SlotSignal = { sentinelSeen: false, turnCompleteAt: 2000, armedAt: ARMED }
    expect(allSlotsFinished([finished, viaTurnComplete])).toBe(true)
  })

  it('is false when any slot is unfinished (partial completion never advances)', () => {
    expect(allSlotsFinished([finished, unfinished])).toBe(false)
  })

  it('is false when a slot only has a stale turn_complete', () => {
    const stale: SlotSignal = { sentinelSeen: false, turnCompleteAt: 500, armedAt: ARMED }
    expect(allSlotsFinished([finished, stale])).toBe(false)
  })
})

describe('turnCompleteDone', () => {
  const SETTLE = 1500

  it('is true when turn_complete is post-arm, latest, and settled', () => {
    // armed=1000, active=1500, turn_complete=2000, now=2000+SETTLE
    expect(turnCompleteDone({
      turnCompleteAt: 2000, lastActiveAt: 1500, armedAt: ARMED,
      now: 2000 + SETTLE, settleMs: SETTLE
    })).toBe(true)
  })

  it('is true exactly at the settle boundary', () => {
    expect(turnCompleteDone({
      turnCompleteAt: 2000, lastActiveAt: 1500, armedAt: ARMED,
      now: 2000 + SETTLE, settleMs: SETTLE
    })).toBe(true)
  })

  it('is false before settle elapses (lets a QUESTION render & be caught first)', () => {
    expect(turnCompleteDone({
      turnCompleteAt: 2000, lastActiveAt: 1500, armedAt: ARMED,
      now: 2000 + 1000, settleMs: SETTLE
    })).toBe(false)
  })

  it('is false when agent_active came AFTER turn_complete (revived by injection)', () => {
    expect(turnCompleteDone({
      turnCompleteAt: 2000, lastActiveAt: 2500, armedAt: ARMED,
      now: 2000 + SETTLE + 5000, settleMs: SETTLE
    })).toBe(false)
  })

  it('is false for a stale turn_complete from before the watcher armed', () => {
    expect(turnCompleteDone({
      turnCompleteAt: 500, lastActiveAt: 0, armedAt: ARMED,
      now: 999_999, settleMs: SETTLE
    })).toBe(false)
  })

  it('is false when there is no turn_complete signal at all', () => {
    expect(turnCompleteDone({
      turnCompleteAt: 0, lastActiveAt: 0, armedAt: ARMED,
      now: 999_999, settleMs: SETTLE
    })).toBe(false)
  })
})
