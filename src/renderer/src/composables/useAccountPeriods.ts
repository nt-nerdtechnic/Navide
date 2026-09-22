import { onScopeDispose, ref } from 'vue'
import type { useBackend } from './useBackend'

// Monthly / yearly totals per account, joined with that period's quota
// cycles (how many, how many ran out, the average spend of the ones that
// did). Fetched over `tokens.account_periods`; asked without an account it
// answers every account, which is what the "all accounts" view shows.
// Refetched on `tokens.quota_cycles_changed` the same way quota cycles are —
// a closed cycle changes the period's cycle counts.

export type PeriodGranularity = 'month' | 'year'

export interface AccountPeriodRow {
  /** "2026-09" for a month, "2026" for a year. */
  period: string
  agent_key: string
  profile_id: string
  input: number | null
  cache_read: number | null
  cache_creation: number | null
  output: number | null
  total: number | null
  calls: number | null
  turns: number | null
  /** Selected-window cycles; without a window filter, nonweekly cycles. */
  cycles: number
  exhausted: number
  avg_total_exhausted: number | null
  weekly_exhausted: number
  period_start?: string
  period_end?: string
  coverage_state?: 'available' | 'partial' | 'unavailable'
  coverage_reason?: string | null
  detail_known?: boolean
  recorded_totals?: Record<string, number>
  eligible_count?: number
  excluded_count?: number
  exclusions?: Record<string, number>
}

export interface PeriodTotal {
  period: string
  total: number | null
  calls: number | null
  turns: number | null
  coverage_state?: 'available' | 'partial' | 'unavailable'
  detail_known?: boolean
}

export interface AccountPeriodsResult {
  ok: true
  granularity: PeriodGranularity
  /** period newest first; within a period by total, largest first. */
  rows: AccountPeriodRow[]
  totals_by_period: PeriodTotal[]
  calendar_timezone?: string
  token_time_key?: string
  cycle_time_key?: string
  refreshed_at?: string
  total_count?: number
  next_offset?: number | null
  effective_range_start?: string
  effective_range_end?: string
  summary?: { eligible_count?: number; excluded_count?: number; avg_total_exhausted?: number | null; cycles?: number }
}

interface AccountPeriodsFailure {
  ok: false
  error: string
}

export interface AccountPeriodsTarget {
  agentKey?: string
  profileId?: string
  granularity: PeriodGranularity
  rangeStart?: string
  rangeEnd?: string
  windowKind?: string
  offset?: number
}

export function useAccountPeriods(backend: ReturnType<typeof useBackend>) {
  const data = ref<AccountPeriodsResult | null>(null)
  const loading = ref(false)
  const error = ref('')
  let loadSeq = 0
  let current: AccountPeriodsTarget | null = null

  async function query(target: AccountPeriodsTarget, exporting = false): Promise<AccountPeriodsResult> {
    const resp = await backend.send<AccountPeriodsResult | AccountPeriodsFailure>('tokens.account_periods', {
      agent_key: target.agentKey || undefined, profile_id: target.profileId || undefined,
      granularity: target.granularity, range_start: target.rangeStart, range_end: target.rangeEnd,
      window_kind: target.windowKind || undefined, offset: exporting ? 0 : target.offset,
      limit: 50, export: exporting || undefined
    })
    if (!resp.ok || !resp.payload) throw new Error(resp.error?.code || resp.error?.message || 'load-failed')
    if (resp.payload.ok === false) throw new Error(resp.payload.error || 'load-failed')
    return resp.payload
  }

  async function load(target: AccountPeriodsTarget): Promise<void> {
    if (current && (current.agentKey !== target.agentKey || current.profileId !== target.profileId || current.granularity !== target.granularity || current.windowKind !== target.windowKind || current.rangeStart !== target.rangeStart || current.rangeEnd !== target.rangeEnd)) data.value = null
    current = target
    const seq = ++loadSeq
    loading.value = true
    error.value = ''
    try {
      const result = await query(target)
      if (seq !== loadSeq) return
      data.value = result
    } catch (err) {
      if (seq !== loadSeq) return
      error.value = String((err as Error).message ?? err)
    } finally {
      if (seq === loadSeq) loading.value = false
    }
  }

  function clear(): void {
    loadSeq++
    current = null
    data.value = null
    loading.value = false
    error.value = ''
  }

  // An unfiltered load covers every account, so any change refetches it; a
  // filtered one only follows its own account.
  const unsub = backend.on('tokens.quota_cycles_changed', (raw) => {
    const ev = raw as { agent_key?: string; profile_id?: string } | null
    if (!ev || !current) return
    if (current.agentKey && ev.agent_key !== current.agentKey) return
    if (current.profileId && ev.profile_id !== current.profileId) return
    void load(current)
  })
  onScopeDispose(() => unsub())

  async function exportAll(): Promise<AccountPeriodRow[]> {
    return current ? (await query({ ...current }, true)).rows : []
  }

  return { data, loading, error, load, clear, exportAll }
}
