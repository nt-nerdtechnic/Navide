import { describe, it, expect } from 'vitest'
import { resolveActiveTab } from '../runGroups'

describe('resolveActiveTab', () => {
  const groups = [{ id: 'rg-default' }, { id: 'rg-1' }, { id: 'rg-2' }]

  it('keeps the current tab when it still exists', () => {
    expect(resolveActiveTab(groups, 'rg-1')).toBe('rg-1')
  })

  it("keeps the special 'manual' tab even with no groups", () => {
    expect(resolveActiveTab([], 'manual')).toBe('manual')
    expect(resolveActiveTab(groups, 'manual')).toBe('manual')
  })

  it('falls back to the last remaining group when the current tab was deleted', () => {
    // simulates a peer window deleting the group this window was viewing
    expect(resolveActiveTab(groups, 'rg-removed')).toBe('rg-2')
  })

  it("falls back to 'manual' when no groups remain", () => {
    expect(resolveActiveTab([], 'rg-1')).toBe('manual')
  })

  it("treats an empty current id as invalid and falls back", () => {
    expect(resolveActiveTab(groups, '')).toBe('rg-2')
    expect(resolveActiveTab([], '')).toBe('manual')
  })
})
