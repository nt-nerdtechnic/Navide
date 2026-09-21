// @vitest-environment happy-dom
// QuotaCycleView — the right side of Turn Stats for a picked account. It owns
// no data, so the assertions are on the two requests it sends
// (`tokens.quota_cycles`, `tokens.account_periods`), the three tabs, the
// window chips, the all-accounts switch, the charts folded above each table,
// the empty / unknown / error states and the CSV shapes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import QuotaCycleView from '../QuotaCycleView.vue'
import type { QuotaCycle, QuotaCyclesResult } from '../../composables/useQuotaCycles'
import type { AccountPeriodRow, AccountPeriodsResult } from '../../composables/useAccountPeriods'
import type { UsageSnapshot } from '../../composables/useUsage'
import { setUsageEnabled } from '../../composables/useUsage'
import { __resetSettingsForTest } from '@navide/plugin-ui/shared/testing'

const wire = vi.hoisted(() => ({
  calls: [] as Array<{ type: string; payload?: Record<string, unknown> }>,
  handlers: {} as Record<string, Array<(raw: unknown) => void>>,
  cycles: null as unknown,
  periods: null as unknown,
}))

function fakeBackend() {
  return {
    status: ref('connected'),
    wsUrl: ref(''),
    httpUrl: ref(''),
    shell: ref(''),
    port: ref(0),
    pid: ref(0),
    lastError: ref(''),
    send: vi.fn(async (type: string, sent?: Record<string, unknown>) => {
      wire.calls.push({ type, payload: sent })
      let payload = type === 'tokens.quota_cycles' ? wire.cycles : type === 'tokens.account_periods' ? wire.periods : { ok: true }
      if (type === 'tokens.quota_cycles' && (payload as QuotaCyclesResult)?.ok) {
        const answer = payload as QuotaCyclesResult
        const all = answer.cycles.filter((c) => !sent?.window_kind || c.window_kind === sent.window_kind)
        const cursor = sent?.cursor as { id: number } | undefined
        const offset = cursor ? all.findIndex((c) => c.id === cursor.id) + 1 : 0
        const rows = sent?.export ? all : all.slice(offset, offset + 50)
        payload = { ...answer, cycles: rows, total_count: all.length, window_kinds: [...new Set(answer.cycles.map((c) => c.window_kind))],
          snapshot: { at: '2026-09-21T03:00:00Z', max_cycle_id: 999 },
          next_cursor: !sent?.export && offset + 50 < all.length ? { id: rows.at(-1)?.id, resets_at: rows.at(-1)?.resets_at } : null }
      }
      return { id: 'r', type, ok: true, payload, error: null, timestamp: '' }
    }),
    on: vi.fn((ev: string, cb: (raw: unknown) => void) => {
      ;(wire.handlers[ev] ??= []).push(cb)
      return () => {}
    }),
    restart: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  } as unknown as never
}

function cycle(over: Partial<QuotaCycle> = {}): QuotaCycle {
  return {
    window_kind: 'session', started_at: '2026-09-16T09:20:00Z', resets_at: '2026-09-16T14:20:00Z', closed: true,
    coverage_state: 'available', detail_known: true, exhausted_source: null,
    max_percent: 94, exhausted_at: null, input: 3981, cache_read: 25_806_112, cache_creation: 912_006, output: 318_442,
    total: 27_040_541, calls: 1204, turns: 163, samples: 12, ...over,
  }
}
function cyclesAnswer(): QuotaCyclesResult {
  return {
    ok: true, agent_key: 'claude', profile_id: 'slot-a',
    cycles: [
      cycle({ started_at: '2026-09-16T14:20:00Z', resets_at: '2026-09-16T19:20:00Z', closed: false, max_percent: 6, input: 182, cache_read: 1_612_404, cache_creation: 58_210, output: 21_933, total: 1_692_729, calls: 61, turns: 9 }),
      cycle(),
      cycle({ started_at: '2026-09-16T04:20:00Z', resets_at: '2026-09-16T09:20:00Z', max_percent: 100, exhausted_at: '2026-09-16T08:41:00Z', input: 4410, cache_read: 27_113_905, cache_creation: 1_020_388, output: 334_910, total: 28_473_613, calls: 1318, turns: 171 }),
      cycle({ window_kind: 'weekly', started_at: '2026-09-11T04:00:00Z', resets_at: '2026-09-18T04:00:00Z', closed: false, max_percent: 64, total: 200_000_000 }),
    ],
    summary: {
      session: { cycles: 3, exhausted: 1, avg_total_exhausted: 28_473_613 },
      weekly: { cycles: 1, exhausted: 0, avg_total_exhausted: null },
    },
  }
}
function periodRow(over: Partial<AccountPeriodRow> = {}): AccountPeriodRow {
  return {
    coverage_state: 'available', detail_known: true, period_start: '2026-09-01T00:00:00Z', period_end: '2026-10-01T00:00:00Z',
    period: '2026-09', agent_key: 'claude', profile_id: 'slot-a',
    input: 61_204, cache_read: 412_880_113, cache_creation: 15_102_441, output: 5_210_392, total: 433_254_150,
    calls: 20_318, turns: 2740, cycles: 44, exhausted: 11, avg_total_exhausted: 28_500_000, weekly_exhausted: 1, ...over,
  }
}
// UTC, as the backend keys periods (a local calendar would miss the open
// period for the first hours of a month east of Greenwich).
const NOW_MONTH = (() => { const d = new Date(); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}` })()
function periodsAnswer(): AccountPeriodsResult {
  return {
    ok: true, granularity: 'month',
    rows: [periodRow({ period: NOW_MONTH }), periodRow({ period: '2026-08', total: 723_530_616, exhausted: 19, avg_total_exhausted: 0 })],
    totals_by_period: [{ period: NOW_MONTH, total: 433_254_150, calls: 20_318, turns: 2740 }, { period: '2026-08', total: 723_530_616, calls: 33_905, turns: 4512 }],
  }
}
function allAccountsAnswer(): AccountPeriodsResult {
  return {
    ok: true, granularity: 'month',
    rows: [
      periodRow({ period: '2026-09', total: 433_254_150 }),
      periodRow({ period: '2026-09', agent_key: 'codex', profile_id: '__default__', total: 201_900_000, exhausted: 6, weekly_exhausted: 1 }),
      periodRow({ period: '2026-09', profile_id: 'unknown', total: 22_500_000, exhausted: 0, weekly_exhausted: 0 }),
    ],
    totals_by_period: [{ period: '2026-09', total: 657_654_150, calls: 34_655, turns: 4565 }],
  }
}
function usage(over: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    provider: 'claude', status: 'ok', planType: 'max', fetchedAt: '2026-09-16T01:00:00Z', error: null,
    windows: [
      { kind: 'session', label: 'Session (5h)', usedPercent: 6, resetsAt: '2026-09-16T19:20:00Z' },
      { kind: 'weekly', label: 'Weekly (all models)', usedPercent: 64, resetsAt: '2026-09-18T04:00:00Z' },
    ],
    ...over,
  }
}

beforeEach(() => {
  __resetSettingsForTest()
  wire.calls = []
  wire.handlers = {}
  wire.cycles = cyclesAnswer()
  wire.periods = periodsAnswer()
  i18n.global.locale.value = 'en-US'
})
afterEach(() => {
  __resetSettingsForTest()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

async function mountView(props: Partial<InstanceType<typeof QuotaCycleView>['$props']> = {}): Promise<VueWrapper> {
  const w = mount(QuotaCycleView, {
    props: {
      backend: fakeBackend(),
      agentKey: 'claude',
      profileId: 'slot-a',
      label: 'services@x.dev',
      vendorLabel: 'Claude Code',
      active: false,
      usage: usage(),
      ...props,
    },
    global: { plugins: [i18n] },
  })
  await flushPromises()
  return w
}
const calls = (type: string) => wire.calls.filter((c) => c.type === type)

describe('QuotaCycleView production history', () => {
  it('loads local history in bounded pages and keeps five cycle columns with a real detail button', async () => {
    const w = await mountView()
    expect(calls('tokens.quota_cycles').at(-1)?.payload).toMatchObject({ agent_key: 'claude', profile_id: 'slot-a', window_kind: 'session', limit: 50 })
    expect(w.findAll('thead th')).toHaveLength(5)
    expect(w.findAll('[data-row="cycle"]')).toHaveLength(3)
    await w.get('[data-row="cycle"] [data-act="details"]').trigger('click')
    expect(w.get('[data-part="selected-detail"]').text()).toContain('Changed readings')
    expect(w.get('[data-act="details"]').attributes('aria-expanded')).toBe('true')
    expect(calls('usage.refresh')).toHaveLength(0)
    w.unmount()
  })

  it('switches windows and preserves full weekly dates and source evidence', async () => {
    const w = await mountView()
    await w.get('[data-kind="weekly"]').trigger('click'); await flushPromises()
    expect(w.findAll('[data-row="cycle"]')).toHaveLength(1)
    expect(w.get('[data-row="cycle"]').text()).toContain('2026')
    expect(w.get('[data-kind="weekly"]').attributes('aria-pressed')).toBe('true')
    w.unmount()
  })

  it('shows missing detail as a chart/table gap while preserving a genuine zero and the full-range average', async () => {
    wire.cycles = { ...cyclesAnswer(), cycles: [
      cycle({ id: 1, total: null, coverage_state: 'partial', detail_known: false, exhausted_source: 'legacy_unknown', exhausted_at: '2026-09-16T12:00:00Z' }),
      cycle({ id: 2, total: 0, input: 0, cache_read: 0, cache_creation: 0, output: 0, calls: 0, turns: 0, exhausted_source: 'cli', exhausted_at: '2026-09-16T12:00:00Z' }),
    ], summary: { session: { cycles: 2, exhausted: 2, avg_total_exhausted: 0, eligible_count: 1, excluded_count: 1 } } }
    const w = await mountView()
    const rows = w.findAll('[data-row="cycle"]')
    expect(rows[0].get('[data-part="total"]').text()).toBe('—')
    expect(rows[0].text()).toContain('unverified')
    expect(rows[1].get('[data-part="total"]').text()).toBe('≈ 0')
    expect(w.findAll('[data-part="cycle-chart"] rect[data-part="bar"]')).toHaveLength(1)
    expect(w.get('[data-part="average"]').text()).toContain(': 0')
    expect(w.get('[data-part="average"]').text()).toContain('1 eligible · 1 excluded')
    w.unmount()
  })

  it('uses server eligibility across pages and preserves selected identity through paging and refresh', async () => {
    const rows = Array.from({ length: 60 }, (_, n) => cycle({ id: n + 1, total: n, resets_at: new Date(Date.UTC(2026, 8, 21) - n * 5 * 3600000).toISOString() }))
    wire.cycles = { ...cyclesAnswer(), cycles: rows, summary: { session: { cycles: 60, exhausted: 5, avg_total_exhausted: 12, eligible_count: 4, excluded_count: 56 } } }
    const w = await mountView()
    expect(w.findAll('[data-row="cycle"]')).toHaveLength(50)
    await w.findAll('[data-act="details"]')[2].trigger('click')
    const detail = w.get('[data-part="selected-detail"]').text()
    const summary = w.get('[data-part="average"]').text()
    await w.get('[data-act="next"]').trigger('click'); await flushPromises()
    expect(w.findAll('[data-row="cycle"]')).toHaveLength(10)
    expect(w.get('[data-part="average"]').text()).toBe(summary)
    expect(w.get('[data-part="selected-detail"]').text()).toBe(detail)
    await w.get('[data-act="previous"]').trigger('click'); await flushPromises()
    expect(w.findAll('[data-row="cycle"]')[2].attributes('data-selected')).toBe('true')
    await w.get('[data-act="refresh"]').trigger('click'); await flushPromises()
    expect(w.findAll('[data-row="cycle"]')[2].attributes('data-selected')).toBe('true')
    expect(calls('tokens.quota_cycles').some((c) => c.payload?.snapshot != null)).toBe(true)
    w.unmount()
  })

  it('clears selection with an explanation when filters change', async () => {
    const w = await mountView()
    await w.get('[data-act="details"]').trigger('click')
    await w.get('[data-kind="weekly"]').trigger('click'); await flushPromises()
    expect(w.find('[data-part="selected-detail"]').exists()).toBe(false)
    expect(w.text()).toContain('Selection cleared')
    w.unmount()
  })

  it('allows chart keyboard selection and matches the equivalent table record', async () => {
    const w = await mountView()
    await w.get('[data-part="bar-group"]').trigger('keydown', { key: 'Enter' })
    expect(w.findAll('[data-row="cycle"]')[2].attributes('data-selected')).toBe('true')
    expect(w.find('[data-part="selected-detail"]').exists()).toBe(true)
    w.unmount()
  })

  it('reads Unknown history and retries retained failures without enabling or polling the provider', async () => {
    const w = await mountView({ profileId: 'unknown' })
    expect(calls('tokens.quota_cycles')[0].payload?.profile_id).toBe('unknown')
    wire.cycles = { ok: false, error: 'read-failed' }
    await w.get('[data-act="refresh"]').trigger('click'); await flushPromises()
    expect(w.get('[data-state="error"]').text()).toContain('retained')
    expect(w.findAll('[data-row="cycle"]')).toHaveLength(3)
    wire.cycles = cyclesAnswer()
    await w.get('[data-act="retry"]').trigger('click'); await flushPromises()
    expect(w.find('[data-state="error"]').exists()).toBe(false)
    expect(calls('usage.refresh')).toHaveLength(0)
    w.unmount()
  })

  it('sends 90-day and custom UTC half-open dates, and offers recovery for empty results', async () => {
    const w = await mountView()
    await w.get('[data-act="range"]').setValue('90'); await flushPromises()
    const start = calls('tokens.quota_cycles').at(-1)?.payload?.range_start as string
    expect(Math.abs(Date.now() - Date.parse(start) - 90 * 86400000)).toBeLessThan(60000)
    await w.get('[data-act="range"]').setValue('custom')
    await w.get('[data-act="from"]').setValue('2026-08-01')
    await w.get('[data-act="to"]').setValue('2026-08-31'); await flushPromises()
    expect(calls('tokens.quota_cycles').at(-1)?.payload).toMatchObject({ range_start: '2026-08-01T00:00:00.000Z', range_end: '2026-09-01T00:00:00.000Z' })
    wire.cycles = { ...cyclesAnswer(), cycles: [], summary: {} }
    await w.get('[data-act="refresh"]').trigger('click'); await flushPromises()
    expect(w.get('[data-state="empty"]').text()).toContain('cannot be reconstructed')
    expect(w.find('[data-act="clear-filters"]').exists()).toBe(true)
    w.unmount()
  })

  it('does not invent provider values for an unsupported window and displays cached freshness separately', async () => {
    const w = await mountView({ usage: usage({ stale: true }) })
    expect(w.get('[data-part="current-reading"]').text()).toContain('Stale cached reading')
    await w.setProps({ usage: usage({ windows: [] }) })
    expect(w.get('[data-part="current-reading"]').text()).toContain('No suitable provider/window reading')
    expect(calls('usage.refresh')).toHaveLength(0)
    w.unmount()
  })

  it('exports all 60 rows once from page two without a page snapshot and leaves the UI page unchanged', async () => {
    wire.cycles = { ...cyclesAnswer(), cycles: Array.from({ length: 60 }, (_, n) => cycle({ id: n + 1 })) }
    const w = await mountView()
    await w.get('[data-act="next"]').trigger('click'); await flushPromises()
    const blobs: Blob[] = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => { blobs.push(blob as Blob); return 'blob:test' })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    await w.get('[data-act="export"]').trigger('click'); await flushPromises()
    const request = calls('tokens.quota_cycles').at(-1)?.payload
    expect(request).toMatchObject({ export: true, profile_id: 'slot-a', window_kind: 'session' })
    expect(request?.snapshot).toBeUndefined(); expect(request?.cursor).toBeUndefined()
    expect((await blobs[0].text()).trim().split('\r\n')).toHaveLength(61)
    expect(w.findAll('[data-row="cycle"]')).toHaveLength(10)
    expect(w.text()).toContain('Exported 60 records')
    vi.restoreAllMocks(); w.unmount()
  })

  it('exports blank numeric cells for partial records and real zeros with proper identity and escaping', async () => {
    const w = await mountView({ label: 'Work, "one"\nteam' })
    const csv = (w.vm as unknown as { buildCyclesCsv: (r: QuotaCycle[]) => string }).buildCyclesCsv([
      cycle({ id: 11, total: 7, coverage_state: 'partial', detail_known: false, coverage_reason: 'retention_expired' }),
      cycle({ id: 12, total: 0 }),
    ])
    expect(csv).toContain('exhausted_source,coverage_state,coverage_reason')
    expect(csv).toContain('"Work, ""one""\nteam"')
    expect(csv).toContain(',,,,,,,,12,2,11')
    expect(csv).toContain('318442,0,1204,163')
    expect(csv).toContain('partial,retention_expired')
    w.unmount()
  })

  it('displays UTC periods and exact boundaries, including zero averages', async () => {
    const w = await mountView()
    await w.get('[data-tab="month"]').trigger('click'); await flushPromises()
    expect(calls('tokens.account_periods').at(-1)?.payload).toMatchObject({ granularity: 'month', limit: 50, window_kind: 'session' })
    expect(w.text()).toContain('Calendar month/year · UTC')
    expect(w.text()).toContain('Without a selected window, cycle statistics exclude weekly quotas')
    const rows = w.findAll('[data-row="period"]')
    expect(rows[1].get('[data-part="avg-exhausted"]').text()).toContain('0')
    await rows[0].get('[data-act="details"]').trigger('click')
    expect(w.get('[data-part="selected-detail"]').text()).toContain('2026-09-01T00:00:00Z')
    await w.get('[data-tab="year"]').trigger('click'); await flushPromises()
    expect(calls('tokens.account_periods').at(-1)?.payload?.granularity).toBe('year')
    w.unmount()
  })

  it.each([
    ['month', 'weekly'],
    ['month', 'weekly-model:Weekly (Sonnet)'],
    ['year', 'weekly'],
    ['year', 'weekly-model:Weekly (Sonnet)'],
  ] as const)('shows selected %s / %s statistics while retaining account token totals', async (granularity, windowKind) => {
    const answer = wire.cycles as QuotaCyclesResult
    answer.cycles.push(cycle({ window_kind: 'weekly-model:Weekly (Sonnet)' }))
    wire.periods = { ...periodsAnswer(), rows: [periodRow({ total: 123 })] }
    const w = await mountView()
    await w.get(`[data-tab="${granularity}"]`).trigger('click'); await flushPromises()
    expect(w.get('[data-row="period"] [data-part="total"]').text()).toContain('123')
    wire.periods = {
      ok: true, granularity,
      rows: [periodRow({ period: granularity === 'month' ? '2026-09' : '2026', total: 123, cycles: 1, exhausted: 1, eligible_count: 1, excluded_count: 0, avg_total_exhausted: 123 })],
      totals_by_period: [{ period: granularity === 'month' ? '2026-09' : '2026', total: 123, calls: 1, turns: 0 }],
      summary: { cycles: 1, eligible_count: 1, excluded_count: 0, avg_total_exhausted: 123 },
    } satisfies AccountPeriodsResult
    await w.get(`[data-kind="${windowKind}"]`).trigger('click'); await flushPromises()
    expect(calls('tokens.account_periods').at(-1)?.payload).toMatchObject({ granularity, window_kind: windowKind, agent_key: 'claude', profile_id: 'slot-a' })
    const row = w.get('[data-row="period"]')
    expect(row.findAll('td')[2].text()).toBe('1')
    expect(row.get('[data-part="total"]').text()).toContain('123')
    expect(row.get('[data-part="avg-exhausted"]').text()).toContain('123')
    expect(row.get('[data-part="avg-exhausted"]').text()).toContain('1 eligible · 0 excluded')
    expect(w.get('[data-part="average"]').text()).toContain('123')
    expect(w.get('[data-part="average"]').text()).toContain('1 eligible · 0 excluded')
    w.unmount()
  })

  it('uses an aggregate heading without a single-account reading and does not fabricate shares across missing coverage', async () => {
    wire.periods = allAccountsAnswer()
    const answer = wire.periods as AccountPeriodsResult
    answer.rows[2].coverage_state = 'partial'; answer.rows[2].total = null
    answer.totals_by_period[0].total = null
    const w = await mountView()
    await w.get('[data-tab="month"]').trigger('click'); await flushPromises()
    await w.get('[data-act="all-accounts"]').trigger('click'); await flushPromises()
    expect(w.get('[data-part="account-name"]').text()).toBe('All accounts')
    expect(w.find('[data-part="active"]').exists()).toBe(false)
    expect(w.find('[data-part="as-of"]').exists()).toBe(false)
    expect(w.find('[data-part="current-reading"]').exists()).toBe(false)
    expect(w.findAll('[data-part="share"]').map((r) => r.text())).toEqual(['—', '—', '—'])
    expect(calls('tokens.account_periods').at(-1)?.payload?.agent_key).toBeUndefined()
    w.unmount()
  })

  it('renders all supported locales without leaking keys', async () => {
    for (const language of ['en-US', 'zh-TW', 'ja-JP'] as const) {
      const w = await mountView(); i18n.global.locale.value = language
      await w.get('[data-act="details"]').trigger('click')
      expect(w.text()).not.toMatch(/quota-cycles\.[a-z]/)
      await w.get('[data-tab="month"]').trigger('click'); await flushPromises()
      expect(w.text()).not.toMatch(/quota-cycles\.[a-z]/)
      w.unmount()
    }
  })
})

describe('QuotaCycleView state and export boundaries', () => {
  it('keeps disabled polling disabled across history refresh and offers its settings action', async () => {
    setUsageEnabled(false)
    const w = await mountView()
    expect(w.text()).toContain('Polling disabled')
    await w.get('[data-act="polling-settings"]').trigger('click')
    expect(w.emitted('openSettings')).toHaveLength(1)
    await w.get('[data-act="refresh"]').trigger('click'); await flushPromises()
    expect(calls('usage.refresh')).toHaveLength(0)
    expect(w.text()).toContain('Polling disabled')
    w.unmount()
  })

  it('reports the bounded full export limit without silently downloading a page', async () => {
    const w = await mountView()
    wire.cycles = { ok: false, error: 'range-too-large' }
    const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    await w.get('[data-act="export"]').trigger('click'); await flushPromises()
    expect(w.text()).toContain('More than 10,000 records')
    expect(download).not.toHaveBeenCalled()
    expect(w.findAll('[data-row="cycle"]')).toHaveLength(3)
    w.unmount()
  })

  it('freezes the export identity when the selected account changes before the response arrives', async () => {
    const backend = fakeBackend() as unknown as { send: ReturnType<typeof vi.fn> }
    const w = await mountView({ backend: backend as never })
    let resolveExport!: (response: unknown) => void
    backend.send.mockImplementationOnce(() => new Promise((resolve) => { resolveExport = resolve }))
    const blobs: Blob[] = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => { blobs.push(blob as Blob); return 'blob:test' })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    await w.get('[data-act="export"]').trigger('click')
    await w.setProps({ profileId: 'slot-b', label: 'Second account' }); await flushPromises()
    resolveExport({ ok: true, payload: { ...cyclesAnswer(), cycles: [cycle({ id: 71 })] } })
    await flushPromises()
    const csv = await blobs[0].text()
    expect(csv).toContain('claude,slot-a,services@x.dev')
    expect(csv).not.toContain('Second account')
    expect(w.get('[data-part="account-name"]').text()).toBe('Second account')
    w.unmount()
  })
})
