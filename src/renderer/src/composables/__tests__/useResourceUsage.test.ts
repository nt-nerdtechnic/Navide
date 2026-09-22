// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import {
  useResourceUsage,
  type ResourceUsageWire,
  type UseResourceUsageOptions,
} from '../useResourceUsage'
import { diskSignal, networkSignal, riskState } from './fixtures/cliRisk'
import { RESOURCE_POLL_ACTIVE_MS, RESOURCE_POLL_IDLE_MS } from '../../lib/resourceSampling'

function wire(over: Partial<ResourceUsageWire> = {}): ResourceUsageWire {
  return {
    available: true,
    cpu_available: true,
    sampled_at: 1,
    panes: [{ terminal_session_id: 'sess-a', pane_id: 'pane-a', bytes: 100, cpu_seconds: 10 }],
    total_bytes: 100,
    cpu_count: 4,
    machine_memory_bytes: 1_000,
    ...over,
  }
}

/** Runs the composable inside a scope so its watcher and timer are disposable. */
function mount(request: () => Promise<ResourceUsageWire | null>, paneCount = 1, panelOpen = false, requestCliRiskAction?: UseResourceUsageOptions['requestCliRiskAction']) {
  const scope = effectScope()
  const panes = ref(paneCount)
  const open = ref(panelOpen)
  const api = scope.run(() =>
    useResourceUsage({ request, paneCount: panes, panelOpen: open, requestCliRiskAction })
  )!
  return { api, panes, open, dispose: () => scope.stop() }
}

let disposers: Array<() => void> = []
afterEach(() => {
  disposers.forEach((d) => d())
  disposers = []
  vi.useRealTimers()
})
beforeEach(() => {
  vi.useFakeTimers()
})

describe('useResourceUsage', () => {
  it('consumes backend order unchanged and clears it for an older backend without cliRisks', async () => {
    const state = riskState([diskSignal(), networkSignal()])
    const request = vi.fn().mockResolvedValueOnce(wire({ cliRisks: { 'pane-a': state } })).mockResolvedValue(wire())
    const m = mount(request)
    disposers.push(m.dispose)
    await vi.advanceTimersByTimeAsync(0)
    expect(m.api.cliRisksByPaneId.value.get('pane-a')).toEqual(state)
    await m.api.refresh()
    expect(m.api.cliRisksByPaneId.value.size).toBe(0)
  })

  it('retains historical findings through unavailable and unknown observations', async () => {
    const initial = riskState()
    const stale = { ...riskState([networkSignal({ stale: true })]), network: { ...initial.network, status: 'unknown' as const } }
    const request = vi.fn().mockResolvedValueOnce(wire({ cliRisks: { 'pane-a': initial } })).mockResolvedValueOnce(null).mockResolvedValueOnce(wire({ cliRisks: { 'pane-a': stale } }))
    const m = mount(request)
    disposers.push(m.dispose)
    await vi.advanceTimersByTimeAsync(0)
    await m.api.refresh()
    expect(m.api.cliRisksByPaneId.value.get('pane-a')).toEqual(initial)
    expect(m.api.cliRisksAvailable.value).toBe(false)
    await m.api.refresh()
    expect(m.api.cliRisksByPaneId.value.get('pane-a')).toEqual(stale)
  })

  it.each(['ignore', 'allow'] as const)('forwards only identity and %s intent and updates every returned pane', async (action) => {
    const state = riskState()
    const empty = riskState([])
    const request = vi.fn().mockResolvedValue(wire({ cliRisks: { 'pane-a': state, 'pane-b': state, 'pane-c': state } }))
    const send = vi.fn().mockResolvedValue({ ok: true, payload: { cliRisks: { 'pane-a': empty, 'pane-b': empty } }, error: null })
    const m = mount(request, 1, false, send)
    disposers.push(m.dispose)
    await vi.advanceTimersByTimeAsync(0)
    await m.api.actOnCliRisk('pane-a', state.signals[0].id, action)
    expect(send).toHaveBeenCalledExactlyOnceWith({ paneId: 'pane-a', signalId: state.signals[0].id, action })
    expect(m.api.cliRisksByPaneId.value.get('pane-a')).toEqual(empty)
    expect(m.api.cliRisksByPaneId.value.get('pane-b')).toEqual(empty)
    expect(m.api.cliRisksByPaneId.value.get('pane-c')).toEqual(state)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('keeps findings on a rejected action and exposes the existing error envelope', async () => {
    const state = riskState()
    const rejection = { ok: false, payload: null, error: { code: 'UNKNOWN_SIGNAL', message: 'Signal no longer exists' } }
    const m = mount(async () => wire({ cliRisks: { 'pane-a': state } }), 1, false, vi.fn().mockResolvedValue(rejection))
    disposers.push(m.dispose)
    await vi.advanceTimersByTimeAsync(0)
    expect(await m.api.actOnCliRisk('pane-a', state.signals[0].id, 'ignore')).toEqual(rejection)
    expect(m.api.cliRisksByPaneId.value.get('pane-a')).toEqual(state)
  })

  it('does not restore a dismissed finding from an older in-flight poll', async () => {
    const state = riskState()
    const empty = riskState([])
    let finishPoll!: (wire: ResourceUsageWire) => void
    const request = vi.fn().mockResolvedValueOnce(wire({ cliRisks: { 'pane-a': state } }))
      .mockImplementationOnce(() => new Promise<ResourceUsageWire>((resolve) => { finishPoll = resolve }))
    const send = vi.fn().mockResolvedValue({ ok: true, payload: { cliRisks: { 'pane-a': empty } }, error: null })
    const m = mount(request, 1, false, send)
    disposers.push(m.dispose)
    await vi.advanceTimersByTimeAsync(0)
    const poll = m.api.refresh()
    await m.api.actOnCliRisk('pane-a', state.signals[0].id, 'ignore')
    finishPoll(wire({ cliRisks: { 'pane-a': state } }))
    await poll
    expect(m.api.cliRisksByPaneId.value.get('pane-a')).toEqual(empty)
  })

  it('drops risk presentation when all panes are reclaimed, including an in-flight sample', async () => {
    let finishPoll!: (wire: ResourceUsageWire) => void
    const request = vi.fn(() => new Promise<ResourceUsageWire>((resolve) => { finishPoll = resolve }))
    const m = mount(request)
    disposers.push(m.dispose)
    m.panes.value = 0
    await nextTick()
    finishPoll(wire({ cliRisks: { 'pane-a': riskState() } }))
    await vi.advanceTimersByTimeAsync(0)
    expect(m.api.cliRisksByPaneId.value.size).toBe(0)
  })

  it('serializes actions across panes so delayed replies cannot restore an earlier projection', async () => {
    const state = riskState()
    const empty = riskState([])
    type Reply = Awaited<ReturnType<NonNullable<UseResourceUsageOptions['requestCliRiskAction']>>>
    const pending: Array<(reply: Reply) => void> = []
    const send = vi.fn(() => new Promise<Reply>((resolve) => { pending.push(resolve) }))
    const m = mount(async () => wire({ cliRisks: { 'pane-a': state, 'pane-b': state } }), 2, false, send)
    disposers.push(m.dispose)
    await vi.advanceTimersByTimeAsync(0)
    const first = m.api.actOnCliRisk('pane-a', 'first-signal', 'ignore')
    const second = m.api.actOnCliRisk('pane-b', 'second-signal', 'allow')
    await vi.advanceTimersByTimeAsync(0)
    // Holding A's older projection must also hold B's request: without that,
    // B's newer response can land first and then be overwritten by A.
    expect(send).toHaveBeenCalledTimes(1)
    pending[0]({ ok: true, payload: { cliRisks: { 'pane-a': empty, 'pane-b': state } }, error: null })
    await first
    await vi.advanceTimersByTimeAsync(0)
    expect(send).toHaveBeenNthCalledWith(2, { paneId: 'pane-b', signalId: 'second-signal', action: 'allow' })
    pending[1]({ ok: true, payload: { cliRisks: { 'pane-a': empty, 'pane-b': empty } }, error: null })
    await second
    expect(m.api.cliRisksByPaneId.value.get('pane-a')).toEqual(empty)
    expect(m.api.cliRisksByPaneId.value.get('pane-b')).toEqual(empty)
  })

  it('discards late action projections and unsent decisions after all panes are reclaimed', async () => {
    type Reply = Awaited<ReturnType<NonNullable<UseResourceUsageOptions['requestCliRiskAction']>>>
    let finish!: (reply: Reply) => void
    const send = vi.fn(() => new Promise<Reply>((resolve) => { finish = resolve }))
    const m = mount(async () => wire({ cliRisks: { 'pane-a': riskState() } }), 1, false, send)
    disposers.push(m.dispose)
    await vi.advanceTimersByTimeAsync(0)
    const first = m.api.actOnCliRisk('pane-a', 'first-signal', 'ignore')
    const queued = m.api.actOnCliRisk('pane-a', 'second-signal', 'ignore')
    await vi.advanceTimersByTimeAsync(0)
    m.panes.value = 0
    await nextTick()
    finish({ ok: true, payload: { cliRisks: { 'pane-a': riskState() } }, error: null })
    await first
    expect((await queued).ok).toBe(false)
    expect(send).toHaveBeenCalledTimes(1)
    expect(m.api.cliRisksByPaneId.value.size).toBe(0)
  })

  it('continues queued actions after a transport rejection', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('Disconnected')).mockResolvedValueOnce({ ok: true, payload: { cliRisks: {} }, error: null })
    const m = mount(async () => wire(), 1, false, send)
    disposers.push(m.dispose)
    const first = m.api.actOnCliRisk('pane-a', 'first-signal', 'ignore')
    const next = m.api.actOnCliRisk('pane-a', 'second-signal', 'ignore')
    await expect(first).rejects.toThrow('Disconnected')
    expect((await next).ok).toBe(true)
  })

  // The backend hands back a counter; the first reading has nothing to
  // difference against, so CPU is unknown until the second one arrives.
  it('reports CPU only from the second sample onwards', async () => {
    const replies = [
      wire({ sampled_at: 1, panes: [{ terminal_session_id: 'sess-a', pane_id: 'pane-a', bytes: 100, cpu_seconds: 10 }] }),
      wire({ sampled_at: 2, panes: [{ terminal_session_id: 'sess-a', pane_id: 'pane-a', bytes: 100, cpu_seconds: 10.5 }] }),
    ]
    let call = 0
    const m = mount(async () => replies[Math.min(call++, replies.length - 1)])
    disposers.push(m.dispose)
    await vi.advanceTimersByTimeAsync(0)
    expect(m.api.cpuPercentByKey.value.get('sess-a')).toBeNull()
    expect(m.api.totalCpuPercent.value).toBeNull()

    await vi.advanceTimersByTimeAsync(RESOURCE_POLL_IDLE_MS)
    expect(m.api.cpuPercentByKey.value.get('sess-a')).toBeCloseTo(50)
    expect(m.api.totalCpuPercent.value).toBeCloseTo(50)
  })

  // Four cores means one busy core is a quarter of the machine.
  it('divides the total by the core count for the machine share', async () => {
    let call = 0
    const m = mount(async () =>
      wire({
        sampled_at: 1 + call++,
        panes: [{ terminal_session_id: 'sess-a', pane_id: 'pane-a', bytes: 250, cpu_seconds: call },],
      })
    )
    disposers.push(m.dispose)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(RESOURCE_POLL_IDLE_MS)
    expect(m.api.cpuShare.value).toBeCloseTo(25)
    expect(m.api.memoryShare.value).toBeCloseTo(25)
  })

  // Showing an unmeasured pane as 0 reads as "this one is free", which is the
  // opposite of what a failed sweep means.
  it('marks usage unavailable rather than zero when the backend cannot answer', async () => {
    const m = mount(async () => null)
    disposers.push(m.dispose)
    await vi.advanceTimersByTimeAsync(0)
    expect(m.api.available.value).toBe(false)
    expect(m.api.cpuAvailable.value).toBe(false)
    expect(m.api.measured.value).toBe(true)
  })

  // A machine deep in swap can take longer than the fast interval, and queueing
  // sweeps would make that worse exactly when the panel was opened to find out
  // why it is slow.
  it('never runs two sweeps at once', async () => {
    let started = 0
    const releases: Array<() => void> = []
    const m = mount(
      () =>
        new Promise<ResourceUsageWire | null>((resolve) => {
          started += 1
          releases.push(() => resolve(wire()))
        })
    )
    disposers.push(m.dispose)
    await vi.advanceTimersByTimeAsync(0)
    expect(started).toBe(1)
    await vi.advanceTimersByTimeAsync(RESOURCE_POLL_IDLE_MS * 3)
    expect(started).toBe(1)
    releases.forEach((r) => r())
  })

  // The pill carries a figure with nothing open, which is what forces a
  // background cadence at all; a panel in front of the user gets the fast one.
  it('switches cadence when the panel opens', async () => {
    let calls = 0
    const m = mount(async () => {
      calls += 1
      return wire({ sampled_at: 1 + calls })
    })
    disposers.push(m.dispose)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)

    m.open.value = true
    await nextTick()
    // Reopening restarts the loop with an immediate reading.
    expect(calls).toBe(2)
    await vi.advanceTimersByTimeAsync(RESOURCE_POLL_ACTIVE_MS)
    expect(calls).toBe(3)
  })

  // Shelling out to `ps` and `footprint` for an empty pid list is pure cost,
  // and a counter kept across an empty stretch would difference against a
  // reading from another era.
  it('stops sampling and forgets its counters with no panes', async () => {
    let calls = 0
    const m = mount(async () => {
      calls += 1
      return wire()
    })
    disposers.push(m.dispose)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)

    m.panes.value = 0
    await nextTick()
    await vi.advanceTimersByTimeAsync(RESOURCE_POLL_IDLE_MS * 2)
    expect(calls).toBe(1)
    expect(m.api.measured.value).toBe(false)
    expect(m.api.bytesByKey.value.size).toBe(0)
  })

  // A pane id reused after its pane went away must not inherit a stale counter
  // and report one enormous spike.
  it('drops the counters of panes that are gone', async () => {
    const rounds: ResourceUsageWire[] = [
      wire({ sampled_at: 1 }),
      wire({ sampled_at: 2, panes: [] }),
      wire({ sampled_at: 3, panes: [{ terminal_session_id: 'sess-a', pane_id: 'pane-a', bytes: 100, cpu_seconds: 9_999 }] }),
    ]
    let call = 0
    const m = mount(async () => rounds[Math.min(call++, rounds.length - 1)])
    disposers.push(m.dispose)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(RESOURCE_POLL_IDLE_MS)
    await vi.advanceTimersByTimeAsync(RESOURCE_POLL_IDLE_MS)
    expect(m.api.cpuPercentByKey.value.get('sess-a')).toBeNull()
  })

  // A pane rebuilt around a new PTY keeps its session while the renderer's pane
  // id moves on, so the sweep keeps reporting the id the PTY was created with.
  // A surface that lists panes by pane id needs that mapping to tell "already
  // accounted for" from "a pane nobody claimed".
  it('remembers which backend pane id each key was reported under', async () => {
    const m = mount(async () =>
      wire({ panes: [{ terminal_session_id: 'sess-a', pane_id: 'old-a', bytes: 10, cpu_seconds: 1 }] })
    )
    disposers.push(m.dispose)
    await vi.advanceTimersByTimeAsync(0)
    expect(m.api.paneIdByKey.value.get('sess-a')).toBe('old-a')

    m.panes.value = 0
    await nextTick()
    expect(m.api.paneIdByKey.value.size).toBe(0)
  })

  it('stops its timer when the scope is disposed', async () => {
    let calls = 0
    const m = mount(async () => {
      calls += 1
      return wire()
    })
    await vi.advanceTimersByTimeAsync(0)
    m.dispose()
    await vi.advanceTimersByTimeAsync(RESOURCE_POLL_IDLE_MS * 3)
    expect(calls).toBe(1)
  })
})
