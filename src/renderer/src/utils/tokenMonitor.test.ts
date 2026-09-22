import { describe, expect, it } from 'vitest'
import { summarizeTokens, movingAverage, chartPoints, comparePeriods } from './tokenMonitor'
describe('token monitor statistics', () => {
  it('handles empty, zeros, odd and even medians without changing source data', () => {
    expect(summarizeTokens([])).toEqual({ count: 0, total: 0, mean: 0, median: 0 })
    expect(summarizeTokens([0])).toEqual({ count: 1, total: 0, mean: 0, median: 0 })
    expect(summarizeTokens([30, 10, 20])).toEqual({ count: 3, total: 60, mean: 20, median: 20 })
    expect(summarizeTokens([30, 0])).toEqual({ count: 2, total: 30, mean: 15, median: 15 })
  })
  it('uses trailing available samples and finite single-point chart geometry', () => {
    expect(movingAverage([10, 20, 30], 2)).toEqual([10, 15, 25])
    expect(chartPoints([], 0)).toBe('')
    expect(chartPoints([0], 0)).toBe('400,176')
  })
  it('compares disjoint periods, excludes future/invalid times, requires adequate baseline', () => {
    const now = Date.parse('2026-09-16T00:00:00Z')
    const current = Array.from({ length: 10 }, () => ({ started_at: '2026-09-15T00:00:00Z', output: 50 }))
    const previous = Array.from({ length: 10 }, () => ({ started_at: '2026-09-09T00:00:00Z', output: 100 }))
    const result = comparePeriods([...current, ...previous, { started_at: null, output: 500 }, { started_at: '2027-01-01', output: 999 }], now)
    expect(result.change).toBe(-50)
    expect(result.recent.count).toBe(10)
    expect(result.baseline.count).toBe(10)
    expect(comparePeriods([...current, ...previous.slice(1)], now).change).toBeNull()
    expect(comparePeriods([...current, ...previous.map(t => ({ ...t, output: 0 }))], now).change).toBeNull()
  })
})
