<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import ViewPanel, { type LayoutMode } from './ViewPanel.vue'
import type { BackendStatus } from '../composables/useBackend'
import type { Role, RoleKey } from '../data/roles'
import type { Stage, StageId } from '../data/stages'

export interface AgentSpec {
  agentKey: string
  label: string
  defaultCommand: string
  skipPermissionFlag?: string
  hint?: string
}

export interface ActivePaneView {
  id: string
  agentKey: string
  agentLabel: string
  roleKey: RoleKey
  roleLabel: string
  stageId: StageId
  command: string
  status: string
  error?: string
  injectionStatus: 'pending' | 'scheduled' | 'sent' | 'failed' | 'skipped'
  kickoffStatus?: 'none' | 'pending' | 'sent' | 'failed'
  origin: 'manual' | 'pipeline'
  /** True when this pane corresponds to a slot marked is_commander=true in
   *  the stage config — shown as 🎯 指揮官 badge in the active-agents list
   *  and the pane header. */
  isCommander?: boolean
  /** CLI session id for resume. Claude: pinned at launch; Codex/Gemini: filled
   *  once detected from the session file. Shown so the user can confirm capture. */
  sessionId?: string
  /** Human-readable slot label (e.g. "Architecture"). Empty for single-agent
   *  stages or manually-spawned panes. Used as stable by_pane key. */
  slotLabel?: string
  /** True when the pane is minimized to the sidebar (hidden in grid, PTY alive). */
  isMinimized?: boolean
}

export interface SpawnPayload {
  agentKey: string
  roleKey: RoleKey
  stageId: StageId
  workspacePath: string
}

export interface PipelineSummary {
  id: string
  name: string
  builtin: boolean
  stage_count: number
}

export type PipelineState = 'idle' | 'running' | 'completed' | 'aborted'

/** Entry mode detected from the opened workspace (see App.detectMode). */
export type WorkspaceMode = 'pipeline' | 'spawn' | 'completed'

export interface PipelineStatusView {
  state: PipelineState
  stageIndex: number // 0..5; only meaningful when running
  totalStages: number
  task: string
  workspacePath: string
  log: string[] // tiny human-readable log of major transitions
  projectId: string
  projectFile: string
  pipelineLogFile: string
  backendLogFile: string
}

export interface ExistingProjectInfo {
  projectId: string
  name: string
  state: 'idle' | 'running' | 'completed' | 'aborted'
  taskDescription: string
  currentStageIndex: number
  totalStages: number
  stagesCompleted: number
  nextStageIndex: number // -1 if all done
  updatedAt: string
  projectFile: string
  pipelineId: string
  runCount: number
}

export interface AnalyzerModelOption {
  name: string
  parameter_size: string
  size: number
}

export interface BenchmarkModelResult {
  name: string
  score: number
  passed: boolean
}

export interface AnalyzerStatusView {
  available: boolean
  version: string
  defaultModel: string
  models: AnalyzerModelOption[]
  benchmarkResults: BenchmarkModelResult[]
}

interface Props {
  backendStatus: BackendStatus
  backendUrl: string
  agentSpecs: AgentSpec[]
  roles: Role[]
  stages: Stage[]
  panes: ActivePaneView[]
  pipeline: PipelineStatusView
  yoloEnabled: boolean
  analyzerModel: string
  analyzerStatus: AnalyzerStatusView
  autoAnswerEnabled: boolean
  existingProject: ExistingProjectInfo | null
  /** Workspace chosen on the Welcome screen; seeds the input on entry. */
  workspace?: string
  /** Entry mode; drives which sections lead (spawn → manual spawn open). */
  mode?: WorkspaceMode
  /** Current layout mode for the terminal grid; passed through to ViewPanel. */
  layoutMode?: LayoutMode
  /** All pipeline summaries from usePipelines. */
  pipelines?: PipelineSummary[]
  /** Currently active pipeline id (global). */
  activePipelineId?: string
}

const props = defineProps<Props>()

// Build tag injected at build time (electron.vite.config.ts) so the header
// shows exactly which build is running — avoids confusion over which version
// is live when juggling worktrees / uncommitted changes.
const buildTag = typeof __APP_BUILD__ === 'string' ? __APP_BUILD__ : 'dev'

const emit = defineEmits<{
  (e: 'spawn', payload: SpawnPayload): void
  (e: 'kill', paneId: string): void
  (e: 'kill-all'): void
  (e: 'interrupt', paneId: string): void
  (e: 'reinject', paneId: string): void
  (e: 'restore', paneId: string): void
  (e: 'pipeline-start', payload: { task: string; workspacePath: string; pipelineId?: string }): void
  (e: 'pipeline-next'): void
  (e: 'pipeline-abort'): void
  (e: 'pipeline-reset'): void
  (e: 'update:yoloEnabled', v: boolean): void
  (e: 'update:analyzerModel', v: string): void
  (e: 'update:autoAnswerEnabled', v: boolean): void
  (e: 'refresh-analyzer'): void
  (e: 'workspace-check', path: string): void
  (e: 'pipeline-resume'): void
  (e: 'pipeline-restart', payload: { task: string; workspacePath: string }): void
  (e: 'focus-pane', paneId: string): void
  (e: 'open-settings'): void
  (e: 'open-history'): void
  (e: 'switch-workspace'): void
  (e: 'workspace-browse', path: string): void
  (e: 'update:layoutMode', v: LayoutMode): void
}>()

const yoloLocal = computed<boolean>({
  get: () => props.yoloEnabled,
  set: (v) => emit('update:yoloEnabled', v)
})

const analyzerModelLocal = computed<string>({
  get: () => props.analyzerModel || props.analyzerStatus.defaultModel,
  set: (v) => emit('update:analyzerModel', v)
})

// Only show models that passed the benchmark (or all if no results yet)
const filteredModels = computed<AnalyzerModelOption[]>(() => {
  const results = props.analyzerStatus.benchmarkResults
  if (!results || results.length === 0) return props.analyzerStatus.models
  const passMap = new Map(results.map((r) => [r.name, r.passed]))
  return props.analyzerStatus.models.filter((m) => passMap.get(m.name) !== false)
})

const autoAnswerLocal = computed<boolean>({
  get: () => props.autoAnswerEnabled,
  set: (v) => emit('update:autoAnswerEnabled', v)
})

const workspacePath = ref<string>('')
const isTaskDragOver = ref(false)
// Workspace selected on the Welcome screen flows in here; the user can still
// edit / re-browse afterwards. Writing it triggers the workspace-check watch
// below, so picking a workspace auto-detects any existing project.
watch(
  () => props.workspace,
  (v) => {
    const next = v ?? ''
    if (next !== workspacePath.value) workspacePath.value = next
  },
  { immediate: true }
)
// Task description uses sessionStorage so it survives Vite HMR / component
// re-mounts within the same app session, but NOT across app restarts. The
// previous localStorage-based approach made stale text linger forever even
// after the pipeline finished and the app was relaunched.
const TASK_DESC_KEY = 'agentTeam.pipelineTaskDescription'
// One-time migration: nuke the old localStorage entry left over from when
// this field used to persist forever. Without this, users who upgrade will
// still see their old task text on first launch after the fix.
try { localStorage.removeItem(TASK_DESC_KEY) } catch { /* ignore */ }
const taskDescription = ref<string>(
  (() => { try { return sessionStorage.getItem(TASK_DESC_KEY) ?? '' } catch { return '' } })()
)
watch(taskDescription, (v) => {
  try { sessionStorage.setItem(TASK_DESC_KEY, v) } catch { /* ignore */ }
})
// Secondary safety net: if parent has an authoritative task (e.g. pipeline is
// running) and our local copy is empty, mirror it back. Never overwrite a
// non-empty local edit.
watch(
  () => props.pipeline.task,
  (parentTask) => {
    if (parentTask && taskDescription.value.trim() === '') {
      taskDescription.value = parentTask
    }
  },
  { immediate: true }
)
// When the user explicitly resets the pipeline (Reset button → state='idle'
// AND parent task cleared), also wipe the local textarea + sessionStorage so
// they start fresh next time.
watch(
  () => [props.pipeline.state, props.pipeline.task] as const,
  ([state, parentTask]) => {
    if (state === 'idle' && !parentTask) {
      taskDescription.value = ''
      try { sessionStorage.removeItem(TASK_DESC_KEY) } catch { /* ignore */ }
    }
  }
)
const pickingWorkspace = ref<boolean>(false)
const confirmingRestart = ref<boolean>(false)

function startOverNow(): void {
  if (!props.existingProject) {
    confirmingRestart.value = false
    return
  }
  const task = props.existingProject.taskDescription || taskDescription.value.trim()
  if (!task || !workspacePath.value.trim()) {
    confirmingRestart.value = false
    return
  }
  emit('pipeline-restart', { task, workspacePath: workspacePath.value.trim() })
  confirmingRestart.value = false
}

async function pickWorkspace(): Promise<void> {
  if (!window.agentTeam?.pickWorkspace) return
  pickingWorkspace.value = true
  try {
    const picked = await window.agentTeam.pickWorkspace(workspacePath.value || undefined)
    if (picked) emit('workspace-browse', picked)
  } finally {
    pickingWorkspace.value = false
  }
}

// Debounced peek for existing project whenever the workspace path stabilises.
let workspaceDebounce: number | null = null
watch(workspacePath, (v) => {
  if (workspaceDebounce !== null) window.clearTimeout(workspaceDebounce)
  workspaceDebounce = window.setTimeout(() => {
    emit('workspace-check', v.trim())
  }, 400)
}, { immediate: true })

// Classify a supervision-log line so errors stand out (red) and warnings
// (yellow) from the normal grey flow. Matches the markers pipelineLog() emits:
// ❌/✕/✗ + words like error/failed/threw/exception/unreachable/rejection → error;
// ⚠ → warning. Everything else stays default.
function logLevel(line: string): '' | 'is-error' | 'is-warn' {
  if (/❌|✕|✗|exception|unreachable|rejection|\berror\b|\bfailed\b|\bthrew\b/i.test(line)) {
    return 'is-error'
  }
  if (/⚠/.test(line)) return 'is-warn'
  return ''
}

// Auto-scroll pipeline log to bottom whenever a new entry arrives.
const pipelineLogRef = ref<HTMLElement | null>(null)
watch(
  () => props.pipeline.log.length,
  async () => {
    await nextTick()
    if (pipelineLogRef.value) {
      pipelineLogRef.value.scrollTop = pipelineLogRef.value.scrollHeight
    }
  }
)

defineExpose({ openPipelineDetail })

function shortPath(p: string): string {
  if (!p) return ''
  const home = '/Users/'
  if (p.startsWith(home)) {
    const rest = p.slice(home.length)
    const slash = rest.indexOf('/')
    if (slash > 0) return '~/' + rest.slice(slash + 1)
  }
  return p
}

async function openPath(p: string): Promise<void> {
  if (!p) return
  if (!window.agentTeam?.openPath) {
    // Fallback: copy to clipboard
    try {
      await navigator.clipboard.writeText(p)
    } catch {
      /* ignore */
    }
    return
  }
  await window.agentTeam.openPath(p)
}
const pickedAgent = ref<string>(props.agentSpecs[0]?.agentKey ?? 'claude')
const pickedRole = ref<RoleKey>('')

// ── Pipeline two-layer navigation ─────────────────────────────────────────────
const sidebarView = ref<'list' | 'pipeline'>('list')
const openedPipelineId = ref<string>('')

const openedPipeline = computed(
  () => props.pipelines?.find((p) => p.id === openedPipelineId.value) ?? null
)

function openPipelineDetail(id: string): void {
  openedPipelineId.value = id
  sidebarView.value = 'pipeline'
}

function backToList(): void {
  sidebarView.value = 'list'
}

function isPipelineRunning(pipelineId: string): boolean {
  return pipelineId === (props.activePipelineId ?? '') && props.pipeline.state === 'running'
}

// ── Pipeline list pagination ───────────────────────────────────────────────
const PIPELINE_PAGE_SIZE = 5
const pipelinePage = ref(0)
const pipelinePageCount = computed(() =>
  Math.ceil((props.pipelines?.length ?? 0) / PIPELINE_PAGE_SIZE)
)
const pagedPipelines = computed(() => {
  const start = pipelinePage.value * PIPELINE_PAGE_SIZE
  return (props.pipelines ?? []).slice(start, start + PIPELINE_PAGE_SIZE)
})
watch(() => props.pipelines?.length, () => { pipelinePage.value = 0 })

const previewOpen = ref<boolean>(false)
const manualSpawnOpen = ref<boolean>(false)
const pipelineOpen = ref<boolean>(true)
// Mode-driven default: spawn workspaces lead with manual spawn expanded;
// pipeline / completed workspaces collapse it so the pipeline controls lead.
// Only sets the default on mode changes — the user can toggle freely after.
watch(
  () => props.mode,
  (m) => {
    if (m) manualSpawnOpen.value = m === 'spawn'
  },
  { immediate: true }
)

const currentRole = computed<Role | undefined>(() =>
  props.roles.find((r) => r.key === pickedRole.value)
)

// Keep pickedRole valid when the roles registry mutates from any window.
watch(
  () => props.roles,
  (rs) => {
    if (rs.length === 0) return
    if (pickedRole.value && !rs.find((r) => r.key === pickedRole.value)) pickedRole.value = ''
  },
  { immediate: true }
)

async function openRolesWindow(): Promise<void> {
  if (!window.agentTeam?.openRolesWindow) return
  await window.agentTeam.openRolesWindow()
}

async function openStagesWindow(): Promise<void> {
  if (!window.agentTeam?.openStagesWindow) return
  await window.agentTeam.openStagesWindow()
}

const canSpawn = computed(
  () => props.backendStatus === 'connected' && workspacePath.value.trim().length > 0
)

// Stage count for the pipeline currently being viewed (may differ from active pipeline)
const effectiveStageCount = computed(() => {
  if (!openedPipelineId.value || openedPipelineId.value === (props.activePipelineId ?? '')) {
    return props.stages.length
  }
  return openedPipeline.value?.stage_count ?? 0
})

const canRunPipeline = computed(
  () =>
    props.backendStatus === 'connected' &&
    workspacePath.value.trim().length > 0 &&
    taskDescription.value.trim().length > 0 &&
    props.pipeline.state !== 'running' &&
    effectiveStageCount.value > 0
)

function spawn(): void {
  if (!canSpawn.value) return
  emit('spawn', {
    agentKey: pickedAgent.value,
    roleKey: pickedRole.value,
    stageId: '',
    workspacePath: workspacePath.value.trim()
  })
}

function startPipeline(): void {
  if (!canRunPipeline.value) return
  emit('pipeline-start', {
    task: taskDescription.value.trim(),
    workspacePath: workspacePath.value.trim(),
    // Pass the opened pipeline id so App.vue activates it first if it differs from active
    pipelineId: openedPipelineId.value || undefined,
  })
  backToList()
}

const statusColor = computed(() => {
  switch (props.backendStatus) {
    case 'connected':
      return '#3fb950'
    case 'connecting':
    case 'starting':
      return '#d29922'
    case 'disconnected':
      return '#8b949e'
    default:
      return '#f85149'
  }
})

const runningCount = computed(
  () => props.panes.filter((p) => p.status === 'running' || p.status === 'starting').length
)

const pipelineProgress = computed(() => {
  const total = props.pipeline.totalStages || props.stages.length || 1
  if (props.pipeline.state === 'idle') return 0
  if (props.pipeline.state === 'completed') return 100
  return Math.round(((props.pipeline.stageIndex + 1) / total) * 100)
})

const pipelineCurrentStage = computed<Stage | null>(() => {
  if (props.pipeline.state !== 'running') return null
  return props.stages[props.pipeline.stageIndex] ?? null
})

const pipelineNextStage = computed<Stage | null>(() => {
  if (props.pipeline.state !== 'running') return null
  return props.stages[props.pipeline.stageIndex + 1] ?? null
})

function injectionLabel(status: ActivePaneView['injectionStatus']): string {
  switch (status) {
    case 'pending':
      return 'role: waiting'
    case 'scheduled':
      return 'role: injecting'
    case 'sent':
      return 'role: injected'
    case 'failed':
      return 'role: inject failed'
    case 'skipped':
      return 'role: skipped'
  }
}

function kickoffLabel(status?: ActivePaneView['kickoffStatus']): string {
  if (!status || status === 'none') return ''
  switch (status) {
    case 'pending':
      return '· kickoff: queued'
    case 'sent':
      return '· kickoff: sent'
    case 'failed':
      return '· kickoff: failed'
  }
}

function extractDropPaths(e: DragEvent): string[] {
  const dt = e.dataTransfer
  if (!dt) return []
  const getPath = window.agentTeam?.getPathForFile
  if (!getPath) return []

  const sources: File[] = dt.items?.length
    ? Array.from(dt.items).filter(i => i.kind === 'file').map(i => i.getAsFile()).filter((f): f is File => f !== null)
    : Array.from(dt.files)

  return sources.map(f => getPath(f)).filter(Boolean)
}

function onWorkspaceDrop(e: DragEvent): void {
  const paths = extractDropPaths(e)
  if (!paths.length) return
  workspacePath.value = paths[0]
}

function onTaskDrop(e: DragEvent): void {
  isTaskDragOver.value = false
  const paths = extractDropPaths(e)
  if (!paths.length) return
  const text = paths.join(' ')
  const el = e.target as HTMLTextAreaElement
  const start = el.selectionStart ?? taskDescription.value.length
  taskDescription.value =
    taskDescription.value.slice(0, start) + text + taskDescription.value.slice(start)
}
</script>

<template>
  <aside class="sidebar">
    <header class="brand">
      <div class="brand-row">
        <h2>Agent-Team</h2>
        <span class="dot" :style="{ background: statusColor }"></span>
        <button class="gear-btn" @click="emit('open-settings')" title="Settings">⚙</button>
      </div>
      <div class="brand-sub">
        backend {{ backendStatus }} <span v-if="backendUrl">· {{ backendUrl }}</span>
      </div>
      <div class="build-tag" title="目前執行的 build 版本">🏷 build {{ buildTag }}</div>
    </header>

    <section v-if="sidebarView === 'list'" class="block panel-section">
      <label class="lbl">Workspace</label>
      <div class="row workspace-row">
        <input
          v-model="workspacePath"
          type="text"
          placeholder="/absolute/path/to/project"
          spellcheck="false"
          autocorrect="off"
          @dragover.prevent
          @drop.prevent="onWorkspaceDrop"
        />
        <button
          class="ghost browse"
          :disabled="pickingWorkspace"
          @click="pickWorkspace"
          title="Pick folder via native dialog"
        >
          {{ pickingWorkspace ? '…' : '📁 Browse' }}
        </button>
        <button
          v-if="workspacePath"
          class="ghost switch-ws"
          @click="emit('switch-workspace')"
          title="Switch / close workspace (back to Welcome)"
        >
          ↺
        </button>
      </div>
      <label class="checkbox-row">
        <input v-model="yoloLocal" type="checkbox" />
        <span>
          <strong>YOLO mode</strong> — auto-bypass permission prompts
          <span class="muted-inline">(claude / codex / gemini)</span>
        </span>
      </label>
    </section>

    <!-- ── Pipeline list (list view only) ───────────────────────────────── -->
    <section v-if="sidebarView === 'list'" class="block panel-section">
      <label class="lbl">Pipelines</label>
      <ul v-if="pipelines && pipelines.length && pipeline.state !== 'running' && pipeline.state !== 'aborted'" class="pipeline-list">
        <li
          v-for="p in pagedPipelines"
          :key="p.id"
          class="pipeline-item"
          :class="{ 'pipeline-active': p.id === activePipelineId }"
          @click="openPipelineDetail(p.id)"
        >
          <span class="pipeline-item-name">{{ p.name }}</span>
          <span class="pipeline-item-meta">{{ p.stage_count }} 階段</span>
          <span
            class="pipeline-item-badge"
            :class="isPipelineRunning(p.id) ? 'running'
              : p.id === activePipelineId && pipeline.state === 'completed' ? 'done'
              : existingProject?.pipelineId === p.id && existingProject?.nextStageIndex < 0 ? 'done'
              : 'idle'"
          >
            {{ isPipelineRunning(p.id) ? '● running'
              : p.id === activePipelineId && pipeline.state === 'completed' ? `✓ ${existingProject?.runCount ?? 1} done`
              : existingProject?.pipelineId === p.id && existingProject?.nextStageIndex < 0 ? `✓ ${existingProject.runCount} done`
              : '○ idle' }}
          </span>
        </li>
      </ul>
      <p v-else-if="pipeline.state !== 'running' && pipeline.state !== 'aborted'" class="hint">尚未載入 pipelines…</p>
      <div v-if="pipelinePageCount > 1 && pipeline.state !== 'running' && pipeline.state !== 'aborted'" class="pipeline-pagination">
        <button class="ghost pg-btn" :disabled="pipelinePage === 0" @click="pipelinePage--">‹</button>
        <span class="pg-info">{{ pipelinePage + 1 }} / {{ pipelinePageCount }}</span>
        <button class="ghost pg-btn" :disabled="pipelinePage >= pipelinePageCount - 1" @click="pipelinePage++">›</button>
      </div>
      <!-- ── Resume card (workspace re-opened with unfinished pipeline) ── -->
      <template v-if="pipeline.state !== 'running' && existingProject && existingProject.state !== 'idle' && existingProject.nextStageIndex >= 0">
        <div class="pipeline-running-divider"></div>
        <div class="resume-card">
          <div class="resume-head">
            <strong>↻ Resume existing pipeline</strong>
            <span class="resume-state" :data-state="existingProject.state">{{ existingProject.state }}</span>
          </div>
          <div class="resume-meta">
            <span>{{ existingProject.stagesCompleted }}/{{ existingProject.totalStages }} stages done</span>
            <span class="dot">·</span>
            <span>updated {{ existingProject.updatedAt }}</span>
          </div>
          <div v-if="existingProject.taskDescription" class="resume-task">
            {{ existingProject.taskDescription.length > 200
              ? existingProject.taskDescription.slice(0, 200) + '…'
              : existingProject.taskDescription }}
          </div>
          <div class="row">
            <button class="primary wide" @click="emit('pipeline-resume')">
              ▶ Resume from Stage {{ String(existingProject.nextStageIndex + 1).padStart(2, '0') }}
            </button>
            <button
              class="danger"
              @click="confirmingRestart = true"
              title="Discard all stage progress and re-run from Stage 01"
            >
              ↺ Start over
            </button>
          </div>
        </div>
      </template>

      <!-- ── Running widget inline ── -->
      <template v-if="pipeline.state === 'running' || pipeline.state === 'aborted'">
        <div class="pipeline-running-divider"></div>
        <div class="pipeline-running-name">
          <div class="prn-title">
            ▶ {{ pipelines?.find(p => p.id === activePipelineId)?.name ?? 'Pipeline' }}
          </div>
          <div v-if="pipeline.task" class="prn-task">{{ pipeline.task }}</div>
          <div class="prn-meta">
            <span v-if="autoAnswerEnabled" class="prn-auto">🤖 Full auto · {{ analyzerModelLocal }}</span>
            <span v-else class="prn-manual">手動確認</span>
          </div>
        </div>
        <div v-if="pipeline.state === 'running'" class="pipeline-running">
          <div class="progress">
            <div class="bar" :style="{ width: pipelineProgress + '%' }"></div>
          </div>
          <div class="pipeline-line">
            Stage {{ pipeline.stageIndex + 1 }} / {{ pipeline.totalStages }}
            <span v-if="pipelineCurrentStage" class="muted">· {{ pipelineCurrentStage.shortTitle }}</span>
          </div>
          <div class="row pipeline-row">
            <button class="primary wide" :disabled="!pipelineNextStage" @click="emit('pipeline-next')">
              {{ pipelineNextStage ? `Next → ${pipelineNextStage.shortTitle}` : 'Finish' }}
            </button>
            <button class="danger" @click="emit('pipeline-abort')">Abort</button>
          </div>
        </div>
        <p v-else-if="pipeline.state === 'aborted'" class="hint warn">
          Pipeline aborted. Agents are kept — Resume to continue, or Reset to clear.
        </p>
        <div v-if="pipeline.log.length > 0" ref="pipelineLogRef" class="pipeline-log">
          <div v-for="(line, i) in pipeline.log" :key="i" class="pipeline-log-line" :class="logLevel(line)">{{ line }}</div>
        </div>
      </template>
    </section>

    <!-- ── Pipeline detail header (back + name only) ─────────────────────── -->
    <template v-if="sidebarView === 'pipeline'">
      <section class="block pipeline-detail-header">
        <div class="pipeline-detail-nav">
          <button class="ghost back-btn" @click="backToList">← 返回</button>
          <span class="pipeline-detail-name">{{ openedPipeline?.name ?? openedPipelineId }}</span>
          <span v-if="openedPipelineId === activePipelineId" class="active-tag">預設</span>
        </div>
      </section>
    </template>

    <section v-if="sidebarView === 'pipeline'" class="block" :class="{ pipeline: pipelineOpen }">
      <button class="lbl collapsible-header" @click="pipelineOpen = !pipelineOpen">
        {{ pipelineOpen ? '▾' : '▸' }} {{ openedPipeline?.name ?? 'Pipeline' }} · {{ effectiveStageCount }}-stage
      </button>
      <template v-if="pipelineOpen">
      <div
        v-if="
          existingProject &&
          pipeline.state !== 'running' &&
          existingProject.state !== 'idle' &&
          existingProject.nextStageIndex >= 0
        "
        class="resume-card"
      >
        <div class="resume-head">
          <strong>↻ Resume existing pipeline</strong>
          <span class="resume-state" :data-state="existingProject.state">{{ existingProject.state }}</span>
        </div>
        <div class="resume-meta">
          <span>{{ existingProject.stagesCompleted }}/{{ existingProject.totalStages }} stages done</span>
          <span class="dot">·</span>
          <span>updated {{ existingProject.updatedAt }}</span>
        </div>
        <div v-if="existingProject.taskDescription" class="resume-task">
          {{ existingProject.taskDescription.length > 200
            ? existingProject.taskDescription.slice(0, 200) + '…'
            : existingProject.taskDescription }}
        </div>
        <div class="row">
          <button class="primary wide" @click="emit('pipeline-resume')">
            ▶ Resume from Stage {{ String(existingProject.nextStageIndex + 1).padStart(2, '0') }}
          </button>
          <button
            class="danger"
            @click="confirmingRestart = true"
            title="Discard all stage progress and re-run from Stage 01"
          >
            ↺ Start over
          </button>
        </div>
      </div>
      <div
        v-else-if="existingProject && existingProject.nextStageIndex < 0 && openedPipelineId === activePipelineId"
        class="resume-card done"
      >
        <div class="done-header">
          <strong>✓ Project completed</strong>
          <span class="resume-meta">
            All {{ existingProject.totalStages }} stages done · {{ existingProject.updatedAt }}
          </span>
        </div>
      </div>

      <textarea
        v-model="taskDescription"
        :disabled="pipeline.state === 'running'"
        :class="{ 'drag-over': isTaskDragOver }"
        placeholder="Describe the task to drive through all 4 stages. e.g. &#10;&quot;為門市建立內部簽核系統，紙本流程數位化…&quot;"
        rows="3"
        spellcheck="false"
        @dragover.prevent
        @dragenter.prevent="isTaskDragOver = true"
        @dragleave="isTaskDragOver = false"
        @drop.prevent="onTaskDrop"
      ></textarea>
      <label class="checkbox-row">
        <input v-model="autoAnswerLocal" type="checkbox" :disabled="!analyzerStatus.available" />
        <span>
          <strong>🤖 Full auto</strong>
          <span v-if="!analyzerStatus.available" class="muted-inline"> — needs Ollama</span>
          <span v-else class="muted-inline"> — LLM auto-answers all agent questions</span>
        </span>
      </label>
      <div v-if="analyzerStatus.available" class="analyzer-row">
        <label class="lbl tiny">Model</label>
        <select v-model="analyzerModelLocal">
          <option v-for="m in filteredModels" :key="m.name" :value="m.name">
            {{ m.name }} · {{ m.parameter_size || (m.size / 1e9).toFixed(1) + 'GB' }}
          </option>
        </select>
        <button
          class="ghost refresh"
          @click="emit('refresh-analyzer')"
          title="Refresh Ollama health + model list"
        >
          ↻
        </button>
      </div>
      <div v-else class="analyzer-row">
        <span class="muted-inline">Ollama unreachable.</span>
        <button class="ghost refresh" @click="emit('refresh-analyzer')" title="Retry connection">
          ↻ Retry
        </button>
      </div>
      <div v-if="pipeline.state === 'idle' || pipeline.state === 'completed' || pipeline.state === 'aborted'" class="row pipeline-row">
        <button class="primary wide" :disabled="!canRunPipeline" @click="startPipeline">
          ▶ Run pipeline
        </button>
        <button
          v-if="pipeline.state !== 'idle'"
          class="ghost"
          @click="emit('pipeline-reset')"
          title="Clear pipeline state and close all agent panes"
        >
          Reset
        </button>
      </div>
      <div v-else class="pipeline-running">
        <div class="progress">
          <div class="bar" :style="{ width: pipelineProgress + '%' }"></div>
        </div>
        <div class="pipeline-line">
          Stage {{ pipeline.stageIndex + 1 }} / {{ pipeline.totalStages }}
          <span v-if="pipelineCurrentStage" class="muted">
            · {{ pipelineCurrentStage.shortTitle }}
          </span>
        </div>
        <div class="row pipeline-row">
          <button
            class="primary wide"
            :disabled="!pipelineNextStage"
            @click="emit('pipeline-next')"
          >
            {{ pipelineNextStage ? `Next → ${pipelineNextStage.shortTitle}` : 'Finish' }}
          </button>
          <button class="danger" @click="emit('pipeline-abort')">Abort</button>
        </div>
      </div>
      <p v-if="pipeline.state === 'completed'" class="hint ok">
        ✓ Pipeline completed all 4 stages. Review each pane on the right.
      </p>
      <p v-else-if="pipeline.state === 'aborted'" class="hint warn">
        Pipeline aborted (paused). Agents are kept — Resume to continue, or Reset to clear.
      </p>
      <p v-else-if="pipeline.state === 'idle' && !canRunPipeline" class="hint">
        Provide task description + workspace, then start.
      </p>
      <div v-if="pipeline.projectId && openedPipelineId === activePipelineId" class="paths">
        <div class="paths-line">
          <span class="paths-key">project</span>
          <code :title="pipeline.projectFile">{{ shortPath(pipeline.projectFile) }}</code>
        </div>
        <div class="paths-line">
          <span class="paths-key">events</span>
          <code :title="pipeline.pipelineLogFile">{{ shortPath(pipeline.pipelineLogFile) }}</code>
        </div>
        <div class="paths-line">
          <span class="paths-key">backend</span>
          <code :title="pipeline.backendLogFile">{{ shortPath(pipeline.backendLogFile) }}</code>
        </div>
        <div class="row tight">
          <button class="ghost" @click="openPath(pipeline.projectFile)" title="Open project.json">
            📄 project.json
          </button>
          <button class="ghost" @click="openPath(pipeline.pipelineLogFile)" title="Open pipeline.log">
            📜 pipeline.log
          </button>
          <button class="ghost" @click="openPath(pipeline.backendLogFile)" title="Open backend.log">
            🪵 backend.log
          </button>
        </div>
      </div>
      <div v-if="pipeline.log.length > 0 && openedPipelineId === activePipelineId" ref="pipelineLogRef" class="pipeline-log">
        <div v-for="(line, i) in pipeline.log" :key="i" class="pipeline-log-line" :class="logLevel(line)">{{ line }}</div>
      </div>
      </template>
    </section>

    <section v-if="sidebarView === 'list'" class="block panel-section">
      <div class="row between">
        <label class="lbl">Active agents ({{ runningCount }}/{{ panes.length }})</label>
        <div class="agent-header-actions">
          <ViewPanel
            :model-value="layoutMode ?? 'auto'"
            @update:model-value="emit('update:layoutMode', $event)"
          />
          <button class="history-btn" @click="emit('open-history')">📋 History</button>
        </div>
      </div>
      <div v-if="panes.length === 0" class="empty">No agents running.</div>
      <ul v-else class="agent-list">
        <li v-for="p in panes" :key="p.id" class="agent-item" :class="{ pipeline: p.origin === 'pipeline', manager: p.isCommander, minimized: p.isMinimized }">
          <div class="agent-line" role="button" title="Focus pane" @click="emit('focus-pane', p.id)">
            <span v-if="p.origin === 'pipeline'" class="pipe-tag">P{{ p.stageId }}</span>
            <span class="badge">{{ p.agentLabel }}</span>
            <span class="badge role">{{ p.roleLabel }}</span>
            <span v-if="p.isMinimized" class="minimized-tag">▪ sidebar</span>
            <span v-else class="state" :data-state="p.status">{{ p.status }}</span>
          </div>
          <div v-if="p.isCommander && !p.isMinimized" class="manager-row">
            <span class="badge manager-badge" title="本階段的 Manager — 控場、決定 ---STAGE-DONE---">🎯 Manager</span>
          </div>
          <div v-if="!p.isMinimized && p.origin === 'pipeline'" class="stage-line">
            stage {{ p.stageId }} · {{ injectionLabel(p.injectionStatus) }} {{ kickoffLabel(p.kickoffStatus) }}
          </div>
          <div v-else-if="!p.isMinimized" class="stage-line">
            manual · {{ injectionLabel(p.injectionStatus) }} {{ kickoffLabel(p.kickoffStatus) }}
          </div>
          <div v-if="!p.isMinimized" class="agent-cmd"><code>{{ p.command }}</code></div>
          <div v-if="!p.isMinimized && p.sessionId" class="agent-session" title="CLI session id — used to resume this agent's memory on restart">
            🔖 session: <code>{{ p.sessionId }}</code>
          </div>
          <div v-if="p.error" class="err">{{ p.error }}</div>
          <div class="row tight">
            <template v-if="p.isMinimized">
              <button class="ghost" @click="emit('restore', p.id)">↑ 還原</button>
              <button class="danger" @click="emit('kill', p.id)">Remove</button>
            </template>
            <template v-else>
              <button class="ghost" @click="emit('interrupt', p.id)" :disabled="p.status !== 'running'">
                Interrupt
              </button>
              <button class="ghost" @click="emit('reinject', p.id)" :disabled="p.status !== 'running' || !p.roleKey">
                Reapply role
              </button>
              <button class="danger" @click="emit('kill', p.id)">Remove</button>
            </template>
          </div>
        </li>
      </ul>

      <hr class="section-divider" />
      <button class="lbl collapsible-header" @click="manualSpawnOpen = !manualSpawnOpen">
        {{ manualSpawnOpen ? '▾' : '▸' }} Manual spawn
      </button>
      <template v-if="manualSpawnOpen">
        <div class="row two-col">
          <select v-model="pickedAgent">
            <option v-for="spec in agentSpecs" :key="spec.agentKey" :value="spec.agentKey">
              {{ spec.label }}
            </option>
          </select>
          <select v-model="pickedRole">
            <option value="">Select role…</option>
            <option v-for="r in roles" :key="r.key" :value="r.key">{{ r.label }}</option>
          </select>
        </div>
        <button class="primary" :disabled="!canSpawn" @click="spawn">+ Add to grid</button>
        <p v-if="!canSpawn" class="hint warn">
          {{ backendStatus !== 'connected' ? 'Waiting for backend…' : 'Set workspace path first' }}
        </p>

        <div v-if="currentRole" class="prompt-block">
          <div class="prompt-head">
            <button class="link" @click="previewOpen = !previewOpen">
              {{ previewOpen ? '▾' : '▸' }} {{ currentRole.label }} system prompt
            </button>
            <button class="link tiny" @click="emit('open-settings')" title="Open Settings">
              ⚙ Settings
            </button>
          </div>
          <p class="role-line">{{ currentRole.one_line }}</p>
          <pre v-if="previewOpen" class="prompt-preview">{{ currentRole.system_prompt }}</pre>
        </div>
        <div v-else class="prompt-block warn-block">
          <p class="warn">
            {{ roles.length === 0 ? 'No roles available. Open the manager to add one.' : 'No role selected. The agent will start without role injection.' }}
          </p>
          <div v-if="roles.length === 0" class="row tight">
            <button class="ghost" @click="emit('open-settings')">⚙ Open Settings</button>
          </div>
        </div>
      </template>
    </section>

    <Teleport to="body">
      <div v-if="confirmingRestart" class="restart-modal" @click.self="confirmingRestart = false">
        <div class="restart-card">
          <h3>↺ Start pipeline over from Stage 01?</h3>
          <p v-if="existingProject">
            This will <strong>discard the current project state</strong>
            ({{ existingProject.stagesCompleted }}/{{ existingProject.totalStages }} stages recorded
            as completed) and re-run from the beginning using the same task description.
          </p>
          <div v-if="existingProject?.taskDescription" class="restart-task">
            {{ existingProject.taskDescription.length > 240
              ? existingProject.taskDescription.slice(0, 240) + '…'
              : existingProject.taskDescription }}
          </div>
          <p class="restart-warn">
            Existing pipeline.log is preserved (events keep appending).
            project.json's stage records will be reset to pending.
          </p>
          <div class="restart-actions">
            <button class="ghost" @click="confirmingRestart = false">Cancel</button>
            <button class="danger" @click="startOverNow">↺ Wipe &amp; restart</button>
          </div>
        </div>
      </div>
    </Teleport>
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  background: #0d1117;
  border-right: 1px solid #21262d;
  color: #c9d1d9;
  font-size: 12px;
  overflow-y: auto;
}
.brand {
  border-bottom: 1px solid #21262d;
  padding-bottom: 10px;
}
.brand-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.gear-btn {
  margin-left: auto;
  background: none;
  border: none;
  color: #8b949e;
  font-size: 14px;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
  line-height: 1;
  transition: color 0.15s, background 0.15s;
}
.gear-btn:hover {
  color: #e6edf3;
  background: #21262d;
}
.brand h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.brand-sub {
  color: #8b949e;
  font-size: 10px;
  margin-top: 4px;
  word-break: break-all;
}
.build-tag {
  color: #6e7681;
  font-size: 10px;
  margin-top: 2px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  word-break: break-all;
}
.block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.panel-section {
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 8px 10px;
  background: #161b22;
}
.section-divider {
  border: none;
  border-top: 1px solid #30363d;
  margin: 8px 0;
}
.lbl {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #8b949e;
}
button.collapsible-header {
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 0;
  text-align: left;
}
button.collapsible-header:hover {
  color: #e6edf3;
}
input[type='text'],
select,
textarea {
  background: #161b22;
  border: 1px solid #30363d;
  color: #e6edf3;
  padding: 6px 8px;
  border-radius: 4px;
  font-family: inherit;
  font-size: 12px;
  box-sizing: border-box;
  width: 100%;
}
textarea {
  font-family: Menlo, Monaco, 'Courier New', monospace;
  resize: vertical;
}
input[type='text']:focus,
select:focus,
textarea:focus {
  outline: none;
  border-color: #1f6feb;
}
textarea.drag-over {
  border-color: #388bfd;
  box-shadow: inset 0 0 0 1px #388bfd, 0 0 0 2px #388bfd44;
}
.row {
  display: flex;
  gap: 6px;
  align-items: center;
}
.row.two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.row.between {
  justify-content: space-between;
}
.row.tight {
  gap: 4px;
  margin-top: 4px;
}
.row.workspace-row {
  gap: 4px;
}
.row.workspace-row input {
  flex: 1;
}
.row.workspace-row .browse {
  flex-shrink: 0;
  white-space: nowrap;
  font-size: 11px;
  padding: 6px 10px;
}
.row.workspace-row .switch-ws {
  flex-shrink: 0;
  font-size: 13px;
  padding: 6px 9px;
  line-height: 1;
}
.checkbox-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 6px;
  font-size: 11px;
  color: #c9d1d9;
  cursor: pointer;
  user-select: none;
}
.checkbox-row input[type='checkbox'] {
  width: 14px;
  height: 14px;
  margin-top: 2px;
  accent-color: #d29922;
  flex-shrink: 0;
}
.checkbox-row strong {
  color: #d29922;
}
.analyzer-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: 22px;
}
.analyzer-row .lbl.tiny {
  font-size: 9px;
  margin: 0;
}
.analyzer-row select {
  flex: 1;
  font-size: 11px;
  padding: 4px 6px;
}
.analyzer-row .refresh {
  font-size: 11px;
  padding: 4px 8px;
  flex-shrink: 0;
}
.muted-inline {
  color: #6e7681;
  font-size: 10px;
}
.muted-inline {
  color: #6e7681;
  font-size: 10px;
}
.pipeline-row {
  margin-top: 4px;
}

button {
  border: 1px solid #30363d;
  background: #21262d;
  color: #e6edf3;
  font-size: 12px;
  padding: 6px 10px;
  border-radius: 4px;
  cursor: pointer;
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
button.wide {
  flex: 1;
}
button.primary {
  background: #238636;
  border-color: #2ea043;
  color: #fff;
  font-weight: 600;
}
button.primary:not(:disabled):hover {
  background: #2ea043;
}
button.danger {
  background: #6f1f1f;
  border-color: #8a2929;
  color: #f4d2d2;
}
button.danger:hover {
  background: #8a2929;
}
button.ghost {
  background: transparent;
}
button.ghost:hover:not(:disabled) {
  background: #21262d;
}
button.link {
  background: transparent;
  border: none;
  color: #58a6ff;
  font-size: 11px;
  padding: 2px 4px;
  text-align: left;
}
.agent-header-actions {
  display: flex;
  gap: 2px;
  align-items: center;
}
button.history-btn {
  background: transparent;
  border: 1px solid #30363d;
  color: #8b949e;
  font-size: 12px;
  padding: 0 8px;
  height: 32px;
  border-radius: 4px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
}
button.history-btn:hover {
  color: #e6edf3;
  border-color: #58a6ff;
  background: #161b22;
}
button.icon-btn {
  background: transparent;
  border: none;
  padding: 2px 4px;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  border-radius: 4px;
  opacity: 0.5;
}
button.icon-btn:hover {
  opacity: 1;
  background: #21262d;
}
button.icon-btn.muted {
  opacity: 0.3;
}
button.icon-btn.muted:hover {
  opacity: 0.8;
}
.hint {
  color: #8b949e;
  font-size: 10px;
  margin: 0;
  line-height: 1.5;
}
.hint.warn {
  color: #d29922;
}
.hint.ok {
  color: #3fb950;
}
/* ── Pipeline list styles ──────────────────────────────────────────────────── */
.pipeline-pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin-top: 6px;
}
.pg-btn {
  padding: 2px 8px;
  font-size: 14px;
  line-height: 1;
  min-width: 28px;
}
.pg-btn:disabled {
  opacity: 0.3;
  cursor: default;
}
.pg-info {
  font-size: 11px;
  color: #8b949e;
  min-width: 36px;
  text-align: center;
}
.pipeline-list {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.pipeline-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 4px;
  background: #161b22;
  border: 1px solid #21262d;
  cursor: pointer;
  transition: background 0.1s;
}
.pipeline-item:hover {
  background: #1c2128;
  border-color: #30363d;
}
.pipeline-item.pipeline-active {
  border-color: #1f6feb;
  background: #0d1a2e;
}
.pipeline-item-name {
  flex: 1;
  font-size: 12px;
  color: #e6edf3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pipeline-active .pipeline-item-name {
  color: #79c0ff;
}
.pipeline-item-meta {
  font-size: 10px;
  color: #6e7681;
  white-space: nowrap;
}
.pipeline-item-badge {
  font-size: 10px;
  white-space: nowrap;
}
.pipeline-item-badge.running {
  color: #3fb950;
}
.pipeline-item-badge.idle {
  color: #6e7681;
}
.pipeline-item-badge.done {
  color: #58a6ff;
}
.new-pipeline-row {
  margin-top: 6px;
  gap: 4px;
}
.new-pipeline-input {
  flex: 1;
  background: #010409;
  border: 1px solid #1f6feb;
  border-radius: 4px;
  color: #e6edf3;
  font-size: 12px;
  padding: 4px 6px;
}
/* ── Pipeline detail header ────────────────────────────────────────────────── */
.pipeline-detail-header {
  padding: 8px 10px;
}
.pipeline-detail-nav {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
  flex-wrap: wrap;
}
.back-btn {
  font-size: 11px;
  padding: 2px 6px;
  color: #8b949e;
}
.back-btn:hover {
  color: #e6edf3;
}
.pipeline-detail-name {
  font-size: 13px;
  font-weight: 600;
  color: #79c0ff;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pipeline-detail-actions {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  margin-top: 2px;
}
.active-tag {
  font-size: 10px;
  color: #3fb950;
  background: #1a2e1a;
  border: 1px solid #2ea04355;
  border-radius: 3px;
  padding: 1px 5px;
  white-space: nowrap;
}
.rename-input {
  flex: 1;
  background: #010409;
  border: 1px solid #1f6feb;
  border-radius: 4px;
  color: #e6edf3;
  font-size: 12px;
  padding: 3px 6px;
}
.hint code,
.agent-cmd code {
  background: #161b22;
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 10px;
}
.pipeline {
  background: #0b1a1f;
  border: 1px solid #1f3a3f;
  padding: 10px;
  border-radius: 6px;
}
.manual-spawn {
  background: #0b1a1f;
  border: 1px solid #1f3a3f;
  padding: 10px;
  border-radius: 6px;
}
.resume-card {
  background: #1a2030;
  border: 1px solid #2d3f5f;
  border-left: 3px solid #58a6ff;
  border-radius: 4px;
  padding: 8px 10px;
  margin-bottom: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.resume-card.done {
  border-left-color: #3fb950;
}
.resume-card.done .done-header {
  display: flex;
  align-items: center;
  gap: 10px;
}
.resume-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #c9d1d9;
}
.resume-state {
  margin-left: auto;
  font-size: 9px;
  text-transform: uppercase;
  padding: 2px 6px;
  border-radius: 999px;
  background: #21262d;
}
.resume-state[data-state='running'] {
  background: #1f6f43;
  color: #d2f4dc;
}
.resume-state[data-state='aborted'] {
  background: #6f1f1f;
  color: #f4d2d2;
}
.resume-state[data-state='completed'] {
  background: #1f3a5f;
  color: #79c0ff;
}
.resume-meta {
  font-size: 10px;
  color: #8b949e;
}
.resume-meta .dot {
  margin: 0 4px;
}
.resume-task {
  font-size: 11px;
  color: #c9d1d9;
  background: #010409;
  padding: 6px 8px;
  border-radius: 3px;
  white-space: pre-wrap;
  max-height: 80px;
  overflow-y: auto;
}
.restart-modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}
.restart-card {
  background: #0d1117;
  border: 1px solid #30363d;
  border-left: 4px solid #f85149;
  border-radius: 8px;
  padding: 20px 22px;
  width: min(480px, 90vw);
  color: #e6edf3;
  font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
  font-size: 13px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
}
.restart-card h3 {
  margin: 0 0 10px;
  font-size: 15px;
}
.restart-card p {
  margin: 8px 0;
  line-height: 1.6;
  color: #c9d1d9;
}
.restart-card .restart-warn {
  color: #8b949e;
  font-size: 11px;
}
.restart-task {
  background: #161b22;
  border: 1px solid #21262d;
  border-radius: 4px;
  padding: 8px 10px;
  font-family: Menlo, Monaco, monospace;
  font-size: 11px;
  margin: 8px 0;
  max-height: 120px;
  overflow-y: auto;
  white-space: pre-wrap;
}
.restart-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 12px;
}
.pipeline-running-divider {
  border-top: 1px solid #21262d;
  margin: 8px 0;
}
.pipeline-running-name {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 8px;
}
.prn-title {
  font-size: 11px;
  font-weight: 600;
  color: #3fb950;
  letter-spacing: 0.02em;
}
.prn-task {
  font-size: 11px;
  color: #e6edf3;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.prn-meta {
  font-size: 10px;
  color: #8b949e;
}
.prn-auto {
  color: #d29922;
}
.prn-manual {
  color: #8b949e;
}
.pipeline-running {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.progress {
  height: 6px;
  background: #161b22;
  border-radius: 999px;
  overflow: hidden;
}
.progress .bar {
  position: relative;
  height: 100%;
  background: linear-gradient(90deg, #1f6feb 0%, #388bfd 40%, #3fb950 100%);
  background-size: 200% 100%;
  transition: width 300ms ease;
  animation: bar-flow 2.5s linear infinite, bar-pulse 2s ease-in-out infinite;
}
.progress .bar::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(255, 255, 255, 0.25) 50%,
    transparent 100%
  );
  animation: bar-shimmer 1.8s ease-in-out infinite;
}
@keyframes bar-flow {
  0%   { background-position: 100% 0; }
  100% { background-position: -100% 0; }
}
@keyframes bar-shimmer {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(400%); }
}
@keyframes bar-pulse {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.82; }
}
.pipeline-line {
  font-size: 11px;
  font-weight: 600;
}
.pipeline-line .muted {
  color: #8b949e;
  font-weight: 400;
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
.paths {
  margin-top: 6px;
  padding: 6px 8px;
  background: #010409;
  border-radius: 4px;
  font-family: Menlo, Monaco, 'Courier New', monospace;
  font-size: 10px;
}
.paths-line {
  display: flex;
  gap: 6px;
  margin-bottom: 2px;
  align-items: baseline;
}
.paths-key {
  color: #8b949e;
  width: 50px;
  flex-shrink: 0;
}
.paths code {
  color: #e6edf3;
  background: transparent;
  padding: 0;
  word-break: break-all;
  font-size: 10px;
}
.empty {
  color: #6e7681;
  font-style: italic;
  padding: 8px 0;
}
.agent-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.agent-item {
  background: #161b22;
  border: 1px solid #21262d;
  border-radius: 4px;
  padding: 8px 10px;
}
.agent-item.pipeline {
  border-color: #1f3a5f;
  background: linear-gradient(180deg, #0d1f2f 0%, #161b22 100%);
}
.agent-item.manager {
  border-color: rgba(216, 180, 109, 0.5);
  box-shadow: 0 0 0 1px rgba(216, 180, 109, 0.15) inset;
}
.agent-line {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
  flex-wrap: wrap;
  cursor: pointer;
  border-radius: 4px;
  padding: 2px 4px;
  margin-left: -4px;
}
.agent-line:hover {
  background: #161b22;
}
.stage-line {
  color: #8b949e;
  font-size: 10px;
  margin-bottom: 4px;
}
.pipe-tag {
  font-size: 9px;
  font-weight: 700;
  background: #1f3a5f;
  color: #79c0ff;
  padding: 1px 5px;
  border-radius: 3px;
}
.badge {
  font-weight: 600;
  font-size: 10px;
  background: #21262d;
  padding: 2px 6px;
  border-radius: 4px;
  color: #c9d1d9;
}
.badge.role {
  background: #1f3a5f;
  color: #79c0ff;
}
.badge.manager-badge {
  background: rgba(216, 180, 109, 0.15);
  color: #d8b46d;
  border: 1px solid rgba(216, 180, 109, 0.35);
  letter-spacing: 0.3px;
}
.manager-row {
  /* Own row beneath .agent-line so the Manager pill never competes for
   * horizontal space with the agent / role badges. */
  margin: 2px 0 4px;
}
.state {
  margin-left: auto;
  font-size: 9px;
  text-transform: uppercase;
  padding: 2px 6px;
  border-radius: 999px;
  background: #21262d;
  color: #8b949e;
}
.state[data-state='running'] {
  background: #1f6f43;
  color: #d2f4dc;
}
.state[data-state='starting'] {
  background: #6f5b1f;
  color: #f4ecd2;
}
.state[data-state='error'] {
  background: #6f1f1f;
  color: #f4d2d2;
}
.state[data-state='exited'] {
  background: #3a3a3a;
}
/* Override ViewPanel's absolute positioning when used inline in the sidebar */
.agent-header-actions :deep(.view-panel) {
  position: static;
}
.agent-item.minimized {
  opacity: 0.7;
}
.minimized-tag {
  margin-left: auto;
  font-size: 10px;
  color: #58a6ff;
  background: #1a2d4a;
  border: 1px solid #1f6feb55;
  border-radius: 999px;
  padding: 2px 8px;
}
.agent-cmd {
  margin-bottom: 4px;
  word-break: break-all;
}
.agent-session {
  font-size: 10px;
  color: #8b949e;
  margin-bottom: 4px;
  word-break: break-all;
}
.agent-session code {
  color: #58a6ff;
}
.err {
  color: #f85149;
  font-size: 10px;
  margin: 4px 0;
}
.prompt-block {
  margin-top: 4px;
  padding: 6px 8px;
  background: #161b22;
  border: 1px solid #21262d;
  border-radius: 4px;
}
.role-line {
  margin: 4px 0 0;
  color: #8b949e;
  font-size: 10px;
}
.prompt-preview {
  margin: 6px 0 0;
  padding: 6px 8px;
  background: #010409;
  border-radius: 4px;
  font-size: 10px;
  line-height: 1.5;
  max-height: 220px;
  overflow: auto;
  white-space: pre-wrap;
  color: #e6edf3;
}
.prompt-head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.prompt-head .tiny {
  margin-left: auto;
  font-size: 10px;
}
.warn-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.warn-block .warn {
  color: #d29922;
  margin: 0;
}
</style>
