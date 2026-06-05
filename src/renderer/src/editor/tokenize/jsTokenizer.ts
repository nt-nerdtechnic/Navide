/**
 * JavaScript / TypeScript syntax tokenizer.
 *
 * Stateful, line-by-line. The only carry-over state is whether we are inside a
 * `/* ... *\/` block comment (see `STATE_BLOCK_COMMENT`). Every non-whitespace
 * character on a line is assigned to exactly one token — `'text'` is the
 * fallback so nothing is ever dropped.
 */

import type {
  LineTokens,
  Token,
  TokenizerState,
  Tokenizer,
  TokenType,
} from '../types'

/** Clean state — start of file / not inside any multi-line construct. */
const STATE_CLEAN: TokenizerState = 0
/** We are inside an unterminated block comment opened on a previous line. */
const STATE_BLOCK_COMMENT: TokenizerState = 1

const KEYWORDS = new Set<string>([
  'const',
  'let',
  'var',
  'function',
  'return',
  'if',
  'else',
  'for',
  'while',
  'class',
  'extends',
  'import',
  'export',
  'from',
  'async',
  'await',
  'new',
  'typeof',
  'instanceof',
  'in',
  'of',
  'try',
  'catch',
  'finally',
  'throw',
  'switch',
  'case',
  'break',
  'continue',
  'default',
  'this',
  'super',
  'yield',
  'void',
  'delete',
  'do',
  'enum',
  'interface',
  'type',
  'implements',
  'public',
  'private',
  'protected',
  'readonly',
  'static',
  'abstract',
  'declare',
  'namespace',
  'override',
  'infer',
  'keyof',
  'asserts',
  'accessor',
  'using',
  'get',
  'set',
  'as',
  'satisfies',
  'null',
  'true',
  'false',
  'undefined',
  'never',
  'unknown',
  'any',
  'object',
  'symbol',
  'bigint',
])

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v'
}

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_$]/.test(ch)
}

function isIdentPart(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch)
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}

/** Multi-character operators, longest-first so we match greedily. */
const MULTI_OPERATORS = [
  '===',
  '!==',
  '**=',
  '>>>',
  '...',
  '&&=',
  '||=',
  '??=',
  '=>',
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '??',
  '?.',
  '++',
  '--',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
  '**',
  '<<',
  '>>',
]

const SINGLE_OPERATORS = new Set<string>([
  '+',
  '-',
  '*',
  '/',
  '%',
  '=',
  '<',
  '>',
  '!',
  '&',
  '|',
  '^',
  '~',
  '?',
  ':',
  '.',
  ',',
  ';',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
])

class JsTokenizerImpl implements Tokenizer {
  initialState(): TokenizerState {
    return STATE_CLEAN
  }

  tokenizeLine(line: string, startState: TokenizerState): LineTokens {
    const tokens: Token[] = []
    const len = line.length
    let i = 0
    let state = startState

    // ── Continuation of a block comment opened on an earlier line. ──
    if (state === STATE_BLOCK_COMMENT) {
      const close = line.indexOf('*/')
      if (close === -1) {
        // Entire line is still comment; stay in block-comment state.
        if (len > 0) tokens.push({ start: 0, end: len, type: 'comment' })
        return { tokens, endState: STATE_BLOCK_COMMENT }
      }
      // Comment ends here (include the closing `*/`).
      const end = close + 2
      tokens.push({ start: 0, end, type: 'comment' })
      i = end
      state = STATE_CLEAN
    }

    while (i < len) {
      const ch = line[i]

      if (isWhitespace(ch)) {
        i++
        continue
      }

      // ── Comments ──
      if (ch === '/' && line[i + 1] === '/') {
        tokens.push({ start: i, end: len, type: 'comment' })
        i = len
        break
      }
      if (ch === '/' && line[i + 1] === '*') {
        const close = line.indexOf('*/', i + 2)
        if (close === -1) {
          tokens.push({ start: i, end: len, type: 'comment' })
          i = len
          state = STATE_BLOCK_COMMENT
          break
        }
        const end = close + 2
        tokens.push({ start: i, end, type: 'comment' })
        i = end
        continue
      }

      // ── Strings ('...', "...", `...`) ──
      if (ch === "'" || ch === '"' || ch === '`') {
        const end = this.scanString(line, i, ch)
        tokens.push({ start: i, end, type: 'string' })
        i = end
        continue
      }

      // ── Numbers ──
      if (
        isDigit(ch) ||
        (ch === '.' && i + 1 < len && isDigit(line[i + 1]))
      ) {
        const end = this.scanNumber(line, i)
        tokens.push({ start: i, end, type: 'number' })
        i = end
        continue
      }

      // ── Identifiers / keywords / functions / types ──
      if (isIdentStart(ch)) {
        let j = i + 1
        while (j < len && isIdentPart(line[j])) j++
        const word = line.slice(i, j)

        let type: TokenType
        if (KEYWORDS.has(word)) {
          type = 'keyword'
        } else if (this.isFollowedByCall(line, j)) {
          type = 'function'
        } else if (/^[A-Z]/.test(word)) {
          type = 'type'
        } else {
          type = 'variable'
        }
        tokens.push({ start: i, end: j, type })
        i = j
        continue
      }

      // ── Operators ──
      const op = this.matchOperator(line, i)
      if (op > 0) {
        tokens.push({ start: i, end: i + op, type: 'operator' })
        i += op
        continue
      }

      // ── Fallback: never drop a character. ──
      tokens.push({ start: i, end: i + 1, type: 'text' })
      i++
    }

    return { tokens, endState: state }
  }

  /** Scan a string starting at the opening quote; returns the end col. */
  private scanString(line: string, start: number, quote: string): number {
    const len = line.length
    let i = start + 1
    while (i < len) {
      const ch = line[i]
      if (ch === '\\') {
        i += 2 // skip the escaped character
        continue
      }
      if (ch === quote) {
        return i + 1
      }
      i++
    }
    // Unterminated on this line — treat the rest of the line as string.
    return len
  }

  /** Scan a numeric literal starting at `start`; returns the end col. */
  private scanNumber(line: string, start: number): number {
    const len = line.length
    let i = start

    // Hex / binary / octal prefixes.
    if (
      line[i] === '0' &&
      i + 1 < len &&
      /[xXbBoO]/.test(line[i + 1])
    ) {
      i += 2
      while (i < len && /[0-9a-fA-F_]/.test(line[i])) i++
      return i
    }

    while (i < len && (isDigit(line[i]) || line[i] === '_')) i++
    if (line[i] === '.') {
      i++
      while (i < len && (isDigit(line[i]) || line[i] === '_')) i++
    }
    // Scientific notation.
    if (i < len && (line[i] === 'e' || line[i] === 'E')) {
      let j = i + 1
      if (j < len && (line[j] === '+' || line[j] === '-')) j++
      if (j < len && isDigit(line[j])) {
        i = j
        while (i < len && (isDigit(line[i]) || line[i] === '_')) i++
      }
    }
    return i
  }

  /** True if the next non-space char after `j` is `(` — i.e. a call site. */
  private isFollowedByCall(line: string, j: number): boolean {
    let k = j
    while (k < line.length && isWhitespace(line[k])) k++
    return line[k] === '('
  }

  /** Length of the operator matched at `i`, or 0 if none. */
  private matchOperator(line: string, i: number): number {
    for (const op of MULTI_OPERATORS) {
      if (line.startsWith(op, i)) return op.length
    }
    if (SINGLE_OPERATORS.has(line[i])) return 1
    return 0
  }
}

/** Singleton tokenizer instance implementing the `Tokenizer` contract. */
export const JsTokenizer: Tokenizer = new JsTokenizerImpl()

export default JsTokenizer
