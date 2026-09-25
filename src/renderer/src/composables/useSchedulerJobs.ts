// Navide's own scheduled jobs for the Tasker tab: the list, the status light
// of each job, and the ▶ / toggle mutations. The backend owns timing and state
// (`scheduler.*` RPC, `scheduler.changed` broadcast); this only mirrors it.
//
// Status light, in priority order:
//   orange  running (state.running_at), or inside the ▶ grace window
//   grey    disabled
//   red     consecutive_errors > 0 — with the "failed ×N | repair" pill
//   grey    last run skipped — with the reason
//   green   last run ok
//   hollow  never run yet (none of the four is true of it)
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { useBackend } from './useBackend'
import { formatClock, shortId, type SchedulerJob } from '../lib/schedulerJobs'

/** After ▶ the row stays orange for at most this long, so a click never looks
 *  ignored while the backend is still waking the pane (NT-ClawLaunch's rule). */
const GRACE_MS = 60_000
const RPC_TIMEOUT_MS = 15_000

export type Light = 'running' | 'off' | 'err' | 'skip' | 'ok' | 'new'

export function useSchedulerJobs(backend: ReturnType<typeof useBackend>) {
  const { t } = useI18n()

  const jobs = ref<SchedulerJob[]>([])
  const listError = ref('')
  const opError = ref('')
  /** Job id → when ▶ was pressed; cleared by a timer at GRACE_MS. */
  const grace = ref<Record<string, number>>({})
  const graceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const pendingId = ref<string | null>(null)
  const now = ref(Date.now())
  let tick: ReturnType<typeof setInterval> | null = null

  /** The ▶ grace window ends early once the backend reports a finished run
   *  that started after the press. */
  function inGrace(job: SchedulerJob): boolean {
    const since = grace.value[job.id]
    if (since === undefined) return false
    const st = job.state
    return !(st && !st.running_at && typeof st.last_run_at === 'number' && st.last_run_at >= since)
  }

  function light(job: SchedulerJob): Light {
    const st = job.state ?? {}
    if (st.running_at || inGrace(job)) return 'running'
    if (!job.enabled) return 'off'
    if ((st.consecutive_errors ?? 0) > 0) return 'err'
    if (st.last_status === 'skipped') return 'skip'
    if (st.last_status === 'ok') return 'ok'
    return 'new'
  }

  function targetGone(job: SchedulerJob): boolean {
    return job.state?.last_status === 'skipped' && job.state.last_skip_reason === 'target_gone'
  }

  function skipLabel(job: SchedulerJob): string {
    const reason = job.state?.last_skip_reason
    return reason ? t(`scheduler.skip.${reason}`) : t('scheduler.skip.unknown')
  }

  function targetLabel(job: SchedulerJob): string {
    const a = job.action
    const name = a.pane_name || shortId(a.pane_id)
    return a.pane_id
      ? t('scheduler.target-with-id', { name, id: shortId(a.pane_id) })
      : t('scheduler.target', { name })
  }

  /** Only what the timeline's time column cannot say: a backoff hold. */
  function backoffLabel(job: SchedulerJob): string {
    const until = job.state?.backoff_until
    if (!job.enabled || typeof until !== 'number' || until <= now.value) return ''
    return t('scheduler.when-backoff', { time: formatClock(until) })
  }

  let listSeq = 0

  async function refresh(): Promise<void> {
    if (backend.status.value !== 'connected') return
    const seq = ++listSeq
    try {
      const resp = await backend.send<{ ok: boolean; jobs?: SchedulerJob[]; error?: string }>(
        'scheduler.list',
        {},
        RPC_TIMEOUT_MS
      )
      if (seq !== listSeq) return
      if (resp.ok && resp.payload && resp.payload.ok !== false) {
        jobs.value = resp.payload.jobs ?? []
        listError.value = ''
      } else listError.value = resp.error?.message ?? resp.payload?.error ?? 'scheduler.list failed'
    } catch (err) {
      if (seq !== listSeq) return
      listError.value = String((err as Error).message ?? err)
    }
  }

  /** Send a mutation; `ok: false` at either level lands in `opError`. */
  async function mutate(type: string, payload: Record<string, unknown>): Promise<boolean> {
    opError.value = ''
    try {
      const resp = await backend.send<{ ok: boolean; error?: string }>(type, payload, RPC_TIMEOUT_MS)
      if (!resp.ok) {
        opError.value = resp.error?.message ?? `${type} failed`
        return false
      }
      if (resp.payload && resp.payload.ok === false) {
        opError.value = resp.payload.error ?? `${type} failed`
        return false
      }
      return true
    } catch (err) {
      opError.value = String((err as Error).message ?? err)
      return false
    }
  }

  function endGrace(id: string): void {
    const timer = graceTimers.get(id)
    if (timer !== undefined) clearTimeout(timer)
    graceTimers.delete(id)
    if (id in grace.value) {
      const next = { ...grace.value }
      delete next[id]
      grace.value = next
    }
  }

  /** ▶ and "repair" are the same call: run_now also clears the backend's
   *  backoff, and the error count resets on the next successful run. */
  async function runNow(job: SchedulerJob): Promise<void> {
    if (pendingId.value) return
    pendingId.value = job.id
    endGrace(job.id)
    grace.value = { ...grace.value, [job.id]: Date.now() }
    graceTimers.set(job.id, setTimeout(() => endGrace(job.id), GRACE_MS))
    try {
      if (!(await mutate('scheduler.run_now', { id: job.id }))) endGrace(job.id)
    } finally {
      pendingId.value = null
    }
  }

  async function toggleEnabled(job: SchedulerJob): Promise<void> {
    if (pendingId.value) return
    pendingId.value = job.id
    try {
      // The broadcast excludes the sender, so this window re-reads on its own.
      if (await mutate('scheduler.set_enabled', { id: job.id, enabled: !job.enabled })) await refresh()
    } finally {
      pendingId.value = null
    }
  }

  let offChanged: (() => void) | null = null

  onMounted(() => {
    offChanged = backend.on('scheduler.changed', (p) => {
      const next = (p as { jobs?: SchedulerJob[] } | null)?.jobs
      if (Array.isArray(next)) jobs.value = next
      else void refresh()
    })
    tick = setInterval(() => (now.value = Date.now()), 30_000)
    void refresh()
  })

  watch(
    () => backend.status.value,
    (status, previous) => {
      if (status === 'connected' && previous !== 'connected') void refresh()
    }
  )

  onUnmounted(() => {
    offChanged?.()
    if (tick !== null) clearInterval(tick)
    for (const timer of graceTimers.values()) clearTimeout(timer)
    graceTimers.clear()
  })

  return {
    jobs,
    listError,
    opError,
    pendingId,
    now,
    light,
    targetGone,
    skipLabel,
    targetLabel,
    backoffLabel,
    refresh,
    runNow,
    toggleEnabled,
  }
}

export type SchedulerJobsApi = ReturnType<typeof useSchedulerJobs>
