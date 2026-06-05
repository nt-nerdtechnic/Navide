import type { LineTokens, Token, TokenizerState, Tokenizer } from '../types'

const STATE_CLEAN: TokenizerState = 0
const STATE_BLOCK_COMMENT: TokenizerState = 1

const AT_RULES = new Set([
  'media', 'keyframes', 'import', 'charset', 'namespace', 'supports',
  'font-face', 'page', 'layer', 'container',
])

class CssTokenizerImpl implements Tokenizer {
  initialState(): TokenizerState { return STATE_CLEAN }

  tokenizeLine(line: string, startState: TokenizerState): LineTokens {
    const tokens: Token[] = []
    const len = line.length
    let i = 0
    let state = startState

    if (state === STATE_BLOCK_COMMENT) {
      const end = line.indexOf('*/')
      if (end === -1) {
        if (len > 0) tokens.push({ start: 0, end: len, type: 'comment' })
        return { tokens, endState: STATE_BLOCK_COMMENT }
      }
      tokens.push({ start: 0, end: end + 2, type: 'comment' })
      i = end + 2
      state = STATE_CLEAN
    }

    while (i < len) {
      const ch = line[i]

      if (ch === ' ' || ch === '\t') { i++; continue }

      // Block comment
      if (ch === '/' && line[i + 1] === '*') {
        const end = line.indexOf('*/', i + 2)
        if (end === -1) {
          tokens.push({ start: i, end: len, type: 'comment' })
          state = STATE_BLOCK_COMMENT
          i = len
          break
        }
        tokens.push({ start: i, end: end + 2, type: 'comment' })
        i = end + 2
        continue
      }

      // At-rule (@media, @keyframes, ...)
      if (ch === '@') {
        let j = i + 1
        while (j < len && /[a-zA-Z-]/.test(line[j])) j++
        const keyword = line.slice(i + 1, j).toLowerCase()
        tokens.push({ start: i, end: j, type: AT_RULES.has(keyword) ? 'keyword' : 'function' })
        i = j
        continue
      }

      // Strings
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

      // Numbers with optional units (12px, 1.5em, 100%)
      if (ch >= '0' && ch <= '9' || (ch === '.' && i + 1 < len && line[i + 1] >= '0' && line[i + 1] <= '9') || (ch === '-' && i + 1 < len && (line[i + 1] >= '0' && line[i + 1] <= '9'))) {
        let j = i
        if (line[j] === '-') j++
        while (j < len && (line[j] >= '0' && line[j] <= '9' || line[j] === '.')) j++
        while (j < len && /[a-zA-Z%]/.test(line[j])) j++
        tokens.push({ start: i, end: j, type: 'number' })
        i = j
        continue
      }

      // Hex colors (#fff, #1a2b3c)
      if (ch === '#') {
        let j = i + 1
        while (j < len && /[0-9a-fA-F]/.test(line[j])) j++
        if (j > i + 1) {
          tokens.push({ start: i, end: j, type: 'number' })
          i = j
          continue
        }
        // Otherwise it's a selector ID (#id)
        while (j < len && /[a-zA-Z0-9_-]/.test(line[j])) j++
        tokens.push({ start: i, end: j, type: 'type' })
        i = j
        continue
      }

      // Class selector (.class)
      if (ch === '.') {
        let j = i + 1
        while (j < len && /[a-zA-Z0-9_-]/.test(line[j])) j++
        if (j > i + 1) {
          tokens.push({ start: i, end: j, type: 'function' })
          i = j
          continue
        }
        tokens.push({ start: i, end: i + 1, type: 'text' })
        i++
        continue
      }

      // Identifiers: CSS property name (before :) or value keyword
      if (/[a-zA-Z_-]/.test(ch)) {
        let j = i
        while (j < len && /[a-zA-Z0-9_-]/.test(line[j])) j++
        const word = line.slice(i, j)
        // Look ahead past whitespace to see if followed by ':'
        let k = j
        while (k < len && (line[k] === ' ' || line[k] === '\t')) k++
        const type = line[k] === ':' && line[k + 1] !== ':' ? 'variable' : 'text'
        tokens.push({ start: i, end: j, type })
        i = j
        continue
      }

      // Pseudo-class / pseudo-element (::before, :hover)
      if (ch === ':') {
        let j = i
        while (j < len && line[j] === ':') j++
        while (j < len && /[a-zA-Z-]/.test(line[j])) j++
        if (j > i + 1) {
          tokens.push({ start: i, end: j, type: 'keyword' })
          i = j
          continue
        }
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

export const CssTokenizer: Tokenizer = new CssTokenizerImpl()
