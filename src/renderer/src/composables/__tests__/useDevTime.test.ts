import { describe, it, expect, vi, afterEach } from 'vitest'
import { ref } from 'vue'
import { useDevTime, formatDuration, ACTIVE_POLL_MS, type DevTimeSnapshot } from '../useDevTime'
import { createMockBackend, withScope, flush } from './mockBackend'

function totals(merged = 0, human = 0, agent = 0, overlap = 0, wall = merged) {
  return { merged_s: merged, human_s: human, agent_s: agent, overlap_s: overlap, wall_s: wall }
}

function snapshot(workspacePath: string, over: Partial<DevTimeSnapshot> = {}): DevTimeSnapshot {
  return {
    workspace_path: workspacePath,
    gap_human_s: 300,
    gap_agent_s: 900,
    active: false,
    active_sources: [],
    totals: {
      today: totals(100, 60, 70, 30),
      last7d: totals(1000, 600, 700, 300),
      last30d: totals(2000, 1200, 1400, 600),
      all: totals(3000, 1800, 2100, 900),
    },
    by_day: [
      { date: '2026-09-06', merged_s: 10, human_s: 5, agent_s: 5 },
      { date: '2026-09-07', merged_s: 0, human_s: 0, agent_s: 0 },
      { date: '2026-09-08', merged_s: 0, human_s: 0, agent_s: 0 },
      { date: '2026-09-09', merged_s: 0, human_s: 0, agent_s: 0 },
      { date: '2026-09-10', merged_s: 0, human_s: 0, agent_s: 0 },
      { date: '2026-09-11', merged_s: 0, human_s: 0, agent_s: 0 },
      { date: '2026-09-12', merged_s: 100, human_s: 60, agent_s: 70 },
    ],
    by_pane: [{ pane_id: 'p1', today_s: 100, all_s: 3000, active: false }],
    ...over,
  }
}

describe('formatDuration', () => {
  it('shows minutes as the finest unit and never rolls hours into days', () => {
    expect(formatDuration(0)).toBe('0m')
    expect(formatDuration(59)).toBe('0m')
    expect(formatDuration(60)).toBe('1m')
    expect(formatDuration(3600)).toBe('1h 0m')
    expect(formatDuration(9300)).toBe('2h 35m')
    expect(formatDuration(90061)).toBe('25h 1m')
  })
})

describe('useDevTime', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('loads a snapshot on connect with the workspace path', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('devtime.snapshot', snapshot('/ws'))
    const { result, scope } = withScope(() => useDevTime(mock.backend, ref('/ws')))
    await flush()

    const sent = mock.sent.find((s) => s.type === 'devtime.snapshot')
    expect(sent?.payload).toEqual({ workspace_path: '/ws' })
    expect(result.snapshot.value?.totals.today.merged_s).toBe(100)
    expect(result.snapshot.value?.by_day).toHaveLength(7)
    expect(result.snapshot.value?.by_pane[0].pane_id).toBe('p1')
    scope.stop()
  })

  it('does NOT fetch while disconnected', async () => {
    const mock = createMockBackend('starting')
    const { result, scope } = withScope(() => useDevTime(mock.backend, ref('/ws')))
    await flush()

    expect(mock.sent).toHaveLength(0)
    expect(result.snapshot.value).toBeNull()
    scope.stop()
  })

  it('re-fetches on a devtime.changed broadcast for the current workspace', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('devtime.snapshot', snapshot('/ws'))
    const { result, scope } = withScope(() => useDevTime(mock.backend, ref('/ws')))
    await flush()
    expect(mock.sent.filter((s) => s.type === 'devtime.snapshot')).toHaveLength(1)

    const updated = snapshot('/ws')
    updated.totals.today.merged_s = 999
    mock.setResponse('devtime.snapshot', updated)
    mock.emit('devtime.changed', { workspace_path: '/ws' })
    await flush()

    expect(mock.sent.filter((s) => s.type === 'devtime.snapshot')).toHaveLength(2)
    expect(result.snapshot.value?.totals.today.merged_s).toBe(999)
    scope.stop()
  })

  it('ignores a devtime.changed broadcast for a sibling workspace', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('devtime.snapshot', snapshot('/ws'))
    const { scope } = withScope(() => useDevTime(mock.backend, ref('/ws')))
    await flush()

    mock.emit('devtime.changed', { workspace_path: '/other' })
    await flush()
    expect(mock.sent.filter((s) => s.type === 'devtime.snapshot')).toHaveLength(1)
    scope.stop()
  })

  // The snapshot is polled while something is open — never advanced locally,
  // so the number can only move to what the backend last reported.
  const polls = (mock: ReturnType<typeof createMockBackend>) =>
    mock.sent.filter((s) => s.type === 'devtime.snapshot').length

  it('polls every 10 s while active and shows only what the backend reports', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('devtime.snapshot', snapshot('/ws', { active: true, active_sources: ['agent'] }))
    vi.useFakeTimers()
    const { result, scope } = withScope(() => useDevTime(mock.backend, ref('/ws')))
    await vi.advanceTimersByTimeAsync(0)
    expect(polls(mock)).toBe(1)

    await vi.advanceTimersByTimeAsync(9_999)
    expect(polls(mock)).toBe(1)
    expect(result.snapshot.value?.totals.today.merged_s).toBe(100)

    const later = snapshot('/ws', { active: true, active_sources: ['agent'] })
    later.totals.today.merged_s = 110
    mock.setResponse('devtime.snapshot', later)
    await vi.advanceTimersByTimeAsync(1)
    expect(polls(mock)).toBe(2)
    expect(result.snapshot.value?.totals.today.merged_s).toBe(110)

    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS * 2)
    expect(polls(mock)).toBe(4)
    scope.stop()
  })

  it('does not poll while inactive', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('devtime.snapshot', snapshot('/ws'))
    vi.useFakeTimers()
    const { scope } = withScope(() => useDevTime(mock.backend, ref('/ws')))
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS * 3)
    expect(polls(mock)).toBe(1)
    scope.stop()
  })

  it('stops polling once a snapshot reports inactive', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('devtime.snapshot', snapshot('/ws', { active: true, active_sources: ['human'] }))
    vi.useFakeTimers()
    const { result, scope } = withScope(() => useDevTime(mock.backend, ref('/ws')))
    await vi.advanceTimersByTimeAsync(0)

    mock.setResponse('devtime.snapshot', snapshot('/ws', { active: false }))
    mock.emit('devtime.changed', { workspace_path: '/ws' })
    await vi.advanceTimersByTimeAsync(0)
    expect(result.snapshot.value?.active).toBe(false)
    const before = polls(mock)

    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS * 3)
    expect(polls(mock)).toBe(before)
    scope.stop()
  })

  it('stops polling when the scope is disposed', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('devtime.snapshot', snapshot('/ws', { active: true, active_sources: ['human'] }))
    vi.useFakeTimers()
    const { scope } = withScope(() => useDevTime(mock.backend, ref('/ws')))
    await vi.advanceTimersByTimeAsync(0)
    scope.stop()

    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS * 3)
    expect(polls(mock)).toBe(1)
  })

  it('reset sends devtime.reset and refetches', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('devtime.snapshot', snapshot('/ws'))
    mock.setResponse('devtime.reset', { ok: true })
    const { result, scope } = withScope(() => useDevTime(mock.backend, ref('/ws')))
    await flush()

    mock.setResponse('devtime.snapshot', snapshot('/ws', { totals: {
      today: totals(), last7d: totals(), last30d: totals(), all: totals(),
    } }))
    await result.reset()

    const reset = mock.sent.find((s) => s.type === 'devtime.reset')
    expect(reset?.payload).toEqual({ workspace_path: '/ws' })
    expect(result.snapshot.value?.totals.all.merged_s).toBe(0)
    scope.stop()
  })

  it('surfaces a backend error', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('devtime.snapshot', null, { ok: false, error: { code: 'X', message: 'boom' } })
    const { result, scope } = withScope(() => useDevTime(mock.backend, ref('/ws')))
    await flush()

    expect(result.lastError.value).toBe('boom')
    scope.stop()
  })
})
