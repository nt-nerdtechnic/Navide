// Inter-CLI messaging protocol: marker constants, turn-text parser, delivery
// envelope, and content sanitizing. Pure functions — no DOM, no side effects.
//
// Wire format (bare lines, never inside a fenced code block):
//   ---MSG-START--- to: <target messagingName>
//   <content, any number of lines>
//   ---MSG-END---
//
// Parsing runs on structured turn text (ActivityEvent.text), never on the
// terminal buffer.

export const MSG_START = '---MSG-START---'
export const MSG_END = '---MSG-END---'
export const MSG_ENVELOPE_PREFIX = '[Navide MSG] from:'

export interface ParsedAgentMessage {
  /** Raw target messagingName from the `to:` field (trimmed). */
  target: string
  /** Message body, trimmed. */
  content: string
}

const START_RE = /^---MSG-START---\s*to\s*:\s*(.*?)\s*$/
const END_RE = /^---MSG-END---\s*$/
const FENCE_RE = /^\s*(```|~~~)/
// Any ---UPPER-CASE--- control-marker token, wherever it appears in a line.
const MARKER_TOKEN_RE = /-{3}([A-Z][A-Z0-9-]*)-{3}/g

/**
 * Extract messaging blocks from one turn's assistant text.
 * - Markers must sit on bare lines (no leading whitespace).
 * - Content inside fenced code blocks (``` / ~~~) is ignored.
 * - Tolerant of a missing MSG-END: the block closes at the next MSG-START or
 *   at end of text.
 * - Blocks with an empty target or empty content are dropped.
 */
export function parseMessages(turnText: string): ParsedAgentMessage[] {
  const out: ParsedAgentMessage[] = []
  if (!turnText) return out

  let inFence = false
  let current: { target: string; lines: string[] } | null = null

  const close = (): void => {
    if (!current) return
    const content = current.lines.join('\n').trim()
    if (current.target && content) out.push({ target: current.target, content })
    current = null
  }

  for (const line of turnText.split('\n')) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence
      if (current) current.lines.push(line)
      continue
    }
    if (inFence) {
      if (current) current.lines.push(line)
      continue
    }
    const start = START_RE.exec(line)
    if (start) {
      close()
      current = { target: start[1], lines: [] }
      continue
    }
    if (current) {
      if (END_RE.test(line)) close()
      else current.lines.push(line)
    }
  }
  close()
  return out
}

/**
 * Break every ---MARKER--- token in forwarded content with zero-width spaces
 * so the delivered text can never re-trigger message/sentinel/router parsers
 * (theirs are not all line-anchored).
 */
export function sanitizeMessageContent(content: string): string {
  return content.replace(MARKER_TOKEN_RE, '-\u200B--$1-\u200B--')
}

/**
 * Wrap a message for injection into the target pane. The reply hint stays on
 * a single line so it can never parse as a bare marker.
 */
export function renderEnvelope(
  sender: string,
  content: string,
  opts: { includeReplyHint?: boolean } = {},
): string {
  const lines = [`${MSG_ENVELOPE_PREFIX} ${sender}`, sanitizeMessageContent(content)]
  if (opts.includeReplyHint !== false) {
    lines.push(
      `（回覆方式：輸出裸行區塊 ${MSG_START} to: ${sender}，下一行起為訊息內容，` +
        `最後一行 ${MSG_END}；marker 必須獨立整行且不可放在 code block 內）`,
    )
  }
  return lines.join('\n')
}

/**
 * One-shot system briefing injected into a pane so its CLI knows the messaging
 * protocol and who it can reach. Re-sent (upserted) whenever the roster
 * changes. Peers come from the pane name registry — the same data the sidebar
 * CLI pane list shows.
 */
export function renderRosterBriefing(
  selfName: string,
  peers: { name: string; label: string }[],
): string {
  const roster = peers.map((p) => `${p.name}（${p.label}）`).join('、')
  return [
    `[Inter-CLI Messaging] 你是「${selfName}」。你可以直接傳訊息給其他 CLI pane：輸出裸行區塊`,
    `${MSG_START} to: <目標名稱>`,
    '<訊息內容，可多行>',
    MSG_END,
    '（marker 必須獨立整行、不可放在 markdown code block 內；沒有溝通需求時不要輸出）',
    `目前可傳訊的對象：${roster}`,
    '收到此訊息不需回覆，繼續原本的工作即可。',
  ].join('\n')
}

/** Smallest free `<agentKey>-<n>` name not present in `taken`. */
export function defaultMessagingName(agentKey: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  for (let n = 1; ; n++) {
    const name = `${agentKey}-${n}`
    if (!used.has(name)) return name
  }
}

/** A usable messagingName: non-empty, single line. Returns trimmed name or null. */
export function normalizeMessagingName(raw: string): string | null {
  const name = raw.trim()
  if (!name || name.includes('\n')) return null
  return name
}
