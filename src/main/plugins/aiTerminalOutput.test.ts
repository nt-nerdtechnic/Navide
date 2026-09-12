import { describe, expect, it } from 'vitest'
import { AiTerminalOutputDecoder } from './aiTerminalOutput'

describe('AI terminal output decoder', () => {
  it('preserves a UTF-8 glyph split across binary batches', () => {
    const decoder = new AiTerminalOutputDecoder()
    const bytes = new TextEncoder().encode('你')

    expect(decoder.decode('instance-1', 'session-1', bytes.slice(0, 2))).toBe('')
    expect(decoder.decode('instance-1', 'session-1', bytes.slice(2))).toBe('你')
  })

  it('handles string and binary batches through the same stream', () => {
    const decoder = new AiTerminalOutputDecoder()
    const bytes = new TextEncoder().encode('終端')

    expect(decoder.decode('instance-1', 'session-1', 'prefix ')).toBe('prefix ')
    expect(decoder.decode('instance-1', 'session-1', bytes.slice(0, 2))).toBe('')
    expect(decoder.decode('instance-1', 'session-1', bytes.slice(2))).toBe('終端')
    expect(decoder.finish('instance-1', 'session-1')).toBe('')
  })

  it('does not share decoder state across sessions or instances', () => {
    const decoder = new AiTerminalOutputDecoder()
    const bytes = new TextEncoder().encode('é')

    expect(decoder.decode('instance-1', 'session-1', bytes.slice(0, 1))).toBe('')
    expect(decoder.decode('instance-1', 'session-2', bytes)).toBe('é')
    // A new instance taking over the same session starts a fresh decoder and
    // cannot complete the previous instance's partial byte sequence.
    expect(decoder.decode('instance-2', 'session-1', 'new instance')).toBe('new instance')
    expect(decoder.finish('instance-1', 'session-1')).toBe('')
  })

  it('flushes a dangling sequence once and removes its decoder', () => {
    const decoder = new AiTerminalOutputDecoder()
    const bytes = new TextEncoder().encode('你')

    expect(decoder.decode('instance-1', 'session-1', bytes.slice(0, 2))).toBe('')
    expect(decoder.finish('instance-1', 'session-1')).toBe('\ufffd')
    expect(decoder.finish('instance-1', 'session-1')).toBe('')
  })

  it('drops a session fragment before the next batch', () => {
    const decoder = new AiTerminalOutputDecoder()
    const bytes = new TextEncoder().encode('你')

    expect(decoder.decode('instance-1', 'session-1', bytes.slice(0, 2))).toBe('')
    decoder.dropSession('session-1')
    expect(decoder.decode('instance-1', 'session-1', bytes)).toBe('你')
  })

  it('drops every fragment owned by an instance while retaining other instances', () => {
    const decoder = new AiTerminalOutputDecoder()
    const bytes = new TextEncoder().encode('你')

    decoder.decode('instance-1', 'session-1', bytes.slice(0, 2))
    decoder.decode('instance-1', 'session-2', bytes.slice(0, 2))
    decoder.decode('instance-2', 'session-3', bytes.slice(0, 2))
    decoder.dropInstance('instance-1')

    expect(decoder.finish('instance-1', 'session-1')).toBe('')
    expect(decoder.finish('instance-1', 'session-2')).toBe('')
    expect(decoder.finish('instance-2', 'session-3')).toBe('\ufffd')
  })

  it('ignores invalid data without converting it or losing a pending fragment', () => {
    const decoder = new AiTerminalOutputDecoder()
    const bytes = new TextEncoder().encode('你')

    expect(decoder.decode('instance-1', 'session-1', bytes.slice(0, 2))).toBe('')
    for (const invalid of [null, undefined, 42, {}, ['not-bytes']]) {
      expect(decoder.decode('instance-1', 'session-1', invalid)).toBe('')
    }
    expect(decoder.decode('instance-1', 'session-1', bytes.slice(2))).toBe('你')
  })
})
