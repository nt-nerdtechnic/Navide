import { describe, expect, it } from 'vitest'
import {
  advanceWidthRebuild,
  coalesceWidthRebuild,
  isWidthRebuildReady,
} from '../paneWidthRebuild'

describe('pane width rebuild scheduling', () => {
  it('requires idle, a completed latest lifecycle signal, and quiet raw output', () => {
    const base = {
      displayStatus: 'idle',
      lastActiveAt: 100,
      turnCompleteAt: 101,
      lastRawActivityAt: 1_000,
      now: 4_000,
      rawQuietMs: 2_500,
    }
    expect(isWidthRebuildReady(base)).toBe(true)
    expect(isWidthRebuildReady({ ...base, displayStatus: 'running' })).toBe(false)
    expect(isWidthRebuildReady({ ...base, lastActiveAt: 102 })).toBe(false)
    expect(isWidthRebuildReady({ ...base, lastRawActivityAt: 2_000 })).toBe(false)
  })

  it('coalesces an identical width and resets grace for the latest width', () => {
    const first = coalesceWidthRebuild(null, 100)
    first.idleSince = 500
    expect(coalesceWidthRebuild(first, 100)).toBe(first)
    expect(coalesceWidthRebuild(first, 120)).toEqual({
      cols: 120,
      generation: 2,
      idleSince: null,
    })
  })

  it('retries activity, then requires an uninterrupted idle grace', () => {
    expect(advanceWidthRebuild(100, false, 200, 750, 500)).toEqual({
      action: 'retry', idleSince: null, delayMs: 500,
    })
    expect(advanceWidthRebuild(null, true, 1_000, 750, 500)).toEqual({
      action: 'wait', idleSince: 1_000, delayMs: 750,
    })
    expect(advanceWidthRebuild(1_000, true, 1_500, 750, 500)).toEqual({
      action: 'wait', idleSince: 1_000, delayMs: 250,
    })
    expect(advanceWidthRebuild(1_000, true, 1_750, 750, 500)).toEqual({
      action: 'rebuild', idleSince: 1_000, delayMs: 0,
    })
  })
})
