<script setup lang="ts">
// NAVIDE JOBS — the top section of the Tasker tab: jobs Navide itself runs on a
// schedule, each one "wake this CLI pane and send it this text". The backend
// owns timing and state (`scheduler.*` RPC, `scheduler.changed` broadcast);
// this section renders, toggles, and hands a row to JobEditorModal.
//
// Status light, in priority order:
//   orange  running (state.running_at), or inside the ▶ grace window
//   grey    disabled
//   red     consecutive_errors > 0 — with the "failed ×N | repair" pill
//   grey    last run skipped — with the reason
//   green   last run ok
//   hollow  never run yet (none of the four is true of it)
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { useBackend } from '../composables/useBackend'
import JobEditorModal from './JobEditorModal.vue'
import type { Translate } from '../lib/cronDescribe'
import {
  describeSchedule,
  formatClock,
  formatDateTime,
  shortId,
  type SchedulerJob,
} from '../lib/schedulerJobs'

const props = defineProps<{ backend: ReturnType<typeof useBackend> }>()

const { t } = useI18n()
const tr: Translate = (key, params) => (params ? t(key, params) : t(key))

/** After ▶ the row stays orange for at most this long, so a click never looks
 *  ignored while the backend is still waking the pane (NT-ClawLaunch's rule). */
const GRACE_MS = 60_000

const jobs = ref<SchedulerJob[]>([])
const listError = ref('')
const opError = ref('')
/** Job id → when ▶ was pressed; cleared by a timer at GRACE_MS. */
const grace = ref<Record<string, number>>({})
const graceTimers = new Map<string, ReturnType<typeof setTimeout>>()
const pendingId = ref<string | null>(null)
const now = ref(Date.now())
let tick: ReturnType<typeof setInterval> | null = null

const editorOpen = ref(false)
const editing = ref<SchedulerJob | null>(null)

type Light = 'running' | 'off' | 'err' | 'skip' | 'ok' | 'new'

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

function whenLabel(job: SchedulerJob): string {
  const st = job.state ?? {}
  if (!job.enabled) return t('scheduler.when-disabled')
  if (typeof st.backoff_until === 'number' && st.backoff_until > now.value)
    return t('scheduler.when-backoff', { time: formatClock(st.backoff_until) })
  if (typeof st.next_run_at === 'number') return t('scheduler.when-next', { time: formatDateTime(st.next_run_at) })
  return ''
}

const RPC_TIMEOUT_MS = 15_000
let listSeq = 0

async function refresh(): Promise<void> {
  if (props.backend.status.value !== 'connected') return
  const seq = ++listSeq
  try {
    const resp = await props.backend.send<{ ok: boolean; jobs?: SchedulerJob[]; error?: string }>(
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

/** Send a mutation; `ok: false` at either level is shown under the section. */
async function mutate(type: string, payload: Record<string, unknown>): Promise<boolean> {
  opError.value = ''
  try {
    const resp = await props.backend.send<{ ok: boolean; error?: string }>(type, payload, RPC_TIMEOUT_MS)
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

function openEditor(job: SchedulerJob | null): void {
  editing.value = job
  editorOpen.value = true
}

function closeEditor(): void {
  editorOpen.value = false
  editing.value = null
}

function onSaved(): void {
  closeEditor()
  void refresh()
}

const count = computed(() => jobs.value.length)

let offChanged: (() => void) | null = null

onMounted(() => {
  offChanged = props.backend.on('scheduler.changed', (p) => {
    const next = (p as { jobs?: SchedulerJob[] } | null)?.jobs
    if (Array.isArray(next)) jobs.value = next
    else void refresh()
  })
  tick = setInterval(() => (now.value = Date.now()), 30_000)
  void refresh()
})

watch(
  () => props.backend.status.value,
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
</script>

<template>
  <section class="sj-section" data-section="navide-jobs">
    <div class="sj-hdr">
      <span class="sj-title">{{ t('scheduler.title') }}</span>
      <span class="sj-count">{{ t('scheduler.count', { count }) }}</span>
      <button class="sj-add" data-test="add-job" @click="openEditor(null)">
        {{ t('scheduler.add') }}
      </button>
    </div>

    <p v-if="listError" class="sj-error">{{ t('scheduler.list-failed', { message: listError }) }}</p>

    <div
      v-for="job in jobs"
      :key="job.id"
      class="sj-row"
      :class="{ off: !job.enabled }"
      :data-job-id="job.id"
      :data-light="light(job)"
    >
      <div class="sj-line1">
        <span class="sj-dot" :class="light(job)" data-test="light" />
        <button class="sj-name" :title="t('scheduler.edit')" @click="openEditor(job)">{{ job.name }}</button>
        <span
          v-if="light(job) === 'err'"
          class="sj-fail"
          data-test="fail-pill"
        >
          <span class="sj-fail-count">{{ t('scheduler.failed', { n: job.state?.consecutive_errors ?? 0 }) }}</span>
          <button
            class="sj-fail-repair"
            data-test="repair"
            :disabled="pendingId !== null"
            :title="job.state?.last_error ?? ''"
            @click="runNow(job)"
          >
            {{ t('scheduler.repair') }}
          </button>
        </span>
        <span v-else-if="light(job) === 'skip' && !targetGone(job)" class="sj-tag" data-test="skip-tag">
          {{ skipLabel(job) }}
        </span>
        <span class="sj-acts">
          <button
            class="sj-act"
            data-test="toggle"
            :disabled="pendingId !== null"
            :title="job.enabled ? t('scheduler.disable') : t('scheduler.enable')"
            @click="toggleEnabled(job)"
          >
            {{ job.enabled ? '⏸' : '⏵' }}
          </button>
          <button
            class="sj-act"
            data-test="run-now"
            :disabled="pendingId !== null || light(job) === 'running'"
            :title="t('scheduler.run-now')"
            @click="runNow(job)"
          >
            ▶
          </button>
        </span>
      </div>
      <div class="sj-line2">
        <span class="sj-desc">{{ describeSchedule(job.schedule, tr) }}</span>
        <span v-if="whenLabel(job)" class="sj-when" data-test="when">· {{ whenLabel(job) }}</span>
      </div>
      <div class="sj-line2">
        <span class="sj-target" data-test="target" :title="job.action.workspace">{{ targetLabel(job) }}</span>
      </div>
      <div v-if="targetGone(job)" class="sj-gone" data-test="target-gone">
        <span>{{ t('scheduler.skip.target_gone') }}</span>
        <button class="sj-retarget" data-test="retarget" @click="openEditor(job)">
          {{ t('scheduler.retarget') }}
        </button>
      </div>
    </div>
    <p v-if="!jobs.length && !listError" class="sj-empty nv-empty nv-empty--inline">
      {{ t('scheduler.empty') }}
    </p>

    <p v-if="opError" class="sj-error" data-test="op-error">{{ opError }}</p>

    <JobEditorModal
      :open="editorOpen"
      :job="editing"
      :backend="backend"
      @close="closeEditor"
      @saved="onSaved"
      @removed="onSaved"
    />
  </section>
</template>

<style scoped>
/* Mirrors TaskerPanel's section and row rhythm (its styles are scoped). */
/* Sits above TaskerPanel's scrolling body (so it also shows on platforms with
   no crontab/launchd), hence its own cap and scroll. */
.sj-section {
  flex: none;
  max-height: 45%;
  overflow-y: auto;
  border-bottom: 1px solid var(--bg-subtle);
  padding-bottom: 6px;
}
.sj-hdr {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 8px 10px 6px;
}
.sj-title {
  flex: 1;
  min-width: 0;
  font-size: var(--font-2xs);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sj-count {
  flex: none;
  font-size: var(--font-3xs);
  color: var(--text-secondary);
}
.sj-add {
  flex: none;
  appearance: none;
  border: 1px solid var(--border-default);
  border-radius: 3px;
  background: transparent;
  color: var(--text-secondary);
  padding: 0 6px;
  font-size: var(--font-3xs);
  line-height: 1.7;
  cursor: pointer;
}
.sj-add:hover {
  color: var(--text-bright);
  background: var(--bg-hover);
}
.sj-row {
  border-top: 1px solid var(--bg-subtle);
  padding: 5px 10px;
}
.sj-row.off {
  opacity: 0.65;
}
.sj-line1 {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  min-width: 0;
}
.sj-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: var(--radius-pill);
  background: var(--text-disabled);
}
.sj-dot.ok {
  background: var(--success-fg);
}
.sj-dot.running {
  background: var(--attention-fg);
}
.sj-dot.err {
  background: var(--danger-fg);
}
.sj-dot.new {
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--text-disabled);
}
.sj-name {
  flex: 1;
  min-width: 0;
  appearance: none;
  border: none;
  background: transparent;
  padding: 0;
  text-align: left;
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--text-bright);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.sj-name:hover {
  text-decoration: underline;
}
.sj-fail {
  flex: none;
  display: inline-flex;
  align-items: stretch;
  border: 1px solid var(--danger-muted);
  border-radius: 4px;
  overflow: hidden;
  font-size: 9px;
  font-weight: 700;
}
.sj-fail-count {
  padding: 0 4px;
  color: var(--danger-fg);
  background: var(--danger-subtle);
}
.sj-fail-repair {
  appearance: none;
  border: none;
  border-left: 1px solid var(--danger-muted);
  padding: 0 5px;
  background: transparent;
  color: var(--danger-fg);
  font: inherit;
  cursor: pointer;
}
.sj-fail-repair:hover:not(:disabled) {
  background: var(--danger-subtle);
}
.sj-tag {
  flex: none;
  border: 1px solid var(--border-default);
  border-radius: 4px;
  padding: 0 4px;
  font-size: 9px;
  font-weight: 700;
  color: var(--text-secondary);
  white-space: nowrap;
}
.sj-acts {
  display: flex;
  flex: none;
  gap: 3px;
}
.sj-act {
  appearance: none;
  width: 20px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-default);
  border-radius: 3px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 9px;
  cursor: pointer;
}
.sj-act:hover:not(:disabled) {
  color: var(--text-bright);
  background: var(--bg-hover);
}
.sj-act:disabled,
.sj-fail-repair:disabled {
  opacity: 0.5;
  cursor: default;
}
.sj-line2 {
  display: flex;
  gap: 4px;
  min-width: 0;
  margin-top: 2px;
  padding-left: 11px;
  font-size: var(--font-3xs);
  color: var(--text-secondary);
}
.sj-desc,
.sj-target {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sj-when {
  flex: none;
  white-space: nowrap;
}
.sj-gone {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 3px;
  padding-left: 11px;
  font-size: var(--font-3xs);
  color: var(--text-secondary);
}
.sj-retarget {
  appearance: none;
  border: 1px solid var(--border-default);
  border-radius: 3px;
  background: transparent;
  color: var(--accent-fg);
  padding: 0 6px;
  font-size: var(--font-3xs);
  cursor: pointer;
}
.sj-empty {
  margin: 0;
  padding: 6px 10px;
  font-size: var(--font-2xs);
  color: var(--text-secondary);
}
.sj-error {
  margin: 6px 10px;
  padding: 5px 8px;
  border: 1px solid var(--danger-muted);
  border-radius: var(--radius-control);
  background: var(--danger-subtle);
  color: var(--danger-bright);
  font-size: var(--font-2xs);
  word-break: break-word;
}
</style>
