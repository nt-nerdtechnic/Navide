import { describe, it, expect } from 'vitest'
import { useAccountPeriods, type AccountPeriodsResult } from '../useAccountPeriods'
import { createMockBackend, withScope, flush } from './mockBackend'

function result(over: Partial<AccountPeriodsResult> = {}): AccountPeriodsResult {
  return {
    ok: true,
    granularity: 'month',
    rows: [
      {
        period: '2026-09', agent_key: 'claude', profile_id: 'slot-a',
        input: 61_204, cache_read: 412_880_113, cache_creation: 15_102_441, output: 5_210_392, total: 433_254_150,
        calls: 20_318, turns: 2740, cycles: 44, exhausted: 11, avg_total_exhausted: 28_500_000, weekly_exhausted: 1,
      },
      {
        period: '2026-09', agent_key: 'claude', profile_id: 'unknown',
        input: 10, cache_read: 20, cache_creation: 0, output: 5, total: 35,
        calls: 2, turns: 1, cycles: 0, exhausted: 0, avg_total_exhausted: null, weekly_exhausted: 0,
      },
      {
        period: '2026-08', agent_key: 'claude', profile_id: 'slot-a',
        input: 88_910, cache_read: 690_441_209, cache_creation: 24_880_120, output: 8_120_377, total: 723_530_616,
        calls: 33_905, turns: 4512, cycles: 71, exhausted: 19, avg_total_exhausted: 28_100_000, weekly_exhausted: 2,
      },
    ],
    totals_by_period: [
      { period: '2026-09', total: 433_254_185, calls: 20_320, turns: 2741 },
      { period: '2026-08', total: 723_530_616, calls: 33_905, turns: 4512 },
    ],
    ...over,
  }
}

describe('useAccountPeriods', () => {
  it('sends tokens.account_periods for one account and exposes rows and period totals', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('tokens.account_periods', result())
    const { result: api, scope } = withScope(() => useAccountPeriods(mock.backend))
    await api.load({ agentKey: 'claude', profileId: 'slot-a', granularity: 'month' })
    expect(mock.sent[0].type).toBe('tokens.account_periods')
    expect(mock.sent[0].payload).toMatchObject({ agent_key: 'claude', profile_id: 'slot-a', granularity: 'month', limit: 50 })
    expect(api.data.value?.rows).toHaveLength(3)
    expect(api.data.value?.rows[0].period).toBe('2026-09')
    expect(api.data.value?.rows[0].avg_total_exhausted).toBe(28_500_000)
    expect(api.data.value?.rows[1].avg_total_exhausted).toBeNull()
    expect(api.data.value?.totals_by_period[1].total).toBe(723_530_616)
    scope.stop()
  })

  it('omits the account fields for the all-accounts query', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('tokens.account_periods', result({ granularity: 'year' }))
    const { result: api, scope } = withScope(() => useAccountPeriods(mock.backend))
    await api.load({ granularity: 'year' })
    expect(mock.sent[0].payload).toMatchObject({ agent_key: undefined, profile_id: undefined, granularity: 'year', limit: 50 })
    expect(api.data.value?.granularity).toBe('year')
    scope.stop()
  })

  it('an empty answer is data, a contract failure is an error, a rejected send is an error', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('tokens.account_periods', result({ rows: [], totals_by_period: [] }))
    const { result: api, scope } = withScope(() => useAccountPeriods(mock.backend))
    await api.load({ granularity: 'month' })
    expect(api.error.value).toBe('')
    expect(api.data.value?.rows).toEqual([])

    mock.setResponse('tokens.account_periods', { ok: false, error: 'unknown-vendor' })
    await api.load({ agentKey: 'nope', granularity: 'month' })
    expect(api.data.value).toBeNull()
    expect(api.error.value).toBe('unknown-vendor')

    mock.setRejection('tokens.account_periods', 'ws not open')
    await api.load({ granularity: 'month' })
    expect(api.error.value).toBe('ws not open')
    expect(api.loading.value).toBe(false)
    scope.stop()
  })

  it('refetches on tokens.quota_cycles_changed: a filtered load only for its own account, an unfiltered one always', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('tokens.account_periods', result())
    const { result: api, scope } = withScope(() => useAccountPeriods(mock.backend))

    await api.load({ agentKey: 'claude', profileId: 'slot-a', granularity: 'month' })
    mock.emit('tokens.quota_cycles_changed', { agent_key: 'claude', profile_id: 'slot-b', window_kind: 'session' })
    await flush()
    expect(mock.sent).toHaveLength(1)
    mock.emit('tokens.quota_cycles_changed', { agent_key: 'claude', profile_id: 'slot-a', window_kind: 'session' })
    await flush()
    expect(mock.sent).toHaveLength(2)

    await api.load({ granularity: 'month' })
    expect(mock.sent).toHaveLength(3)
    mock.emit('tokens.quota_cycles_changed', { agent_key: 'codex', profile_id: 'whoever', window_kind: 'weekly' })
    await flush()
    expect(mock.sent).toHaveLength(4)
    expect(mock.sent[3].payload).toMatchObject({ granularity: 'month' })
    scope.stop()
  })

  it('clear() drops the data and an event no longer refetches', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('tokens.account_periods', result())
    const { result: api, scope } = withScope(() => useAccountPeriods(mock.backend))
    await api.load({ granularity: 'month' })
    api.clear()
    expect(api.data.value).toBeNull()
    mock.emit('tokens.quota_cycles_changed', { agent_key: 'claude', profile_id: 'slot-a', window_kind: 'session' })
    await flush()
    expect(mock.sent).toHaveLength(1)
    scope.stop()
  })
})
