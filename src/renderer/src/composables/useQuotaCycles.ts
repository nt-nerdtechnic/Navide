import { onScopeDispose, ref } from 'vue'
import type { useBackend } from './useBackend'

// Quota cycles of one account: every quota window (5h session, weekly, …) the
// backend has seen for an (agent, profile) pair, with the tokens spent inside
// it and how far the window got. Fetched on demand over `tokens.quota_cycles`;
// the backend broadcasts `tokens.quota_cycles_changed` when a cycle closes or
// its samples move, and the loaded target refetches itself on that.

export interface QuotaCycle {
  window_kind: string
  /** null when the vendor reports no window length (monthly vendors before
   *  their first reset sample). */
  started_at: string | null
  resets_at: string
  /** resetsAt has passed: the figures are frozen. */
  closed: boolean
  max_percent: number
  /** First sample at 100%, or null when the window never ran out. */
  exhausted_at: string | null
  input: number
  cache_read: number
  cache_creation: number
  output: number
  total: number
  calls: number
  turns: number
  samples: number
  /** true = the cycle started after token slices were kept, so the token
   *  figures are real (0 means nothing spent); false = closed before that,
   *  the figures are not to be trusted. Absent from a backend that predates
   *  the flag. */
  detail_known?: boolean
}

export interface QuotaCycleSummary {
  cycles: number
  exhausted: number
  avg_total_exhausted: number | null
}

export interface QuotaCyclesResult {
  ok: true
  agent_key: string
  profile_id: string
  /** resets_at newest first. */
  cycles: QuotaCycle[]
  summary: Record<string, QuotaCycleSummary>
}

interface QuotaCyclesFailure {
  ok: false
  error: 'unknown-vendor' | 'no-data' | string
}

export interface QuotaCyclesTarget {
  agentKey: string
  profileId: string
  windowKind?: string
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

  async function load(target: QuotaCyclesTarget): Promise<void> {
    current = target
    const seq = ++loadSeq
    loading.value = true
    error.value = ''
    try {
      const resp = await backend.send<QuotaCyclesResult | QuotaCyclesFailure>('tokens.quota_cycles', {
        agent_key: target.agentKey,
        profile_id: target.profileId,
        window_kind: target.windowKind || undefined
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

  // A change to the account on screen refetches it; other accounts' cycles
  // are not ours to redraw.
  const unsub = backend.on('tokens.quota_cycles_changed', (raw) => {
    const ev = raw as QuotaCyclesChangedEvent | null
    if (!ev || !current) return
    if (ev.agent_key !== current.agentKey || ev.profile_id !== current.profileId) return
    void load(current)
  })
  onScopeDispose(() => unsub())

  return { data, loading, error, load, clear }
}
