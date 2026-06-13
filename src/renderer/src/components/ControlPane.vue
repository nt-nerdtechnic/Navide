<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { extractDropPaths } from '../lib/drop'
import ViewPanel, { type LayoutMode } from './ViewPanel.vue'
import GitPane from './GitPane.vue'
import ExplorerPane from './ExplorerPane.vue'
import type { BackendStatus, useBackend } from '../composables/useBackend'
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
  preparationStatus?: 'starting' | 'checking-dialog' | 'settling' | 'injecting-role' | 'waiting-agent' | 'ready' | 'failed'
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
  /** Full backend instance — forwarded to GitPane for git operations. */
  backend?: ReturnType<typeof useBackend>
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
  // Send the path verbatim: folder names may legitimately end with a space
  // (e.g. Google Drive folders), and every source of this value (picker,
  // Welcome screen, drag-drop) already provides an exact filesystem path.
  emit('pipeline-restart', { task, workspacePath: workspacePath.value })
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
    emit('workspace-check', v)
  }, 400)
}, { immediate: true })
onUnmounted(() => {
  if (workspaceDebounce !== null) window.clearTimeout(workspaceDebounce)
  // Guard against unmounting mid-drag leaving stale document listeners.
  document.removeEventListener('mousemove', onPipelineDividerMove)
  document.removeEventListener('mouseup', onPipelineDividerEnd)
  document.removeEventListener('mousemove', onExplorerDividerMove)
  document.removeEventListener('mouseup', onExplorerDividerEnd)
})

defineExpose({ openPipelineDetail })

const manualAgentSpecs = computed(() =>
  props.agentSpecs.filter((spec) => spec.agentKey !== 'terminal')
)

const pickedAgent = ref<string>(manualAgentSpecs.value[0]?.agentKey ?? 'claude')
const pickedRole = ref<RoleKey>('')

watch(
  manualAgentSpecs,
  (specs) => {
    if (!specs.some((spec) => spec.agentKey === pickedAgent.value)) {
      pickedAgent.value = specs[0]?.agentKey ?? 'claude'
    }
  },
  { immediate: true }
)

// ── Top-level tab: pipeline | git ─────────────────────────────────────────────
const _TAB_KEY = 'agentTeam.sidebarTab'
type SidebarTab = 'explorer' | 'pipeline' | 'git'
const sidebarTab = ref<SidebarTab>(
  (() => {
    try {
      const v = sessionStorage.getItem(_TAB_KEY) as SidebarTab | null
      // Backward-compat: unknown / legacy values fall back to 'pipeline'.
      return v === 'explorer' || v === 'pipeline' || v === 'git' ? v : 'pipeline'
    } catch { return 'pipeline' }
  })()
)
watch(sidebarTab, (v) => { try { sessionStorage.setItem(_TAB_KEY, v) } catch { /* ignore */ } })

// Git tab badge — updated by GitPane via changes-count event
const gitChangesCount = ref(0)

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
    workspacePath: workspacePath.value
  })
}

function openTerminal(): void {
  if (!canSpawn.value) return
  emit('spawn', {
    agentKey: 'terminal',
    roleKey: '',
    stageId: '',
    workspacePath: workspacePath.value
  })
}

function startPipeline(): void {
  if (!canRunPipeline.value) return
  emit('pipeline-start', {
    task: taskDescription.value.trim(),
    workspacePath: workspacePath.value,
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

function preparationLabel(status: ActivePaneView['preparationStatus']): string {
  switch (status) {
    case 'starting':
      return 'setup: starting CLI'
    case 'checking-dialog':
      return 'setup: checking dialog'
    case 'settling':
      return 'setup: waiting prompt'
    case 'injecting-role':
      return 'setup: injecting role'
    case 'waiting-agent':
      return 'setup: waiting agent'
    case 'ready':
      return 'setup: ready'
    case 'failed':
      return 'setup: failed'
    default:
      return ''
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

// ── pipeline pane: draggable split (top = controls, bottom = agents) ─────────
const pipelineTopEl = ref<HTMLElement | null>(null)
const pipelineTopRatio = ref<number>(
  (() => { try { return parseFloat(localStorage.getItem('agentTeam.pipelineTopRatio') ?? '') || 0.55 } catch { return 0.55 } })()
)
watch(pipelineTopRatio, (v) => { try { localStorage.setItem('agentTeam.pipelineTopRatio', String(v)) } catch {} })

let _plDragStartY = 0, _plDragStartTopPx = 0, _plDragContainerPx = 0
function onPipelineDividerStart(e: MouseEvent): void {
  const top = pipelineTopEl.value
  if (!top) return
  _plDragStartY = e.clientY
  _plDragStartTopPx = top.getBoundingClientRect().height
  _plDragContainerPx = top.parentElement?.getBoundingClientRect().height || 0
  document.body.style.userSelect = 'none'
  document.body.style.cursor = 'row-resize'
  document.addEventListener('mousemove', onPipelineDividerMove)
  document.addEventListener('mouseup', onPipelineDividerEnd)
  e.preventDefault()
}
function onPipelineDividerMove(e: MouseEvent): void {
  if (!_plDragContainerPx) return
  const ratio = (_plDragStartTopPx + e.clientY - _plDragStartY) / _plDragContainerPx
  pipelineTopRatio.value = Math.max(0.15, Math.min(0.85, ratio))
}
function onPipelineDividerEnd(): void {
  document.body.style.userSelect = ''
  document.body.style.cursor = ''
  document.removeEventListener('mousemove', onPipelineDividerMove)
  document.removeEventListener('mouseup', onPipelineDividerEnd)
}

// ── explorer pane: same split pattern ────────────────────────────────────────
const explorerTopEl = ref<HTMLElement | null>(null)
const explorerTopRatio = ref<number>(
  (() => { try { return parseFloat(localStorage.getItem('agentTeam.explorerTopRatio') ?? '') || 0.60 } catch { return 0.60 } })()
)
watch(explorerTopRatio, (v) => { try { localStorage.setItem('agentTeam.explorerTopRatio', String(v)) } catch {} })

let _exDragStartY = 0, _exDragStartTopPx = 0, _exDragContainerPx = 0
function onExplorerDividerStart(e: MouseEvent): void {
  const top = explorerTopEl.value
  if (!top) return
  _exDragStartY = e.clientY
  _exDragStartTopPx = top.getBoundingClientRect().height
  _exDragContainerPx = top.parentElement?.getBoundingClientRect().height || 0
  document.body.style.userSelect = 'none'
  document.body.style.cursor = 'row-resize'
  document.addEventListener('mousemove', onExplorerDividerMove)
  document.addEventListener('mouseup', onExplorerDividerEnd)
  e.preventDefault()
}
function onExplorerDividerMove(e: MouseEvent): void {
  if (!_exDragContainerPx) return
  const ratio = (_exDragStartTopPx + e.clientY - _exDragStartY) / _exDragContainerPx
  explorerTopRatio.value = Math.max(0.15, Math.min(0.85, ratio))
}
function onExplorerDividerEnd(): void {
  document.body.style.userSelect = ''
  document.body.style.cursor = ''
  document.removeEventListener('mousemove', onExplorerDividerMove)
  document.removeEventListener('mouseup', onExplorerDividerEnd)
}
</script>

<template>
  <aside class="sidebar">
    <!-- ── Top-level tab nav (icon style, Cursor-like) ────────────────────── -->
    <div class="sidebar-tabs">
      <button :class="['tab-btn', { active: sidebarTab === 'explorer' }]" title="Explorer" @click="sidebarTab = 'explorer'">
        <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5L6.2 1.7A1.75 1.75 0 0 0 4.96 1H1.75Z"/></svg>
      </button>

      <button :class="['tab-btn', { active: sidebarTab === 'pipeline' }]" title="Pipeline" @click="sidebarTab = 'pipeline'">
        <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor"><path d="M0 1.75C0 .784.784 0 1.75 0h3.5C6.216 0 7 .784 7 1.75v3.5A1.75 1.75 0 0 1 5.25 7H4v4a1 1 0 0 0 1 1h4v-1.25C9 9.784 9.784 9 10.75 9h3.5c.966 0 1.75.784 1.75 1.75v3.5A1.75 1.75 0 0 1 14.25 16h-3.5A1.75 1.75 0 0 1 9 14.25v-.75H5A2.5 2.5 0 0 1 2.5 11V7h-.75A1.75 1.75 0 0 1 0 5.25Zm1.75-.25a.25.25 0 0 0-.25.25v3.5c0 .138.112.25.25.25h3.5a.25.25 0 0 0 .25-.25v-3.5a.25.25 0 0 0-.25-.25Zm9 9a.25.25 0 0 0-.25.25v3.5c0 .138.112.25.25.25h3.5a.25.25 0 0 0 .25-.25v-3.5a.25.25 0 0 0-.25-.25Z"/></svg>
      </button>
      <button :class="['tab-btn', { active: sidebarTab === 'git' }]" title="Git" @click="sidebarTab = 'git'">
        <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor"><path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25z"/></svg>
        <span v-if="gitChangesCount > 0" class="git-badge">{{ gitChangesCount > 99 ? '99+' : gitChangesCount }}</span>
      </button>
    </div>

    <!-- ── Explorer / Git tabs (shared split: panel on top, agent dock pinned at bottom) ── -->
    <div v-show="sidebarTab === 'explorer' || sidebarTab === 'git'" class="pane-split">
      <div class="part-top" ref="explorerTopEl" :style="{ height: (explorerTopRatio * 100) + '%' }">
        <ExplorerPane
          v-if="backend"
          v-show="sidebarTab === 'explorer'"
          :workspace-path="workspace ?? ''"
          :backend="backend"
        />
        <GitPane
          v-if="backend"
          v-show="sidebarTab === 'git'"
          :workspace-path="workspace ?? ''"
          :analyzer-model="analyzerModel"
          :backend="backend"
          @changes-count="gitChangesCount = $event"
          @open-workspace="$emit('workspace-browse', $event)"
        />
      </div>
      <div class="part-resize" title="Drag to resize" @mousedown="onExplorerDividerStart">
        <div class="part-resize-grip" />
      </div>
      <div class="part-bottom">
        <section class="block panel-section">
          <div class="row between agent-list-hdr">
            <label class="lbl">{{ $t('label.active-agents', { running: runningCount, total: panes.length }) }}</label>
            <div class="agent-header-actions">
              <ViewPanel
                :model-value="layoutMode ?? 'auto'"
                @update:model-value="emit('update:layoutMode', $event)"
              />
              <button class="history-btn" :title="$t('label.history')" @click="emit('open-history')">📋</button>
            </div>
          </div>
          <div v-if="panes.length === 0" class="empty">{{ $t('label.no-agents-running') }}</div>
          <ul v-else class="agent-list">
            <li v-for="p in panes" :key="p.id" class="agent-item" :class="{ pipeline: p.origin === 'pipeline', manager: p.isCommander, minimized: p.isMinimized }">
              <div class="agent-line" role="button" title="Focus pane" @click="emit('focus-pane', p.id)">
                <span v-if="p.origin === 'pipeline'" class="pipe-tag">P{{ p.stageId }}</span>
                <span class="badge">{{ p.agentLabel }}</span>
                <span v-if="p.isCommander" class="manager-inline" title="Stage manager — controls flow and decides ---STAGE-DONE---">🎯 Mgr</span>
                <span v-if="p.isMinimized" class="minimized-tag">▪ sidebar</span>
                <span v-else class="state" :data-state="p.status">{{ p.status }}</span>
              </div>
              <div v-if="p.roleLabel" class="role-line">{{ p.roleLabel }}</div>
              <div v-if="!p.isMinimized && p.origin === 'pipeline'" class="stage-line">
                stage {{ p.stageId }} · {{ preparationLabel(p.preparationStatus) }} · {{ injectionLabel(p.injectionStatus) }} {{ kickoffLabel(p.kickoffStatus) }}
              </div>
              <div v-else-if="!p.isMinimized" class="stage-line">
                manual · {{ preparationLabel(p.preparationStatus) }} · {{ injectionLabel(p.injectionStatus) }} {{ kickoffLabel(p.kickoffStatus) }}
              </div>
              <div v-if="!p.isMinimized" class="agent-cmd"><code>{{ p.command }}</code></div>
              <div v-if="!p.isMinimized && p.sessionId" class="agent-session" title="CLI session id — used to resume this agent's memory on restart">
                🔖 session: <code>{{ p.sessionId }}</code>
              </div>
              <div v-if="p.error" class="err">{{ p.error }}</div>
              <div class="row tight">
                <template v-if="p.isMinimized">
                  <button class="ghost" @click="emit('restore', p.id)">{{ $t('action.restore') }}</button>
                  <button class="danger" @click="emit('kill', p.id)">{{ $t('action.remove') }}</button>
                </template>
                <template v-else>
                  <button class="ghost" @click="emit('interrupt', p.id)" :disabled="p.status !== 'running'">{{ $t('action.interrupt') }}</button>
                  <button class="ghost" @click="emit('reinject', p.id)" :disabled="p.status !== 'running' || !p.roleKey">{{ $t('action.reapply-role') }}</button>
                  <button class="danger" @click="emit('kill', p.id)">{{ $t('action.remove') }}</button>
                </template>
              </div>
            </li>
          </ul>

          <div class="spawn-card">
            <div class="spawn-card-hdr" @click="manualSpawnOpen = !manualSpawnOpen">
              <span class="spawn-caret">{{ manualSpawnOpen ? '▾' : '▸' }}</span>
              <span>{{ $t('label.manual-spawn') }}</span>
            </div>
            <div v-if="manualSpawnOpen" class="spawn-card-body">
              <div class="row two-col">
                <select v-model="pickedAgent">
                  <option v-for="spec in manualAgentSpecs" :key="spec.agentKey" :value="spec.agentKey">
                    {{ spec.label }}
                  </option>
                </select>
                <select v-model="pickedRole">
                  <option value="">{{ $t('label.select-role') }}</option>
                  <option v-for="r in roles" :key="r.key" :value="r.key">{{ r.label }}</option>
                </select>
              </div>
              <div class="row spawn-actions">
                <button class="primary wide" :disabled="!canSpawn" @click="spawn">{{ $t('action.add-to-grid') }}</button>
                <button class="ghost wide terminal-btn" :disabled="!canSpawn" @click="openTerminal">{{ $t('action.open-terminal') }}</button>
              </div>
              <p v-if="!canSpawn" class="hint warn">
                {{ backendStatus !== 'connected' ? $t('label.waiting-backend') : $t('label.set-workspace-first') }}
              </p>
              <div v-if="currentRole" class="prompt-block">
                <div class="prompt-head">
                  <button class="link" @click="previewOpen = !previewOpen">
                    {{ previewOpen ? '▾' : '▸' }} {{ currentRole.label }} system prompt
                  </button>
                  <button class="link tiny" @click="emit('open-settings')" :title="$t('action.settings')">
                    ⚙ {{ $t('action.settings') }}
                  </button>
                </div>
                <p class="role-line">{{ currentRole.one_line }}</p>
                <pre v-if="previewOpen" class="prompt-preview">{{ currentRole.system_prompt }}</pre>
              </div>
              <div v-else class="prompt-block warn-block">
                <p class="warn">
                  {{ roles.length === 0 ? $t('label.no-roles-available') : $t('label.no-role-selected') }}
                </p>
                <div v-if="roles.length === 0" class="row tight">
                  <button class="ghost" @click="emit('open-settings')">⚙ {{ $t('action.settings') }}</button>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>

    <!-- ── Pipeline tab ──────────────────────────────────────────────────── -->
    <div v-if="sidebarTab === 'pipeline'" class="pipeline-split">

    <!-- ══ LIST VIEW: top (controls) / divider / bottom (agents) ═══════════ -->
    <template v-if="sidebarView === 'list'">
    <div class="part-top" ref="pipelineTopEl" :style="{ height: (pipelineTopRatio * 100) + '%' }">

    <section class="block panel-section">
      <label class="checkbox-row">
        <input v-model="yoloLocal" type="checkbox" />
        <span>
          <strong>{{ $t('label.yolo-mode') }}</strong> {{ $t('label.yolo-bypass') }}
          <span class="muted-inline">(claude / codex / gemini)</span>
        </span>
      </label>
    </section>

    <!-- ── Pipeline list ────────────────────────────────────────────────── -->
    <section class="block panel-section">
      <label class="lbl">{{ $t('label.pipelines') }}</label>
      <ul v-if="pipelines && pipelines.length && pipeline.state !== 'running' && pipeline.state !== 'aborted'" class="pipeline-list">
        <li
          v-for="p in pagedPipelines"
          :key="p.id"
          class="pipeline-item"
          :class="{ 'pipeline-active': p.id === activePipelineId }"
          @click="openPipelineDetail(p.id)"
        >
          <span class="pipeline-item-name">{{ p.name }}</span>
          <span class="pipeline-item-meta">{{ p.stage_count }} stages</span>
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
      <p v-else-if="pipeline.state !== 'running' && pipeline.state !== 'aborted'" class="hint">{{ $t('label.no-pipelines') }}</p>
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
              :title="$t('action.discard-progress')"
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
            ▶ {{ pipelines?.find(p => p.id === activePipelineId)?.name ?? $t('label.pipelines') }}
          </div>
          <div v-if="pipeline.task" class="prn-task">{{ pipeline.task }}</div>
          <div class="prn-meta">
            <span v-if="autoAnswerEnabled" class="prn-auto">{{ $t('label.full-auto') }} · {{ analyzerModelLocal }}</span>
            <span v-else class="prn-manual">{{ $t('label.manual-confirm') }}</span>
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
              {{ pipelineNextStage ? `Next → ${pipelineNextStage.shortTitle}` : $t('action.finish') }}
            </button>
            <button class="danger" @click="emit('pipeline-abort')">{{ $t('action.abort') }}</button>
          </div>
        </div>
        <p v-else-if="pipeline.state === 'aborted'" class="hint warn">
          {{ $t('label.pipeline-aborted') }}
        </p>
      </template>
    </section>

    </div><!-- /part-top -->
    <div class="part-resize" title="Drag to resize" @mousedown="onPipelineDividerStart">
      <div class="part-resize-grip" />
    </div>
    <div class="part-bottom">

    <!-- ── Active agents ──────────────────────────────────────────────────── -->
    <section class="block panel-section">
      <div class="row between agent-list-hdr">
        <label class="lbl">{{ $t('label.active-agents', { running: runningCount, total: panes.length }) }}</label>
        <div class="agent-header-actions">
          <ViewPanel
            :model-value="layoutMode ?? 'auto'"
            @update:model-value="emit('update:layoutMode', $event)"
          />
          <button class="history-btn" :title="$t('label.history')" @click="emit('open-history')">📋</button>
        </div>
      </div>
      <div v-if="panes.length === 0" class="empty">{{ $t('label.no-agents-running') }}</div>
      <ul v-else class="agent-list">
        <li v-for="p in panes" :key="p.id" class="agent-item" :class="{ pipeline: p.origin === 'pipeline', manager: p.isCommander, minimized: p.isMinimized }">
          <div class="agent-line" role="button" title="Focus pane" @click="emit('focus-pane', p.id)">
            <span v-if="p.origin === 'pipeline'" class="pipe-tag">P{{ p.stageId }}</span>
            <span class="badge">{{ p.agentLabel }}</span>
            <span v-if="p.isCommander" class="manager-inline" title="Stage manager — controls flow and decides ---STAGE-DONE---">🎯 Mgr</span>
            <span v-if="p.isMinimized" class="minimized-tag">▪ sidebar</span>
            <span v-else class="state" :data-state="p.status">{{ p.status }}</span>
            <button class="icon-btn agent-close-btn" :title="$t('action.remove')" @click.stop="emit('kill', p.id)">✕</button>
          </div>
          <div v-if="p.roleLabel" class="role-line">{{ p.roleLabel }}</div>
          <div v-if="!p.isMinimized && p.origin === 'pipeline'" class="stage-line">
            stage {{ p.stageId }} · {{ preparationLabel(p.preparationStatus) }} · {{ injectionLabel(p.injectionStatus) }} {{ kickoffLabel(p.kickoffStatus) }}
          </div>
          <div v-else-if="!p.isMinimized" class="stage-line">
            manual · {{ preparationLabel(p.preparationStatus) }} · {{ injectionLabel(p.injectionStatus) }} {{ kickoffLabel(p.kickoffStatus) }}
          </div>
          <div v-if="!p.isMinimized" class="agent-cmd"><code>{{ p.command }}</code></div>
          <div v-if="!p.isMinimized && p.sessionId" class="agent-session" title="CLI session id — used to resume this agent's memory on restart">
            🔖 session: <code>{{ p.sessionId }}</code>
          </div>
          <div v-if="p.error" class="err">{{ p.error }}</div>
          <div class="row tight">
            <template v-if="p.isMinimized">
              <button class="ghost" @click="emit('restore', p.id)">{{ $t('action.restore') }}</button>
              <button class="danger" @click="emit('kill', p.id)">{{ $t('action.remove') }}</button>
            </template>
            <template v-else>
              <button class="ghost" @click="emit('interrupt', p.id)" :disabled="p.status !== 'running'">
                {{ $t('action.interrupt') }}
              </button>
              <button class="ghost" @click="emit('reinject', p.id)" :disabled="p.status !== 'running' || !p.roleKey">
                {{ $t('action.reapply-role') }}
              </button>
              <button class="danger" @click="emit('kill', p.id)">{{ $t('action.remove') }}</button>
            </template>
          </div>
        </li>
      </ul>

      <div class="spawn-card">
        <div class="spawn-card-hdr" @click="manualSpawnOpen = !manualSpawnOpen">
          <span class="spawn-caret">{{ manualSpawnOpen ? '▾' : '▸' }}</span>
          <span>{{ $t('label.manual-spawn') }}</span>
        </div>
        <div v-if="manualSpawnOpen" class="spawn-card-body">
          <div class="row two-col">
            <select v-model="pickedAgent">
              <option v-for="spec in manualAgentSpecs" :key="spec.agentKey" :value="spec.agentKey">
                {{ spec.label }}
              </option>
            </select>
            <select v-model="pickedRole">
              <option value="">{{ $t('label.select-role') }}</option>
              <option v-for="r in roles" :key="r.key" :value="r.key">{{ r.label }}</option>
            </select>
          </div>
          <div class="row spawn-actions">
            <button class="primary wide" :disabled="!canSpawn" @click="spawn">{{ $t('action.add-to-grid') }}</button>
            <button class="ghost wide terminal-btn" :disabled="!canSpawn" @click="openTerminal">{{ $t('action.open-terminal') }}</button>
          </div>
          <p v-if="!canSpawn" class="hint warn">
            {{ backendStatus !== 'connected' ? $t('label.waiting-backend') : $t('label.set-workspace-first') }}
          </p>

          <div v-if="currentRole" class="prompt-block">
            <div class="prompt-head">
              <button class="link" @click="previewOpen = !previewOpen">
                {{ previewOpen ? '▾' : '▸' }} {{ currentRole.label }} system prompt
              </button>
              <button class="link tiny" @click="emit('open-settings')" :title="$t('action.settings')">
                ⚙ {{ $t('action.settings') }}
              </button>
            </div>
            <p class="role-line">{{ currentRole.one_line }}</p>
            <pre v-if="previewOpen" class="prompt-preview">{{ currentRole.system_prompt }}</pre>
          </div>
          <div v-else class="prompt-block warn-block">
            <p class="warn">
              {{ roles.length === 0 ? $t('label.no-roles-available') : $t('label.no-role-selected') }}
            </p>
            <div v-if="roles.length === 0" class="row tight">
              <button class="ghost" @click="emit('open-settings')">⚙ {{ $t('action.settings') }}</button>
            </div>
          </div>
        </div>
      </div>
    </section>

    </div><!-- /part-bottom -->
    </template><!-- /sidebarView === 'list' -->

    <!-- ══ DETAIL VIEW: no split, full-height scroll ══════════════════════════ -->
    <div v-else class="pipeline-detail-scroll">
      <section class="block pipeline-detail-header">
        <div class="pipeline-detail-nav">
          <button class="ghost back-btn" @click="backToList">← Back</button>
          <span class="pipeline-detail-name">{{ openedPipeline?.name ?? openedPipelineId }}</span>
          <span v-if="openedPipelineId === activePipelineId" class="active-tag">{{ $t('label.default') }}</span>
        </div>
      </section>
      <section class="block" :class="{ pipeline: pipelineOpen }">
        <button class="lbl collapsible-header" @click="pipelineOpen = !pipelineOpen">
          {{ pipelineOpen ? '▾' : '▸' }} {{ openedPipeline?.name ?? $t('label.pipelines') }} · {{ effectiveStageCount }}-stage
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
              :title="$t('action.discard-progress')"
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
          :placeholder="$t('label.task-placeholder')"
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
            <strong>{{ $t('label.full-auto') }}</strong>
            <span v-if="!analyzerStatus.available" class="muted-inline">{{ $t('label.needs-ollama') }}</span>
            <span v-else class="muted-inline">{{ $t('label.auto-answers') }}</span>
          </span>
        </label>
        <div v-if="analyzerStatus.available" class="analyzer-row">
          <label class="lbl tiny">{{ $t('label.model') }}</label>
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
          <span class="muted-inline">{{ $t('label.ollama-unreachable') }}</span>
          <button class="ghost refresh" @click="emit('refresh-analyzer')" title="Retry connection">
            {{ $t('action.retry') }}
          </button>
        </div>
        <div v-if="pipeline.state === 'idle' || pipeline.state === 'completed' || pipeline.state === 'aborted'" class="row pipeline-row">
          <button class="primary wide" :disabled="!canRunPipeline" @click="startPipeline">
            {{ $t('action.run-pipeline') }}
          </button>
          <button
            v-if="pipeline.state !== 'idle'"
            class="ghost"
            @click="emit('pipeline-reset')"
            :title="$t('action.clear-pipeline')"
          >
            {{ $t('action.reset') }}
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
              {{ pipelineNextStage ? `Next → ${pipelineNextStage.shortTitle}` : $t('action.finish') }}
            </button>
            <button class="danger" @click="emit('pipeline-abort')">{{ $t('action.abort') }}</button>
          </div>
        </div>
        <p v-if="pipeline.state === 'completed'" class="hint ok">
          {{ $t('label.pipeline-completed') }}
        </p>
        <p v-else-if="pipeline.state === 'aborted'" class="hint warn">
          {{ $t('label.pipeline-aborted-paused') }}
        </p>
        <p v-else-if="pipeline.state === 'idle' && !canRunPipeline" class="hint">
          {{ $t('label.provide-task') }}
        </p>
        </template>
      </section>
    </div><!-- /pipeline-detail-scroll -->

    </div><!-- end sidebarTab === 'pipeline' / pipeline-split -->

    <Teleport to="body">
      <div v-if="confirmingRestart" class="restart-modal" @click.self="confirmingRestart = false">
        <div class="restart-card">
          <h3>{{ $t('label.restart-title') }}</h3>
          <p v-if="existingProject" v-html="$t('hint.restart-confirm', { completed: existingProject.stagesCompleted, total: existingProject.totalStages })"></p>
          <div v-if="existingProject?.taskDescription" class="restart-task">
            {{ existingProject.taskDescription.length > 240
              ? existingProject.taskDescription.slice(0, 240) + '…'
              : existingProject.taskDescription }}
          </div>
          <p class="restart-warn">
            {{ $t('label.restart-preserved') }}
          </p>
          <div class="restart-actions">
            <button class="ghost" @click="confirmingRestart = false">{{ $t('action.cancel') }}</button>
            <button class="danger" @click="startOverNow">{{ $t('action.wipe-restart') }}</button>
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
  background: var(--bg-base);
  border-right: 1px solid var(--border-muted);
  color: var(--text-primary);
  font-size: 12px;
  overflow: hidden;
}

/* ── Sidebar top-level tabs ─────────────────────────────────────── */
.sidebar-tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--border-muted);
  margin: -4px -14px 0;
  padding: 4px 10px 6px;
}
.tab-btn {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  background: none;
  border: none;
  border-radius: 6px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.tab-btn:hover { color: var(--text-primary); background: var(--bg-elevated); }
.tab-btn.active {
  color: var(--text-bright);
  background: var(--bg-muted);
}
.git-badge {
  position: absolute;
  top: -2px;
  right: -2px;
  min-width: 14px;
  height: 14px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--attention-fg);
  color: var(--bg-base);
  font-size: 9px;
  font-weight: 700;
  border-radius: 999px;
  padding: 0 3px;
  line-height: 1;
  border: 1px solid var(--bg-base);
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* ── Flat section style (VS Code / GitPane) ──────────────────────────────── */
.panel-section {
  border: none;
  border-radius: 0;
  background: transparent;
  padding: 6px 0 10px;
  border-top: 1px solid var(--border-muted);
}
/* first visible section in each scroll area: no top divider */
.part-top > .block:first-child,
.part-bottom > .block:first-child {
  border-top: none;
  padding-top: 4px;
}

.section-divider {
  border: none;
  border-top: 1px solid var(--border-muted);
  margin: 6px 0;
}

/* Section header label (matches GitPane sec-label) */
.lbl {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.2px;
  text-transform: none;
  color: var(--text-secondary);
  padding: 2px 0;
  display: block;
}
.lbl.tiny {
  font-size: 10px;
  color: var(--text-muted);
  padding: 0;
}

/* Section header row with actions (matches GitPane sec-hdr layout) */
.panel-section > .row.between {
  min-height: 22px;
  align-items: center;
  padding: 0;
}

button.collapsible-header {
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 0;
  text-align: left;
}
button.collapsible-header:hover {
  color: var(--text-bright);
}
button.collapsible-header:hover {
  color: var(--text-bright);
}
input[type='text'],
select,
textarea {
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  color: var(--text-bright);
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
  border-color: var(--accent-emphasis);
}
textarea.drag-over {
  border-color: var(--accent-focus);
  box-shadow: inset 0 0 0 1px var(--accent-focus), 0 0 0 2px color-mix(in srgb, var(--accent-focus) 27%, transparent);
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
  color: var(--text-primary);
  cursor: pointer;
  user-select: none;
}
.checkbox-row input[type='checkbox'] {
  width: 14px;
  height: 14px;
  margin-top: 2px;
  accent-color: var(--attention-fg);
  flex-shrink: 0;
}
.checkbox-row strong {
  color: var(--attention-fg);
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
  color: var(--text-muted);
  font-size: 10px;
}
.muted-inline {
  color: var(--text-muted);
  font-size: 10px;
}
.pipeline-row {
  margin-top: 4px;
}
.spawn-actions {
  flex-direction: column;
  gap: 4px;
  align-items: stretch;
}
.terminal-btn {
  opacity: 0.6;
  border-style: dashed;
  transition: opacity 0.2s, background 0.2s;
}
.terminal-btn:hover:not(:disabled) {
  opacity: 1;
}

button {
  border: 1px solid var(--border-default);
  background: var(--bg-muted);
  color: var(--text-bright);
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
  background: var(--success-emphasis);
  border-color: var(--success-strong);
  color: var(--text-on-emphasis);
  font-weight: 600;
}
button.primary:not(:disabled):hover {
  background: var(--success-strong);
}
button.danger {
  background: var(--danger-emphasis);
  border-color: transparent;
  color: var(--text-on-emphasis);
}
button.danger:hover {
  background: var(--danger-bright);
}
button.ghost {
  background: transparent;
}
button.ghost:hover:not(:disabled) {
  background: var(--bg-muted);
}
button.link {
  background: transparent;
  border: none;
  color: var(--accent-fg);
  font-size: 11px;
  padding: 2px 4px;
  text-align: left;
}
.agent-list-hdr {
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--bg-base);
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border-muted);
  margin-bottom: 4px;
}
.agent-header-actions {
  display: flex;
  gap: 2px;
  align-items: center;
}
button.history-btn {
  background: transparent;
  border: 1px solid var(--border-default);
  color: var(--text-secondary);
  font-size: 14px;
  padding: 0;
  width: 32px;
  height: 32px;
  border-radius: 4px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
button.history-btn:hover {
  color: var(--text-bright);
  border-color: var(--accent-fg);
  background: var(--bg-subtle);
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
  background: var(--bg-muted);
}
button.icon-btn.muted {
  opacity: 0.3;
}
button.icon-btn.muted:hover {
  opacity: 0.8;
}
.hint {
  color: var(--text-secondary);
  font-size: 10px;
  margin: 0;
  line-height: 1.5;
}
.hint.warn {
  color: var(--attention-fg);
}
.hint.ok {
  color: var(--success-fg);
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
  color: var(--text-secondary);
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
  background: var(--bg-subtle);
  border: 1px solid var(--border-muted);
  cursor: pointer;
  transition: background 0.1s;
}
.pipeline-item:hover {
  background: var(--bg-elevated);
  border-color: var(--border-default);
}
.pipeline-item.pipeline-active {
  border-color: var(--accent-emphasis);
  background: var(--accent-subtle);
}
.pipeline-item-name {
  flex: 1;
  font-size: 12px;
  color: var(--text-bright);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pipeline-active .pipeline-item-name {
  color: var(--accent-bright);
}
.pipeline-item-meta {
  font-size: 10px;
  color: var(--text-muted);
  white-space: nowrap;
}
.pipeline-item-badge {
  font-size: 10px;
  white-space: nowrap;
}
.pipeline-item-badge.running {
  color: var(--success-fg);
}
.pipeline-item-badge.idle {
  color: var(--text-muted);
}
.pipeline-item-badge.done {
  color: var(--accent-fg);
}
.new-pipeline-row {
  margin-top: 6px;
  gap: 4px;
}
.new-pipeline-input {
  flex: 1;
  background: var(--bg-inset);
  border: 1px solid var(--accent-emphasis);
  border-radius: 4px;
  color: var(--text-bright);
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
  color: var(--text-secondary);
}
.back-btn:hover {
  color: var(--text-bright);
}
.pipeline-detail-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--accent-bright);
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
  color: var(--success-fg);
  background: var(--success-subtle);
  border: 1px solid color-mix(in srgb, var(--success-strong) 33%, transparent);
  border-radius: 3px;
  padding: 1px 5px;
  white-space: nowrap;
}
.rename-input {
  flex: 1;
  background: var(--bg-inset);
  border: 1px solid var(--accent-emphasis);
  border-radius: 4px;
  color: var(--text-bright);
  font-size: 12px;
  padding: 3px 6px;
}
.hint code,
.agent-cmd code {
  background: var(--bg-subtle);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 10px;
}
.pipeline {
  background: var(--bg-inset);
  border: 1px solid var(--accent-muted);
  padding: 10px;
  border-radius: 6px;
}
.pipeline-detail-scroll .pipeline {
  flex: 1;
  min-height: 0;
}
.pipeline-detail-scroll .pipeline textarea {
  flex: 1;
  min-height: 60px;
}
.manual-spawn {
  background: var(--bg-inset);
  border: 1px solid var(--accent-muted);
  padding: 10px;
  border-radius: 6px;
}
.resume-card {
  background: var(--bg-elevated);
  border: 1px solid var(--accent-muted);
  border-left: 3px solid var(--accent-fg);
  border-radius: 4px;
  padding: 8px 10px;
  margin-bottom: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.resume-card.done {
  border-left-color: var(--success-fg);
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
  color: var(--text-primary);
}
.resume-state {
  margin-left: auto;
  font-size: 9px;
  text-transform: uppercase;
  padding: 2px 6px;
  border-radius: 999px;
  background: var(--bg-muted);
}
.resume-state[data-state='running'] {
  background: var(--success-muted);
  color: var(--success-fg);
}
.resume-state[data-state='aborted'] {
  background: var(--danger-deep);
  color: var(--danger-fg);
}
.resume-state[data-state='completed'] {
  background: var(--accent-muted);
  color: var(--accent-bright);
}
.resume-meta {
  font-size: 10px;
  color: var(--text-secondary);
}
.resume-meta .dot {
  margin: 0 4px;
}
.resume-task {
  font-size: 11px;
  color: var(--text-primary);
  background: var(--bg-inset);
  padding: 6px 8px;
  border-radius: 3px;
  white-space: pre-wrap;
  max-height: 80px;
  overflow-y: auto;
}
.restart-modal {
  position: fixed;
  inset: 0;
  background: var(--shadow-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}
.restart-card {
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-left: 4px solid var(--danger-fg);
  border-radius: 8px;
  padding: 20px 22px;
  width: min(480px, 90vw);
  color: var(--text-bright);
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
  color: var(--text-primary);
}
.restart-card .restart-warn {
  color: var(--text-secondary);
  font-size: 11px;
}
.restart-task {
  background: var(--bg-subtle);
  border: 1px solid var(--border-muted);
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
  border-top: 1px solid var(--border-muted);
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
  color: var(--success-fg);
  letter-spacing: 0.02em;
}
.prn-task {
  font-size: 11px;
  color: var(--text-bright);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.prn-meta {
  font-size: 10px;
  color: var(--text-secondary);
}
.prn-auto {
  color: var(--attention-fg);
}
.prn-manual {
  color: var(--text-secondary);
}
.pipeline-running {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.progress {
  height: 6px;
  background: var(--bg-subtle);
  border-radius: 999px;
  overflow: hidden;
}
.progress .bar {
  position: relative;
  height: 100%;
  background: linear-gradient(90deg, var(--accent-emphasis) 0%, var(--accent-focus) 40%, var(--success-fg) 100%);
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
  color: var(--text-secondary);
  font-weight: 400;
}
.empty {
  color: var(--text-muted);
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
  background: var(--bg-subtle);
  border: 1px solid var(--border-muted);
  border-radius: 4px;
  padding: 8px 10px;
}
.agent-item.pipeline {
  border-color: var(--accent-muted);
  background: linear-gradient(180deg, var(--accent-subtle) 0%, var(--bg-subtle) 100%);
}
.agent-item.manager {
  border-color: var(--attention-muted);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--manager-fg) 15%, transparent) inset;
}
.agent-line {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 2px;
  cursor: pointer;
  border-radius: 4px;
  padding: 2px 4px;
  margin-left: -4px;
  overflow: hidden;
}
.role-line {
  font-size: 9px;
  color: var(--accent-bright);
  margin-bottom: 3px;
  padding-left: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.agent-line:hover {
  background: var(--bg-subtle);
}
.agent-close-btn {
  margin-left: 4px;
  padding: 0 4px;
  font-size: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 18px;
  width: 18px;
}
.agent-close-btn:hover {
  color: var(--danger-fg);
  background: var(--danger-deep);
}
.stage-line {
  color: var(--text-secondary);
  font-size: 10px;
  margin-bottom: 4px;
}
.pipe-tag {
  font-size: 9px;
  font-weight: 700;
  background: var(--accent-muted);
  color: var(--accent-bright);
  padding: 1px 5px;
  border-radius: 3px;
}
.badge {
  font-weight: 600;
  font-size: 10px;
  background: var(--bg-muted);
  padding: 2px 6px;
  border-radius: 4px;
  color: var(--text-primary);
}
.badge.role {
  background: var(--accent-muted);
  color: var(--accent-bright);
}
.manager-inline {
  font-size: 9px;
  font-weight: 600;
  color: var(--attention-fg);
  background: var(--attention-subtle);
  border: 1px solid color-mix(in srgb, var(--manager-fg) 35%, transparent);
  border-radius: 999px;
  padding: 1px 6px;
  white-space: nowrap;
  flex-shrink: 0;
}
.state {
  margin-left: auto;
  font-size: 9px;
  text-transform: uppercase;
  padding: 2px 6px;
  border-radius: 999px;
  background: var(--bg-muted);
  color: var(--text-secondary);
}
.state[data-state='running'] {
  background: var(--success-muted);
  color: var(--success-fg);
}
.state[data-state='starting'] {
  background: var(--attention-muted);
  color: var(--attention-fg);
}
.state[data-state='error'] {
  background: var(--danger-deep);
  color: var(--danger-fg);
}
.state[data-state='exited'] {
  background: var(--bg-muted);
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
  color: var(--accent-fg);
  background: var(--accent-subtle);
  border: 1px solid color-mix(in srgb, var(--accent-emphasis) 33%, transparent);
  border-radius: 999px;
  padding: 2px 8px;
}
.agent-cmd {
  margin-bottom: 4px;
  overflow: hidden;
}
.agent-cmd code {
  display: block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.agent-session {
  font-size: 10px;
  color: var(--text-secondary);
  margin-bottom: 4px;
  word-break: break-all;
}
.agent-session code {
  color: var(--accent-fg);
}
.err {
  color: var(--danger-fg);
  font-size: 10px;
  margin: 4px 0;
}
.prompt-block {
  margin-top: 4px;
  padding: 6px 8px;
  background: var(--bg-subtle);
  border: 1px solid var(--border-muted);
  border-radius: 4px;
}
.role-line {
  margin: 4px 0 0;
  color: var(--text-secondary);
  font-size: 10px;
}
.prompt-preview {
  margin: 6px 0 0;
  padding: 6px 8px;
  background: var(--bg-inset);
  border-radius: 4px;
  font-size: 10px;
  line-height: 1.5;
  max-height: 220px;
  overflow: auto;
  white-space: pre-wrap;
  color: var(--text-bright);
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
  color: var(--attention-fg);
  margin: 0;
}

/* ── Manual spawn card (matches GitPane git-card / History style) ─────────── */
.spawn-card {
  border: 1px solid var(--border-muted);
  border-radius: 6px;
  overflow: hidden;
  margin-top: 6px;
}
.spawn-card-hdr {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  min-height: 28px;
  background: var(--bg-subtle);
  cursor: pointer;
  user-select: none;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-primary);
}
.spawn-card-hdr:hover { background: var(--bg-elevated); }
.spawn-caret {
  font-size: 9px;
  color: var(--text-muted);
  width: 10px;
  flex-shrink: 0;
}
.spawn-card-body {
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-top: 1px solid var(--border-muted);
}

/* ── Shared split-scroll layout (pipeline + explorer) ───────────────────── */
.pane-split,
.pipeline-split {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  margin: 0 -14px -14px; /* compensate sidebar padding */
}
.pane-split .part-top,
.pipeline-split .part-top {
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0; /* sections use border-top as divider, no inter-section gap needed */
  padding: 0 14px 4px;
  min-height: 0;
}
.pane-split .part-bottom,
.pipeline-split .part-bottom {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 0 14px 14px;
  min-height: 0;
}
.pane-split .part-resize,
.pipeline-split .part-resize {
  flex-shrink: 0;
  height: 11px;
  cursor: row-resize;
  display: flex;
  align-items: center;
  background: var(--bg-base);
  border-top: 1px solid var(--border-muted);
  border-bottom: 1px solid var(--border-muted);
  transition: background 0.1s;
}
.pane-split .part-resize:hover,
.pipeline-split .part-resize:hover {
  background: var(--bg-elevated);
}
.pane-split .part-resize-grip,
.pipeline-split .part-resize-grip {
  margin: 0 auto;
  width: 44px;
  height: 3px;
  border-radius: 2px;
  background: var(--text-muted);
  transition: height 0.1s, width 0.1s, background 0.1s;
}
.pane-split .part-resize:hover .part-resize-grip,
.pipeline-split .part-resize:hover .part-resize-grip,
.pane-split .part-resize:active .part-resize-grip,
.pipeline-split .part-resize:active .part-resize-grip {
  height: 4px;
  width: 60px;
  background: var(--accent-focus);
}
.pipeline-split .pipeline-detail-scroll {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 0 14px 14px;
  min-height: 0;
}
/* ExplorerPane fills its part-top container */
.pane-split .part-top > * {
  flex: 1;
  min-height: 0;
}
</style>
