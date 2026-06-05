import { describe, it, expect } from 'vitest'
import { MarkdownTokenizer } from '../markdownTokenizer'
import { tokenizerFor } from '../index'
import type { Token } from '../../types'

function lex(line: string, state = MarkdownTokenizer.initialState()): Token[] {
  return MarkdownTokenizer.tokenizeLine(line, state).tokens
}
function endState(line: string, state = MarkdownTokenizer.initialState()): number {
  return MarkdownTokenizer.tokenizeLine(line, state).endState
}
function find(tokens: Token[], text: string, src: string): Token | undefined {
  return tokens.find((t) => src.slice(t.start, t.end) === text)
}

describe('MarkdownTokenizer — headings', () => {
  it('tags h1 as keyword', () => {
    const line = '# Hello World'
    const [t] = lex(line)
    expect(t.type).toBe('keyword')
    expect(t.start).toBe(0)
    expect(t.end).toBe(line.length)
  })

  it('tags h3 as keyword', () => {
    const line = '### Section'
    expect(lex(line)[0].type).toBe('keyword')
  })

  it('does not tag ########  (>6 hashes) as keyword', () => {
    const line = '####### too many'
    const tokens = lex(line)
    expect(tokens.every((t) => t.type !== 'keyword')).toBe(true)
  })
})

describe('MarkdownTokenizer — blockquote', () => {
  it('tags blockquote as comment', () => {
    const line = '> some quoted text'
    const [t] = lex(line)
    expect(t.type).toBe('comment')
    expect(t.end).toBe(line.length)
  })
})

describe('MarkdownTokenizer — thematic break', () => {
  // Thematic breaks appear after the first line, so use explicit state = 0 (STATE_NORMAL).
  it('tags --- as operator after initial line', () => {
    const line = '---'
    expect(MarkdownTokenizer.tokenizeLine(line, 0).tokens[0].type).toBe('operator')
  })

  it('tags *** as operator', () => {
    const line = '***'
    expect(MarkdownTokenizer.tokenizeLine(line, 0).tokens[0].type).toBe('operator')
  })

  it('tags --- with spaces as operator', () => {
    const line = '- - -'
    expect(MarkdownTokenizer.tokenizeLine(line, 0).tokens[0].type).toBe('operator')
  })
})

describe('MarkdownTokenizer — YAML front matter', () => {
  it('tags opening --- as comment at file start', () => {
    const tokens = MarkdownTokenizer.tokenizeLine('---', MarkdownTokenizer.initialState()).tokens
    expect(tokens[0].type).toBe('comment')
  })

  it('enters FRONT_MATTER_BODY state (2) after opening ---', () => {
    const state = MarkdownTokenizer.tokenizeLine('---', MarkdownTokenizer.initialState()).endState
    expect(state).toBe(2)
  })

  it('treats front matter body lines as comment', () => {
    const tokens = MarkdownTokenizer.tokenizeLine('title: Hello World', 2).tokens
    expect(tokens[0].type).toBe('comment')
  })

  it('closes front matter on second ---', () => {
    const state = MarkdownTokenizer.tokenizeLine('---', 2).endState
    expect(state).toBe(0)
  })

  it('does not treat first non-front-matter line as front matter', () => {
    const line = '# Heading'
    const tokens = MarkdownTokenizer.tokenizeLine(line, MarkdownTokenizer.initialState()).tokens
    expect(tokens[0].type).toBe('keyword')
  })
})

describe('MarkdownTokenizer — list markers', () => {
  it('tags unordered list marker as function', () => {
    const line = '- item text'
    const t = find(lex(line), '- ', line)!
    expect(t.type).toBe('function')
  })

  it('tags * list marker as function', () => {
    const line = '* item'
    const t = find(lex(line), '* ', line)!
    expect(t.type).toBe('function')
  })

  it('tags ordered list marker as function', () => {
    const line = '1. first item'
    const t = find(lex(line), '1. ', line)!
    expect(t.type).toBe('function')
  })

  it('tags nested list marker as function', () => {
    const line = '  - nested'
    const t = find(lex(line), '- ', line)!
    expect(t.type).toBe('function')
  })
})

describe('MarkdownTokenizer — code fence', () => {
  it('tags opening ``` line as string', () => {
    const line = '```typescript'
    expect(lex(line)[0].type).toBe('string')
  })

  it('transitions to CODE_FENCE state on opening ```', () => {
    expect(endState('```js')).toBe(1)
  })

  it('tags code fence content as string', () => {
    const line = 'const x = 1'
    const tokens = MarkdownTokenizer.tokenizeLine(line, 1).tokens
    expect(tokens[0].type).toBe('string')
    expect(tokens[0].end).toBe(line.length)
  })

  it('transitions back to NORMAL on closing ```', () => {
    const state1 = endState('```')
    expect(state1).toBe(1)
    expect(endState('```', state1)).toBe(0)
  })

  it('tags closing ``` line as string', () => {
    const tokens = MarkdownTokenizer.tokenizeLine('```', 1).tokens
    expect(tokens[0].type).toBe('string')
  })

  it('also recognises ~~~ fences', () => {
    expect(endState('~~~python')).toBe(1)
    expect(endState('~~~', 1)).toBe(0)
  })
})

describe('MarkdownTokenizer — inline code', () => {
  it('tags `code` as string', () => {
    const line = 'use `npm install` to install'
    const t = find(lex(line), '`npm install`', line)!
    expect(t.type).toBe('string')
  })
})

describe('MarkdownTokenizer — bold and italic', () => {
  it('tags **bold** as type', () => {
    const line = '**bold text**'
    const [t] = lex(line)
    expect(t.type).toBe('type')
    expect(line.slice(t.start, t.end)).toBe('**bold text**')
  })

  it('tags *italic* as keyword', () => {
    const line = '*italic*'
    const [t] = lex(line)
    expect(t.type).toBe('keyword')
  })

  it('tags __bold__ as type', () => {
    const line = '__bold__'
    expect(lex(line)[0].type).toBe('type')
  })
})

describe('MarkdownTokenizer — links and images', () => {
  it('tags [text] as function and (url) as number', () => {
    const line = '[click here](https://example.com)'
    const tokens = lex(line)
    const text = find(tokens, '[click here]', line)!
    const url = find(tokens, '(https://example.com)', line)!
    expect(text.type).toBe('function')
    expect(url.type).toBe('number')
  })

  it('tags ![alt](url) image similarly', () => {
    const line = '![logo](./logo.png)'
    const tokens = lex(line)
    const alt = find(tokens, '![logo]', line)!
    const url = find(tokens, '(./logo.png)', line)!
    expect(alt.type).toBe('function')
    expect(url.type).toBe('number')
  })
})

describe('tokenizerFor registry — Markdown', () => {
  it('returns MarkdownTokenizer for md', () => {
    expect(tokenizerFor('md')).toBe(MarkdownTokenizer)
  })

  it('returns MarkdownTokenizer for mdx', () => {
    expect(tokenizerFor('mdx')).toBe(MarkdownTokenizer)
  })
})
