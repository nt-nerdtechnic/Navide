/**
 * JSON tokenizer. JSON strings are always single-line (no carry-over state).
 * Handles strings, numbers (including negative/scientific), keywords (true/false/null),
 * and structural punctuation.
 */

import type { LineTokens, Token, TokenizerState, Tokenizer } from '../types'

const STATE_CLEAN: TokenizerState = 0

const JSON_KEYWORDS = new Set(['true', 'false', 'null'])

class JsonTokenizerImpl implements Tokenizer {
  initialState(): TokenizerState { return STATE_CLEAN }

  tokenizeLine(line: string, _startState: TokenizerState): LineTokens {
    const tokens: Token[] = []
    const len = line.length
    let i = 0

    while (i < len) {
      const ch = line[i]

      if (ch === ' ' || ch === '\t') { i++; continue }

      // String
      if (ch === '"') {
        let j = i + 1
        while (j < len) {
          if (line[j] === '\\') { j += 2; continue }
          if (line[j] === '"') { j++; break }
          j++
        }
        tokens.push({ start: i, end: j, type: 'string' })
        i = j
        continue
      }

      // Number (including negative, decimal, scientific)
      if ((ch >= '0' && ch <= '9') || (ch === '-' && i + 1 < len && line[i + 1] >= '0' && line[i + 1] <= '9')) {
        let j = i
        if (line[j] === '-') j++
        while (j < len && line[j] >= '0' && line[j] <= '9') j++
        if (j < len && line[j] === '.') {
          j++
          while (j < len && line[j] >= '0' && line[j] <= '9') j++
        }
        if (j < len && (line[j] === 'e' || line[j] === 'E')) {
          j++
          if (j < len && (line[j] === '+' || line[j] === '-')) j++
          while (j < len && line[j] >= '0' && line[j] <= '9') j++
        }
        tokens.push({ start: i, end: j, type: 'number' })
        i = j
        continue
      }

      // true / false / null
      if (ch >= 'a' && ch <= 'z') {
        let j = i + 1
        while (j < len && line[j] >= 'a' && line[j] <= 'z') j++
        const word = line.slice(i, j)
        tokens.push({ start: i, end: j, type: JSON_KEYWORDS.has(word) ? 'keyword' : 'text' })
        i = j
        continue
      }

      // Structural punctuation
      if ('{}[]:,'.includes(ch)) {
        tokens.push({ start: i, end: i + 1, type: 'operator' })
        i++
        continue
      }

      // Comments (jsonc: // and /* */)
      if (ch === '/' && i + 1 < len) {
        if (line[i + 1] === '/') {
          tokens.push({ start: i, end: len, type: 'comment' })
          i = len
          break
        }
        if (line[i + 1] === '*') {
          const close = line.indexOf('*/', i + 2)
          const end = close === -1 ? len : close + 2
          tokens.push({ start: i, end, type: 'comment' })
          i = end
          continue
        }
      }

      tokens.push({ start: i, end: i + 1, type: 'text' })
      i++
    }

    return { tokens, endState: STATE_CLEAN }
  }
}

export const JsonTokenizer: Tokenizer = new JsonTokenizerImpl()
