import { describe, it, expect } from 'vitest'
import { parseDelimited, delimiterFor } from '../csvParser'

const parse = (text: string, delim = ',', max = 100) => parseDelimited(text, delim, max)

describe('parseDelimited – basics', () => {
  it('splits unquoted fields and LF rows', () => {
    const { rows, truncated } = parse('a,b,c\n1,2,3')
    expect(rows).toEqual([['a', 'b', 'c'], ['1', '2', '3']])
    expect(truncated).toBe(false)
  })

  it('handles CRLF line endings', () => {
    const { rows } = parse('a,b\r\n1,2\r\n')
    expect(rows).toEqual([['a', 'b'], ['1', '2']])
  })

  it('does not emit an empty trailing row for a final newline', () => {
    const { rows } = parse('a,b\n1,2\n')
    expect(rows).toHaveLength(2)
  })

  it('keeps empty fields', () => {
    const { rows } = parse('a,,c\n,,\n')
    expect(rows).toEqual([['a', '', 'c'], ['', '', '']])
  })
})

describe('parseDelimited – quoting', () => {
  it('unwraps quoted fields', () => {
    const { rows } = parse('"a","b c"\n')
    expect(rows).toEqual([['a', 'b c']])
  })

  it('keeps delimiters inside quoted fields', () => {
    const { rows } = parse('"a,b",c\n')
    expect(rows).toEqual([['a,b', 'c']])
  })

  it('unescapes doubled quotes inside quoted fields', () => {
    const { rows } = parse('"say ""hi""",x\n')
    expect(rows).toEqual([['say "hi"', 'x']])
  })

  it('keeps newlines inside quoted fields', () => {
    const { rows } = parse('"line1\nline2",b\nnext,row\n')
    expect(rows).toEqual([['line1\nline2', 'b'], ['next', 'row']])
  })

  it('treats quotes in the middle of an unquoted field literally', () => {
    const { rows } = parse('a"b,c\n')
    expect(rows).toEqual([['a"b', 'c']])
  })
})

describe('parseDelimited – TSV', () => {
  it('splits on tabs and leaves commas alone', () => {
    const { rows } = parse('a\tb,c\n1\t2\n', '\t')
    expect(rows).toEqual([['a', 'b,c'], ['1', '2']])
  })
})

describe('parseDelimited – row cap', () => {
  it('stops at maxRows and reports truncation', () => {
    const { rows, truncated } = parse('a\nb\nc\nd\n', ',', 2)
    expect(rows).toEqual([['a'], ['b']])
    expect(truncated).toBe(true)
  })

  it('does not report truncation when the row count equals the cap', () => {
    const { rows, truncated } = parse('a\nb\n', ',', 2)
    expect(rows).toHaveLength(2)
    expect(truncated).toBe(false)
  })
})

describe('delimiterFor', () => {
  it('is tab for .tsv and comma otherwise', () => {
    expect(delimiterFor('data/table.tsv')).toBe('\t')
    expect(delimiterFor('data/table.TSV')).toBe('\t')
    expect(delimiterFor('data/table.csv')).toBe(',')
  })
})
