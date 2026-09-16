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
      const payload = type === 'tokens.quota_cycles' ? wire.cycles : type === 'tokens.account_periods' ? wire.periods : { ok: true }
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
    period: '2026-09', agent_key: 'claude', profile_id: 'slot-a',
    input: 61_204, cache_read: 412_880_113, cache_creation: 15_102_441, output: 5_210_392, total: 433_254_150,
    calls: 20_318, turns: 2740, cycles: 44, exhausted: 11, avg_total_exhausted: 28_500_000, weekly_exhausted: 1, ...over,
  }
}
const NOW_MONTH = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` })()
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
  wire.calls = []
  wire.handlers = {}
  wire.cycles = cyclesAnswer()
  wire.periods = periodsAnswer()
  i18n.global.locale.value = 'en-US'
})
afterEach(() => {
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

describe('QuotaCycleView cycles', () => {
  it('loads the account\'s cycles, offers one chip per window kind (session first, labelled by the snapshot), and lists the picked kind newest first', async () => {
    const w = await mountView()
    expect(calls('tokens.quota_cycles')).toHaveLength(1)
    expect(calls('tokens.quota_cycles')[0].payload).toMatchObject({ agent_key: 'claude', profile_id: 'slot-a' })
    expect(calls('tokens.account_periods')).toHaveLength(0)
    expect(w.get('[data-part="account-name"]').text()).toBe('services@x.dev')
    expect(w.get('[data-part="active"]').text()).toBe(i18n.global.t('account-dim.inactive'))

    const chips = w.findAll('[data-act="window-chip"]')
    expect(chips.map((c) => c.attributes('data-kind'))).toEqual(['session', 'weekly'])
    expect(chips[0].text()).toBe('Session (5h)')
    expect(chips[0].classes()).toContain('on')

    const rows = w.findAll('[data-row="cycle"]')
    expect(rows).toHaveLength(3)
    expect(rows[0].attributes('data-closed')).toBe('false')
    expect(rows[0].get('[data-part="in-progress"]').text()).toBe(i18n.global.t('quota-cycles.in-progress'))
    expect(rows[0].get('[data-part="max"]').text()).toBe('6%')
    expect(rows[0].get('[data-part="total"]').text()).toBe('1,692,729')
    expect(rows[0].get('[data-part="per-percent"]').text()).toBe('282k')
    expect(rows[2].attributes('data-exhausted')).toBe('true')
    expect(rows[2].get('[data-part="exhausted"]').text()).not.toBe('—')
    expect(rows[1].get('[data-part="exhausted"]').text()).toBe('—')
    expect(w.get('[data-part="cycle-summary"]').text()).toContain(i18n.global.t('quota-cycles.summary', { cycles: 3, exhausted: 1 }))
    expect(w.get('[data-part="cycle-summary"]').text()).toContain('28.5M')
    // The footer averages the exhausted cycles only.
    const avg = w.get('[data-row="exhausted-average"]')
    expect(avg.text()).toContain(i18n.global.t('quota-cycles.row-exhausted-average', { count: 1 }))
    expect(avg.get('[data-part="total"]').text()).toBe('28,473,613')
  })

  it('switching the window chip swaps the rows; a kind with no exhausted cycle has no average row', async () => {
    const w = await mountView()
    await w.get('[data-act="window-chip"][data-kind="weekly"]').trigger('click')
    const rows = w.findAll('[data-row="cycle"]')
    expect(rows).toHaveLength(1)
    expect(rows[0].get('[data-part="total"]').text()).toBe('200,000,000')
    expect(w.find('[data-row="exhausted-average"]').exists()).toBe(false)
    expect(calls('tokens.quota_cycles')).toHaveLength(1)
  })

  it('draws the cycle chart oldest first with the exhausted dot, and a bar click selects the matching (newest-first) row', async () => {
    const w = await mountView()
    const chart = w.get('[data-part="cycle-chart"]')
    expect(chart.findAll('[data-part="bar"]')).toHaveLength(3)
    expect(chart.findAll('[data-part="dot"][data-exhausted="true"]')).toHaveLength(1)
    expect(chart.findAll('[data-part="x-note"]')).toHaveLength(1)
    await chart.get('[data-part="bar"][data-index="0"]').trigger('click')
    const rows = w.findAll('[data-row="cycle"]')
    expect(rows[2].attributes('data-selected')).toBe('true')
    expect(rows[0].attributes('data-selected')).toBe('false')
    await chart.get('[data-act="toggle-chart"]').trigger('click')
    expect(chart.find('svg').exists()).toBe(false)
  })

  it('shows the empty state for an account without cycles, the unknown note for the unknown bucket, and the vendor error', async () => {
    wire.cycles = { ...cyclesAnswer(), cycles: [], summary: {} }
    let w = await mountView()
    expect(w.get('[data-state="empty"]').text()).toBe(i18n.global.t('quota-cycles.empty'))
    expect(w.find('[data-act="window-chip"]').exists()).toBe(false)
    expect(w.get('[data-act="export"]').attributes('disabled')).toBeDefined()
    w.unmount()

    wire.calls = []
    w = await mountView({ profileId: 'unknown', label: 'Unknown' })
    expect(w.get('[data-state="unknown"]').text()).toBe(i18n.global.t('quota-cycles.unknown-account'))
    expect(calls('tokens.quota_cycles')).toHaveLength(0)
    expect(w.find('[data-part="active"]').exists()).toBe(false)
    w.unmount()

    wire.cycles = { ok: false, error: 'unknown-vendor' }
    w = await mountView({ agentKey: 'nope' })
    expect(w.get('[data-state="error"]').text()).toBe(i18n.global.t('quota-cycles.error-unknown-vendor'))
  })

  it('refetches when the backend says this account\'s cycles changed, and reloads when the account prop changes', async () => {
    const w = await mountView()
    for (const h of wire.handlers['tokens.quota_cycles_changed'] ?? []) h({ agent_key: 'claude', profile_id: 'slot-a', window_kind: 'session' })
    await flushPromises()
    expect(calls('tokens.quota_cycles')).toHaveLength(2)
    await w.setProps({ profileId: '__default__', label: 'me@x.dev' })
    await flushPromises()
    expect(calls('tokens.quota_cycles')).toHaveLength(3)
    expect(calls('tokens.quota_cycles')[2].payload).toMatchObject({ profile_id: '__default__' })
  })

  it('keys per-model weekly buckets as "kind:label" chips, labelled from the matching snapshot window', async () => {
    const answer = cyclesAnswer()
    answer.cycles.push(
      cycle({ window_kind: 'weekly-model:Fable only', started_at: '2026-09-11T04:00:00Z', resets_at: '2026-09-18T04:00:00Z', closed: false, max_percent: 20, total: 5_000_000 }),
      cycle({ window_kind: 'weekly-model:Opus', started_at: '2026-09-11T04:00:00Z', resets_at: '2026-09-18T04:00:00Z', closed: false, max_percent: 3, total: 1_000_000 }),
    )
    answer.summary['weekly-model:Fable only'] = { cycles: 1, exhausted: 0, avg_total_exhausted: null }
    answer.summary['weekly-model:Opus'] = { cycles: 1, exhausted: 0, avg_total_exhausted: null }
    wire.cycles = answer
    const w = await mountView({
      usage: usage({
        windows: [
          { kind: 'session', label: 'Session (5h)', usedPercent: 6, resetsAt: null },
          { kind: 'weekly', label: 'Weekly (all models)', usedPercent: 64, resetsAt: null },
          { kind: 'weekly-model', label: 'Opus', usedPercent: 3, resetsAt: null },
          { kind: 'weekly-model', label: 'Fable only', usedPercent: 20, resetsAt: null },
        ],
      }),
    })
    const chips = w.findAll('[data-act="window-chip"]')
    expect(chips.map((c) => c.attributes('data-kind'))).toEqual(['session', 'weekly', 'weekly-model:Fable only', 'weekly-model:Opus'])
    expect(chips.map((c) => c.text())).toEqual(['Session (5h)', 'Weekly (all models)', 'Fable only', 'Opus'])
    await chips[2].trigger('click')
    expect(w.findAll('[data-row="cycle"]')).toHaveLength(1)
    expect(w.get('[data-row="cycle"] [data-part="total"]').text()).toBe('5,000,000')
    // Without a snapshot the label part of the key still names the chip.
    await w.setProps({ usage: undefined })
    expect(w.findAll('[data-act="window-chip"]').map((c) => c.text())).toEqual(['session', 'weekly', 'Fable only', 'Opus'])
  })

  it('a closed cycle with no token detail reads as "—", is excluded from the token averages, and a 0.0 summary average is not printed', async () => {
    const answer = cyclesAnswer()
    // Before slices were kept: samples say it ran out, the spend is unknown (all zeros).
    answer.cycles.push(cycle({ started_at: '2026-09-15T21:05:00Z', resets_at: '2026-09-16T02:05:00Z', max_percent: 100, exhausted_at: '2026-09-16T01:12:00Z', input: 0, cache_read: 0, cache_creation: 0, output: 0, total: 0, calls: 0, turns: 0, samples: 4 }))
    answer.summary.session = { cycles: 4, exhausted: 2, avg_total_exhausted: 14_236_806 }
    wire.cycles = answer
    const w = await mountView()
    const rows = w.findAll('[data-row="cycle"]')
    expect(rows).toHaveLength(4)
    const bare = rows[3]
    expect(bare.attributes('data-no-detail')).toBe('true')
    expect(bare.get('[data-part="no-detail"]').text()).toBe(i18n.global.t('quota-cycles.no-detail-short'))
    expect(bare.get('[data-part="total"]').text()).toBe('—')
    expect(bare.get('[data-part="calls"]').text()).toBe('—')
    expect(bare.get('[data-part="per-percent"]').text()).toBe('—')
    expect(bare.get('[data-part="max"]').text()).toBe('100%')
    // An open cycle at 0 is not "no detail" — it has simply not spent yet.
    expect(rows[0].attributes('data-no-detail')).toBe('false')
    // Two exhausted, one with detail: the token average is that one's figures.
    const avg = w.get('[data-row="exhausted-average"]')
    expect(avg.text()).toContain(i18n.global.t('quota-cycles.row-exhausted-average', { count: 2 }))
    expect(avg.get('[data-part="average-detailed"]').text()).toBe(i18n.global.t('quota-cycles.average-detailed', { detailed: 1 }))
    expect(avg.get('[data-part="total"]').text()).toBe('28,473,613')
    w.unmount()

    // The backend reports 0.0 when none of the exhausted cycles carry detail.
    const bareOnly = cyclesAnswer()
    bareOnly.cycles = [cycle({ max_percent: 100, exhausted_at: '2026-09-16T13:00:00Z', input: 0, cache_read: 0, cache_creation: 0, output: 0, total: 0, calls: 0, turns: 0 })]
    bareOnly.summary = { session: { cycles: 1, exhausted: 1, avg_total_exhausted: 0 } }
    wire.cycles = bareOnly
    const w2 = await mountView()
    expect(w2.get('[data-part="cycle-summary"]').text()).not.toContain(i18n.global.t('quota-cycles.summary-avg', { total: '0' }))
    expect(w2.get('[data-row="exhausted-average"] [data-part="total"]').text()).toBe('—')
  })

  it('builds a cycles CSV with one row per cycle', async () => {
    const w = await mountView()
    const csv = (w.vm as unknown as { buildCyclesCsv: (rows: QuotaCycle[]) => string }).buildCyclesCsv(cyclesAnswer().cycles.slice(0, 2))
    const lines = csv.trimEnd().split('\n')
    expect(lines[0]).toBe('window_kind,started_at,resets_at,closed,max_percent,exhausted_at,input,cache_read,cache_creation,output,total,calls,turns,samples')
    expect(lines).toHaveLength(3)
    expect(lines[1]).toBe('session,2026-09-16T14:20:00Z,2026-09-16T19:20:00Z,0,6,,182,1612404,58210,21933,1692729,61,9,12')
    expect(lines[2].startsWith('session,2026-09-16T09:20:00Z,2026-09-16T14:20:00Z,1,94,,3981,')).toBe(true)
  })
})

describe('QuotaCycleView periods', () => {
  it('the Monthly tab asks for this account\'s months and lists them with the cycle columns; the open month is marked', async () => {
    const w = await mountView()
    await w.get('[data-act="tab"][data-tab="month"]').trigger('click')
    await flushPromises()
    expect(calls('tokens.account_periods')).toHaveLength(1)
    expect(calls('tokens.account_periods')[0].payload).toEqual({ agent_key: 'claude', profile_id: 'slot-a', granularity: 'month' })
    const table = w.get('[data-state="table"]')
    expect(table.attributes('data-mode')).toBe('single')
    const rows = w.findAll('[data-row="period"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].get('[data-part="period"]').text()).toContain(NOW_MONTH)
    expect(rows[0].get('[data-part="in-progress"]').text()).toBe(i18n.global.t('quota-cycles.in-progress'))
    expect(rows[1].find('[data-part="in-progress"]').exists()).toBe(false)
    expect(rows[0].get('[data-part="total"]').text()).toBe('433,254,150')
    expect(rows[0].get('[data-part="cycles"]').text()).toBe('44')
    expect(rows[0].get('[data-part="exhausted"]').text()).toBe('11')
    expect(rows[0].get('[data-part="avg-exhausted"]').text()).toBe('28.5M')
    expect(rows[1].get('[data-part="avg-exhausted"]').text()).toBe('—')
    expect(rows[0].get('[data-part="weekly-exhausted"]').text()).toBe('1')
    // The chart stacks one segment per account: a single account, one segment per bar, oldest first.
    const chart = w.get('[data-part="period-chart"]')
    expect(chart.findAll('[data-part="bar"]')).toHaveLength(2)
    expect(chart.findAll('[data-part="segment"]')).toHaveLength(2)
    expect(chart.findAll('[data-part="x-label"]').map((l) => l.text())).toEqual(['2026-08', NOW_MONTH])
    await chart.get('[data-part="bar"][data-index="0"]').trigger('click')
    expect(rows[1].attributes('data-selected')).toBe('true')
  })

  it('the Yearly tab asks for years, and switching tabs reloads with the new granularity', async () => {
    wire.periods = { ...periodsAnswer(), granularity: 'year', rows: [periodRow({ period: '2026' })], totals_by_period: [{ period: '2026', total: 1, calls: 1, turns: 1 }] }
    const w = await mountView()
    await w.get('[data-act="tab"][data-tab="year"]').trigger('click')
    await flushPromises()
    expect(calls('tokens.account_periods')[0].payload).toMatchObject({ granularity: 'year' })
    expect(w.get('[data-row="period"] [data-part="period"]').text()).toContain('2026')
    await w.get('[data-act="tab"][data-tab="cycle"]').trigger('click')
    expect(w.find('[data-row="period"]').exists()).toBe(false)
    expect(w.findAll('[data-row="cycle"]')).toHaveLength(3)
  })

  it('All accounts asks without an account and groups every account under each period with its share', async () => {
    const w = await mountView({ cliProfiles: {
      identityFor: (_a: string, id: string | null) => (id === 'slot-a' ? { email: 'services@x.dev', signedIn: true } : null),
      findProfile: () => undefined,
      defaultProfileId: () => null,
      profilesForAgent: () => [],
    } as unknown as never })
    await w.get('[data-act="tab"][data-tab="month"]').trigger('click')
    await flushPromises()
    wire.periods = allAccountsAnswer()
    await w.get('[data-act="all-accounts"]').trigger('click')
    await flushPromises()
    expect(calls('tokens.account_periods')[1].payload).toEqual({ agent_key: undefined, profile_id: undefined, granularity: 'month' })
    expect(w.get('[data-act="all-accounts"]').attributes('data-on')).toBe('true')
    expect(w.get('[data-state="table"]').attributes('data-mode')).toBe('all')
    const head = w.get('[data-row="period-head"]')
    expect(head.get('[data-part="total"]').text()).toBe('657,654,150')
    const rows = w.findAll('[data-row="period-account"]')
    expect(rows.map((r) => r.attributes('data-account-key'))).toEqual(['claude/slot-a', 'codex/__default__', 'claude/unknown'])
    expect(rows[0].get('[data-part="account"]').text()).toContain('services@x.dev')
    expect(rows[0].get('[data-part="share"]').text()).toBe('66%')
    expect(rows[1].get('[data-part="account"]').text()).toContain('Codex')
    expect(rows[1].get('[data-part="share"]').text()).toBe('31%')
    expect(rows[2].classes()).toContain('unknown')
    expect(rows[2].get('[data-part="exhausted"]').text()).toBe('—')
    // The chart stacks the three accounts into the one bar.
    const chart = w.get('[data-part="period-chart"]')
    expect(chart.findAll('[data-part="bar"]')).toHaveLength(1)
    expect(chart.findAll('[data-part="segment"]')).toHaveLength(3)
    expect(chart.findAll('[data-part="legend-item"]')).toHaveLength(3)
  })

  it('an empty period answer shows the empty state and disables export', async () => {
    wire.periods = { ...periodsAnswer(), rows: [], totals_by_period: [] }
    const w = await mountView()
    await w.get('[data-act="tab"][data-tab="month"]').trigger('click')
    await flushPromises()
    expect(w.get('[data-state="empty"]').text()).toBe(i18n.global.t('quota-cycles.empty-periods'))
    expect(w.get('[data-act="export"]').attributes('disabled')).toBeDefined()
  })

  it('builds a periods CSV with the account name beside its id', async () => {
    const w = await mountView()
    const csv = (w.vm as unknown as { buildPeriodsCsv: (rows: AccountPeriodRow[]) => string }).buildPeriodsCsv([periodRow()])
    const lines = csv.trimEnd().split('\n')
    expect(lines[0]).toBe('period,agent_key,profile_id,account,input,cache_read,cache_creation,output,total,calls,turns,cycles,exhausted,avg_total_exhausted,weekly_exhausted')
    expect(lines[1]).toBe(`2026-09,claude,slot-a,slot-a · ${i18n.global.t('account-dim.removed')},61204,412880113,15102441,5210392,433254150,20318,2740,44,11,28500000,1`)
  })

  it('never leaks a raw i18n key on any tab, in either locale', async () => {
    for (const locale of ['en-US', 'zh-TW'] as const) {
      i18n.global.locale.value = locale
      const w = await mountView()
      for (const tab of ['month', 'year', 'cycle']) {
        await w.get(`[data-act="tab"][data-tab="${tab}"]`).trigger('click')
        await flushPromises()
        expect(w.text()).not.toMatch(/(turn-stats|account-dim|quota-cycles)\.[a-z-]+/)
      }
      w.unmount()
    }
  })
})
