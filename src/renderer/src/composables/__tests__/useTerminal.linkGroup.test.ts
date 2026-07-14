// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import {
  getWrappedLineGroup,
  groupPosToRowCol,
  groupRowColToPos,
  findFileLinkAt,
  findFileLinkMatchAt,
  splitMatchAtRowStarts,
} from '../useTerminal'

// Minimal stand-in for the xterm buffer surface getWrappedLineGroup reads.
// Fixture texts are pre-trimmed (translateToString(true) right-trims).
function mockTerm(rows: Array<{ text: string; wrapped?: boolean }>): Terminal {
  return {
    cols: 80,
    buffer: {
      active: {
        getLine: (r: number) =>
          rows[r] === undefined
            ? undefined
            : { isWrapped: !!rows[r].wrapped, translateToString: () => rows[r].text },
      },
    },
  } as unknown as Terminal
}

// The exact CLI pre-wrap case from the bug report: Claude Code wraps a long
// path at its own content width (narrower than the pane) with a real newline,
// indenting the continuation with the block's gutter. isWrapped is false.
const PREWRAP_ROWS = [
  { text: '     /Users/neillu/Desktop/Leankoo/Leankoo1/vendor/seba' },
  { text: '     stian/cli-parser/README.md' },
]
const PREWRAP_FULL = '/Users/neillu/Desktop/Leankoo/Leankoo1/vendor/sebastian/cli-parser/README.md'

describe('getWrappedLineGroup', () => {
  it('keeps an isolated line as its own group', () => {
    const term = mockTerm([{ text: 'hello world' }, { text: '' }])
    const g = getWrappedLineGroup(term, 0)
    expect(g).toEqual({ groupStart: 0, lineLengths: [11], strips: [0], fullText: 'hello world' })
  })

  it('joins genuine xterm wraps via isWrapped regardless of content', () => {
    const term = mockTerm([{ text: 'abc def' }, { text: 'ghi', wrapped: true }])
    const g = getWrappedLineGroup(term, 0)
    expect(g.fullText).toBe('abc defghi')
    expect(g.strips).toEqual([0, 0])
  })

  it('joins CLI pre-wrapped rows and strips the continuation gutter', () => {
    const g = getWrappedLineGroup(mockTerm(PREWRAP_ROWS), 0)
    expect(g.fullText).toContain(PREWRAP_FULL)
    expect(g.strips).toEqual([0, 5])
  })

  it('finds the same group when starting from the continuation row', () => {
    const term = mockTerm(PREWRAP_ROWS)
    expect(getWrappedLineGroup(term, 1)).toEqual(getWrappedLineGroup(term, 0))
  })

  it('joins across differing indents (tool-result ⎿ gutter)', () => {
    const term = mockTerm([
      { text: '  ⎿  /Users/x/very-long-' },
      { text: '     name.md' },
    ])
    const g = getWrappedLineGroup(term, 0)
    expect(findFileLinkAt(g.fullText, g.fullText.indexOf('/Users'))).toBe('/Users/x/very-long-name.md')
  })

  it('does not join across a blank row', () => {
    const term = mockTerm([{ text: '/Users/a/one.md' }, { text: '' }, { text: '/Users/a/two.md' }])
    expect(getWrappedLineGroup(term, 0).fullText).toBe('/Users/a/one.md')
  })

  it('keeps the clicked path intact in column-aligned output (git create mode)', () => {
    // Rows here end where their content ends, not at a width limit — a
    // measurably longer neighbour proves that, so the clicked row must not
    // have the next row glued onto it ('…Test.phpcreate').
    const rows = [
      { text: '      create mode 100644 lang/zh_TW/conversations.php' },
      { text: '      create mode 100644 resources/views/employer/conversations/index.blade.php' },
      { text: '      create mode 100644 tests/Feature/WaTemplateControllerTest.php' },
      { text: '      create mode 100644 tests/Unit/OrganizationTest.php' },
    ]
    const g = getWrappedLineGroup(mockTerm(rows), 2)
    expect(g.fullText).not.toContain('OrganizationTest')
    const pos = groupRowColToPos(g, 2, rows[2].text.indexOf('tests/'))
    expect(findFileLinkAt(g.fullText, pos)).toBe('tests/Feature/WaTemplateControllerTest.php')
  })
})

describe('position mapping', () => {
  const g = getWrappedLineGroup(mockTerm(PREWRAP_ROWS), 0)

  it('maps a click on the continuation row into fullText and back', () => {
    const pos = groupRowColToPos(g, 1, 7)
    expect(g.fullText[pos]).toBe('i') // '     stian…'[7] === 'i'
    expect(groupPosToRowCol(g, pos)).toEqual({ row: 1, col: 7 })
  })

  it('returns -1 for clicks in the stripped gutter or right of the content', () => {
    expect(groupRowColToPos(g, 1, 3)).toBe(-1)
    expect(groupRowColToPos(g, 1, 999)).toBe(-1)
  })

  it('hit-tests the full joined path from either row', () => {
    expect(findFileLinkAt(g.fullText, groupRowColToPos(g, 0, 10))).toBe(PREWRAP_FULL)
    expect(findFileLinkAt(g.fullText, groupRowColToPos(g, 1, 7))).toBe(PREWRAP_FULL)
  })
})

describe('splitMatchAtRowStarts', () => {
  // find-output where every row is near the same width: the width-limit check
  // cannot tell "one wrapped path" from "adjacent full-width paths", so the
  // whole block still glues into one regex match — the genuinely ambiguous
  // case the split-back heuristic exists for.
  const GLUE_PATHS = ['alpha', 'bravo', 'gamma'].map(
    (n) => `/Users/neillu/Desktop/Leankoo/Leankoo1/vendor/sebastian/pkg-${n}/README.md`
  )
  const WRAP = 40 // pre-wrap column; must not fall on a '/' (asserted below)
  const term = mockTerm(
    GLUE_PATHS.flatMap((p) => [
      { text: '     ' + p.slice(0, WRAP) },
      { text: '     ' + p.slice(WRAP) },
    ])
  )
  const g = getWrappedLineGroup(term, 5)
  const clickPos = groupRowColToPos(g, 5, 7) // click inside the last path's tail
  const m = findFileLinkMatchAt(g.fullText, clickPos)!

  it('splits a glued find-output block back into per-path pieces', () => {
    expect(GLUE_PATHS.every((p) => p[WRAP] !== '/' && p[WRAP] !== '~')).toBe(true)
    expect(splitMatchAtRowStarts(g, m.index, m.text).map((p) => p.text)).toEqual(GLUE_PATHS)
  })

  it('the piece under the click is the wrapped path, not the whole block', () => {
    const piece = splitMatchAtRowStarts(g, m.index, m.text).find(
      (p) => clickPos >= p.index && clickPos < p.index + p.text.length
    )
    expect(piece?.text).toBe(GLUE_PATHS[2])
  })

  it('leaves a match with no fresh-path row starts as a single piece', () => {
    const g2 = getWrappedLineGroup(mockTerm(PREWRAP_ROWS), 0)
    const m2 = findFileLinkMatchAt(g2.fullText, groupRowColToPos(g2, 1, 7))!
    expect(splitMatchAtRowStarts(g2, m2.index, m2.text)).toEqual([
      { index: m2.index, text: PREWRAP_FULL },
    ])
  })
})

describe('findFileLinkAt', () => {
  it('returns the row-local path for adjacent unrelated paths (find output)', () => {
    // In `find` output every row is a path, so rows join into one mega token;
    // the click handler falls back to this row-local match via fs.stat_path.
    expect(findFileLinkAt('     /Users/a/two.md', 7)).toBe('/Users/a/two.md')
  })

  it('ignores URLs and out-of-range positions', () => {
    expect(findFileLinkAt('see https://example.com/x', 10)).toBeNull()
    expect(findFileLinkAt('/Users/a/b.md', -1)).toBeNull()
  })
})