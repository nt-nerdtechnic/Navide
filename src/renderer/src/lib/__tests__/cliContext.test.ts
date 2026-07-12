import { describe, it, expect } from 'vitest'
import {
  buildCliPaneBufferReply,
  parseCliContextPayload,
  buildCliContextChip,
  CLI_CHIP_BUFFER_CAP
} from '../cliContext'

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
        { sessionId: 's-1', cleanBuffer: 'output' }
      )
    ).toEqual({ label: 'My Pane', sessionId: 's-1', buffer: 'output' })
  })

  it('falls back to agentLabel when customName is empty', () => {
    expect(
      buildCliPaneBufferReply(
        { customName: '', agentLabel: 'Claude' },
        { sessionId: 's-1', cleanBuffer: 'output' }
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
    expect(buildCliPaneBufferReply(undefined, { sessionId: 's-1', cleanBuffer: 'x' })).toEqual({
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
