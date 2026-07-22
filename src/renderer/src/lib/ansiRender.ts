// ansiRender.ts — pure helpers for rendering terminal log text in the UI.
//
// Only a whitelist of SGR attributes is honored (basic 16 colors, bold,
// reset); every other escape sequence (cursor movement, OSC titles/links,
// charset designations, ...) is stripped. Rendering must NOT use v-html:
// callers render segments as v-for spans so the text goes through Vue's
// interpolation and is escaped naturally.

export interface AnsiSegment {
  text: string
  /** Basic color name, e.g. 'red' or 'bright-blue' (maps to --ansi-* vars). */
  fg?: string
  bg?: string
  bold?: boolean
}

/** A segment piece after search-highlight splitting. `matchIndex` is set on
 * pieces that belong to the Nth (0-based) query match. */
export interface HighlightedPiece extends AnsiSegment {
  matchIndex?: number
}

const BASIC_COLORS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
] as const

function colorName(index: number): string | undefined {
  if (index >= 0 && index < 8) return BASIC_COLORS[index]
  if (index >= 8 && index < 16) return `bright-${BASIC_COLORS[index - 8]}`
  return undefined
}

// Alternatives, in priority order:
// 1. CSI:  ESC [ params final-byte      (only final 'm' = SGR is interpreted)
// 2. OSC:  ESC ] ... terminated by BEL or ST (ESC \), terminator optional so
//          a truncated OSC at end-of-buffer is still stripped
// 3. Other ESC sequences: intermediates + final byte (charset designation,
//    ESC 7 / ESC = , ...) — '[' and ']' are claimed by alternatives 1-2 first
// 4. A lone trailing ESC
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE =
  /\x1b\[([0-9;?]*)([\x40-\x7e])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[\x20-\x2f]*[\x30-\x7e]|\x1b/g

interface SgrState {
  fg?: string
  bg?: string
  bold: boolean
}

function applySgr(params: string, state: SgrState): void {
  // Private-parameter SGR (e.g. ESC[?...m) is not real SGR — ignore entirely.
  if (params.includes('?')) return
  const codes = params.split(';').map((p) => (p === '' ? 0 : Number(p)))
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i]
    if (Number.isNaN(code)) continue
    if (code === 0) {
      state.fg = undefined
      state.bg = undefined
      state.bold = false
    } else if (code === 1) {
      state.bold = true
    } else if (code >= 30 && code <= 37) {
      state.fg = colorName(code - 30)
    } else if (code >= 90 && code <= 97) {
      state.fg = colorName(code - 90 + 8)
    } else if (code >= 40 && code <= 47) {
      state.bg = colorName(code - 40)
    } else if (code >= 100 && code <= 107) {
      state.bg = colorName(code - 100 + 8)
    } else if (code === 38 || code === 48) {
      // Extended color. 38;5;n / 48;5;n maps to the basic 16 when n < 16 and
      // is ignored otherwise; 38;2;r;g;b / 48;2;r;g;b is always ignored.
      // Either way the extra params must be consumed.
      const mode = codes[i + 1]
      if (mode === 5) {
        const n = codes[i + 2]
        const name = typeof n === 'number' ? colorName(n) : undefined
        if (name !== undefined) {
          if (code === 38) state.fg = name
          else state.bg = name
        }
        i += 2
      } else if (mode === 2) {
        i += 4
      }
    }
    // Everything else (underline, dim, 39/49, ...) is outside the whitelist
    // and intentionally a no-op.
  }
}

/** Parse text containing ANSI escapes into styled segments. Non-SGR escape
 * sequences are stripped; the text itself is returned verbatim (callers
 * render it via Vue interpolation, never v-html). */
export function parseAnsiSegments(text: string): AnsiSegment[] {
  const segments: AnsiSegment[] = []
  const state: SgrState = { bold: false }

  function push(chunk: string): void {
    if (!chunk) return
    const prev = segments[segments.length - 1]
    if (
      prev &&
      prev.fg === state.fg &&
      prev.bg === state.bg &&
      (prev.bold ?? false) === state.bold
    ) {
      prev.text += chunk
      return
    }
    const seg: AnsiSegment = { text: chunk }
    if (state.fg !== undefined) seg.fg = state.fg
    if (state.bg !== undefined) seg.bg = state.bg
    if (state.bold) seg.bold = true
    segments.push(seg)
  }

  ANSI_ESCAPE_RE.lastIndex = 0
  let last = 0
  let match: RegExpExecArray | null
  while ((match = ANSI_ESCAPE_RE.exec(text)) !== null) {
    push(text.slice(last, match.index))
    last = match.index + match[0].length
    if (match[2] === 'm') applySgr(match[1] ?? '', state)
    // Any other sequence: stripped, no state change.
  }
  push(text.slice(last))
  return segments
}

/** Plain text with every ANSI escape sequence removed. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, '')
}

/** Split segments so every case-insensitive occurrence of `query` becomes its
 * own piece tagged with a 0-based matchIndex. Matches are found on the joined
 * plain text, so a match spanning a style boundary yields multiple pieces
 * sharing one matchIndex. Empty/blank query or no hits returns the input
 * pieces untouched with matchCount 0. */
export function highlightSegments(
  segments: AnsiSegment[],
  query: string
): { pieces: HighlightedPiece[]; matchCount: number } {
  const q = query.toLowerCase()
  if (!q) return { pieces: segments, matchCount: 0 }

  const full = segments.map((s) => s.text).join('').toLowerCase()
  const ranges: Array<[number, number]> = []
  let at = 0
  while ((at = full.indexOf(q, at)) !== -1) {
    ranges.push([at, at + q.length])
    at += q.length
  }
  if (ranges.length === 0) return { pieces: segments, matchCount: 0 }

  const pieces: HighlightedPiece[] = []
  let offset = 0
  let r = 0
  for (const seg of segments) {
    const segStart = offset
    const segEnd = offset + seg.text.length
    let local = 0
    while (local < seg.text.length) {
      const abs = segStart + local
      while (r < ranges.length && ranges[r][1] <= abs) r++
      if (r < ranges.length && ranges[r][0] <= abs) {
        const end = Math.min(ranges[r][1], segEnd) - segStart
        pieces.push({ ...seg, text: seg.text.slice(local, end), matchIndex: r })
        local = end
      } else {
        const next =
          r < ranges.length ? Math.min(ranges[r][0] - segStart, seg.text.length) : seg.text.length
        pieces.push({ ...seg, text: seg.text.slice(local, next) })
        local = next
      }
    }
    offset = segEnd
  }
  return { pieces, matchCount: ranges.length }
}

/** Keep at most the last `maxLines` lines of `text`. */
export function tailLines(
  text: string,
  maxLines: number
): { text: string; truncated: boolean } {
  let count = 0
  let idx = text.length
  while (count < maxLines) {
    const nl = text.lastIndexOf('\n', idx - 1)
    if (nl === -1) return { text, truncated: false }
    count++
    idx = nl
  }
  return { text: text.slice(idx + 1), truncated: true }
}
