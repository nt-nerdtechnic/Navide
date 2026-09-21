import { describe, it, expect } from 'vitest'
import { useQuotaCycles, type QuotaCyclesResult } from '../useQuotaCycles'
import { createMockBackend, withScope, flush } from './mockBackend'

function result(over: Partial<QuotaCyclesResult> = {}): QuotaCyclesResult {
  return {
    ok: true,
    agent_key: 'claude',
    profile_id: 'slot-a',
    cycles: [
      {
        window_kind: 'session',
        started_at: '2026-09-16T09:20:00Z',
        resets_at: '2026-09-16T14:20:00Z',
        closed: false,
        max_percent: 6,
        exhausted_at: null,
        input: 182,
        cache_read: 1_612_404,
        cache_creation: 58_210,
        output: 21_933,
        total: 1_692_729,
        calls: 61,
        turns: 9,
        samples: 3,
      },
      {
        window_kind: 'session',
        started_at: '2026-09-16T04:20:00Z',
        resets_at: '2026-09-16T09:20:00Z',
        closed: true,
        max_percent: 100,
        exhausted_at: '2026-09-16T08:41:00Z',
        input: 4410,
        cache_read: 27_113_905,
        cache_creation: 1_020_388,
        output: 334_910,
        total: 28_473_613,
        calls: 1318,
        turns: 171,
        samples: 20,
      },
    ],
    summary: { session: { cycles: 2, exhausted: 1, avg_total_exhausted: 28_473_613 } },
    ...over,
  }
}

describe('useQuotaCycles', () => {
  it('sends tokens.quota_cycles with the contract fields and exposes the body', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('tokens.quota_cycles', result())
    const { result: api, scope } = withScope(() => useQuotaCycles(mock.backend))
    const p = api.load({ agentKey: 'claude', profileId: 'slot-a' })
    expect(api.loading.value).toBe(true)
    await p
    expect(mock.sent).toHaveLength(1)
    expect(mock.sent[0].type).toBe('tokens.quota_cycles')
    expect(mock.sent[0].payload).toMatchObject({ agent_key: 'claude', profile_id: 'slot-a', window_kind: undefined, limit: 50, include_current: true })
    expect(api.loading.value).toBe(false)
    expect(api.error.value).toBe('')
    expect(api.data.value?.cycles).toHaveLength(2)
    expect(api.data.value?.cycles[0].closed).toBe(false)
    expect(api.data.value?.cycles[1].exhausted_at).toBe('2026-09-16T08:41:00Z')
    expect(api.data.value?.summary.session.avg_total_exhausted).toBe(28_473_613)
    scope.stop()
  })

  it('passes window_kind through when given', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('tokens.quota_cycles', result())
    const { result: api, scope } = withScope(() => useQuotaCycles(mock.backend))
    await api.load({ agentKey: 'claude', profileId: '__default__', windowKind: 'weekly' })
    expect(mock.sent[0].payload).toMatchObject({ profile_id: '__default__', window_kind: 'weekly' })
    scope.stop()
  })

  it('surfaces a contract failure (unknown-vendor) carried inside an ok envelope', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('tokens.quota_cycles', { ok: false, error: 'unknown-vendor' })
    const { result: api, scope } = withScope(() => useQuotaCycles(mock.backend))
    await api.load({ agentKey: 'nope', profileId: 'x' })
    expect(api.data.value).toBeNull()
    expect(api.error.value).toBe('unknown-vendor')
    scope.stop()
  })

  it('keeps an empty answer as data — no cycles is not an error', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('tokens.quota_cycles', result({ cycles: [], summary: {} }))
    const { result: api, scope } = withScope(() => useQuotaCycles(mock.backend))
    await api.load({ agentKey: 'claude', profileId: 'slot-a' })
    expect(api.error.value).toBe('')
    expect(api.data.value?.cycles).toEqual([])
    scope.stop()
  })

  it('reports a rejected send as an error, not a hang', async () => {
    const mock = createMockBackend('connected')
    mock.setRejection('tokens.quota_cycles', 'ws not open')
    const { result: api, scope } = withScope(() => useQuotaCycles(mock.backend))
    await api.load({ agentKey: 'claude', profileId: 'slot-a' })
    expect(api.error.value).toBe('ws not open')
    expect(api.loading.value).toBe(false)
    scope.stop()
  })

  it('refetches the loaded account on tokens.quota_cycles_changed and ignores other accounts', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('tokens.quota_cycles', result())
    const { result: api, scope } = withScope(() => useQuotaCycles(mock.backend))
    await api.load({ agentKey: 'claude', profileId: 'slot-a' })
    expect(mock.sent).toHaveLength(1)

    mock.emit('tokens.quota_cycles_changed', { agent_key: 'claude', profile_id: 'slot-b', window_kind: 'session' })
    await flush()
    expect(mock.sent).toHaveLength(1)

    mock.emit('tokens.quota_cycles_changed', { agent_key: 'claude', profile_id: 'slot-a', window_kind: 'session' })
    await flush()
    expect(mock.sent).toHaveLength(2)
    expect(mock.sent[1].payload).toMatchObject({ agent_key: 'claude', profile_id: 'slot-a' })
    scope.stop()
  })

  it('clear() drops the data and stops following events; the scope end unsubscribes', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('tokens.quota_cycles', result())
    const { result: api, scope } = withScope(() => useQuotaCycles(mock.backend))
    await api.load({ agentKey: 'claude', profileId: 'slot-a' })
    api.clear()
    expect(api.data.value).toBeNull()
    mock.emit('tokens.quota_cycles_changed', { agent_key: 'claude', profile_id: 'slot-a', window_kind: 'session' })
    await flush()
    expect(mock.sent).toHaveLength(1)
    await api.load({ agentKey: 'claude', profileId: 'slot-a' })
    scope.stop()
    mock.emit('tokens.quota_cycles_changed', { agent_key: 'claude', profile_id: 'slot-a', window_kind: 'session' })
    await flush()
    expect(mock.sent).toHaveLength(2)
  })

  it('a stale answer does not overwrite a newer load', async () => {
    const mock = createMockBackend('connected')
    let release: (() => void) | null = null
    const gate = new Promise<void>((r) => { release = r })
    const original = mock.backend.send
    let first = true
    mock.backend.send = (async (type: string, payload: Record<string, unknown>) => {
      if (first) {
        first = false
        await gate
        return { id: 'r', type, ok: true, error: null, timestamp: '', payload: result({ profile_id: 'old' }) }
      }
      return original(type, payload)
    }) as typeof original
    mock.setResponse('tokens.quota_cycles', result({ profile_id: 'new' }))
    const { result: api, scope } = withScope(() => useQuotaCycles(mock.backend))
    const p1 = api.load({ agentKey: 'claude', profileId: 'old' })
    await api.load({ agentKey: 'claude', profileId: 'new' })
    release!()
    await p1
    expect(api.data.value?.profile_id).toBe('new')
    scope.stop()
  })
})
