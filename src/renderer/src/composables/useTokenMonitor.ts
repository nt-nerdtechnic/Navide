import { onScopeDispose, ref, watch, type Ref } from 'vue'
import type { useBackend } from './useBackend'

export interface MonitorTurn {
  session_id: string
  turn_index: number
  started_at: string | null
  ended_at: string | null
  model: string
  input: number
  cache_read: number
  cache_creation: number
  output: number
  total: number
  calls: number
}
export interface MonitorResult {
  ok: true
  scope: string
  account_attribution: string
  turns: MonitorTurn[]
  quota: { error?: string | null; active_slot_id: string; enabled: boolean; samples: Array<{
    slot_id: string; fetched_at: string; plan_type: string | null
    windows: Array<{ kind: string; label: string; usedPercent: number; resetsAt: string | null; windowMinutes?: number | null }>
  }> }
  coverage: { sessions_scanned: number; sessions_available: number; truncated: boolean; errors: number }
  limitations: string[]
}

export function useTokenMonitor(backend: ReturnType<typeof useBackend>, days: Ref<number>) {
  const data = ref<MonitorResult | null>(null)
  const loading = ref(false)
  const error = ref('')
  const updatedAt = ref('')
  let sequence = 0
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined

  async function refresh(): Promise<void> {
    if (disposed || backend.status.value !== 'connected') return
    clearTimeout(timer)
    const current = ++sequence
    loading.value = true
    error.value = ''
    try {
      const response = await backend.send<MonitorResult | { ok: false; error: string }>('tokens.monitor', { days: days.value })
      if (disposed || current !== sequence) return
      if (!response.ok || !response.payload) throw new Error(response.error?.message || 'Unable to load token history')
      if (!response.payload.ok) throw new Error(response.payload.error)
      data.value = response.payload
      updatedAt.value = new Date().toISOString()
    } catch (err) {
      if (!disposed && current === sequence) error.value = err instanceof Error ? err.message : String(err)
    } finally {
      if (!disposed && current === sequence) {
        loading.value = false
        timer = setTimeout(() => void refresh(), 60_000)
      }
    }
  }
  watch([days, backend.status], () => {
    sequence++
    clearTimeout(timer)
    data.value = null
    loading.value = false
    updatedAt.value = ''
    error.value = ''
    void refresh()
  }, { immediate: true })
  onScopeDispose(() => { disposed = true; sequence++; clearTimeout(timer) })
  return { data, loading, error, updatedAt, refresh }
}
