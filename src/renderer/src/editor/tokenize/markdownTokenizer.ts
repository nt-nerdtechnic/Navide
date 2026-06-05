import type { LineTokens, Token, TokenizerState, Tokenizer } from '../types'

const STATE_NORMAL: TokenizerState = 0
const STATE_CODE_FENCE: TokenizerState = 1
const STATE_FRONT_MATTER_BODY: TokenizerState = 2
/** Emitted by initialState(): we are at the very first line — `---` means front matter. */
const STATE_FRONT_MATTER_AWAIT: TokenizerState = 3

class MarkdownTokenizerImpl implements Tokenizer {
  initialState(): TokenizerState { return STATE_FRONT_MATTER_AWAIT }

  tokenizeLine(line: string, startState: TokenizerState): LineTokens {
    const len = line.length

    // Very first line of file: `---` is YAML front matter; anything else is normal.
    if (startState === STATE_FRONT_MATTER_AWAIT) {
      if (/^-{3,}\s*$/.test(line)) {
        const tokens: Token[] = len > 0 ? [{ start: 0, end: len, type: 'comment' }] : []
        return { tokens, endState: STATE_FRONT_MATTER_BODY }
      }
      return this.tokenizeNormal(line, STATE_NORMAL)
    }

    // Inside YAML front matter block.
    if (startState === STATE_FRONT_MATTER_BODY) {
      if (/^(-{3,}|\.{3,})\s*$/.test(line)) {
        const tokens: Token[] = len > 0 ? [{ start: 0, end: len, type: 'comment' }] : []
        return { tokens, endState: STATE_NORMAL }
      }
      const tokens: Token[] = len > 0 ? [{ start: 0, end: len, type: 'comment' }] : []
      return { tokens, endState: STATE_FRONT_MATTER_BODY }
    }

    return this.tokenizeNormal(line, startState)
  }

  private tokenizeNormal(line: string, startState: TokenizerState): LineTokens {
    const tokens: Token[] = []
    const len = line.length
    const trimmed = line.trimStart()

    // Inside a fenced code block: whole line is string
    if (startState === STATE_CODE_FENCE) {
      if (len > 0) tokens.push({ start: 0, end: len, type: 'string' })
      if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
        return { tokens, endState: STATE_NORMAL }
      }
      return { tokens, endState: STATE_CODE_FENCE }
    }

    // Opening code fence: ``` or ~~~
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      if (len > 0) tokens.push({ start: 0, end: len, type: 'string' })
      const fenceTag = trimmed.startsWith('```') ? '```' : '~~~'
      const afterFence = trimmed.slice(fenceTag.length)
      // Single-line fence (e.g., ```code``` — unusual but safe to handle)
      return { tokens, endState: afterFence.includes(fenceTag) ? STATE_NORMAL : STATE_CODE_FENCE }
    }

    // ATX Heading: # through ######
    if (line.startsWith('#')) {
      let i = 0
      while (i < len && line[i] === '#') i++
      if (i <= 6 && (i === len || line[i] === ' ')) {
        tokens.push({ start: 0, end: len, type: 'keyword' })
        return { tokens, endState: STATE_NORMAL }
      }
    }

    // Blockquote
    if (trimmed.startsWith('>')) {
      tokens.push({ start: 0, end: len, type: 'comment' })
      return { tokens, endState: STATE_NORMAL }
    }

    // Thematic break: --- / *** / === (3+ identical chars, optional spaces)
    const stripped = line.replace(/ /g, '')
    if (/^(-{3,}|\*{3,}|={3,})$/.test(stripped)) {
      if (len > 0) tokens.push({ start: 0, end: len, type: 'operator' })
      return { tokens, endState: STATE_NORMAL }
    }

    // List item marker (unordered: - * +  or ordered: 1.)
    const listM = line.match(/^(\s*)([-*+]|\d+\.)( )/)
    if (listM) {
      const markerStart = listM[1].length
      const markerEnd = markerStart + listM[2].length + listM[3].length
      tokens.push({ start: markerStart, end: markerEnd, type: 'function' })
      this.scanInline(line, markerEnd, tokens)
      return { tokens, endState: STATE_NORMAL }
    }

    // Normal line — scan inline spans
    this.scanInline(line, 0, tokens)
    return { tokens, endState: STATE_NORMAL }
  }

  private scanInline(line: string, start: number, tokens: Token[]): void {
    const len = line.length
    let i = start
    while (i < len) {
      const ch = line[i]

      // Inline code: `...`
      if (ch === '`') {
        let j = i + 1
        while (j < len && line[j] !== '`') j++
        if (j < len) { tokens.push({ start: i, end: j + 1, type: 'string' }); i = j + 1; continue }
        i++; continue
      }

      // Bold: **...** or __...__
      if ((ch === '*' && line[i + 1] === '*') || (ch === '_' && line[i + 1] === '_')) {
        const delim = ch + ch
        const j = line.indexOf(delim, i + 2)
        if (j !== -1) { tokens.push({ start: i, end: j + 2, type: 'type' }); i = j + 2; continue }
      }

      // Italic: *...* or _..._
      if (ch === '*' || ch === '_') {
        const j = line.indexOf(ch, i + 1)
        if (j !== -1 && j > i + 1) { tokens.push({ start: i, end: j + 1, type: 'keyword' }); i = j + 1; continue }
      }

      // Image: ![alt](url)  or  Link: [text](url)
      if (ch === '[' || (ch === '!' && line[i + 1] === '[')) {
        const off = ch === '!' ? 1 : 0
        const closeB = line.indexOf(']', i + off + 1)
        if (closeB !== -1 && line[closeB + 1] === '(') {
          const closeP = line.indexOf(')', closeB + 2)
          if (closeP !== -1) {
            tokens.push({ start: i, end: closeB + 1, type: 'function' })
            tokens.push({ start: closeB + 1, end: closeP + 1, type: 'number' })
            i = closeP + 1; continue
          }
        }
      }

      i++
    }
  }
}

export const MarkdownTokenizer: Tokenizer = new MarkdownTokenizerImpl()
