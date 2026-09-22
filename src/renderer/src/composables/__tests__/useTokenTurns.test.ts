import { describe, it, expect } from 'vitest'
import { useTokenTurns, type TokenTurnsResult } from '../useTokenTurns'
import { createMockBackend, withScope, flush } from './mockBackend'

function result(over: Partial<TokenTurnsResult> = {}): TokenTurnsResult {
  return {
    ok: true,
    pane_id: 'p1',
    session_id: '3e146a7d-ba35-4e81-9999-cb65cddda625',
    vendor: 'claude',
    file_path: '/tmp/s.jsonl',
    method: 'exact',
    turns: [
      {
        turn_index: 1,
        started_at: '2026-09-16T01:00:00Z',
        ended_at: '2026-09-16T01:00:30Z',
        prompt_excerpt: 'hello',
        input: 10,
        cache_read: 100,
        cache_creation: 5,
        output: 20,
        total: 135,
        calls: 2
      }
    ],
    totals: { input: 10, cache_read: 100, cache_creation: 5, output: 20, total: 135, calls: 2 },
    scanned_at: '2026-09-16T01:01:00Z',
    ...over
  }
}

describe('useTokenTurns', () => {
  it('sends tokens.turns with the pane id and include_calls, then exposes the body', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('tokens.turns', result())
    const { result: api, scope } = withScope(() => useTokenTurns(mock.backend))

    const p = api.load({ paneId: 'p1', agentKey: 'claude' }, { includeCalls: true })
    expect(api.loading.value).toBe(true)
    await p

    expect(mock.sent).toHaveLength(1)
    expect(mock.sent[0].type).toBe('tokens.turns')
    expect(mock.sent[0].payload).toMatchObject({ pane_id: 'p1', agent_key: 'claude', include_calls: true })
    expect(api.loading.value).toBe(false)
    expect(api.error.value).toBe('')
    expect(api.data.value?.turns).toHaveLength(1)
    expect(api.data.value?.totals.total).toBe(135)
    scope.stop()
  })

  it('include_calls defaults to false and session_id is passed when given', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('tokens.turns', result())
    const { result: api, scope } = withScope(() => useTokenTurns(mock.backend))
    await api.load({ sessionId: 'abc' })
    expect(mock.sent[0].payload).toMatchObject({ session_id: 'abc', include_calls: false })
    expect(mock.sent[0].payload.pane_id).toBeUndefined()
    scope.stop()
  })

  it('surfaces a contract error carried inside an ok envelope', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('tokens.turns', { ok: false, error: 'no-session', detail: 'pane p9 has no session' })
    const { result: api, scope } = withScope(() => useTokenTurns(mock.backend))
    await api.load({ paneId: 'p9' })
    expect(api.data.value).toBeNull()
    expect(api.error.value).toBe('no-session')
    expect(api.errorDetail.value).toBe('pane p9 has no session')
    expect(api.loading.value).toBe(false)
    scope.stop()
  })

  it('surfaces a transport-level error envelope by its code', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('tokens.turns', null, {
      ok: false,
      error: { code: 'scan-failed', message: 'reader crashed' }
    })
    const { result: api, scope } = withScope(() => useTokenTurns(mock.backend))
    await api.load({ paneId: 'p1' })
    expect(api.data.value).toBeNull()
    expect(api.error.value).toBe('scan-failed')
    expect(api.errorDetail.value).toBe('reader crashed')
    scope.stop()
  })

  it('reports a rejected send (socket down) as an error, not a hang', async () => {
    const mock = createMockBackend('connected')
    mock.setRejection('tokens.turns', 'ws not open')
    const { result: api, scope } = withScope(() => useTokenTurns(mock.backend))
    await api.load({ paneId: 'p1' })
    expect(api.error.value).toBe('ws not open')
    expect(api.loading.value).toBe(false)
    scope.stop()
  })

  it('keeps an unsupported answer as data (ok stays true, turns empty)', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('tokens.turns', result({ vendor: 'cursor', method: 'unsupported', turns: [], totals: { input: 0, cache_read: 0, cache_creation: 0, output: 0, total: 0, calls: 0 } }))
    const { result: api, scope } = withScope(() => useTokenTurns(mock.backend))
    await api.load({ paneId: 'p2' })
    expect(api.error.value).toBe('')
    expect(api.data.value?.method).toBe('unsupported')
    expect(api.data.value?.turns).toEqual([])
    scope.stop()
  })

  it('a stale answer does not overwrite a newer load', async () => {
    const mock = createMockBackend('connected')
    const { result: api, scope } = withScope(() => useTokenTurns(mock.backend))
    // First request is slow; the second one resolves first.
    let releaseFirst!: () => void
    const first = new Promise<void>((r) => { releaseFirst = r })
    let n = 0
    mock.backend.send = (async (type: string, payload: Record<string, unknown>) => {
      mock.sent.push({ type, payload })
      const which = ++n
      if (which === 1) await first
      return { id: 't', type, ok: true, payload: result({ pane_id: String(payload.pane_id) }), error: null, timestamp: '' }
    }) as typeof mock.backend.send

    const a = api.load({ paneId: 'old' })
    const b = api.load({ paneId: 'new' })
    await b
    expect(api.data.value?.pane_id).toBe('new')
    releaseFirst()
    await a
    await flush()
    expect(api.data.value?.pane_id).toBe('new')
    expect(api.loading.value).toBe(false)
    scope.stop()
  })

  it('clear() drops the data and error', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('tokens.turns', result())
    const { result: api, scope } = withScope(() => useTokenTurns(mock.backend))
    await api.load({ paneId: 'p1' })
    expect(api.data.value).not.toBeNull()
    api.clear()
    expect(api.data.value).toBeNull()
    expect(api.error.value).toBe('')
    expect(api.loading.value).toBe(false)
    scope.stop()
  })
})
