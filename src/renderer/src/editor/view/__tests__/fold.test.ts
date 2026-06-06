import { describe, it, expect } from 'vitest'
import { getIndent, foldRangeEnd, computeVisibleModelLines } from '../foldUtils'

// ── helpers ──────────────────────────────────────────────────────────────────
function makeGetLine(lines: string[]): (l: number) => string {
  return (l) => lines[l] ?? ''
}

// ── getIndent ────────────────────────────────────────────────────────────────
describe('getIndent', () => {
  it('returns 0 for non-indented line', () => {
    expect(getIndent('function foo() {')).toBe(0)
  })

  it('counts spaces', () => {
    expect(getIndent('    return x')).toBe(4)
  })

  it('counts tabs', () => {
    expect(getIndent('\t\treturn x')).toBe(2)
  })

  it('returns -1 for blank line', () => {
    expect(getIndent('')).toBe(-1)
    expect(getIndent('   ')).toBe(-1)
    expect(getIndent('\t')).toBe(-1)
  })
})

// ── foldRangeEnd ─────────────────────────────────────────────────────────────
describe('foldRangeEnd', () => {
  it('returns startLine for non-foldable line (flat indentation)', () => {
    const lines = ['a', 'b', 'c']
    expect(foldRangeEnd(makeGetLine(lines), lines.length, 0)).toBe(0)
  })

  it('folds simple 2-level block', () => {
    const lines = [
      'function foo() {', // 0 — indent 0, foldable
      '  const x = 1',   // 1 — indent 2
      '  return x',      // 2 — indent 2
      '}',               // 3 — indent 0 → stops before here
    ]
    expect(foldRangeEnd(makeGetLine(lines), lines.length, 0)).toBe(2)
  })

  it('includes trailing blank lines inside the fold range', () => {
    const lines = [
      'if (a) {',   // 0
      '  doSomething()', // 1
      '',            // 2 — blank, included in fold range
      '}',           // 3 — stops before here
    ]
    expect(foldRangeEnd(makeGetLine(lines), lines.length, 0)).toBe(2)
  })

  it('handles nested indentation — outer fold ends at last deeper line', () => {
    const lines = [
      'class Foo {',       // 0 — indent 0
      '  method() {',      // 1 — indent 2
      '    return 42',     // 2 — indent 4
      '  }',               // 3 — indent 2, still deeper than outer
      '}',                 // 4 — indent 0, stops outer fold here
    ]
    expect(foldRangeEnd(makeGetLine(lines), lines.length, 0)).toBe(3)
  })

  it('nested inner fold ends at correct line', () => {
    const lines = [
      'class Foo {',       // 0
      '  method() {',      // 1 — foldable inner block
      '    return 42',     // 2
      '  }',               // 3 — indent 2, stops inner fold
      '}',                 // 4
    ]
    expect(foldRangeEnd(makeGetLine(lines), lines.length, 1)).toBe(2)
  })

  it('returns startLine when block is empty (no deeper content)', () => {
    const lines = ['function foo() {}', 'next()']
    expect(foldRangeEnd(makeGetLine(lines), lines.length, 0)).toBe(0)
  })

  it('works for a line at the very end of the document', () => {
    const lines = ['def foo():', '  pass']
    expect(foldRangeEnd(makeGetLine(lines), lines.length, 0)).toBe(1)
  })
})

// ── computeVisibleModelLines ──────────────────────────────────────────────────
describe('computeVisibleModelLines', () => {
  it('returns all lines when nothing is folded', () => {
    const result = computeVisibleModelLines(5, new Set(), () => 0)
    expect(result).toEqual([0, 1, 2, 3, 4])
  })

  it('hides folded child lines (fold at line 0, range ends at 2)', () => {
    const lines = ['fn {', '  a', '  b', '}']
    const getRangeEnd = (l: number) => foldRangeEnd(makeGetLine(lines), lines.length, l)
    const result = computeVisibleModelLines(lines.length, new Set([0]), getRangeEnd)
    // lines 1 and 2 are hidden (inside the fold at line 0)
    expect(result).toEqual([0, 3])
  })

  it('multiple independent folds both hide their children', () => {
    const lines = [
      'fn a {',  // 0 — foldable, range ends at 1
      '  x',    // 1
      'fn b {',  // 2 — foldable, range ends at 3
      '  y',    // 3
    ]
    const getRangeEnd = (l: number) => foldRangeEnd(makeGetLine(lines), lines.length, l)
    const result = computeVisibleModelLines(lines.length, new Set([0, 2]), getRangeEnd)
    expect(result).toEqual([0, 2])
  })

  it('preserves display→model index ordering', () => {
    const lines = ['a', 'b', 'c', 'd', 'e']
    // fold line 1 (range = just line 1 since no deeper content in flat file)
    // but we'll test with a mock getRangeEnd that returns 3 for line 1
    const result = computeVisibleModelLines(lines.length, new Set([1]), (_l) => 3)
    // lines 2 and 3 are hidden; line 1 is the fold start (visible), line 4 visible
    expect(result).toEqual([0, 1, 4])
  })
})
