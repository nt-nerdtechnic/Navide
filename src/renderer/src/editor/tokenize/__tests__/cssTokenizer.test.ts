import { describe, it, expect } from 'vitest'
import { CssTokenizer } from '../cssTokenizer'
import { tokenizerFor } from '../index'
import type { Token } from '../../types'

function lex(line: string, state = CssTokenizer.initialState()): Token[] {
  return CssTokenizer.tokenizeLine(line, state).tokens
}
function endState(line: string, state = CssTokenizer.initialState()): number {
  return CssTokenizer.tokenizeLine(line, state).endState
}
function find(line: string, tokens: Token[], text: string): Token | undefined {
  return tokens.find((t) => line.slice(t.start, t.end) === text)
}

describe('CssTokenizer — class selectors', () => {
  it('tags .class as function', () => {
    const line = '.container {'
    const t = find(line, lex(line), '.container')!
    expect(t.type).toBe('function')
  })
})

describe('CssTokenizer — property names', () => {
  it('tags property before : as variable', () => {
    const line = '  color: red;'
    const t = find(line, lex(line), 'color')!
    expect(t.type).toBe('variable')
  })

  it('tags hyphenated property as variable', () => {
    const line = '  background-color: #fff;'
    const t = find(line, lex(line), 'background-color')!
    expect(t.type).toBe('variable')
  })
})

describe('CssTokenizer — numbers and units', () => {
  it('tags numeric value with unit as number', () => {
    const line = '  margin: 12px;'
    const t = find(line, lex(line), '12px')!
    expect(t.type).toBe('number')
  })

  it('tags percentage as number', () => {
    const line = '  width: 100%;'
    const t = find(line, lex(line), '100%')!
    expect(t.type).toBe('number')
  })
})

describe('CssTokenizer — hex colors', () => {
  it('tags hex color as number', () => {
    const line = '  color: #ff0000;'
    const t = find(line, lex(line), '#ff0000')!
    expect(t.type).toBe('number')
  })

  it('tags short hex color as number', () => {
    const line = '  color: #fff;'
    const t = find(line, lex(line), '#fff')!
    expect(t.type).toBe('number')
  })
})

describe('CssTokenizer — at-rules', () => {
  it('tags @media as keyword', () => {
    const line = '@media (max-width: 768px) {'
    const t = find(line, lex(line), '@media')!
    expect(t.type).toBe('keyword')
  })

  it('tags @keyframes as keyword', () => {
    const line = '@keyframes slide {'
    const t = find(line, lex(line), '@keyframes')!
    expect(t.type).toBe('keyword')
  })
})

describe('CssTokenizer — block comments', () => {
  it('tokenizes single-line block comment', () => {
    const line = '/* comment */'
    const t = find(line, lex(line), '/* comment */')!
    expect(t.type).toBe('comment')
  })

  it('returns STATE_BLOCK_COMMENT when comment spans line', () => {
    expect(endState('/* starts here')).toBe(1)
  })

  it('resumes and closes block comment on next line', () => {
    const openLine = '/* open'
    const { endState: s } = CssTokenizer.tokenizeLine(openLine, CssTokenizer.initialState())
    const closeLine = '   ends here */'
    const { tokens, endState: s2 } = CssTokenizer.tokenizeLine(closeLine, s)
    expect(s2).toBe(0)
    expect(tokens[0].type).toBe('comment')
    expect(tokens[0].start).toBe(0)
    expect(tokens[0].end).toBeGreaterThan(0)
  })
})

describe('CssTokenizer — pseudo-classes', () => {
  it('tags :hover as keyword', () => {
    const line = 'a:hover { color: blue; }'
    const t = find(line, lex(line), ':hover')!
    expect(t.type).toBe('keyword')
  })

  it('tags ::before as keyword', () => {
    const line = 'p::before {'
    const t = find(line, lex(line), '::before')!
    expect(t.type).toBe('keyword')
  })
})

describe('tokenizerFor registry — CSS', () => {
  it('returns CssTokenizer for css', () => {
    expect(tokenizerFor('css')).toBe(CssTokenizer)
  })

  it('returns CssTokenizer for scss', () => {
    expect(tokenizerFor('scss')).toBe(CssTokenizer)
  })

  it('returns CssTokenizer for less', () => {
    expect(tokenizerFor('less')).toBe(CssTokenizer)
  })
})
