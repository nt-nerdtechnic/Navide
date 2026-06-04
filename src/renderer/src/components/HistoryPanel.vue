<script setup lang="ts">
import { computed, nextTick, ref, watch, type Ref } from 'vue'
import { useHistory, type HistoryEvent } from '../composables/useHistory'
import type { useBackend } from '../composables/useBackend'
import type { PipelineStatusView } from './ControlPane.vue'

interface Props {
  backend: ReturnType<typeof useBackend>
  workspacePath: string
  pipeline: PipelineStatusView
}
const props = defineProps<Props>()

// ─────────────────────── Run info: file links + live log ───────────────────
// Moved here from ControlPane so the run's project.json / pipeline.log /
// backend.log links and the supervision log live alongside the timeline.
// Classify a supervision-log line so errors stand out (red) and warnings (yellow).
function logLevel(line: string): '' | 'is-error' | 'is-warn' {
  if (/❌|✕|✗|exception|unreachable|rejection|\berror\b|\bfailed\b|\bthrew\b/i.test(line)) {
    return 'is-error'
  }
  if (/⚠/.test(line)) return 'is-warn'
  return ''
}
async function openPath(p: string): Promise<void> {
  if (!p) return
  if (!window.agentTeam?.openPath) {
    try {
      await navigator.clipboard.writeText(p)
    } catch {
      /* ignore */
    }
    return
  }
  await window.agentTeam.openPath(p)
}
// Auto-scroll the supervision log to the bottom whenever a new entry arrives.
const pipelineLogEl = ref<HTMLElement | null>(null)
watch(
  () => props.pipeline.log.length,
  async () => {
    await nextTick()
    if (pipelineLogEl.value) pipelineLogEl.value.scrollTop = pipelineLogEl.value.scrollHeight
  }
)

const workspacePathRef: Ref<string> = computed(() => props.workspacePath) as unknown as Ref<string>
const { events, path, loading } = useHistory(props.backend, workspacePathRef)

// type → display icon. Unknown types fall back to a neutral dot.
const ICONS: Record<string, string> = {
  pipeline_start: '▶',
  pipeline_complete: '🎉',
  pipeline_abort: '✖',
  stage_advance: '⏭',
  stage_completed: '🏁',
  stage_stalled: '⏰',
  sentinel_detected: '🏁',
  pane_spawn: '＋',
  context_handoff: '📤',
  manager: '🎯',
  question_detected: '❓',
  question_answered: '↩',
  question_auto_answered: '🤖',
  analyzer_result: '🧠',
  warning: '⚠',
  log: '·'
}
function iconFor(t: string): string {
  return ICONS[t] ?? '·'
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString()
  } catch {
    return iso
  }
}

// ─────────────────────── Filters ───────────────────────
const typeFilter = ref<string>('all')
const stageFilter = ref<string>('all')
const search = ref<string>('')

const typeOptions = computed(() => {
  const s = new Set<string>()
  for (const e of events.value) s.add(e.type)
  return ['all', ...Array.from(s).sort()]
})
const stageOptions = computed(() => {
  const s = new Set<string>()
  for (const e of events.value) if (e.stage_id) s.add(e.stage_id)
  return ['all', ...Array.from(s).sort()]
})

const filtered = computed<HistoryEvent[]>(() => {
  const q = search.value.trim().toLowerCase()
  return events.value.filter((e) => {
    if (typeFilter.value !== 'all' && e.type !== typeFilter.value) return false
    if (stageFilter.value !== 'all' && e.stage_id !== stageFilter.value) return false
    if (q && !e.summary.toLowerCase().includes(q)) return false
    return true
  })
})

// ─────────────────────── Row expand ───────────────────────
const expandedIds = ref<Set<string>>(new Set())
function toggle(id: string): void {
  const next = new Set(expandedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedIds.value = next
}
function detailJson(e: HistoryEvent): string {
  return JSON.stringify(e.detail ?? {}, null, 2)
}

// ─────────────────────── Auto-scroll (stick to bottom) ───────────────────────
// New events append at the bottom (chronological). Keep the timeline pinned to
// the newest row, but only while the user is already near the bottom — if they
// scrolled up to read history, don't yank them back down.
const timelineEl = ref<HTMLElement | null>(null)
const stick = ref(true)

function onScroll(): void {
  const el = timelineEl.value
  if (!el) return
  // tolerance so small layout shifts (row expand, font metrics) stay "stuck"
  stick.value = el.scrollHeight - el.scrollTop - el.clientHeight < 40
}

watch(
  () => filtered.value.length,
  () => {
    if (!stick.value) return
    nextTick(() => {
      const el = timelineEl.value
      if (el) el.scrollTop = el.scrollHeight
    })
  }
)

// ─────────────────────── Export / open ───────────────────────
function exportJsonl(): void {
  const text = filtered.value.map((e) => JSON.stringify(e)).join('\n')
  const blob = new Blob([text], { type: 'application/x-ndjson' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'history.jsonl'
  a.click()
  URL.revokeObjectURL(url)
}
async function openFile(): Promise<void> {
  if (!path.value) return
  try {
    await window.agentTeam?.openPath(path.value)
  } catch {
    /* ignore */
  }
}
</script>

<template>
  <div class="history">
    <div v-if="pipeline.projectId || pipeline.log.length" class="run-info">
      <div v-if="pipeline.projectId" class="paths-actions">
        <button class="ghost" :title="pipeline.projectFile" @click="openPath(pipeline.projectFile)">📄 project.json</button>
        <button class="ghost" :title="pipeline.pipelineLogFile" @click="openPath(pipeline.pipelineLogFile)">📜 pipeline.log</button>
        <button class="ghost" :title="pipeline.backendLogFile" @click="openPath(pipeline.backendLogFile)">🪵 backend.log</button>
      </div>
      <div v-if="pipeline.log.length" ref="pipelineLogEl" class="pipeline-log">
        <div v-for="(line, i) in pipeline.log" :key="i" class="pipeline-log-line" :class="logLevel(line)">{{ line }}</div>
      </div>
    </div>

    <div class="filters">
      <select v-model="typeFilter" class="flt" title="Filter by type">
        <option v-for="t in typeOptions" :key="t" :value="t">{{ t }}</option>
      </select>
      <select v-model="stageFilter" class="flt" title="Filter by stage">
        <option v-for="s in stageOptions" :key="s" :value="s">
          {{ s === 'all' ? 'all stages' : `Stage ${s}` }}
        </option>
      </select>
      <input v-model="search" class="search" type="text" placeholder="🔍 search…" />
    </div>

    <div v-if="loading && events.length === 0" class="msg">Loading…</div>
    <div v-else-if="filtered.length === 0" class="msg">尚無事件</div>

    <div ref="timelineEl" class="timeline" @scroll="onScroll">
      <div
        v-for="e in filtered"
        :key="e.id"
        class="row"
        :class="{ open: expandedIds.has(e.id) }"
        @click="toggle(e.id)"
      >
        <span class="ts">{{ fmtTime(e.ts) }}</span>
        <span class="icon">{{ iconFor(e.type) }}</span>
        <span class="summary">{{ e.summary }}</span>
        <pre v-if="expandedIds.has(e.id) && e.detail" class="detail">{{ detailJson(e) }}</pre>
      </div>
    </div>

    <div class="actions">
      <button class="act" @click="exportJsonl" title="Download filtered events as .jsonl">💾 Export</button>
      <button class="act" :disabled="!path" @click="openFile" title="Open history.jsonl in Finder">📂 Open file</button>
    </div>
  </div>
</template>

<style scoped>
.history {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.run-info {
  padding: 6px 8px;
  border-bottom: 1px solid #21262d;
}
.paths-actions {
  display: flex;
  gap: 4px;
}
.paths-actions .ghost {
  flex: 1;
  background: transparent;
  color: #c9d1d9;
  border: 1px solid #30363d;
  border-radius: 5px;
  font-size: 10px;
  padding: 4px 4px;
  cursor: pointer;
  white-space: nowrap;
}
.paths-actions .ghost:hover {
  background: #21262d;
}
.pipeline-log {
  background: #010409;
  border-radius: 4px;
  padding: 6px 8px;
  margin-top: 4px;
  max-height: 200px;
  overflow-y: auto;
  overscroll-behavior: contain;
  font-family: Menlo, Monaco, 'Courier New', monospace;
  font-size: 10px;
}
.pipeline-log-line {
  color: #8b949e;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
.pipeline-log-line.is-error {
  color: #f85149;
  font-weight: 600;
}
.pipeline-log-line.is-warn {
  color: #d29922;
}
.filters {
  display: flex;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid #21262d;
}
.flt,
.search {
  background: #0d1117;
  color: #e6edf3;
  border: 1px solid #30363d;
  border-radius: 5px;
  font-size: 11px;
  padding: 3px 5px;
}
.search {
  flex: 1;
  min-width: 0;
}
.timeline {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  padding: 4px 0;
}
.row {
  display: grid;
  grid-template-columns: auto auto 1fr;
  gap: 6px;
  align-items: baseline;
  padding: 3px 8px;
  font-size: 11px;
  line-height: 1.45;
  cursor: pointer;
  border-left: 2px solid transparent;
}
.row:hover {
  background: #161b22;
}
.row.open {
  background: #161b22;
  border-left-color: #2f81f7;
}
.ts {
  color: #6e7681;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.icon {
  width: 16px;
  text-align: center;
}
.summary {
  color: #c9d1d9;
  word-break: break-word;
}
.detail {
  grid-column: 1 / -1;
  margin: 4px 0 2px;
  padding: 6px 8px;
  background: #010409;
  border: 1px solid #21262d;
  border-radius: 5px;
  color: #8b949e;
  font-size: 10px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 240px;
  overflow: auto;
}
.msg {
  padding: 12px 8px;
  color: #6e7681;
  font-size: 12px;
}
.actions {
  display: flex;
  gap: 6px;
  padding: 6px 8px;
  border-top: 1px solid #21262d;
}
.act {
  flex: 1;
  background: #0d1117;
  color: #c9d1d9;
  border: 1px solid #30363d;
  border-radius: 5px;
  font-size: 11px;
  padding: 5px 6px;
  cursor: pointer;
}
.act:hover:not(:disabled) {
  background: #161b22;
}
.act:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
