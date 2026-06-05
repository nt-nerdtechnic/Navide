/**
 * Python tokenizer. Handles:
 * - # single-line comments
 * - Triple-quoted strings (""" and ''') spanning multiple lines (carry-over state)
 * - Regular single/double-quoted strings (single-line)
 * - @decorators → function token
 * - Python keywords
 * - Numbers (int, float, scientific, hex/bin/oct)
 * - Identifiers: function calls, PascalCase types, variables
 */

import type { LineTokens, Token, TokenizerState, Tokenizer, TokenType } from '../types'

const STATE_CLEAN: TokenizerState = 0
const STATE_TRIPLE_DOUBLE: TokenizerState = 1
const STATE_TRIPLE_SINGLE: TokenizerState = 2

const PYTHON_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await',
  'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except',
  'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is',
  'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return',
  'try', 'while', 'with', 'yield',
])

function isDigit(ch: string): boolean { return ch >= '0' && ch <= '9' }
function isIdStart(ch: string): boolean { return /[A-Za-z_]/.test(ch) }
function isIdPart(ch: string): boolean { return /[A-Za-z0-9_]/.test(ch) }
function isWS(ch: string): boolean { return ch === ' ' || ch === '\t' }

class PythonTokenizerImpl implements Tokenizer {
  initialState(): TokenizerState { return STATE_CLEAN }

  tokenizeLine(line: string, startState: TokenizerState): LineTokens {
    const tokens: Token[] = []
    const len = line.length
    let i = 0
    let state = startState

    // Continue triple-quoted string from previous line
    if (state === STATE_TRIPLE_DOUBLE || state === STATE_TRIPLE_SINGLE) {
      const close = state === STATE_TRIPLE_DOUBLE ? '"""' : "'''"
      const idx = line.indexOf(close)
      if (idx === -1) {
        if (len > 0) tokens.push({ start: 0, end: len, type: 'string' })
        return { tokens, endState: state }
      }
      const end = idx + 3
      tokens.push({ start: 0, end, type: 'string' })
      i = end
      state = STATE_CLEAN
    }

    while (i < len) {
      const ch = line[i]

      if (isWS(ch)) { i++; continue }

      // Comment
      if (ch === '#') {
        tokens.push({ start: i, end: len, type: 'comment' })
        break
      }

      // Triple-quoted strings (check before single-quoted)
      if ((ch === '"' && line.startsWith('"""', i)) || (ch === "'" && line.startsWith("'''", i))) {
        const isDouble = ch === '"'
        const close = isDouble ? '"""' : "'''"
        const nextState = isDouble ? STATE_TRIPLE_DOUBLE : STATE_TRIPLE_SINGLE
        const closeIdx = line.indexOf(close, i + 3)
        if (closeIdx === -1) {
          tokens.push({ start: i, end: len, type: 'string' })
          state = nextState
          i = len
          break
        }
        const end = closeIdx + 3
        tokens.push({ start: i, end, type: 'string' })
        i = end
        continue
      }

      // String prefixes: r"", b"", f"", rb"", etc.
      if (isIdStart(ch) && i + 1 < len) {
        const peek = line.slice(i).toLowerCase()
        const prefixMatch = /^(r|b|f|u|rb|br|fr|rf)["']/.exec(peek)
        if (prefixMatch) {
          const prefixLen = prefixMatch[1].length
          const quote = line[i + prefixLen]
          // Check for triple-quote with prefix
          if (line.startsWith(quote.repeat(3), i + prefixLen)) {
            const close = quote.repeat(3)
            const nextState = quote === '"' ? STATE_TRIPLE_DOUBLE : STATE_TRIPLE_SINGLE
            const closeIdx = line.indexOf(close, i + prefixLen + 3)
            if (closeIdx === -1) {
              tokens.push({ start: i, end: len, type: 'string' })
              state = nextState
              i = len
              break
            }
            const end = closeIdx + 3
            tokens.push({ start: i, end, type: 'string' })
            i = end
            continue
          }
          // Single-quoted with prefix
          let j = i + prefixLen + 1
          while (j < len && line[j] !== quote) {
            if (line[j] === '\\') j++
            j++
          }
          if (j < len) j++
          tokens.push({ start: i, end: j, type: 'string' })
          i = j
          continue
        }
      }

      // Single/double-quoted strings
      if (ch === '"' || ch === "'") {
        let j = i + 1
        while (j < len && line[j] !== ch) {
          if (line[j] === '\\') j++
          j++
        }
        if (j < len) j++
        tokens.push({ start: i, end: j, type: 'string' })
        i = j
        continue
      }

      // Decorator (@name)
      if (ch === '@') {
        let j = i + 1
        while (j < len && isIdPart(line[j])) j++
        tokens.push({ start: i, end: j, type: 'function' })
        i = j
        continue
      }

      // Number
      if (isDigit(ch) || (ch === '.' && i + 1 < len && isDigit(line[i + 1]))) {
        let j = i
        // Hex / bin / oct prefix
        if (line[j] === '0' && j + 1 < len && /[xXbBoO]/.test(line[j + 1])) {
          j += 2
          while (j < len && /[0-9a-fA-F_]/.test(line[j])) j++
        } else {
          while (j < len && (isDigit(line[j]) || line[j] === '_')) j++
          if (j < len && line[j] === '.') {
            j++
            while (j < len && (isDigit(line[j]) || line[j] === '_')) j++
          }
          if (j < len && (line[j] === 'e' || line[j] === 'E')) {
            j++
            if (j < len && (line[j] === '+' || line[j] === '-')) j++
            while (j < len && isDigit(line[j])) j++
          }
        }
        // Optional complex suffix j/J
        if (j < len && (line[j] === 'j' || line[j] === 'J')) j++
        tokens.push({ start: i, end: j, type: 'number' })
        i = j
        continue
      }

      // Identifiers, keywords, builtins
      if (isIdStart(ch)) {
        let j = i + 1
        while (j < len && isIdPart(line[j])) j++
        const word = line.slice(i, j)
        let k = j
        while (k < len && isWS(line[k])) k++
        let type: TokenType = 'variable'
        if (PYTHON_KEYWORDS.has(word)) type = 'keyword'
        else if (line[k] === '(') type = 'function'
        else if (/^[A-Z]/.test(word)) type = 'type'
        tokens.push({ start: i, end: j, type })
        i = j
        continue
      }

      // Operators and punctuation
      if ('+-*/%=<>!&|^~()[]{}.,:;\\'  .includes(ch)) {
        tokens.push({ start: i, end: i + 1, type: 'operator' })
        i++
        continue
      }

      tokens.push({ start: i, end: i + 1, type: 'text' })
      i++
    }

    return { tokens, endState: state }
  }
}

export const PythonTokenizer: Tokenizer = new PythonTokenizerImpl()
