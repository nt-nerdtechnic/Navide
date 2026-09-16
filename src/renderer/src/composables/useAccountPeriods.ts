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
  input: number
  cache_read: number
  cache_creation: number
  output: number
  total: number
  calls: number
  turns: number
  /** Session-window cycles that fell in the period. */
  cycles: number
  exhausted: number
  avg_total_exhausted: number | null
  weekly_exhausted: number
}

export interface PeriodTotal {
  period: string
  total: number
  calls: number
  turns: number
}

export interface AccountPeriodsResult {
  ok: true
  granularity: PeriodGranularity
  /** period newest first; within a period by total, largest first. */
  rows: AccountPeriodRow[]
  totals_by_period: PeriodTotal[]
}

interface AccountPeriodsFailure {
  ok: false
  error: string
}

export interface AccountPeriodsTarget {
  agentKey?: string
  profileId?: string
  granularity: PeriodGranularity
}

export function useAccountPeriods(backend: ReturnType<typeof useBackend>) {
  const data = ref<AccountPeriodsResult | null>(null)
  const loading = ref(false)
  const error = ref('')
  let loadSeq = 0
  let current: AccountPeriodsTarget | null = null

  async function load(target: AccountPeriodsTarget): Promise<void> {
    current = target
    const seq = ++loadSeq
    loading.value = true
    error.value = ''
    try {
      const resp = await backend.send<AccountPeriodsResult | AccountPeriodsFailure>('tokens.account_periods', {
        agent_key: target.agentKey || undefined,
        profile_id: target.profileId || undefined,
        granularity: target.granularity
      })
      if (seq !== loadSeq) return
      if (!resp.ok || !resp.payload) {
        data.value = null
        error.value = resp.error?.code || resp.error?.message || 'load-failed'
        return
      }
      if (resp.payload.ok === false) {
        data.value = null
        error.value = resp.payload.error || 'load-failed'
        return
      }
      data.value = resp.payload
    } catch (err) {
      if (seq !== loadSeq) return
      data.value = null
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

  return { data, loading, error, load, clear }
}
