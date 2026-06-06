import { describe, it, expect } from 'vitest'
import { TextModel } from '../../model/TextModel'
import type { Position, Range, EditOperation } from '../../types'

// ── Pure helpers mirroring EditorView.vue logic ───────────────────────────────

function insertCursorAbove(
  cursor: Position,
  extraCursors: Position[],
  getLineLength: (l: number) => number,
): Position | null {
  if (cursor.line <= 0) return null
  const newLine = cursor.line - 1
  const newPos: Position = { line: newLine, col: Math.min(cursor.col, getLineLength(newLine)) }
  if (extraCursors.some(e => e.line === newPos.line && e.col === newPos.col)) return null
  return newPos
}

function insertCursorBelow(
  cursor: Position,
  extraCursors: Position[],
  lineCount: number,
  getLineLength: (l: number) => number,
): Position | null {
  if (cursor.line >= lineCount - 1) return null
  const newLine = cursor.line + 1
  const newPos: Position = { line: newLine, col: Math.min(cursor.col, getLineLength(newLine)) }
  if (extraCursors.some(e => e.line === newPos.line && e.col === newPos.col)) return null
  return newPos
}

// Simulates the bottom-to-top sorting used in applyMultiCursorEdit.
function sortedEntriesBottomToTop(
  primary: Position,
  extras: Position[],
  getRange: (pos: Position) => Range,
): Array<{ pos: Position; range: Range }> {
  const all = [primary, ...extras].map(pos => ({ pos, range: getRange(pos) }))
  return all.sort((a, b) => {
    if (b.range.start.line !== a.range.start.line) return b.range.start.line - a.range.start.line
    return b.range.start.col - a.range.start.col
  })
}

// ── insertCursorAbove ────────────────────────────────────────────────────────
describe('insertCursorAbove', () => {
  const model = new TextModel('line0\nline1\nline2')
  const getLen = (l: number) => model.getLine(l).length

  it('adds cursor on line above', () => {
    const result = insertCursorAbove({ line: 1, col: 3 }, [], getLen)
    expect(result).toEqual({ line: 0, col: 3 })
  })

  it('clamps col to line length when shorter', () => {
    const shortModel = new TextModel('ab\nlonger line\nc')
    const getL = (l: number) => shortModel.getLine(l).length
    // cursor on line 1 col 8; line 0 has length 2 → clamped to 2
    const result = insertCursorAbove({ line: 1, col: 8 }, [], getL)
    expect(result).toEqual({ line: 0, col: 2 })
  })

  it('returns null on first line (no line above)', () => {
    const result = insertCursorAbove({ line: 0, col: 0 }, [], getLen)
    expect(result).toBeNull()
  })

  it('returns null if identical extra cursor already exists', () => {
    const existing: Position[] = [{ line: 0, col: 3 }]
    const result = insertCursorAbove({ line: 1, col: 3 }, existing, getLen)
    expect(result).toBeNull()
  })

  it('allows cursor when existing extra is on same line but different col', () => {
    const existing: Position[] = [{ line: 0, col: 1 }]
    const result = insertCursorAbove({ line: 1, col: 3 }, existing, getLen)
    expect(result).toEqual({ line: 0, col: 3 })
  })
})

// ── insertCursorBelow ────────────────────────────────────────────────────────
describe('insertCursorBelow', () => {
  const model = new TextModel('line0\nline1\nline2')
  const getLen = (l: number) => model.getLine(l).length

  it('adds cursor on line below', () => {
    const result = insertCursorBelow({ line: 0, col: 2 }, [], model.lineCount(), getLen)
    expect(result).toEqual({ line: 1, col: 2 })
  })

  it('clamps col to line length when shorter', () => {
    const m = new TextModel('longer line\nab\nc')
    const getL = (l: number) => m.getLine(l).length
    const result = insertCursorBelow({ line: 0, col: 10 }, [], m.lineCount(), getL)
    expect(result).toEqual({ line: 1, col: 2 })
  })

  it('returns null on last line (no line below)', () => {
    const result = insertCursorBelow({ line: 2, col: 0 }, [], model.lineCount(), getLen)
    expect(result).toBeNull()
  })

  it('returns null if identical extra cursor already exists', () => {
    const existing: Position[] = [{ line: 1, col: 2 }]
    const result = insertCursorBelow({ line: 0, col: 2 }, existing, model.lineCount(), getLen)
    expect(result).toBeNull()
  })
})

// ── applyMultiEdit position updates (bottom-to-top ordering) ─────────────────
describe('applyMultiCursorEdit — bottom-to-top ordering and position updates', () => {
  it('sorts cursors bottom-to-top so upper positions stay valid after lower edits', () => {
    const primary: Position = { line: 0, col: 5 }
    const extra: Position = { line: 2, col: 3 }
    const getRange = (pos: Position): Range => ({ start: pos, end: pos })
    const sorted = sortedEntriesBottomToTop(primary, [extra], getRange)
    // bottom (line 2) should come first
    expect(sorted[0].pos.line).toBe(2)
    expect(sorted[1].pos.line).toBe(0)
  })

  it('same-line cursors are sorted by col descending', () => {
    const primary: Position = { line: 1, col: 2 }
    const extra: Position = { line: 1, col: 7 }
    const getRange = (pos: Position): Range => ({ start: pos, end: pos })
    const sorted = sortedEntriesBottomToTop(primary, [extra], getRange)
    expect(sorted[0].pos.col).toBe(7)
    expect(sorted[1].pos.col).toBe(2)
  })

  it('TextModel inserts at multiple positions bottom-to-top preserve upper offsets', () => {
    // 'aaa\nbbb\nccc' — insert 'X' at line 2 col 1, then at line 0 col 1
    // If applied bottom-to-top, line 0 position stays valid (no line index shift).
    const m = new TextModel('aaa\nbbb\nccc')
    // bottom edit first
    const op2: EditOperation = { range: { start: { line: 2, col: 1 }, end: { line: 2, col: 1 } }, text: 'X' }
    m.applyEdit(op2)
    // top edit second (line 0 is unchanged by bottom edit)
    const op0: EditOperation = { range: { start: { line: 0, col: 1 }, end: { line: 0, col: 1 } }, text: 'X' }
    m.applyEdit(op0)
    const lines = m.getValue().split('\n')
    expect(lines[0]).toBe('aXaa')
    expect(lines[2]).toBe('cXcc')
  })

  it('TextModel: top-to-bottom insertion corrupts lower positions (verifying why order matters)', () => {
    // This test demonstrates the problem with top-to-bottom order (insert newline at top → shifts line numbers).
    const m = new TextModel('aaa\nbbb\nccc')
    // top edit first: insert newline after line 0
    const op0: EditOperation = { range: { start: { line: 0, col: 3 }, end: { line: 0, col: 3 } }, text: '\n' }
    m.applyEdit(op0)
    // now line 'ccc' is at line index 3, not 2 — a hardcoded line: 2 ref would be wrong
    expect(m.getLine(2)).toBe('bbb')
    expect(m.getLine(3)).toBe('ccc')
  })
})
