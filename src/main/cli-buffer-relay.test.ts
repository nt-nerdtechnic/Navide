import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  CliBufferRelay,
  CLI_BUFFER_REQUEST_CHANNEL,
  type CliBufferRelayTarget
} from './cli-buffer-relay'

function target(): CliBufferRelayTarget & { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn() }
}

/** Correlation id from the target's recorded request (2nd send arg). */
function requestIdOf(t: ReturnType<typeof target>): string {
  return t.send.mock.calls[0][1] as string
}

describe('CliBufferRelay', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves unavailable when there is no window to ask', async () => {
    const relay = new CliBufferRelay()
    await expect(relay.request([], 'pane-1')).resolves.toEqual({ error: 'unavailable' })
  })

  it('sends the request to every target and resolves with the first success reply', async () => {
    const relay = new CliBufferRelay()
    const a = target()
    const b = target()
    const promise = relay.request([a, b], 'pane-1')
    expect(a.send).toHaveBeenCalledWith(CLI_BUFFER_REQUEST_CHANNEL, requestIdOf(a), 'pane-1')
    expect(b.send).toHaveBeenCalledWith(CLI_BUFFER_REQUEST_CHANNEL, requestIdOf(a), 'pane-1')

    relay.handleReply(requestIdOf(a), { label: 'Claude', sessionId: 's-1', buffer: 'out' })
    await expect(promise).resolves.toEqual({ label: 'Claude', sessionId: 's-1', buffer: 'out' })
  })

  it('resolves not-found only once every window replied without the pane', async () => {
    const relay = new CliBufferRelay()
    const a = target()
    const b = target()
    const promise = relay.request([a, b], 'pane-gone')
    const resolved = vi.fn()
    void promise.then(resolved)

    relay.handleReply(requestIdOf(a), { error: 'not-found' })
    await Promise.resolve()
    expect(resolved).not.toHaveBeenCalled() // the other window may still have it

    relay.handleReply(requestIdOf(a), { error: 'not-found' })
    await expect(promise).resolves.toEqual({ error: 'not-found' })
  })

  it('a success from one window wins over a not-found from another', async () => {
    const relay = new CliBufferRelay()
    const a = target()
    const b = target()
    const promise = relay.request([a, b], 'pane-1')
    relay.handleReply(requestIdOf(a), { error: 'not-found' })
    relay.handleReply(requestIdOf(a), { label: 'Codex', sessionId: null, buffer: 'x' })
    await expect(promise).resolves.toEqual({ label: 'Codex', sessionId: null, buffer: 'x' })
  })

  it('resolves timeout when no reply arrives in time, and ignores a late reply', async () => {
    const relay = new CliBufferRelay()
    const a = target()
    const promise = relay.request([a], 'pane-1', 3000)
    vi.advanceTimersByTime(3000)
    await expect(promise).resolves.toEqual({ error: 'timeout' })
    // Late reply after timeout must be a no-op (entry already dropped).
    relay.handleReply(requestIdOf(a), { label: 'late', sessionId: null, buffer: '' })
  })

  it('ignores replies with an unknown correlation id', () => {
    const relay = new CliBufferRelay()
    relay.handleReply('never-issued', { label: 'x', sessionId: null, buffer: '' })
  })

  it('keeps concurrent requests separate via correlation ids', async () => {
    const relay = new CliBufferRelay()
    const a = target()
    const p1 = relay.request([a], 'pane-1')
    const p2 = relay.request([a], 'pane-2')
    const id1 = a.send.mock.calls[0][1] as string
    const id2 = a.send.mock.calls[1][1] as string
    expect(id1).not.toBe(id2)

    relay.handleReply(id2, { label: 'two', sessionId: null, buffer: 'b2' })
    relay.handleReply(id1, { label: 'one', sessionId: null, buffer: 'b1' })
    await expect(p1).resolves.toEqual({ label: 'one', sessionId: null, buffer: 'b1' })
    await expect(p2).resolves.toEqual({ label: 'two', sessionId: null, buffer: 'b2' })
  })
})
