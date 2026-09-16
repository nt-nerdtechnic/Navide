<script setup lang="ts">
// Quota cycles of one account — the right half of the Turn Stats modal when
// an account (not a pane) is picked on the left. Three tabs: the account's
// quota windows one per row (what a 5h / weekly window cost from reset to
// reset, how far it got, whether it ran out), and its monthly / yearly totals
// with the cycle counts folded in. Every tab draws its chart above the table.
//
// It owns no data: the backend keeps the cycles (`tokens.quota_cycles`) and
// the period ledger (`tokens.account_periods`); both composables refetch on
// `tokens.quota_cycles_changed`.
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { CLI_AGENT_SPECS } from '@navide/plugin-shell'
import type { useBackend } from '../composables/useBackend'
import type { useCliProfiles } from '../composables/useCliProfiles'
import { useQuotaCycles, type QuotaCycle } from '../composables/useQuotaCycles'
import { useAccountPeriods, type AccountPeriodRow, type PeriodGranularity } from '../composables/useAccountPeriods'
import type { UsageSnapshot } from '../composables/useUsage'
import { UNKNOWN_PROFILE_ID, accountKey, accountLabel as resolveAccountLabel, accountTint } from '../lib/accountLabel'
import BarsWithLine from './charts/BarsWithLine.vue'
import StackedBars from './charts/StackedBars.vue'

const props = defineProps<{
  backend: ReturnType<typeof useBackend>
  agentKey: string
  profileId: string
  /** The account's display name, resolved by the host. */
  label: string
  vendorLabel: string
  /** True when this account is the one the agent runs on right now. */
  active: boolean
  /** The account's own quota snapshot, for the window labels and its clock. */
  usage?: UsageSnapshot
  /** Names the other accounts in the all-accounts breakdown. */
  cliProfiles?: ReturnType<typeof useCliProfiles>
}>()

const { t } = useI18n()

type Tab = 'cycle' | 'month' | 'year'
const tab = ref<Tab>('cycle')
const showChart = ref(true)

// ── Formatting ──────────────────────────────────────────────────────────────
function num(n: number | null | undefined): string {
  return n === null || n === undefined ? '—' : n.toLocaleString('en-US')
}
function compact(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + 'k'
  if (n < 1_000_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  return (n / 1_000_000_000).toFixed(1) + 'B'
}
function pct(n: number | null): string {
  return n === null ? '—' : `${Math.round(n)}%`
}
const two = (v: number): string => String(v).padStart(2, '0')
/** "9/16 17:20" — the cycle table's clock. */
function stamp(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${d.getMonth() + 1}/${d.getDate()} ${two(d.getHours())}:${two(d.getMinutes())}`
}
function clock(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${two(d.getHours())}:${two(d.getMinutes())}`
}
function csvCell(v: string | number | null | undefined): string {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
function download(name: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

// ── Cycles ──────────────────────────────────────────────────────────────────
const cyclesApi = useQuotaCycles(props.backend)
const cycles = computed<QuotaCycle[]>(() => cyclesApi.data.value?.cycles ?? [])

// The window kinds this account has cycles for, headline kinds first so the
// chip row reads the way the badge's windows do. A snapshot with several
// windows of one kind (Claude's per-model weekly buckets) keys each as
// "<kind>:<label>" so they stay separate cycles; the base kind (before the
// colon) orders them and finds the provider's label.
const KIND_ORDER = ['session', 'weekly', 'weekly-model', 'monthly', 'cycle']
function baseKind(kind: string): string {
  const i = kind.indexOf(':')
  return i === -1 ? kind : kind.slice(0, i)
}
const windowKinds = computed<string[]>(() => {
  const kinds = [...new Set(cycles.value.map((c) => c.window_kind))]
  const rank = (k: string): number => {
    const i = KIND_ORDER.indexOf(baseKind(k))
    return i === -1 ? KIND_ORDER.length : i
  }
  return kinds.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
})
const windowKind = ref('')
watch(windowKinds, (kinds) => {
  if (!kinds.includes(windowKind.value)) windowKind.value = kinds[0] ?? ''
}, { immediate: true })
/** The provider's own label for a window kind when the snapshot carries it
 *  ("Session (5h)"; for "weekly-model:Fable only" the bucket whose label is
 *  "Fable only"), else the label part of the key, else the kind itself. */
function kindLabel(kind: string): string {
  const base = baseKind(kind)
  const suffix = kind.slice(base.length + 1)
  const windows = props.usage?.windows ?? []
  const match = windows.find((w) => w.kind === base && (!suffix || w.label === suffix)) ?? (suffix ? undefined : windows.find((w) => w.kind === base))
  return match?.label ?? (suffix || kind)
}
/** Newest first, as the backend sorts. */
const kindCycles = computed(() => cycles.value.filter((c) => c.window_kind === windowKind.value))
const kindSummary = computed(() => cyclesApi.data.value?.summary?.[windowKind.value] ?? null)

/** A closed cycle from before token slices were kept has quota samples but
 *  no spend behind them: every token figure is 0 and must read as "no
 *  detail", not as a free window. An open cycle at 0 has simply not spent. */
function noDetail(c: QuotaCycle): boolean {
  return c.closed && c.total === 0 && c.calls === 0 && c.turns === 0
}
function cell(c: QuotaCycle, value: number): string {
  return noDetail(c) ? '—' : num(value)
}

type CycleSum = { max_percent: number; input: number; cache_read: number; cache_creation: number; output: number; total: number; calls: number; turns: number; count: number; detailed: number }
/** Column-wise average of the cycles that ran out — the only ones that say
 *  what "100%" is; an unfinished window would pull the estimate down. The
 *  token columns average only the cycles that carry detail; the peak and
 *  the count cover every exhausted cycle. */
const exhaustedAverage = computed<CycleSum | null>(() => {
  const spent = kindCycles.value.filter((c) => c.exhausted_at !== null)
  if (spent.length === 0) return null
  const detailed = spent.filter((c) => !noDetail(c))
  const sum: CycleSum = { max_percent: 0, input: 0, cache_read: 0, cache_creation: 0, output: 0, total: 0, calls: 0, turns: 0, count: spent.length, detailed: detailed.length }
  for (const c of spent) sum.max_percent += c.max_percent
  for (const c of detailed) {
    sum.input += c.input
    sum.cache_read += c.cache_read
    sum.cache_creation += c.cache_creation
    sum.output += c.output
    sum.total += c.total
    sum.calls += c.calls
    sum.turns += c.turns
  }
  const n = Math.max(1, detailed.length)
  return {
    max_percent: sum.max_percent / spent.length,
    input: Math.round(sum.input / n),
    cache_read: Math.round(sum.cache_read / n),
    cache_creation: Math.round(sum.cache_creation / n),
    output: Math.round(sum.output / n),
    total: Math.round(sum.total / n),
    calls: Math.round(sum.calls / n),
    turns: Math.round(sum.turns / n),
    count: spent.length,
    detailed: detailed.length,
  }
})
function avgCell(value: number): string {
  return exhaustedAverage.value && exhaustedAverage.value.detailed > 0 ? num(value) : '—'
}
/** Tokens per percent point: how much the window is worth at this spend
 *  mix. Stable across cycles = the capacity estimate can be trusted. */
function perPercent(total: number, maxPercent: number): string {
  return maxPercent > 0 && total > 0 ? compact(Math.round(total / maxPercent)) : '—'
}
/** The backend's average is 0.0 (not null) when the exhausted cycles carry
 *  no detail; either way there is nothing to print. */
const summaryAvg = computed<number | null>(() => {
  const avg = kindSummary.value?.avg_total_exhausted ?? null
  return avg ? avg : null
})

/** Oldest on the left. */
const cycleBars = computed(() =>
  [...kindCycles.value].reverse().map((c) => ({
    label: stamp(c.started_at ?? c.resets_at),
    note: !c.closed ? t('quota-cycles.in-progress') : noDetail(c) ? t('quota-cycles.no-detail-short') : undefined,
    value: c.total,
    percent: c.max_percent,
    exhausted: c.exhausted_at !== null,
  }))
)
const selectedCycle = ref<number | null>(null)
function onCycleSelect(barIndex: number): void {
  // The chart is oldest-first; the table newest-first.
  const rowIndex = kindCycles.value.length - 1 - barIndex
  selectedCycle.value = selectedCycle.value === rowIndex ? null : rowIndex
}
const selectedCycleBar = computed(() =>
  selectedCycle.value === null ? null : kindCycles.value.length - 1 - selectedCycle.value
)

const CYCLE_CSV = ['window_kind', 'started_at', 'resets_at', 'closed', 'max_percent', 'exhausted_at', 'input', 'cache_read', 'cache_creation', 'output', 'total', 'calls', 'turns', 'samples']
function buildCyclesCsv(rows: QuotaCycle[]): string {
  const lines = [CYCLE_CSV.join(',')]
  for (const c of rows) {
    lines.push(
      [c.window_kind, c.started_at, c.resets_at, c.closed ? 1 : 0, c.max_percent, c.exhausted_at, c.input, c.cache_read, c.cache_creation, c.output, c.total, c.calls, c.turns, c.samples]
        .map(csvCell)
        .join(',')
    )
  }
  return lines.join('\n') + '\n'
}

// ── Periods (month / year) ──────────────────────────────────────────────────
const periodsApi = useAccountPeriods(props.backend)
/** When on, the period tabs show every account of every vendor, with each
 *  period's share per account. */
const allAccounts = ref(false)
const granularity = computed<PeriodGranularity | null>(() =>
  tab.value === 'month' ? 'month' : tab.value === 'year' ? 'year' : null
)
const periodRows = computed<AccountPeriodRow[]>(() => periodsApi.data.value?.rows ?? [])
const periodTotals = computed(() => periodsApi.data.value?.totals_by_period ?? [])

/** "2026-09" / "2026" for now, so the open period can be marked. */
function currentPeriod(g: PeriodGranularity): string {
  const d = new Date()
  return g === 'month' ? `${d.getFullYear()}-${two(d.getMonth() + 1)}` : String(d.getFullYear())
}
function periodOpen(period: string): boolean {
  return granularity.value !== null && period === currentPeriod(granularity.value)
}
function rowAccountLabel(row: AccountPeriodRow): string {
  return resolveAccountLabel(props.cliProfiles, row.agent_key, row.profile_id, t)
}
const VENDOR_LABEL: Record<string, string> = Object.fromEntries(CLI_AGENT_SPECS.map((s) => [s.agentKey, s.label]))
function rowVendorLabel(agentKey: string): string {
  return agentKey === props.agentKey ? props.vendorLabel : VENDOR_LABEL[agentKey] ?? agentKey
}

/** All-accounts view: the periods newest first, each with its rows (largest
 *  first, as the backend sorts) and the period's total for the share column. */
const periodGroups = computed(() => {
  const totals = new Map(periodTotals.value.map((p) => [p.period, p]))
  const byPeriod = new Map<string, AccountPeriodRow[]>()
  for (const row of periodRows.value) {
    const list = byPeriod.get(row.period)
    if (list) list.push(row)
    else byPeriod.set(row.period, [row])
  }
  return [...byPeriod.entries()].map(([period, rows]) => {
    const total = totals.get(period)
    const sum = rows.reduce((acc, r) => acc + r.total, 0)
    return {
      period,
      rows,
      total: total?.total ?? sum,
      calls: total?.calls ?? rows.reduce((acc, r) => acc + r.calls, 0),
      turns: total?.turns ?? rows.reduce((acc, r) => acc + r.turns, 0),
      exhausted: rows.reduce((acc, r) => acc + r.exhausted, 0),
      weeklyExhausted: rows.reduce((acc, r) => acc + r.weekly_exhausted, 0),
    }
  })
})
function share(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—'
}

/** Oldest on the left; one segment per account (one account = one segment). */
const periodBars = computed(() => {
  const groups = [...periodGroups.value].reverse()
  return groups.map((g) => ({
    label: g.period,
    note: periodOpen(g.period) ? t('quota-cycles.in-progress') : undefined,
    segments: g.rows.map((r) => ({
      key: accountKey(r.agent_key, r.profile_id),
      label: rowAccountLabel(r),
      value: r.total,
      color: accountTint(r.profile_id),
    })),
  }))
})
const selectedPeriod = ref<string | null>(null)
function onPeriodSelect(barIndex: number): void {
  const period = [...periodGroups.value].reverse()[barIndex]?.period ?? null
  selectedPeriod.value = selectedPeriod.value === period ? null : period
}
const selectedPeriodBar = computed(() => {
  if (selectedPeriod.value === null) return null
  const i = [...periodGroups.value].reverse().findIndex((g) => g.period === selectedPeriod.value)
  return i === -1 ? null : i
})

const PERIOD_CSV = ['period', 'agent_key', 'profile_id', 'account', 'input', 'cache_read', 'cache_creation', 'output', 'total', 'calls', 'turns', 'cycles', 'exhausted', 'avg_total_exhausted', 'weekly_exhausted']
function buildPeriodsCsv(rows: AccountPeriodRow[]): string {
  const lines = [PERIOD_CSV.join(',')]
  for (const r of rows) {
    lines.push(
      [r.period, r.agent_key, r.profile_id, rowAccountLabel(r), r.input, r.cache_read, r.cache_creation, r.output, r.total, r.calls, r.turns, r.cycles, r.exhausted, r.avg_total_exhausted, r.weekly_exhausted]
        .map(csvCell)
        .join(',')
    )
  }
  return lines.join('\n') + '\n'
}

// ── Loading ─────────────────────────────────────────────────────────────────
// The cycles follow the account; the periods follow the account, the tab
// and the all-accounts switch. Each load drops the previous answer first so
// another account's rows never sit under this account's name.
watch(
  [() => props.agentKey, () => props.profileId],
  ([agentKey, profileId]) => {
    selectedCycle.value = null
    cyclesApi.clear()
    if (profileId === UNKNOWN_PROFILE_ID) return
    void cyclesApi.load({ agentKey, profileId })
  },
  { immediate: true }
)
watch(
  [() => props.agentKey, () => props.profileId, granularity, allAccounts],
  ([agentKey, profileId, g, all]) => {
    selectedPeriod.value = null
    periodsApi.clear()
    if (!g) return
    void periodsApi.load(all ? { granularity: g } : { agentKey, profileId, granularity: g })
  },
  { immediate: true }
)

function exportCsv(): void {
  const stem = `${props.agentKey}-${props.profileId.slice(0, 8)}`
  if (tab.value === 'cycle') {
    if (kindCycles.value.length === 0) return
    download(`quota-cycles-${stem}-${windowKind.value}.csv`, buildCyclesCsv(kindCycles.value))
    return
  }
  if (periodRows.value.length === 0) return
  download(`account-${tab.value}-${allAccounts.value ? 'all' : stem}.csv`, buildPeriodsCsv(periodRows.value))
}
const canExport = computed(() => (tab.value === 'cycle' ? kindCycles.value.length > 0 : periodRows.value.length > 0))

const cyclesPanel = computed<'unknown' | 'loading' | 'error' | 'empty' | 'table'>(() => {
  if (props.profileId === UNKNOWN_PROFILE_ID) return 'unknown'
  if (cyclesApi.loading.value && !cyclesApi.data.value) return 'loading'
  if (cyclesApi.error.value) return 'error'
  if (kindCycles.value.length === 0) return 'empty'
  return 'table'
})
const periodsPanel = computed<'loading' | 'error' | 'empty' | 'table'>(() => {
  if (periodsApi.loading.value && !periodsApi.data.value) return 'loading'
  if (periodsApi.error.value) return 'error'
  if (periodRows.value.length === 0) return 'empty'
  return 'table'
})
function errorText(code: string): string {
  if (code === 'unknown-vendor') return t('quota-cycles.error-unknown-vendor')
  return t('quota-cycles.error-generic', { detail: code })
}

defineExpose({ buildCyclesCsv, buildPeriodsCsv })
</script>

<template>
  <div class="qc-view" data-part="quota-cycles">
    <div class="qc-toolbar">
      <span class="qc-account" data-part="account-name" :title="profileId">{{ label }}</span>
      <span class="qc-vendor" data-part="vendor">· {{ vendorLabel }}</span>
      <span v-if="profileId !== UNKNOWN_PROFILE_ID" class="qc-active" :class="{ on: active }" data-part="active">
        {{ active ? t('account-dim.active') : t('account-dim.inactive') }}
      </span>
      <span v-if="usage?.fetchedAt" class="qc-asof" data-part="as-of">
        {{ usage.stale ? t('turn-stats.quota-as-of-stale', { time: clock(usage.fetchedAt) }) : t('turn-stats.quota-as-of', { time: clock(usage.fetchedAt) }) }}
      </span>
      <span class="qc-spacer" />
      <button class="qc-ghost" data-act="export" :disabled="!canExport" @click="exportCsv">{{ t('turn-stats.export') }}</button>
    </div>

    <div class="qc-tabs" role="tablist">
      <button
        v-for="name in (['cycle', 'month', 'year'] as Tab[])"
        :key="name"
        type="button"
        role="tab"
        class="qc-tab"
        data-act="tab"
        :data-tab="name"
        :class="{ on: tab === name }"
        :aria-selected="tab === name ? 'true' : 'false'"
        @click="tab = name"
      >{{ t(`quota-cycles.tab-${name}`) }}</button>
      <span class="qc-spacer" />
      <template v-if="tab === 'cycle' && windowKinds.length">
        <button
          v-for="kind in windowKinds"
          :key="kind"
          type="button"
          class="qc-chip"
          data-act="window-chip"
          :data-kind="kind"
          :class="{ on: windowKind === kind }"
          @click="windowKind = kind"
        >{{ kindLabel(kind) }}</button>
      </template>
      <button
        v-else-if="tab !== 'cycle'"
        type="button"
        class="qc-chip"
        data-act="all-accounts"
        :data-on="allAccounts ? 'true' : 'false'"
        :class="{ on: allAccounts }"
        @click="allAccounts = !allAccounts"
      >{{ t('quota-cycles.all-accounts') }}</button>
    </div>

    <!-- ── Cycles ─────────────────────────────────────────────────────────── -->
    <template v-if="tab === 'cycle'">
      <div v-if="cyclesPanel === 'table' && kindSummary" class="qc-summary" data-part="cycle-summary">
        {{ t('quota-cycles.summary', { cycles: kindSummary.cycles, exhausted: kindSummary.exhausted }) }}
        <template v-if="summaryAvg !== null">
          · {{ t('quota-cycles.summary-avg', { total: compact(summaryAvg) }) }}
        </template>
      </div>
      <div v-if="cyclesPanel === 'table'" class="qc-chart" data-part="cycle-chart">
        <button class="qc-chart-toggle" data-act="toggle-chart" :aria-expanded="showChart ? 'true' : 'false'" @click="showChart = !showChart">
          <span class="qc-caret">{{ showChart ? '▾' : '▸' }}</span>{{ t('quota-cycles.chart-cycles') }}
          <span class="qc-hint">{{ t('quota-cycles.chart-cycles-hint') }}</span>
        </button>
        <BarsWithLine
          v-if="showChart"
          :bars="cycleBars"
          :value-format="compact"
          :selected="selectedCycleBar"
          :ariaLabel="t('quota-cycles.chart-cycles')"
          :empty-text="t('quota-cycles.empty')"
          @select="onCycleSelect"
        />
      </div>
      <div class="qc-body">
        <p v-if="cyclesPanel === 'unknown'" class="qc-empty" data-state="unknown">{{ t('quota-cycles.unknown-account') }}</p>
        <p v-else-if="cyclesPanel === 'loading'" class="qc-empty" data-state="loading">{{ t('turn-stats.scanning') }}</p>
        <p v-else-if="cyclesPanel === 'error'" class="qc-empty qc-error" data-state="error">{{ errorText(cyclesApi.error.value) }}</p>
        <p v-else-if="cyclesPanel === 'empty'" class="qc-empty" data-state="empty">{{ t('quota-cycles.empty') }}</p>
        <table v-else class="qc-table" data-state="table">
          <thead>
            <tr>
              <th class="c-period">{{ t('quota-cycles.col-cycle') }}</th>
              <th class="c-num">{{ t('quota-cycles.col-max') }}</th>
              <th class="c-when">{{ t('quota-cycles.col-exhausted') }}</th>
              <th class="c-num">{{ t('turn-stats.col-input') }}</th>
              <th class="c-num">{{ t('turn-stats.col-cache-read') }}</th>
              <th class="c-num">{{ t('turn-stats.col-cache-write') }}</th>
              <th class="c-num">{{ t('turn-stats.col-output') }}</th>
              <th class="c-num c-total">{{ t('turn-stats.col-total') }}</th>
              <th class="c-num">{{ t('turn-stats.col-calls') }}</th>
              <th class="c-num">{{ t('quota-cycles.col-turns') }}</th>
              <th class="c-num">{{ t('quota-cycles.col-per-percent') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(c, i) in kindCycles"
              :key="`${c.window_kind}:${c.resets_at}`"
              class="qc-row"
              data-row="cycle"
              :data-index="i"
              :data-closed="c.closed ? 'true' : 'false'"
              :data-exhausted="c.exhausted_at !== null ? 'true' : 'false'"
              :data-no-detail="noDetail(c) ? 'true' : 'false'"
              :data-selected="selectedCycle === i ? 'true' : 'false'"
              :title="noDetail(c) ? t('quota-cycles.no-detail') : undefined"
              @click="selectedCycle = selectedCycle === i ? null : i"
            >
              <td class="c-period" data-part="cycle">
                {{ stamp(c.started_at) }} → {{ stamp(c.resets_at) }}
                <span v-if="!c.closed" class="qc-open" data-part="in-progress">{{ t('quota-cycles.in-progress') }}</span>
                <span v-else-if="noDetail(c)" class="qc-nodetail" data-part="no-detail">{{ t('quota-cycles.no-detail-short') }}</span>
              </td>
              <td class="c-num" data-part="max">{{ pct(c.max_percent) }}</td>
              <td class="c-when" data-part="exhausted">{{ c.exhausted_at ? clock(c.exhausted_at) : '—' }}</td>
              <td class="c-num" data-part="input">{{ cell(c, c.input) }}</td>
              <td class="c-num" data-part="cache-read">{{ cell(c, c.cache_read) }}</td>
              <td class="c-num" data-part="cache-write">{{ cell(c, c.cache_creation) }}</td>
              <td class="c-num" data-part="output">{{ cell(c, c.output) }}</td>
              <td class="c-num c-total" data-part="total">{{ cell(c, c.total) }}</td>
              <td class="c-num" data-part="calls">{{ cell(c, c.calls) }}</td>
              <td class="c-num" data-part="turns">{{ cell(c, c.turns) }}</td>
              <td class="c-num" data-part="per-percent">{{ perPercent(c.total, c.max_percent) }}</td>
            </tr>
          </tbody>
          <tfoot v-if="exhaustedAverage">
            <tr class="qc-avg" data-row="exhausted-average">
              <td class="c-period" :title="exhaustedAverage.detailed < exhaustedAverage.count ? t('quota-cycles.average-detailed', { detailed: exhaustedAverage.detailed }) : undefined">
                {{ t('quota-cycles.row-exhausted-average', { count: exhaustedAverage.count }) }}
                <span v-if="exhaustedAverage.detailed < exhaustedAverage.count" class="qc-nodetail" data-part="average-detailed">{{ t('quota-cycles.average-detailed', { detailed: exhaustedAverage.detailed }) }}</span>
              </td>
              <td class="c-num">{{ pct(exhaustedAverage.max_percent) }}</td>
              <td class="c-when" />
              <td class="c-num">{{ avgCell(exhaustedAverage.input) }}</td>
              <td class="c-num">{{ avgCell(exhaustedAverage.cache_read) }}</td>
              <td class="c-num">{{ avgCell(exhaustedAverage.cache_creation) }}</td>
              <td class="c-num">{{ avgCell(exhaustedAverage.output) }}</td>
              <td class="c-num c-total" data-part="total">{{ avgCell(exhaustedAverage.total) }}</td>
              <td class="c-num">{{ avgCell(exhaustedAverage.calls) }}</td>
              <td class="c-num">{{ avgCell(exhaustedAverage.turns) }}</td>
              <td class="c-num">{{ perPercent(exhaustedAverage.total, exhaustedAverage.max_percent) }}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div class="qc-foot"><span class="qc-foot-note" data-part="note">{{ t('quota-cycles.note') }}</span></div>
    </template>

    <!-- ── Month / year ───────────────────────────────────────────────────── -->
    <template v-else>
      <div v-if="periodsPanel === 'table'" class="qc-chart" data-part="period-chart">
        <button class="qc-chart-toggle" data-act="toggle-chart" :aria-expanded="showChart ? 'true' : 'false'" @click="showChart = !showChart">
          <span class="qc-caret">{{ showChart ? '▾' : '▸' }}</span>{{ t(`quota-cycles.chart-${tab}`) }}
          <span class="qc-hint">{{ t('quota-cycles.chart-periods-hint') }}</span>
        </button>
        <StackedBars
          v-if="showChart"
          :bars="periodBars"
          :value-format="compact"
          :selected="selectedPeriodBar"
          :ariaLabel="t(`quota-cycles.chart-${tab}`)"
          :empty-text="t('quota-cycles.empty-periods')"
          @select="onPeriodSelect"
        />
      </div>
      <div class="qc-body">
        <p v-if="periodsPanel === 'loading'" class="qc-empty" data-state="loading">{{ t('turn-stats.scanning') }}</p>
        <p v-else-if="periodsPanel === 'error'" class="qc-empty qc-error" data-state="error">{{ errorText(periodsApi.error.value) }}</p>
        <p v-else-if="periodsPanel === 'empty'" class="qc-empty" data-state="empty">{{ t('quota-cycles.empty-periods') }}</p>

        <!-- One account: a row per period. -->
        <table v-else-if="!allAccounts" class="qc-table" data-state="table" data-mode="single">
          <thead>
            <tr>
              <th class="c-period">{{ t(`quota-cycles.col-${tab}`) }}</th>
              <th class="c-num">{{ t('turn-stats.col-input') }}</th>
              <th class="c-num">{{ t('turn-stats.col-cache-read') }}</th>
              <th class="c-num">{{ t('turn-stats.col-cache-write') }}</th>
              <th class="c-num">{{ t('turn-stats.col-output') }}</th>
              <th class="c-num c-total">{{ t('turn-stats.col-total') }}</th>
              <th class="c-num">{{ t('turn-stats.col-calls') }}</th>
              <th class="c-num">{{ t('quota-cycles.col-turns') }}</th>
              <th class="c-num">{{ t('quota-cycles.col-cycles') }}</th>
              <th class="c-num">{{ t('quota-cycles.col-exhausted-count') }}</th>
              <th class="c-num">{{ t('quota-cycles.col-avg-exhausted') }}</th>
              <th class="c-num">{{ t('quota-cycles.col-weekly-exhausted') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="r in periodRows"
              :key="`${r.period}:${r.agent_key}:${r.profile_id}`"
              class="qc-row"
              data-row="period"
              :data-period="r.period"
              :data-selected="selectedPeriod === r.period ? 'true' : 'false'"
              @click="selectedPeriod = selectedPeriod === r.period ? null : r.period"
            >
              <td class="c-period" data-part="period">
                {{ r.period }}
                <span v-if="periodOpen(r.period)" class="qc-open" data-part="in-progress">{{ t('quota-cycles.in-progress') }}</span>
              </td>
              <td class="c-num" data-part="input">{{ num(r.input) }}</td>
              <td class="c-num" data-part="cache-read">{{ num(r.cache_read) }}</td>
              <td class="c-num" data-part="cache-write">{{ num(r.cache_creation) }}</td>
              <td class="c-num" data-part="output">{{ num(r.output) }}</td>
              <td class="c-num c-total" data-part="total">{{ num(r.total) }}</td>
              <td class="c-num" data-part="calls">{{ num(r.calls) }}</td>
              <td class="c-num" data-part="turns">{{ num(r.turns) }}</td>
              <td class="c-num" data-part="cycles">{{ num(r.cycles) }}</td>
              <td class="c-num" data-part="exhausted">{{ num(r.exhausted) }}</td>
              <td class="c-num" data-part="avg-exhausted">{{ r.avg_total_exhausted ? compact(r.avg_total_exhausted) : '—' }}</td>
              <td class="c-num" data-part="weekly-exhausted">{{ num(r.weekly_exhausted) }}</td>
            </tr>
          </tbody>
        </table>

        <!-- Every account: the periods, each with its accounts' shares. -->
        <table v-else class="qc-table" data-state="table" data-mode="all">
          <thead>
            <tr>
              <th class="c-period">{{ t('quota-cycles.col-account') }}</th>
              <th class="c-num c-total">{{ t('turn-stats.col-total') }}</th>
              <th class="c-num">{{ t('quota-cycles.col-share') }}</th>
              <th class="c-num">{{ t('turn-stats.col-calls') }}</th>
              <th class="c-num">{{ t('quota-cycles.col-turns') }}</th>
              <th class="c-num">{{ t('quota-cycles.col-exhausted-count') }}</th>
              <th class="c-num">{{ t('quota-cycles.col-weekly-exhausted') }}</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="g in periodGroups" :key="g.period">
              <tr class="qc-period-head" data-row="period-head" :data-period="g.period" :data-selected="selectedPeriod === g.period ? 'true' : 'false'">
                <td class="c-period" data-part="period">
                  {{ g.period }}
                  <span v-if="periodOpen(g.period)" class="qc-open" data-part="in-progress">{{ t('quota-cycles.in-progress') }}</span>
                </td>
                <td class="c-num c-total" data-part="total">{{ num(g.total) }}</td>
                <td class="c-num">100%</td>
                <td class="c-num" data-part="calls">{{ num(g.calls) }}</td>
                <td class="c-num" data-part="turns">{{ num(g.turns) }}</td>
                <td class="c-num" data-part="exhausted">{{ num(g.exhausted) }}</td>
                <td class="c-num" data-part="weekly-exhausted">{{ num(g.weeklyExhausted) }}</td>
              </tr>
              <tr
                v-for="r in g.rows"
                :key="`${r.period}:${r.agent_key}:${r.profile_id}`"
                class="qc-row qc-account-row"
                data-row="period-account"
                :data-period="r.period"
                :data-account-key="accountKey(r.agent_key, r.profile_id)"
                :class="{ unknown: r.profile_id === UNKNOWN_PROFILE_ID }"
              >
                <td class="c-period c-account" data-part="account" :title="`${r.agent_key} · ${r.profile_id}`">
                  <span class="qc-swatch" :style="{ background: accountTint(r.profile_id) }" aria-hidden="true" />
                  {{ rowAccountLabel(r) }}<span class="qc-vendor-sub"> · {{ rowVendorLabel(r.agent_key) }}</span>
                </td>
                <td class="c-num c-total" data-part="total">{{ num(r.total) }}</td>
                <td class="c-num" data-part="share">{{ share(r.total, g.total) }}</td>
                <td class="c-num" data-part="calls">{{ num(r.calls) }}</td>
                <td class="c-num" data-part="turns">{{ num(r.turns) }}</td>
                <td class="c-num" data-part="exhausted">{{ r.profile_id === UNKNOWN_PROFILE_ID ? '—' : num(r.exhausted) }}</td>
                <td class="c-num" data-part="weekly-exhausted">{{ r.profile_id === UNKNOWN_PROFILE_ID ? '—' : num(r.weekly_exhausted) }}</td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
      <div class="qc-foot"><span class="qc-foot-note" data-part="note">{{ t('quota-cycles.periods-note') }}</span></div>
    </template>
  </div>
</template>

<style scoped>
.qc-view {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  color: var(--text-secondary);
  font-size: var(--font-xs);
  overflow: hidden;
}
.qc-spacer { flex: 1; }

.qc-toolbar {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border-muted);
}
.qc-account {
  color: var(--text-bright);
  font-weight: 600;
  font-size: var(--font-sm);
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.qc-vendor { color: var(--text-muted); }
.qc-active {
  padding: 0 6px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border-muted);
  font-size: var(--font-3xs);
  color: var(--text-muted);
}
.qc-active.on {
  color: var(--success-fg);
  border-color: var(--success-muted);
  background: var(--success-subtle);
}
.qc-asof { font-size: var(--font-3xs); color: var(--text-muted); }
.qc-ghost {
  padding: 4px 10px;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  cursor: pointer;
}
.qc-ghost:hover { color: var(--text-bright); }
.qc-ghost:disabled { color: var(--text-disabled); cursor: default; }

.qc-tabs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 6px 16px;
  border-bottom: 1px solid var(--border-muted);
}
.qc-tab {
  padding: 4px 10px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  font-weight: 600;
  cursor: pointer;
}
.qc-tab:hover { color: var(--text-bright); }
.qc-tab.on { color: var(--accent-fg); border-bottom-color: var(--accent-emphasis); }
.qc-chip {
  padding: 2px 10px;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  cursor: pointer;
  white-space: nowrap;
}
.qc-chip:hover { color: var(--text-bright); border-color: var(--border-default); }
.qc-chip.on {
  background: var(--accent-subtle);
  border-color: var(--accent-muted);
  color: var(--accent-fg);
}

.qc-summary {
  padding: 8px 16px;
  border-bottom: 1px solid var(--border-muted);
  color: var(--text-bright);
  font-weight: 600;
  font-size: var(--font-sm);
  font-variant-numeric: tabular-nums;
}

.qc-chart {
  padding: 6px 16px;
  border-bottom: 1px solid var(--border-muted);
}
.qc-chart-toggle {
  display: flex;
  align-items: baseline;
  gap: 6px;
  width: 100%;
  padding: 2px 0;
  border: 0;
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}
.qc-chart-toggle:hover { color: var(--text-bright); }
.qc-caret { color: var(--text-muted); }
.qc-hint { color: var(--text-muted); font-weight: 400; font-size: var(--font-3xs); }

.qc-body {
  flex: 1 1 auto;
  min-height: 120px;
  overflow: auto;
}
.qc-empty {
  margin: 0;
  padding: 24px 16px;
  color: var(--text-muted);
  text-align: center;
}
.qc-error { color: var(--attention-fg); }

.qc-table {
  width: 100%;
  border-collapse: collapse;
  font-variant-numeric: tabular-nums;
}
.qc-table th,
.qc-table td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--border-muted);
  white-space: nowrap;
}
.qc-table th {
  position: sticky;
  top: 0;
  background: var(--bg-subtle);
  color: var(--text-muted);
  font-weight: 400;
  font-size: var(--font-3xs);
  text-align: left;
}
.qc-table th:first-child,
.qc-table td:first-child { padding-left: 16px; }
.qc-table th:last-child,
.qc-table td:last-child { padding-right: 16px; }
.c-period { color: var(--text-primary); }
.c-when { width: 7ch; color: var(--text-muted); }
.qc-table th.c-num,
.qc-table td.c-num { text-align: right; }
.c-total { color: var(--text-bright); font-weight: 600; }
.qc-row { cursor: pointer; }
.qc-row:hover { background: var(--bg-hover-faint); }
.qc-row[data-selected='true'] { background: var(--bg-selected); }
.qc-row[data-exhausted='true'] .c-when { color: var(--danger-fg); font-weight: 600; }
.qc-open {
  margin-left: 6px;
  padding: 0 6px;
  border-radius: var(--radius-pill);
  background: var(--accent-subtle);
  color: var(--accent-fg);
  font-size: var(--font-3xs);
}
.qc-nodetail {
  margin-left: 6px;
  color: var(--text-muted);
  font-size: var(--font-3xs);
  font-style: italic;
}
.qc-row[data-no-detail='true'] .c-num { color: var(--text-muted); }
.qc-avg td {
  border-top: 1px solid var(--border-default);
  border-bottom: 0;
  color: var(--text-bright);
  font-weight: 600;
  background: var(--bg-subtle);
}
.qc-period-head td {
  background: var(--bg-subtle);
  color: var(--text-bright);
  font-weight: 600;
}
.qc-period-head[data-selected='true'] td { background: var(--bg-selected); }
.qc-account-row .c-account { padding-left: 28px; }
.qc-account-row.unknown .c-account { color: var(--text-muted); font-style: italic; }
.qc-swatch {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 6px;
  border-radius: 2px;
  vertical-align: middle;
}
.qc-vendor-sub { color: var(--text-muted); font-size: var(--font-3xs); }

.qc-foot {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 8px 16px;
  border-top: 1px solid var(--border-muted);
  background: var(--bg-subtle);
  font-size: var(--font-3xs);
  color: var(--text-muted);
}
.qc-foot-note { line-height: 1.45; }
</style>
