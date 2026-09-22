import { onScopeDispose, ref, watch, type Ref } from 'vue'
import type { useBackend } from './useBackend'

export type DevTimeSource = 'human' | 'agent'

export interface DevTimeTotals {
  merged_s: number
  human_s: number
  agent_s: number
  overlap_s: number
  /** Clock seconds from the first to the last interval inside the window;
   *  0 when it holds none. `1 - merged_s / wall_s` is the idle share. */
  wall_s: number
}

export interface DevTimeDay {
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string
  merged_s: number
  human_s: number
  agent_s: number
}

export interface DevTimePane {
  /** Same id space as `ActivePane.id` in the renderer. */
  pane_id: string
  today_s: number
  all_s: number
  active: boolean
}

export type DevTimeWindow = 'today' | 'last7d' | 'last30d' | 'all'

export interface DevTimeSnapshot {
  workspace_path: string
  gap_human_s: number
  gap_agent_s: number
  /** Any open interval for this workspace right now. */
  active: boolean
  active_sources: DevTimeSource[]
  totals: Record<DevTimeWindow, DevTimeTotals>
  /** Exactly 7 entries, oldest first, ending today. */
  by_day: DevTimeDay[]
  /** Merged per pane, sorted by all_s desc. */
  by_pane: DevTimePane[]
}

export const ACTIVE_POLL_MS = 10_000

/**
 * `2h 35m` — minutes are the finest unit shown, so anything under a minute
 * reads as `0m` and hours never roll over into days.
 */
export function formatDuration(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60)
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h === 0 ? `${m}m` : `${h}h ${m}m`
}

/**
 * Tracks the accumulated development time of one workspace.
 *
 * Mirrors useTokens: fetches `devtime.snapshot` on connect / workspace change
 * and re-fetches on a `devtime.changed` broadcast for this workspace. The
 * broadcast is throttled (30s) while beats keep arriving, so while `active`
 * is set the snapshot is also polled every 10 s.
 */
export function useDevTime(
  backend: ReturnType<typeof useBackend>,
  workspacePath: Ref<string>
) {
  const snapshot = ref<DevTimeSnapshot | null>(null)
  const loading = ref<boolean>(false)
  const lastError = ref<string>('')
  let refreshSeq = 0

  async function refresh(): Promise<void> {
    if (backend.status.value !== 'connected') return
    const seq = ++refreshSeq
    loading.value = true
    lastError.value = ''
    try {
      const resp = await backend.send<DevTimeSnapshot>('devtime.snapshot', {
        workspace_path: workspacePath.value || undefined
      })
      if (seq !== refreshSeq) return
      if (resp.ok && resp.payload) {
        snapshot.value = resp.payload
      } else {
        lastError.value = resp.error?.message ?? 'snapshot failed'
      }
    } catch (err) {
      lastError.value = String((err as Error).message ?? err)
    } finally {
      loading.value = false
    }
  }

  async function reset(): Promise<void> {
    try {
      const resp = await backend.send<{ ok: boolean }>('devtime.reset', {
        workspace_path: workspacePath.value || undefined
      })
      if (!resp.ok) {
        lastError.value = resp.error?.message ?? 'reset failed'
        return
      }
    } catch (err) {
      lastError.value = String((err as Error).message ?? err)
      return
    }
    // The backend also broadcasts devtime.changed; refetching here just
    // closes the gap for the window that asked.
    await refresh()
  }

  // ─── polling while active ───
  // No local per-second increment: the backend closes an interval at its
  // last beat, not at the wall clock, so a locally advanced number would fall
  // back by up to one gap the moment the sweeper reported. Instead the panel
  // asks again every 10 s for as long as something is open; displayed numbers
  // only ever move to what the backend reports.
  let poll: ReturnType<typeof setInterval> | null = null
  function stopPoll(): void {
    if (poll) clearInterval(poll)
    poll = null
  }
  watch(
    () => snapshot.value?.active ?? false,
    (active) => {
      if (active && !poll) {
        poll = setInterval(() => { void refresh() }, ACTIVE_POLL_MS)
      } else if (!active) {
        stopPoll()
      }
    },
    { immediate: true }
  )

  const unsubChanged = backend.on('devtime.changed', (raw) => {
    const payload = raw as { workspace_path?: string } | null
    if (!payload) return
    const own = workspacePath.value || ''
    const theirs = payload.workspace_path || ''
    if (own === theirs) void refresh()
  })

  watch(
    () => [backend.status.value, workspacePath.value] as const,
    ([s, path], prev) => {
      if (!prev || path !== prev[1]) {
        snapshot.value = null
        refreshSeq++
      }
      if (s === 'connected') void refresh()
    },
    { immediate: true }
  )

  onScopeDispose(() => {
    unsubChanged()
    stopPoll()
  })

  return { snapshot, loading, lastError, refresh, reset }
}
