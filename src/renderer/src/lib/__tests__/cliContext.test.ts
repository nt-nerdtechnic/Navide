import { describe, it, expect } from 'vitest'
import {
  buildCliPaneBufferReply,
  parseCliContextPayload,
  resolveCliDropPayload,
  buildCliContextChip,
  screenToClientPoint,
  resolveCliDropSource,
  buildPaneContextPaste,
  chunkForPty,
  CLI_CHIP_BUFFER_CAP,
  CLI_PASTE_BUFFER_CAP
} from '../cliContext'

describe('screenToClientPoint', () => {
  it('offsets the screen point by the viewport origin', () => {
    expect(screenToClientPoint({ screenX: 900, screenY: 500 }, { screenX: 700, screenY: 300 }))
      .toEqual({ x: 200, y: 200 })
  })

  it('is identity when the viewport sits at the screen origin', () => {
    expect(screenToClientPoint({ screenX: 40, screenY: 60 }, { screenX: 0, screenY: 0 }))
      .toEqual({ x: 40, y: 60 })
  })

  it('yields negative coordinates for a point above/left of the viewport', () => {
    expect(screenToClientPoint({ screenX: 10, screenY: 20 }, { screenX: 100, screenY: 50 }))
      .toEqual({ x: -90, y: -30 })
  })

  it('handles a viewport on a monitor at negative screen coordinates', () => {
    expect(screenToClientPoint({ screenX: -900, screenY: -100 }, { screenX: -1200, screenY: -300 }))
      .toEqual({ x: 300, y: 200 })
  })
})

describe('buildCliPaneBufferReply', () => {
  it('returns not-found when the pane ref is gone (pane closed before drop)', () => {
    expect(buildCliPaneBufferReply(undefined, null)).toEqual({ error: 'not-found' })
    expect(buildCliPaneBufferReply({ agentLabel: 'Claude' }, undefined)).toEqual({
      error: 'not-found'
    })
  })

  it('builds the reply from the pane ref, preferring customName over agentLabel', () => {
    expect(
      buildCliPaneBufferReply(
        { customName: 'My Pane', agentLabel: 'Claude' },
        { sessionId: 's-1', buffer: 'output' }
      )
    ).toEqual({ label: 'My Pane', sessionId: 's-1', buffer: 'output' })
  })

  it('falls back to agentLabel when customName is empty', () => {
    expect(
      buildCliPaneBufferReply(
        { customName: '', agentLabel: 'Claude' },
        { sessionId: 's-1', buffer: 'output' }
      )
    ).toEqual({ label: 'Claude', sessionId: 's-1', buffer: 'output' })
  })

  it('normalizes a missing/empty session id to null and a missing buffer to empty', () => {
    expect(buildCliPaneBufferReply({ agentLabel: 'Codex' }, { sessionId: '' })).toEqual({
      label: 'Codex',
      sessionId: null,
      buffer: ''
    })
  })

  it('labels an unknown pane record with an empty string rather than failing', () => {
    expect(buildCliPaneBufferReply(undefined, { sessionId: 's-1', buffer: 'x' })).toEqual({
      label: '',
      sessionId: 's-1',
      buffer: 'x'
    })
  })
})

describe('parseCliContextPayload', () => {
  it('parses a valid drag payload', () => {
    const raw = JSON.stringify({ paneId: 'p-1', agentKey: 'claude', label: 'Claude', sessionId: 's-1' })
    expect(parseCliContextPayload(raw)).toEqual({
      paneId: 'p-1',
      agentKey: 'claude',
      label: 'Claude',
      sessionId: 's-1'
    })
  })

  it('returns null for malformed JSON', () => {
    expect(parseCliContextPayload('not json')).toBeNull()
    expect(parseCliContextPayload('')).toBeNull()
  })

  it('returns null when paneId is missing or not a string', () => {
    expect(parseCliContextPayload(JSON.stringify({ agentKey: 'claude' }))).toBeNull()
    expect(parseCliContextPayload(JSON.stringify({ paneId: 42 }))).toBeNull()
    expect(parseCliContextPayload(JSON.stringify({ paneId: '' }))).toBeNull()
    expect(parseCliContextPayload('null')).toBeNull()
    expect(parseCliContextPayload('"string"')).toBeNull()
  })

  it('normalizes empty agentKey/label to undefined and empty sessionId to null', () => {
    expect(parseCliContextPayload(JSON.stringify({ paneId: 'p-1', agentKey: '', label: '', sessionId: null }))).toEqual({
      paneId: 'p-1',
      agentKey: undefined,
      label: undefined,
      sessionId: null
    })
  })
})

describe('resolveCliDropPayload', () => {
  it('prefers a valid CLI-context payload over the pane-id fallback', () => {
    const raw = JSON.stringify({ paneId: 'p-1', agentKey: 'claude', label: 'Claude', sessionId: 's-1' })
    expect(resolveCliDropPayload(raw, 'p-other')).toEqual({
      paneId: 'p-1',
      agentKey: 'claude',
      label: 'Claude',
      sessionId: 's-1'
    })
  })

  it("returns 'malformed' when the CLI-context payload is present but unparseable", () => {
    expect(resolveCliDropPayload('not json', '')).toBe('malformed')
    expect(resolveCliDropPayload(JSON.stringify({ paneId: '' }), 'p-9')).toBe('malformed')
  })

  it('synthesizes a minimal payload from a bare pane id (pane-id fallback)', () => {
    expect(resolveCliDropPayload('', 'p-9')).toEqual({
      paneId: 'p-9',
      agentKey: '',
      label: '',
      sessionId: null
    })
  })

  it('returns null when neither MIME string is present (not a CLI drop)', () => {
    expect(resolveCliDropPayload('', '')).toBeNull()
  })
})

describe('buildCliContextChip', () => {
  const payload = { paneId: 'p-1', agentKey: 'claude', label: 'My Pane', sessionId: 's-drag' }
  const capturedAt = Date.UTC(2026, 6, 12, 10, 30, 0)

  it('builds a chip with @cli: label, header line, fenced buffer, and cli-pane sourceId', () => {
    const result = buildCliContextChip(payload, { label: 'Reply Pane', sessionId: 's-1', buffer: 'hello output' }, capturedAt)
    expect(result).toEqual({
      kind: 'chip',
      label: '@cli:Reply Pane',
      content:
        '// CLI pane: claude — session: s-1 — captured: 2026-07-12T10:30:00.000Z\n' +
        '```\nhello output\n```',
      sourceId: 'cli-pane:p-1'
    })
  })

  it('falls back to the drag payload label, then agentKey, when the reply label is empty', () => {
    const fromPayload = buildCliContextChip(payload, { label: '', buffer: 'x' }, capturedAt)
    expect(fromPayload.kind === 'chip' && fromPayload.label).toBe('@cli:My Pane')
    const fromAgent = buildCliContextChip({ paneId: 'p-1', agentKey: 'codex' }, { buffer: 'x' }, capturedAt)
    expect(fromAgent.kind === 'chip' && fromAgent.label).toBe('@cli:codex')
  })

  it('builds a chip from a pane-id fallback payload, labeled from the IPC reply', () => {
    const fallback = { paneId: 'p-9', agentKey: '', label: '', sessionId: null }
    const result = buildCliContextChip(fallback, { label: 'Codex 2', sessionId: 's-9', buffer: 'out' }, capturedAt)
    expect(result).toEqual({
      kind: 'chip',
      label: '@cli:Codex 2',
      content:
        '// CLI pane: Codex 2 — session: s-9 — captured: 2026-07-12T10:30:00.000Z\n' +
        '```\nout\n```',
      sourceId: 'cli-pane:p-9'
    })
  })

  it("resolves an all-empty label chain to 'pane' / 'unknown agent'", () => {
    const fallback = { paneId: 'p-9', agentKey: '', label: '', sessionId: null }
    const result = buildCliContextChip(fallback, { buffer: 'out' }, capturedAt)
    expect(result.kind === 'chip' && result.label).toBe('@cli:pane')
    expect(result.kind === 'chip' && result.content).toContain('// CLI pane: unknown agent')
  })

  it("shows 'no session' when neither reply nor payload carries a session id", () => {
    const result = buildCliContextChip({ paneId: 'p-1' }, { buffer: 'x' }, capturedAt)
    expect(result.kind === 'chip' && result.content).toContain('— session: no session —')
  })

  it('tail-truncates an oversized buffer to the cap (keeps the end, drops the head)', () => {
    const buffer = 'HEAD-MARKER\n' + 'x'.repeat(CLI_CHIP_BUFFER_CAP) + '\nTAIL-MARKER'
    const result = buildCliContextChip(payload, { buffer }, capturedAt)
    if (result.kind !== 'chip') throw new Error('expected chip')
    expect(result.content).toContain('TAIL-MARKER')
    expect(result.content).not.toContain('HEAD-MARKER')
    const fenced = result.content.split('```')[1]
    expect(fenced.length).toBeLessThanOrEqual(CLI_CHIP_BUFFER_CAP + 2) // + wrapping newlines
  })

  it('signals empty for an empty or whitespace-only buffer (no chip)', () => {
    expect(buildCliContextChip(payload, { buffer: '' })).toEqual({ kind: 'empty' })
    expect(buildCliContextChip(payload, { buffer: '  \n ' })).toEqual({ kind: 'empty' })
    expect(buildCliContextChip(payload, {})).toEqual({ kind: 'empty' })
  })

  it('passes an error reply through untouched (caller surfaces it, no chip)', () => {
    expect(buildCliContextChip(payload, { error: 'not-found' })).toEqual({ kind: 'error', error: 'not-found' })
    expect(buildCliContextChip(payload, { error: 'timeout', buffer: 'stale' })).toEqual({ kind: 'error', error: 'timeout' })
    expect(buildCliContextChip(payload, { error: 'unavailable' })).toEqual({ kind: 'error', error: 'unavailable' })
  })
})

describe('resolveCliDropSource', () => {
  const payload = (paneId: string): string => JSON.stringify({ paneId, agentKey: 'claude' })

  it('resolves the source pane id from the CLI-context payload', () => {
    expect(resolveCliDropSource(payload('pane-a'), 'pane-a', 'pane-b')).toBe('pane-a')
  })

  it('resolves the source pane id from the bare pane-id fallback', () => {
    expect(resolveCliDropSource('', 'pane-a', 'pane-b')).toBe('pane-a')
  })

  it('returns null for a self-drop (pane dropped onto its own terminal)', () => {
    expect(resolveCliDropSource(payload('pane-a'), 'pane-a', 'pane-a')).toBeNull()
    expect(resolveCliDropSource('', 'pane-a', 'pane-a')).toBeNull()
  })

  it('returns null for a malformed payload or a drag with no pane identity', () => {
    expect(resolveCliDropSource('{not json', '', 'pane-b')).toBeNull()
    expect(resolveCliDropSource('', '', 'pane-b')).toBeNull()
  })
})

describe('buildPaneContextPaste', () => {
  it('builds a header naming the source pane and agent, wrapping the buffer', () => {
    const text = buildPaneContextPaste('Backend', 'claude', 'line one\nline two')
    expect(text).toBe(
      '--- context from CLI pane: Backend (claude) ---\nline one\nline two\n--- end of context ---'
    )
  })

  it('omits the agent key from the header when the pane has none', () => {
    const text = buildPaneContextPaste('Backend', undefined, 'out')
    expect(text?.split('\n')[0]).toBe('--- context from CLI pane: Backend ---')
  })

  it("falls back to 'pane' when the source has no display name", () => {
    expect(buildPaneContextPaste('', '', 'out')?.split('\n')[0])
      .toBe('--- context from CLI pane: pane ---')
  })

  it('tail-truncates an oversized buffer and says so in the header', () => {
    const buffer = 'x'.repeat(CLI_PASTE_BUFFER_CAP + 500)
    const text = buildPaneContextPaste('Backend', 'codex', buffer) as string
    const [header, body] = text.split('\n')
    expect(header).toBe(
      `--- context from CLI pane: Backend (codex) — last ${CLI_PASTE_BUFFER_CAP} chars ---`
    )
    expect(body).toHaveLength(CLI_PASTE_BUFFER_CAP)
  })

  it('does not claim truncation when the whole buffer fits under the cap', () => {
    const text = buildPaneContextPaste('Backend', 'codex', 'short output') as string
    expect(text).not.toContain('last')
  })

  it('does not end with a newline (the paste must not submit itself)', () => {
    expect(buildPaneContextPaste('Backend', 'claude', 'out')?.endsWith('\n')).toBe(false)
  })

  it('returns null for an empty or whitespace-only buffer (nothing to share)', () => {
    expect(buildPaneContextPaste('Backend', 'claude', '')).toBeNull()
    expect(buildPaneContextPaste('Backend', 'claude', '  \n\t\n ')).toBeNull()
  })
})

describe('chunkForPty', () => {
  it('splits text into chunks of at most the given size', () => {
    expect(chunkForPty('abcdefg', 3)).toEqual(['abc', 'def', 'g'])
  })

  it('returns a single chunk when the text fits', () => {
    expect(chunkForPty('abc', 8)).toEqual(['abc'])
    expect(chunkForPty('', 8)).toEqual([])
  })

  it('never splits a surrogate pair across chunks (non-BMP chars survive)', () => {
    // '😀' is two UTF-16 code units — a naive slice(0, 3) would cut it in half.
    const text = 'ab😀cd'
    const chunks = chunkForPty(text, 3)
    expect(chunks.join('')).toBe(text)
    for (const chunk of chunks) expect(chunk).not.toMatch(/[\uD800-\uDBFF]$/)
    expect(chunks).toEqual(['ab', '😀c', 'd'])
  })

  it('preserves the original text when re-joined', () => {
    const text = '🚀 done — 完成\nnext'
    expect(chunkForPty(text, 4).join('')).toBe(text)
  })
})
