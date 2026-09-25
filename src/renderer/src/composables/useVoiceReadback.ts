/**
 * Spoken readback for voice-driven panes.
 *
 * When a pane that took a voice message in the last READBACK_WINDOW_MS ends a
 * turn, a short local summary of the turn's text is spoken with the platform
 * speech synthesizer. Nothing leaves the machine and no model is involved: the
 * summary is a heuristic (see summarizeForSpeech). Off by default, and panes
 * the user never spoke to are never read out.
 */

export const READBACK_WINDOW_MS = 10 * 60_000
export const READBACK_MAX_CHARS = 200
const MAX_SENTENCES = 2

/** The first `n` sentences of `text`. A sentence ends at CJK/ASCII ! ? 。 or at
 *  a '.' followed by whitespace — so "v1.2" and "file.ts" stay whole. */
function firstSentences(text: string, n: number): string {
  let count = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const ends = '。！？!?'.includes(c) || (c === '.' && (i + 1 === text.length || /\s/.test(text[i + 1])))
    if (!ends) continue
    // A run of terminators ("?!", "。。") closes one sentence.
    while (i + 1 < text.length && '。！？!?.'.includes(text[i + 1])) i++
    if (++count === n) return text.slice(0, i + 1).trim()
  }
  return text.trim()
}

/**
 * Plain-speech summary of an agent's turn: code, markup and inter-CLI message
 * blocks removed, then the first two sentences, capped at READBACK_MAX_CHARS.
 * Empty when nothing speakable is left.
 */
export function summarizeForSpeech(text: string): string {
  const plain = text
    // Inter-CLI message blocks are addressed to another pane, not the user.
    .replace(/^---MSG-START---[\s\S]*?^---MSG-END---\s*$/gm, ' ')
    // Fenced code blocks, closed or left open at the end of the turn.
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/~~~[\s\S]*?(~~~|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/<[^>\n]+>/g, ' ')
    // Images vanish, links keep their label.
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    // Line-level markup: headings, quotes, list bullets, table rules.
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, '')
    .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, ' ')
    .replace(/\|/g, ' ')
    .replace(/^\s*(?:[-*_]\s*){3,}$/gm, ' ')
    // Emphasis markers.
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim()
  if (!plain) return ''
  let out = firstSentences(plain, MAX_SENTENCES)
  if (out.length > READBACK_MAX_CHARS) out = `${out.slice(0, READBACK_MAX_CHARS - 1).trimEnd()}…`
  return out
}

export interface ReadbackDeps {
  enabled: () => boolean
  /** Speak `text`, cutting off anything still being spoken. */
  speak: (text: string) => void
  /** Fallback line when a turn leaves nothing to summarize. */
  doneLine: (paneId: string) => string
  now?: () => number
}

export function useVoiceReadback(deps: ReadbackDeps) {
  const now = deps.now ?? (() => Date.now())
  /** paneId → when a voice message last reached it. */
  const voicedAt = new Map<string, number>()

  function noteVoiceDelivered(paneId: string): void {
    voicedAt.set(paneId, now())
  }

  /**
   * A pane ended a turn. `eventMs` is the event's own clock when it has one
   * (NaN otherwise); a replayed event from before the voice message is skipped.
   */
  function onTurnComplete(paneId: string, text: string, eventMs: number = Number.NaN): void {
    if (!deps.enabled()) return
    const at = voicedAt.get(paneId)
    if (at === undefined) return
    const t = now()
    if (t - at > READBACK_WINDOW_MS) {
      voicedAt.delete(paneId)
      return
    }
    if (!Number.isNaN(eventMs) && eventMs < at) return
    deps.speak(summarizeForSpeech(text) || deps.doneLine(paneId))
  }

  return { noteVoiceDelivered, onTurnComplete }
}

/** The platform synthesizer, interrupting whatever it was saying. */
export function speakWithSynthesis(text: string, lang?: string): void {
  const synth = globalThis.speechSynthesis
  if (!synth || typeof SpeechSynthesisUtterance === 'undefined') return
  synth.cancel()
  const u = new SpeechSynthesisUtterance(text)
  if (lang) u.lang = lang
  synth.speak(u)
}
