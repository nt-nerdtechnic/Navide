import { onScopeDispose, ref, watch, type Ref } from 'vue'
import type { useBackend } from './useBackend'

export interface HistoryEvent {
  id: string
  ts: string
  run_id: string
  type: string
  summary: string
  stage_id?: string
  pane_id?: string
  vendor?: string
  detail?: Record<string, unknown>
}

export interface HistorySnapshot {
  workspace_path: string
  run_dir: string
  path: string
  events: HistoryEvent[]
}

/**
 * Streams the structured pipeline history (timeline) for the current run.
 *
 * Loads a snapshot on connect / workspace change and then appends live
 * `history.appended` broadcasts. Only events for the current workspace are
 * applied so multiple windows don't cross-contaminate. Events are kept in
 * chronological order (oldest → newest) and capped to avoid unbounded growth.
 */
export function useHistory(
  backend: ReturnType<typeof useBackend>,
  workspacePath: Ref<string>
) {
  const events = ref<HistoryEvent[]>([])
  const path = ref<string>('')
  const loading = ref<boolean>(false)
  const lastError = ref<string>('')

  const MAX_EVENTS = 2000

  function cap(): void {
    if (events.value.length > MAX_EVENTS) {
      events.value.splice(0, events.value.length - MAX_EVENTS)
    }
  }

  async function refresh(): Promise<void> {
    if (backend.status.value !== 'connected') return
    loading.value = true
    lastError.value = ''
    try {
      const resp = await backend.send<HistorySnapshot>('history.snapshot', {
        workspace_path: workspacePath.value || undefined
      })
      if (resp.ok && resp.payload) {
        events.value = resp.payload.events ?? []
        path.value = resp.payload.path ?? ''
      } else {
        lastError.value = resp.error?.message ?? 'snapshot failed'
      }
    } catch (err) {
      lastError.value = String((err as Error).message ?? err)
    } finally {
      loading.value = false
    }
  }

  const unsub = backend.on('history.appended', (raw) => {
    const msg = raw as { workspace_path?: string; event?: HistoryEvent }
    if (!msg?.event) return
    const own = workspacePath.value || ''
    const theirs = msg.workspace_path || ''
    if (own !== theirs) return
    events.value.push(msg.event)
    cap()
  })

  watch(
    () => [backend.status.value, workspacePath.value] as const,
    ([s]) => {
      if (s === 'connected') void refresh()
    },
    { immediate: true }
  )

  onScopeDispose(() => unsub())

  return { events, path, loading, lastError, refresh }
}
