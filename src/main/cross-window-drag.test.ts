import { describe, it, expect } from 'vitest'
import {
  hitTestWindows,
  selectDropCandidates,
  type CandidateWindow,
  type DropCandidate
} from './cross-window-drag'

function candidate(
  name: string,
  bounds: { x: number; y: number; width: number; height: number },
  opts: { visible?: boolean; minimized?: boolean } = {}
): DropCandidate<string> {
  return {
    bounds,
    visible: opts.visible ?? true,
    minimized: opts.minimized ?? false,
    window: name
  }
}

describe('hitTestWindows', () => {
  const editor = candidate('editor', { x: 100, y: 50, width: 400, height: 300 })

  it('returns the window containing the point', () => {
    expect(hitTestWindows({ x: 200, y: 100 }, [editor])).toBe('editor')
  })

  it('includes the top-left edge and excludes the bottom-right edge', () => {
    expect(hitTestWindows({ x: 100, y: 50 }, [editor])).toBe('editor')
    expect(hitTestWindows({ x: 500, y: 350 }, [editor])).toBeNull()
    expect(hitTestWindows({ x: 499, y: 349 }, [editor])).toBe('editor')
  })

  it('returns null for a point outside every window', () => {
    expect(hitTestWindows({ x: 20, y: 20 }, [editor])).toBeNull()
    expect(hitTestWindows({ x: 200, y: 400 }, [editor])).toBeNull()
  })

  it('returns null when there is no candidate window', () => {
    expect(hitTestWindows({ x: 200, y: 100 }, [])).toBeNull()
  })

  it('skips minimized and hidden windows', () => {
    const minimized = candidate('min', { x: 0, y: 0, width: 800, height: 600 }, { minimized: true })
    const hidden = candidate('hidden', { x: 0, y: 0, width: 800, height: 600 }, { visible: false })
    expect(hitTestWindows({ x: 200, y: 100 }, [minimized, hidden])).toBeNull()
    expect(hitTestWindows({ x: 200, y: 100 }, [minimized, hidden, editor])).toBe('editor')
  })

  it('picks the first matching window when several overlap', () => {
    const other = candidate('other', { x: 0, y: 0, width: 800, height: 600 })
    expect(hitTestWindows({ x: 200, y: 100 }, [editor, other])).toBe('editor')
    expect(hitTestWindows({ x: 200, y: 100 }, [other, editor])).toBe('other')
  })

  it('handles negative screen coordinates (window on a left/top monitor)', () => {
    const left = candidate('left', { x: -1200, y: -300, width: 800, height: 600 })
    expect(hitTestWindows({ x: -900, y: -100 }, [left])).toBe('left')
    expect(hitTestWindows({ x: -1300, y: -100 }, [left])).toBeNull()
  })
})

describe('selectDropCandidates', () => {
  const bounds = { x: 0, y: 0, width: 800, height: 600 }
  function win(name: string, id: number): CandidateWindow<string> {
    return { ...candidate(name, bounds), id }
  }

  it('excludes the drag-source window', () => {
    const picked = selectDropCandidates([win('a', 1), win('b', 2)], 1, () => 0)
    expect(picked.map((c) => c.window)).toEqual(['b'])
  })

  it('keeps every window when senderId is null', () => {
    const picked = selectDropCandidates([win('a', 1), win('b', 2)], null, () => 0)
    expect(picked).toHaveLength(2)
  })

  it('orders by focus recency, most recent first', () => {
    const seq = new Map([
      [1, 5],
      [2, 9],
      [3, 7]
    ])
    const picked = selectDropCandidates(
      [win('a', 1), win('b', 2), win('c', 3)],
      null,
      (id) => seq.get(id) ?? 0
    )
    expect(picked.map((c) => c.window)).toEqual(['b', 'c', 'a'])
  })

  it('treats never-focused windows as least recent', () => {
    const seq = new Map([[2, 1]])
    const picked = selectDropCandidates(
      [win('a', 1), win('b', 2)],
      null,
      (id) => seq.get(id) ?? 0
    )
    expect(picked.map((c) => c.window)).toEqual(['b', 'a'])
  })

  it('recency ordering decides overlapping-window hit-tests', () => {
    const seq = new Map([
      [1, 1],
      [2, 2]
    ])
    const picked = selectDropCandidates(
      [win('under', 1), win('over', 2)],
      null,
      (id) => seq.get(id) ?? 0
    )
    expect(hitTestWindows({ x: 100, y: 100 }, picked)).toBe('over')
  })
})
