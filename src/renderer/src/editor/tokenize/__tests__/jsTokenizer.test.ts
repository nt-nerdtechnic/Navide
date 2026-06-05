import { describe, it, expect } from 'vitest'

import { JsTokenizer } from '../jsTokenizer'
import type { Token } from '../../types'

/** Helper: tokenize a single line from the clean state. */
function lex(line: string): Token[] {
  return JsTokenizer.tokenizeLine(line, JsTokenizer.initialState()).tokens
}

/** Find the token whose [start,end) text equals `text`. */
function find(line: string, tokens: Token[], text: string): Token | undefined {
  return tokens.find((t) => line.slice(t.start, t.end) === text)
}

describe('JsTokenizer.initialState', () => {
  it('returns 0 (clean)', () => {
    expect(JsTokenizer.initialState()).toBe(0)
  })
})

describe('JsTokenizer single-line tokens', () => {
  it('tags keywords', () => {
    const line = 'const x = 1'
    const tokens = lex(line)
    const kw = find(line, tokens, 'const')!
    expect(kw).toEqual({ start: 0, end: 5, type: 'keyword' })
  })

  it('tags string literals', () => {
    const line = "let s = 'hi'"
    const tokens = lex(line)
    const str = find(line, tokens, "'hi'")!
    expect(str.type).toBe('string')
    expect(str.start).toBe(8)
    expect(str.end).toBe(12)
  })

  it('handles double-quote, template and escaped quotes', () => {
    expect(find('"a"', lex('"a"'), '"a"')!.type).toBe('string')
    expect(find('`t`', lex('`t`'), '`t`')!.type).toBe('string')
    const line = "x = 'a\\'b'"
    const tokens = lex(line)
    const str = find(line, tokens, "'a\\'b'")!
    expect(str.type).toBe('string')
  })

  it('tags numbers (int, float, hex, scientific)', () => {
    expect(find('42', lex('42'), '42')!.type).toBe('number')
    const f = lex('3.14')
    expect(f[0]).toEqual({ start: 0, end: 4, type: 'number' })
    expect(find('0xFF', lex('0xFF'), '0xFF')!.type).toBe('number')
    expect(find('1e10', lex('1e10'), '1e10')!.type).toBe('number')
    expect(find('1.5e-3', lex('1.5e-3'), '1.5e-3')!.type).toBe('number')
  })

  it('tags line comments to end of line', () => {
    const line = 'a // note here'
    const tokens = lex(line)
    const c = tokens.find((t) => t.type === 'comment')!
    expect(c.start).toBe(2)
    expect(c.end).toBe(line.length)
  })

  it('tags operators including multi-char === and =>', () => {
    const line = 'a === b'
    const tokens = lex(line)
    const eq = find(line, tokens, '===')!
    expect(eq).toEqual({ start: 2, end: 5, type: 'operator' })
    const arrow = find('() => x', lex('() => x'), '=>')!
    expect(arrow.type).toBe('operator')
  })

  it('tags identifier before "(" as a function', () => {
    const line = 'doThing(arg)'
    const tokens = lex(line)
    const fn = find(line, tokens, 'doThing')!
    expect(fn).toEqual({ start: 0, end: 7, type: 'function' })
  })

  it('tags PascalCase identifiers as types', () => {
    const line = 'let p: MyType'
    const tokens = lex(line)
    const ty = find(line, tokens, 'MyType')!
    expect(ty.type).toBe('type')
  })

  it('tags lowercase identifiers as variables', () => {
    const line = 'foo + bar'
    const tokens = lex(line)
    expect(find(line, tokens, 'foo')!.type).toBe('variable')
    expect(find(line, tokens, 'bar')!.type).toBe('variable')
  })

  it('does not drop any non-whitespace character', () => {
    const line = 'const Foo = bar(1, "s") // c'
    const tokens = lex(line)
    // Reconstruct covered cols; every non-space col must be in some token.
    const covered = new Set<number>()
    for (const t of tokens) {
      for (let c = t.start; c < t.end; c++) covered.add(c)
    }
    for (let c = 0; c < line.length; c++) {
      if (line[c] !== ' ') expect(covered.has(c)).toBe(true)
    }
  })
})

describe('JsTokenizer cross-line block comments', () => {
  it('opens, continues and closes a block comment across three lines', () => {
    const l1 = 'code /* open'
    const r1 = JsTokenizer.tokenizeLine(l1, JsTokenizer.initialState())
    expect(r1.endState).not.toBe(0)
    // `code` is a normal variable, then the comment runs to EOL.
    expect(find(l1, r1.tokens, 'code')!.type).toBe('variable')
    const c1 = r1.tokens.find((t) => t.type === 'comment')!
    expect(c1.start).toBe(5)
    expect(c1.end).toBe(l1.length)

    const l2 = 'still comment'
    const r2 = JsTokenizer.tokenizeLine(l2, r1.endState)
    expect(r2.endState).not.toBe(0)
    expect(r2.tokens).toEqual([{ start: 0, end: l2.length, type: 'comment' }])

    const l3 = 'closing */ code'
    const r3 = JsTokenizer.tokenizeLine(l3, r2.endState)
    expect(r3.endState).toBe(0)
    const c3 = r3.tokens.find((t) => t.type === 'comment')!
    expect(c3.start).toBe(0)
    expect(c3.end).toBe(l3.indexOf('*/') + 2) // 10
    // Trailing `code` after the close is tokenized normally.
    expect(find(l3, r3.tokens, 'code')!.type).toBe('variable')
  })

  it('handles a block comment opened and closed on the same line', () => {
    const line = 'a /* mid */ b'
    const r = JsTokenizer.tokenizeLine(line, JsTokenizer.initialState())
    expect(r.endState).toBe(0)
    const c = r.tokens.find((t) => t.type === 'comment')!
    expect(c.start).toBe(2)
    expect(c.end).toBe(11)
  })
})

describe('JsTokenizer TypeScript-specific keywords', () => {
  const TS_KEYWORDS = [
    'abstract', 'declare', 'namespace', 'override',
    'infer', 'keyof', 'asserts', 'accessor', 'using',
    'never', 'unknown', 'any', 'object', 'symbol', 'bigint',
  ]
  for (const kw of TS_KEYWORDS) {
    it(`tags "${kw}" as keyword`, () => {
      const line = `${kw} foo`
      const tokens = lex(line)
      const t = find(line, tokens, kw)!
      expect(t?.type).toBe('keyword')
    })
  }
})

describe('JsTokenizer empty lines', () => {
  it('returns no tokens and preserves clean state', () => {
    const r = JsTokenizer.tokenizeLine('', JsTokenizer.initialState())
    expect(r.tokens).toEqual([])
    expect(r.endState).toBe(0)
  })

  it('preserves block-comment state across a blank continuation line', () => {
    // A truly empty line inside a block comment stays in-comment with no token.
    const r = JsTokenizer.tokenizeLine('', 1)
    expect(r.tokens).toEqual([])
    expect(r.endState).toBe(1)
  })
})
