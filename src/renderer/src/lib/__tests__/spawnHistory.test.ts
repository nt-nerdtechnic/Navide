import { describe, expect, it } from 'vitest'
import { historyEntryLabel, updateHistoryCustomName, type HistoryTitleEntry } from '../spawnHistory'

function entry(overrides: Partial<HistoryTitleEntry> = {}): HistoryTitleEntry {
  return {
    paneId: 'pane-1',
    agentLabel: 'Claude Code',
    ...overrides,
  }
}

describe('spawn history titles', () => {
  it('prefers the CLI custom title and falls back to the vendor label', () => {
    expect(historyEntryLabel(entry({ customName: 'Frontend Lead' }))).toBe('Frontend Lead')
    expect(historyEntryLabel(entry())).toBe('Claude Code')
  })

  it('synchronizes rename and reset operations with the matching history entry', () => {
    const entries = [entry()]

    expect(updateHistoryCustomName(entries, 'pane-1', ' Reviewer ')).toBe(true)
    expect(entries[0].customName).toBe('Reviewer')

    expect(updateHistoryCustomName(entries, 'pane-1', '  ')).toBe(true)
    expect(entries[0].customName).toBeUndefined()
  })

  it('leaves history unchanged when the pane is not present', () => {
    const entries = [entry()]
    expect(updateHistoryCustomName(entries, 'missing', 'Reviewer')).toBe(false)
    expect(entries).toEqual([entry()])
  })
})
