import { describe, it, expect } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { serializeRenderedBuffer } from '../useTerminal'

// Minimal stand-in for the xterm buffer surface serializeRenderedBuffer reads.
// Fixture texts are pre-trimmed (translateToString(true) right-trims). The
// cursor sits on the last row, as it does in a live pane.
function mockTerm(rows: string[]): Terminal {
  return {
    buffer: {
      active: {
        baseY: rows.length - 1,
        cursorY: 0,
        getLine: (r: number) =>
          rows[r] === undefined ? undefined : { translateToString: () => rows[r] },
      },
    },
  } as unknown as Terminal
}

describe('serializeRenderedBuffer', () => {
  it('returns the rendered rows oldest→newest', () => {
    expect(serializeRenderedBuffer(mockTerm(['one', 'two', 'three']), 100)).toBe('one\ntwo\nthree')
  })

  it('drops trailing blank lines but keeps interior ones', () => {
    expect(serializeRenderedBuffer(mockTerm(['a', '', 'b', '', '   ']), 100)).toBe('a\n\nb')
  })

  it('keeps only the last maxLines rows', () => {
    expect(serializeRenderedBuffer(mockTerm(['a', 'b', 'c', 'd']), 2)).toBe('c\nd')
  })

  it("drops the CLI's trailing box-drawing input frame", () => {
    const rows = [
      '> summarize the diff',
      '  Done — 3 files changed.',
      '╭──────────────────────────╮',
      '│ >',
      '╰──────────────────────────╯',
      '',
    ]
    // Only the trailing frame line goes: the prompt row carries content, so the
    // walk stops there (deliberately simple — no widget-wide filter).
    expect(serializeRenderedBuffer(mockTerm(rows), 100)).toBe(
      '> summarize the diff\n  Done — 3 files changed.\n╭──────────────────────────╮\n│ >'
    )
  })

  it('returns an empty string for an all-blank buffer', () => {
    expect(serializeRenderedBuffer(mockTerm(['', '  ', '']), 100)).toBe('')
  })

  it('tolerates rows xterm has no line for', () => {
    const term = {
      buffer: { active: { baseY: 2, cursorY: 0, getLine: () => undefined } },
    } as unknown as Terminal
    expect(serializeRenderedBuffer(term, 100)).toBe('')
  })
})
