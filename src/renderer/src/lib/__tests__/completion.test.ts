import { describe, it, expect } from 'vitest'
import { slotFinished, allSlotsFinished, turnCompleteDone, turnEndsWithSentinel, type SlotSignal } from '../completion'

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

describe('turnEndsWithSentinel', () => {
  const S = '---SPEC-DONE---'

  it('accepts the sentinel as the final non-empty line', () => {
    expect(turnEndsWithSentinel(`規格完成。\n${S}`, S)).toBe(true)
    expect(turnEndsWithSentinel(`規格完成。\n${S}\n\n  `, S)).toBe(true)
    expect(turnEndsWithSentinel(`  ${S}  `, S)).toBe(true)
  })

  it('rejects mid-text mentions (quoted protocol / instructions)', () => {
    // Real kickoff instruction lines from the CRM run — these were echoed by
    // the TUI and falsely completed stages under the old log-file scanner.
    expect(turnEndsWithSentinel(`錯誤：完成了 ${S}\n接下來開始工作`, S)).toBe(false)
    expect(turnEndsWithSentinel(`${S}\n正確：最後一行只有 ${S}。`, S)).toBe(false)
    expect(turnEndsWithSentinel(`完成後，最後一行只輸出 ${S}。`, S)).toBe(false)
  })

  it('rejects inline text on the final line', () => {
    expect(turnEndsWithSentinel(`完成了 ${S}`, S)).toBe(false)
    expect(turnEndsWithSentinel(`${S} 以上`, S)).toBe(false)
  })

  it('rejects empty inputs', () => {
    expect(turnEndsWithSentinel('', S)).toBe(false)
    expect(turnEndsWithSentinel('done', '')).toBe(false)
  })

  it('question block followed by a bare sentinel line still ends with the sentinel', () => {
    // Ordering (question wins) is the caller's job; this fn only judges the tail.
    const text = `---QUESTION-START---\ntype: choice\nprompt: MVP 核心？\n---QUESTION-END---\n${S}`
    expect(turnEndsWithSentinel(text, S)).toBe(true)
  })
})
