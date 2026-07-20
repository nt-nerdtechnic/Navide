import { describe, expect, it } from 'vitest'
import { gridPageCount, gridPageSlice, gridPresetDims, parseGridPreset } from '../gridLayout'

describe('parseGridPreset', () => {
  it('accepts the three fixed presets', () => {
    expect(parseGridPreset('2x1')).toBe('2x1')
    expect(parseGridPreset('2x2')).toBe('2x2')
    expect(parseGridPreset('3x3')).toBe('3x3')
  })

  it('falls back to auto for anything else', () => {
    expect(parseGridPreset('auto')).toBe('auto')
    expect(parseGridPreset('4x4')).toBe('auto')
    expect(parseGridPreset('')).toBe('auto')
    expect(parseGridPreset(null)).toBe('auto')
    expect(parseGridPreset(undefined)).toBe('auto')
  })
})

describe('gridPresetDims', () => {
  it('returns null for auto and fixed dims otherwise', () => {
    expect(gridPresetDims('auto')).toBeNull()
    expect(gridPresetDims('2x1')).toEqual({ cols: 2, rows: 1 })
    expect(gridPresetDims('2x2')).toEqual({ cols: 2, rows: 2 })
    expect(gridPresetDims('3x3')).toEqual({ cols: 3, rows: 3 })
  })
})

describe('gridPageCount', () => {
  it('is always 1 for auto (unlimited panes on one page)', () => {
    expect(gridPageCount(0, 'auto')).toBe(1)
    expect(gridPageCount(12, 'auto')).toBe(1)
  })

  it('divides panes by page capacity, rounding up', () => {
    expect(gridPageCount(4, '2x2')).toBe(1)
    expect(gridPageCount(5, '2x2')).toBe(2)
    expect(gridPageCount(7, '2x1')).toBe(4)
    expect(gridPageCount(9, '3x3')).toBe(1)
    expect(gridPageCount(10, '3x3')).toBe(2)
  })

  it('never returns less than 1', () => {
    expect(gridPageCount(0, '2x2')).toBe(1)
  })
})

describe('gridPageSlice', () => {
  const panes = ['a', 'b', 'c', 'd', 'e', 'f', 'g']

  it('returns all panes for auto regardless of page', () => {
    expect(gridPageSlice(panes, 'auto', 0)).toEqual(panes)
    expect(gridPageSlice(panes, 'auto', 3)).toEqual(panes)
  })

  it('slices fixed presets into capacity-sized pages', () => {
    expect(gridPageSlice(panes, '2x2', 0)).toEqual(['a', 'b', 'c', 'd'])
    expect(gridPageSlice(panes, '2x2', 1)).toEqual(['e', 'f', 'g'])
    expect(gridPageSlice(panes, '2x1', 2)).toEqual(['e', 'f'])
  })

  it('clamps out-of-range pages instead of returning empty', () => {
    expect(gridPageSlice(panes, '2x2', 5)).toEqual(['e', 'f', 'g'])
    expect(gridPageSlice(panes, '2x2', -1)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('handles an empty pane list', () => {
    expect(gridPageSlice([], '3x3', 0)).toEqual([])
  })
})
