import { describe, it, expect } from 'vitest'
import { TextModel } from '../TextModel'
import type { EditOperation } from '../../types'

describe('TextModel construction', () => {
  it('empty string is a single empty line', () => {
    const m = new TextModel('')
    expect(m.lineCount()).toBe(1)
    expect(m.getLine(0)).toBe('')
    expect(m.getValue()).toBe('')
  })

  it('preserves trailing empty line semantics', () => {
    const m = new TextModel('a\n')
    expect(m.lineCount()).toBe(2)
    expect(m.getLine(0)).toBe('a')
    expect(m.getLine(1)).toBe('')
    expect(m.getValue()).toBe('a\n')
  })

  it('round-trips multiline text via getValue', () => {
    const text = 'line1\nline2\nline3'
    expect(new TextModel(text).getValue()).toBe(text)
  })

  it('setValue replaces content and round-trips', () => {
    const m = new TextModel('old')
    m.setValue('new\ncontent\n')
    expect(m.lineCount()).toBe(3)
    expect(m.getValue()).toBe('new\ncontent\n')
  })
})

describe('TextModel.getValueInRange', () => {
  it('reads a single-line range', () => {
    const m = new TextModel('hello world')
    expect(m.getValueInRange({ start: { line: 0, col: 6 }, end: { line: 0, col: 11 } })).toBe('world')
  })

  it('reads a multi-line range', () => {
    const m = new TextModel('abc\ndef\nghi')
    const r = { start: { line: 0, col: 1 }, end: { line: 2, col: 2 } }
    expect(m.getValueInRange(r)).toBe('bc\ndef\ngh')
  })
})

describe('TextModel.applyEdit', () => {
  it('pure insertion (start == end)', () => {
    const m = new TextModel('ac')
    const op: EditOperation = { range: { start: { line: 0, col: 1 }, end: { line: 0, col: 1 } }, text: 'b' }
    const { caret, inverse } = m.applyEdit(op)
    expect(m.getValue()).toBe('abc')
    expect(caret).toEqual({ line: 0, col: 2 })
    expect(inverse.text).toBe('')
    expect(inverse.range).toEqual({ start: { line: 0, col: 1 }, end: { line: 0, col: 2 } })
  })

  it('single-line replacement', () => {
    const m = new TextModel('hello world')
    const op: EditOperation = { range: { start: { line: 0, col: 6 }, end: { line: 0, col: 11 } }, text: 'there' }
    const { caret } = m.applyEdit(op)
    expect(m.getValue()).toBe('hello there')
    expect(caret).toEqual({ line: 0, col: 11 })
  })

  it('cross-line deletion (text empty)', () => {
    const m = new TextModel('abc\ndef\nghi')
    const op: EditOperation = { range: { start: { line: 0, col: 1 }, end: { line: 2, col: 2 } }, text: '' }
    const { caret } = m.applyEdit(op)
    expect(m.getValue()).toBe('ai')
    expect(m.lineCount()).toBe(1)
    expect(caret).toEqual({ line: 0, col: 1 })
  })

  it('inserting a newline increases line count and caret moves to new line', () => {
    const m = new TextModel('abcd')
    const op: EditOperation = { range: { start: { line: 0, col: 2 }, end: { line: 0, col: 2 } }, text: '\n' }
    const { caret } = m.applyEdit(op)
    expect(m.lineCount()).toBe(2)
    expect(m.getValue()).toBe('ab\ncd')
    expect(caret).toEqual({ line: 1, col: 0 })
  })

  it('inserting multi-line text places caret at end of last segment', () => {
    const m = new TextModel('XY')
    const op: EditOperation = { range: { start: { line: 0, col: 1 }, end: { line: 0, col: 1 } }, text: 'a\nbb\nccc' }
    const { caret } = m.applyEdit(op)
    expect(m.getValue()).toBe('Xa\nbb\ncccY')
    expect(caret).toEqual({ line: 2, col: 3 })
  })

  it('clamps out-of-range positions', () => {
    const m = new TextModel('ab')
    const op: EditOperation = { range: { start: { line: 9, col: 9 }, end: { line: 9, col: 99 } }, text: 'Z' }
    m.applyEdit(op)
    expect(m.getValue()).toBe('abZ')
  })
})

describe('TextModel inverse round-trip property', () => {
  const cases: { initial: string; op: EditOperation }[] = [
    { initial: 'ac', op: { range: { start: { line: 0, col: 1 }, end: { line: 0, col: 1 } }, text: 'b' } },
    { initial: 'hello world', op: { range: { start: { line: 0, col: 6 }, end: { line: 0, col: 11 } }, text: 'there' } },
    { initial: 'abc\ndef\nghi', op: { range: { start: { line: 0, col: 1 }, end: { line: 2, col: 2 } }, text: '' } },
    { initial: 'abcd', op: { range: { start: { line: 0, col: 2 }, end: { line: 0, col: 2 } }, text: '\n' } },
    { initial: 'XY', op: { range: { start: { line: 0, col: 1 }, end: { line: 0, col: 1 } }, text: 'a\nbb\nccc' } },
    { initial: 'one\ntwo\nthree', op: { range: { start: { line: 1, col: 0 }, end: { line: 1, col: 3 } }, text: 'XYZ\nW' } },
    { initial: '', op: { range: { start: { line: 0, col: 0 }, end: { line: 0, col: 0 } }, text: 'fresh\ntext' } },
  ]

  it.each(cases)('apply then apply(inverse) restores original (%#)', ({ initial, op }) => {
    const m = new TextModel(initial)
    const { inverse } = m.applyEdit(op)
    m.applyEdit(inverse)
    expect(m.getValue()).toBe(initial)
  })
})
