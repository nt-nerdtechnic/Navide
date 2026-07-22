import { describe, expect, it } from 'vitest'
import {
  highlightSegments,
  parseAnsiSegments,
  stripAnsi,
  tailLines,
  type AnsiSegment,
} from '../ansiRender'

const ESC = '\x1b'

describe('parseAnsiSegments', () => {
  it('parses basic foreground colors (30-37)', () => {
    expect(parseAnsiSegments(`${ESC}[31mred${ESC}[0m plain`)).toEqual([
      { text: 'red', fg: 'red' },
      { text: ' plain' },
    ])
  })

  it('parses bright foreground colors (90-97)', () => {
    expect(parseAnsiSegments(`${ESC}[94mblue`)).toEqual([{ text: 'blue', fg: 'bright-blue' }])
  })

  it('parses background colors (40-47 and 100-107)', () => {
    expect(parseAnsiSegments(`${ESC}[42mgreen bg${ESC}[0m${ESC}[101mbright red bg`)).toEqual([
      { text: 'green bg', bg: 'green' },
      { text: 'bright red bg', bg: 'bright-red' },
    ])
  })

  it('parses bold and reset', () => {
    expect(parseAnsiSegments(`${ESC}[1mbold${ESC}[0mnormal`)).toEqual([
      { text: 'bold', bold: true },
      { text: 'normal' },
    ])
  })

  it('accumulates combined/nested attributes until reset', () => {
    expect(parseAnsiSegments(`${ESC}[1;31mA${ESC}[32mB${ESC}[0mC`)).toEqual([
      { text: 'A', fg: 'red', bold: true },
      { text: 'B', fg: 'green', bold: true },
      { text: 'C' },
    ])
  })

  it('treats a bare ESC[m as reset (empty params default to 0)', () => {
    expect(parseAnsiSegments(`${ESC}[31mred${ESC}[mplain`)).toEqual([
      { text: 'red', fg: 'red' },
      { text: 'plain' },
    ])
  })

  it('maps 38;5;n / 48;5;n to basic 16 colors when n < 16', () => {
    expect(parseAnsiSegments(`${ESC}[38;5;9mX${ESC}[0m${ESC}[48;5;4mY`)).toEqual([
      { text: 'X', fg: 'bright-red' },
      { text: 'Y', bg: 'blue' },
    ])
  })

  it('ignores 38;5;n outside the basic 16 but still consumes its params', () => {
    // 200 is not mappable; the following ;1 must still be applied as bold.
    expect(parseAnsiSegments(`${ESC}[38;5;200;1mX`)).toEqual([{ text: 'X', bold: true }])
  })

  it('ignores truecolor 38;2;r;g;b but still consumes its params', () => {
    expect(parseAnsiSegments(`${ESC}[38;2;10;20;30;31mX`)).toEqual([{ text: 'X', fg: 'red' }])
  })

  it('ignores non-whitelisted SGR codes (underline, dim, ...)', () => {
    expect(parseAnsiSegments(`${ESC}[4;2;31mX`)).toEqual([{ text: 'X', fg: 'red' }])
  })

  it('strips non-SGR CSI sequences (cursor movement, erase, private modes)', () => {
    expect(parseAnsiSegments(`${ESC}[2Ahello${ESC}[K world${ESC}[?25l!`)).toEqual([
      { text: 'hello world!' },
    ])
  })

  it('strips OSC sequences terminated by BEL or ST', () => {
    expect(parseAnsiSegments(`${ESC}]0;window title\x07text`)).toEqual([{ text: 'text' }])
    expect(parseAnsiSegments(`${ESC}]8;;https://x.test${ESC}\\link`)).toEqual([{ text: 'link' }])
  })

  it('strips charset designations and lone escapes', () => {
    expect(parseAnsiSegments(`${ESC}(Babc${ESC}`)).toEqual([{ text: 'abc' }])
  })

  it('keeps HTML-looking text as inert plain-text segments (injection samples)', () => {
    const script = '<script>alert(1)</script>'
    expect(parseAnsiSegments(script)).toEqual([{ text: script }])
    const img = `${ESC}[31m<img src=x onerror=alert(1)>${ESC}[0m`
    expect(parseAnsiSegments(img)).toEqual([
      { text: '<img src=x onerror=alert(1)>', fg: 'red' },
    ])
  })

  it('merges consecutive chunks with identical style', () => {
    expect(parseAnsiSegments(`a${ESC}[Kb${ESC}[31mc${ESC}[31md`)).toEqual([
      { text: 'ab' },
      { text: 'cd', fg: 'red' },
    ])
  })
})

describe('stripAnsi', () => {
  it('removes every escape sequence and keeps plain text', () => {
    const input = `${ESC}[1;32mok${ESC}[0m ${ESC}]0;t\x07done${ESC}[2K`
    expect(stripAnsi(input)).toBe('ok done')
  })
})

describe('highlightSegments', () => {
  const segs = (): AnsiSegment[] => parseAnsiSegments(`${ESC}[31mfoo bar${ESC}[0m FOO`)

  it('returns input untouched for an empty query', () => {
    const input = segs()
    const { pieces, matchCount } = highlightSegments(input, '')
    expect(pieces).toBe(input)
    expect(matchCount).toBe(0)
  })

  it('finds case-insensitive matches and tags pieces with matchIndex', () => {
    const { pieces, matchCount } = highlightSegments(segs(), 'foo')
    expect(matchCount).toBe(2)
    expect(pieces).toEqual([
      { text: 'foo', fg: 'red', matchIndex: 0 },
      { text: ' bar', fg: 'red' },
      { text: ' ' },
      { text: 'FOO', matchIndex: 1 },
    ])
  })

  it('splits a match spanning a style boundary into pieces sharing one index', () => {
    const input = parseAnsiSegments(`${ESC}[31mfo${ESC}[32mo${ESC}[0m!`)
    const { pieces, matchCount } = highlightSegments(input, 'foo')
    expect(matchCount).toBe(1)
    expect(pieces).toEqual([
      { text: 'fo', fg: 'red', matchIndex: 0 },
      { text: 'o', fg: 'green', matchIndex: 0 },
      { text: '!' },
    ])
  })

  it('returns matchCount 0 when nothing matches', () => {
    const { pieces, matchCount } = highlightSegments(segs(), 'zzz')
    expect(matchCount).toBe(0)
    expect(pieces.map((p) => p.matchIndex)).toEqual([undefined, undefined])
  })
})

describe('tailLines', () => {
  it('returns the text untruncated when within the limit', () => {
    expect(tailLines('a\nb\nc', 3)).toEqual({ text: 'a\nb\nc', truncated: false })
  })

  it('keeps only the last N lines when over the limit', () => {
    expect(tailLines('a\nb\nc\nd', 2)).toEqual({ text: 'c\nd', truncated: true })
  })
})
