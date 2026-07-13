// Reply builder for the main window's cli:get-pane-buffer responder (see the
// onCliPaneBufferRequest registration in App.vue). Pure so the lookup → reply
// mapping is unit-testable without mounting App.vue.

import { bufferTail } from './buffer'

/** MIME type set by TerminalPane's header dragstart (drag source). */
export const CLI_CONTEXT_MIME = 'application/x-cli-context'
/** MIME type carrying a bare pane id. Set (as an inline literal) by pane
 *  reorder drag sources: TerminalPane's header and ControlPane's agent list. */
export const PANE_ID_MIME = 'application/x-pane-id'
/** sourceId prefix marking a chip as a CLI-pane snapshot (enables refresh). */
export const CLI_SOURCE_PREFIX = 'cli-pane:'
/** Tail cap applied to the pane buffer before wrapping it into a chip. */
export const CLI_CHIP_BUFFER_CAP = 32 * 1024

/** Drag payload carried under CLI_CONTEXT_MIME (set in TerminalPane.vue). */
export interface CliContextPayload {
  paneId: string
  agentKey?: string
  label?: string
  sessionId?: string | null
}

/** Parse the CLI-context drag payload. Returns null for malformed JSON or a
 *  payload without a usable paneId. */
export function parseCliContextPayload(raw: string): CliContextPayload | null {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const rec = obj as Record<string, unknown>
  if (typeof rec.paneId !== 'string' || !rec.paneId) return null
  return {
    paneId: rec.paneId,
    agentKey: typeof rec.agentKey === 'string' && rec.agentKey ? rec.agentKey : undefined,
    label: typeof rec.label === 'string' && rec.label ? rec.label : undefined,
    sessionId: typeof rec.sessionId === 'string' && rec.sessionId ? rec.sessionId : null
  }
}

/** Decide the CLI drop payload from the two drag-MIME strings.
 *  - cliRaw present → parse it; malformed → 'malformed' (caller surfaces it)
 *  - cliRaw absent but paneIdRaw present → minimal synthesized payload (the
 *    pane-buffer IPC reply fills in label/sessionId)
 *  - neither → null (not a CLI-pane drop) */
export function resolveCliDropPayload(
  cliRaw: string,
  paneIdRaw: string
): CliContextPayload | 'malformed' | null {
  if (cliRaw) return parseCliContextPayload(cliRaw) ?? 'malformed'
  if (paneIdRaw) return { paneId: paneIdRaw, agentKey: '', label: '', sessionId: null }
  return null
}

export type CliContextChipResult =
  | { kind: 'chip'; label: string; content: string; sourceId: string }
  | { kind: 'empty' }
  | { kind: 'error'; error: string }

/** Build the context-chip fields from the drag payload and the pane-buffer
 *  reply. Pure (timestamp injected) so it is unit-testable without AIChatPane.
 *  - reply carries an error → passthrough (caller surfaces it, no chip)
 *  - empty/whitespace buffer → 'empty' (no chip)
 *  - otherwise → chip with a header line + tail-truncated fenced buffer */
export function buildCliContextChip(
  payload: CliContextPayload,
  reply: { label?: string; sessionId?: string | null; buffer?: string; error?: string },
  capturedAt: number = Date.now()
): CliContextChipResult {
  if (reply.error) return { kind: 'error', error: reply.error }
  const buffer = reply.buffer ?? ''
  if (!buffer.trim()) return { kind: 'empty' }
  const name = reply.label || payload.label || payload.agentKey || 'pane'
  const session = reply.sessionId || payload.sessionId || null
  const header =
    `// CLI pane: ${payload.agentKey || payload.label || reply.label || 'unknown agent'}` +
    ` — session: ${session ?? 'no session'}` +
    ` — captured: ${new Date(capturedAt).toISOString()}`
  const tail = bufferTail(buffer, CLI_CHIP_BUFFER_CAP)
  return {
    kind: 'chip',
    label: `@cli:${name}`,
    content: `${header}\n\`\`\`\n${tail}\n\`\`\``,
    sourceId: `${CLI_SOURCE_PREFIX}${payload.paneId}`
  }
}

export interface CliPaneBufferReply {
  label: string
  sessionId: string | null
  buffer: string
}

/** Shape a responder reply from the pane record and its TerminalPane ref.
 *  A missing ref means the pane is gone (closed between drag and drop). */
export function buildCliPaneBufferReply(
  pane: { customName?: string; agentLabel: string } | undefined,
  paneRef: { sessionId?: string; cleanBuffer?: string } | null | undefined
): CliPaneBufferReply | { error: 'not-found' } {
  if (!paneRef) return { error: 'not-found' }
  return {
    label: pane ? pane.customName || pane.agentLabel : '',
    sessionId: paneRef.sessionId || null,
    buffer: paneRef.cleanBuffer ?? ''
  }
}
