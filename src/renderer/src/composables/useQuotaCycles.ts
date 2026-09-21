import { onScopeDispose, ref } from 'vue'
import type { useBackend } from './useBackend'

// Quota cycles of one account: every quota window (5h session, weekly, …) the
// backend has seen for an (agent, profile) pair, with the tokens spent inside
// it and how far the window got. Fetched on demand over `tokens.quota_cycles`;
// the backend broadcasts `tokens.quota_cycles_changed` when a cycle closes or
// its samples move, and the loaded target refetches itself on that.

export interface QuotaCycle {
  id?: number
  agent_key?: string
  profile_id?: string
  window_kind: string
  /** null when the vendor reports no window length (monthly vendors before
   *  their first reset sample). */
  started_at: string | null
  resets_at: string
  /** Lifecycle ends at reset; retained local detail can still reconcile. */
  closed: boolean
  max_percent: number
  /** First recorded limit observation; its source may be unverified legacy evidence. */
  exhausted_at: string | null
  input: number | null
  cache_read: number | null
  cache_creation: number | null
  output: number | null
  total: number | null
  calls: number | null
  turns: number | null
  samples: number
  exhausted_source?: 'sample' | 'cli' | 'legacy_unknown' | null
  coverage_state?: 'available' | 'partial' | 'unavailable'
  coverage_reason?: string | null
  recorded_totals?: Record<string, number>
  provisional?: boolean
  last_sample_at?: string | null
  reconciled_at?: string | null
  token_scope?: string
  bucket_seconds?: number
  average_eligible?: boolean
  /** Compatibility flag for available local coverage, not provider completeness. */
  detail_known?: boolean
}

export interface QuotaCycleSummary {
  cycles: number
  exhausted: number
  avg_total_exhausted: number | null
  eligible_count?: number
  excluded_count?: number
  exclusions?: Record<string, number>
}

export interface QuotaCursor { resets_at: string; id: number }
export interface QuotaSnapshot { at: string; max_cycle_id: number }

export interface QuotaCyclesResult {
  ok: true
  agent_key: string
  profile_id: string
  /** resets_at newest first. */
  cycles: QuotaCycle[]
  summary: Record<string, QuotaCycleSummary>
  schema_version?: number
  total_count?: number
  next_cursor?: QuotaCursor | null
  snapshot?: QuotaSnapshot
  range_start?: string
  range_end?: string
  include_current?: boolean
  refreshed_at?: string
  window_kinds?: string[]
}

interface QuotaCyclesFailure {
  ok: false
  error: 'unknown-vendor' | 'no-data' | string
}

export interface QuotaCyclesTarget {
  agentKey: string
  profileId: string
  windowKind?: string
  rangeStart?: string
  rangeEnd?: string
  includeCurrent?: boolean
  cursor?: QuotaCursor
  snapshot?: QuotaSnapshot
}

export interface QuotaCyclesChangedEvent {
  agent_key: string
  profile_id: string
  window_kind: string
}

export function useQuotaCycles(backend: ReturnType<typeof useBackend>) {
  const data = ref<QuotaCyclesResult | null>(null)
  const loading = ref(false)
  const error = ref('')
  let loadSeq = 0
  let current: QuotaCyclesTarget | null = null

  async function query(target: QuotaCyclesTarget, exporting = false): Promise<QuotaCyclesResult> {
    const resp = await backend.send<QuotaCyclesResult | QuotaCyclesFailure>('tokens.quota_cycles', {
      agent_key: target.agentKey, profile_id: target.profileId,
      window_kind: target.windowKind || undefined,
      range_start: target.rangeStart, range_end: target.rangeEnd,
      include_current: target.includeCurrent ?? true,
      limit: 50, cursor: exporting ? undefined : target.cursor,
      snapshot: exporting ? undefined : target.snapshot, export: exporting || undefined
    })
    if (!resp.ok || !resp.payload) throw new Error(resp.error?.code || resp.error?.message || 'load-failed')
    if (resp.payload.ok === false) throw new Error(resp.payload.error || 'load-failed')
    return resp.payload
  }

  async function load(target: QuotaCyclesTarget): Promise<void> {
    if (current && (current.agentKey !== target.agentKey || current.profileId !== target.profileId || current.windowKind !== target.windowKind || current.rangeStart !== target.rangeStart || current.rangeEnd !== target.rangeEnd)) data.value = null
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

  /** The backend materializes one bounded snapshot for the full export. */
  async function exportAll(): Promise<QuotaCycle[]> {
    if (!current) return []
    return (await query({ ...current }, true)).cycles
  }

  function clear(): void {
    loadSeq++
    current = null
    data.value = null
    loading.value = false
    error.value = ''
  }

  // A change to the account on screen refetches it; other accounts' cycles
  // are not ours to redraw.
  const unsub = backend.on('tokens.quota_cycles_changed', (raw) => {
    const ev = raw as QuotaCyclesChangedEvent | null
    if (!ev || !current) return
    if (ev.agent_key !== current.agentKey || ev.profile_id !== current.profileId) return
    void load(current)
  })
  onScopeDispose(() => unsub())

  return { data, loading, error, load, clear, exportAll }
}
