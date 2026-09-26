import { describe, expect, it, vi } from 'vitest'
import { terminalSnapshotCandidates } from './terminalSnapshots'

describe('terminal snapshot candidates', () => {
  it('starts with 10000 scrollback and replays a snapshot without the alternate buffer', () => {
    const serialize = vi.fn(() => 'history')
    expect(terminalSnapshotCandidates(serialize, false)).toEqual(Array(6).fill('history'))
    expect(serialize).toHaveBeenCalledWith({ scrollback: 2000, excludeAltBuffer: true })
  })

  it('halves oversized candidates and strips alternate-screen enter sequences', () => {
    const serialize = vi.fn(({ scrollback }: { scrollback: number }) =>
      scrollback > 500 ? 'x'.repeat(70_000) : '\u001b[?1049h\u001b[Hscreen')
    const candidates = terminalSnapshotCandidates(serialize, true)
    expect(candidates[0]).toBe('screen')
    expect(serialize).toHaveBeenCalledWith({ scrollback: 2000, excludeAltBuffer: false })
    expect(serialize).toHaveBeenCalledWith({ scrollback: 1000, excludeAltBuffer: false })
  })

  it('returns no snapshot for clean empty output', () => {
    expect(terminalSnapshotCandidates(() => '  \n', false)).toEqual([])
  })
})
