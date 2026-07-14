<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import { useTerminal } from '../composables/useTerminal'
import { useTheme } from '../composables/useTheme'
import type { useBackend } from '../composables/useBackend'
import { extractDropPaths, shellEscape } from '../lib/drop'
import { CLI_CONTEXT_MIME, PANE_ID_MIME, resolveCliDropSource } from '../lib/cliContext'
import RebuildIcon from './RebuildIcon.vue'

interface Props {
  paneId: string
  title: string
  subtitle?: string
  /** CLI vendor key (e.g. 'claude', 'codex') carried in the cli-context drag payload. */
  agentKey?: string
  /** Vendor conversation id, distinct from useTerminal's backend PTY id. */
  cliSessionId?: string
  sessionHomeId?: string
  conversationLogPath?: string
  pipeTag?: string
  isCommander?: boolean
  isFocus?: boolean
  /** True when this pane has a resumable CLI session id — enables the rebuild
   *  button (re-spawns the pane via --resume to recover from render corruption). */
  canRebuild?: boolean
  isPreparing?: boolean
  preparingLabel?: string
  backend: ReturnType<typeof useBackend>
  workspacePath?: string
}

const props = defineProps<Props>()
const emit = defineEmits<{
  (e: 'set-focus'): void
  (e: 'minimize'): void
  (e: 'rebuild'): void
  (e: 'rebuild-clean'): void
  (e: 'width-settled', cols: number): void
  (e: 'rename', name: string): void
  (e: 'context-menu', ev: MouseEvent): void
  (e: 'reorder-drop', draggedPaneId: string): void
  /** Another CLI pane was dropped onto this pane's terminal area — App.vue
   *  pastes that pane's recent output into this pane's input prompt. */
  (e: 'cli-context-drop', sourcePaneId: string): void
}>()
const containerRef = ref<HTMLElement | null>(null)
const isDragOver = ref(false)
/** Hovering a CLI pane over this terminal (context share), not files (path insert). */
const isCliDragOver = ref(false)

// Inline title rename — double-click the header title to edit, Enter/blur to
// commit, Escape to cancel. The committed name bubbles up as a 'rename' event.
const editingTitle = ref(false)
const titleDraft = ref('')
const titleInput = ref<HTMLInputElement | null>(null)
let _cancelledTitle = false

async function startTitleEdit(): Promise<void> {
  _cancelledTitle = false
  titleDraft.value = props.title
  editingTitle.value = true
  await nextTick()
  titleInput.value?.select()
}

function commitTitleEdit(): void {
  if (_cancelledTitle) return
  editingTitle.value = false
  emit('rename', titleDraft.value.trim())
}

function onTitleKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter') { e.preventDefault(); commitTitleEdit() }
  if (e.key === 'Escape') { e.preventDefault(); _cancelledTitle = true; editingTitle.value = false }
}

const terminal = useTerminal(props.paneId, props.backend, {
  workspacePath: props.workspacePath,
  onClear: () => emit('rebuild-clean'),
  onStableWidthChange: (cols) => emit('width-settled', cols),
})
const { theme } = useTheme()
watch(theme, () => terminal.updateXtermTheme())

watch(() => props.isPreparing, (isPrep) => {
  if (terminal.setDisableStdin) {
    terminal.setDisableStdin(!!isPrep)
  }
}, { immediate: true })

// RUNNING vs IDLE is driven entirely by the CLI-execution signal inside
// useTerminal (agent.activity events), not by guessing from the output buffer.
const displayStatus = terminal.displayStatus

defineExpose({
  spawn: terminal.spawn,
  interrupt: terminal.interrupt,
  kill: terminal.kill,
  focus: terminal.focus,
  status: terminal.status,
  displayStatus,
  sessionId: terminal.sessionId,
  error: terminal.error,
  lastCommand: terminal.lastCommand,
  cleanBuffer: terminal.cleanBuffer,
  cleanBytesSeen: terminal.cleanBytesSeen,
  lastActivityAt: terminal.lastActivityAt,
  lastRawActivityAt: terminal.lastRawActivityAt,
  markBufferPosition: terminal.markBufferPosition,
  recleanBuffer: terminal.recleanBuffer,
  readRenderedText: terminal.readRenderedText,
  fitTerminal: terminal.fitTerminal
})

/** True when the drag carries a CLI pane's identity (pane→pane context share)
 *  rather than files/text (path insert). Readable during dragover: the TYPES
 *  are visible in protected mode even though the data is not. */
function isCliPaneDrag(e: DragEvent): boolean {
  const types = e.dataTransfer?.types
  return !!types && (types.includes(CLI_CONTEXT_MIME) || types.includes(PANE_ID_MIME))
}

function onTerminalDragOver(e: DragEvent): void {
  e.preventDefault()
  const cli = isCliPaneDrag(e)
  // Dragging this pane's own header over its own terminal is a no-op — don't
  // advertise a drop target for it.
  isCliDragOver.value = cli && !draggingSelf
  isDragOver.value = !cli
}

function onTerminalDragLeave(): void {
  isDragOver.value = false
  isCliDragOver.value = false
}

function onTerminalDrop(e: DragEvent): void {
  isDragOver.value = false
  isCliDragOver.value = false
  // CLI pane dropped onto this terminal: share its recent output with this pane.
  // App.vue owns pane state, so it resolves the buffer and does the paste.
  if (isCliPaneDrag(e)) {
    const sourcePaneId = resolveCliDropSource(
      e.dataTransfer?.getData(CLI_CONTEXT_MIME) || '',
      e.dataTransfer?.getData(PANE_ID_MIME) || '',
      props.paneId
    )
    if (sourcePaneId) emit('cli-context-drop', sourcePaneId)
    return
  }
  const paths = extractDropPaths(e)
  if (!paths.length) return
  terminal.pasteText(paths.map(shellEscape).join(' '))
}

// Drag the pane (by its header) onto a tab to move it into that run group,
// or onto another pane's header to reorder (see the drop handlers below).
function onHeaderDragStart(e: DragEvent): void {
  if (!e.dataTransfer) return
  e.dataTransfer.setData('application/x-pane-id', props.paneId)
  // Carry a fast local snapshot; AI Chat still fetches authoritative live
  // metadata and rendered output on drop through the pane-buffer IPC relay.
  e.dataTransfer.setData(
    'application/x-cli-context',
    JSON.stringify({
      paneId: props.paneId,
      agentKey: props.agentKey ?? '',
      label: props.title,
      sessionId: props.cliSessionId || null,
      sessionHomeId: props.sessionHomeId ?? '',
      workspacePath: props.workspacePath ?? '',
      conversationLogPath: props.conversationLogPath ?? ''
    })
  )
  e.dataTransfer.effectAllowed = 'move'
  draggingSelf = true
}

// Drop target for pane reordering: another pane's header dropped onto this
// header emits 'reorder-drop' with the dragged pane's id; App.vue moves that
// pane into this pane's slot. During dragover the payload is unreadable
// (dataTransfer protected mode), so hovering is gated on the data TYPE plus a
// local "this pane is the drag source" flag — the id check happens on drop.
const isReorderDragOver = ref(false)
let draggingSelf = false

function onHeaderDragEnd(e: DragEvent): void {
  draggingSelf = false
  isReorderDragOver.value = false
  // Cross-window handoff: a drag released over ANOTHER window produces no drop
  // event there (HTML5 DnD is per-BrowserWindow), but dragend still fires here
  // with the release point in screen coords. dropEffect === 'none' means no
  // in-window drop consumed the drag (an in-window pane reorder sets 'move'),
  // so only then ask main to route the pane to the window under the pointer.
  console.warn('[cli-dragend]', { dropEffect: e.dataTransfer?.dropEffect, screenX: e.screenX, screenY: e.screenY })
  if (e.dataTransfer?.dropEffect !== 'none') return
  window.agentTeam?.cliPaneDragEnd?.(props.paneId, e.screenX, e.screenY)
}

function onHeaderDragOver(e: DragEvent): void {
  if (draggingSelf || !e.dataTransfer?.types.includes('application/x-pane-id')) return
  e.preventDefault()
  isReorderDragOver.value = true
}

function onHeaderDragLeave(): void {
  isReorderDragOver.value = false
}

function onHeaderDrop(e: DragEvent): void {
  isReorderDragOver.value = false
  const draggedId = e.dataTransfer?.getData('application/x-pane-id') || ''
  if (!draggedId || draggedId === props.paneId) return
  emit('reorder-drop', draggedId)
}

onMounted(() => {
  if (containerRef.value) terminal.mount(containerRef.value)
})
</script>

<template>
  <div :class="['pane', { 'pane-focus': isFocus }]">
    <button
      v-if="canRebuild"
      class="rebuild-btn"
      @click.stop="emit('rebuild')"
      :title="$t('pane.terminal.rebuild-tooltip')"
      :aria-label="$t('pane.terminal.rebuild-tooltip')"
    ><RebuildIcon /></button>
    <button class="minimize-btn" @click.stop="emit('minimize')" :title="$t('pane.terminal.minimize-tooltip')">⊟</button>
    <header
      :class="['pane-header', { 'drag-over': isReorderDragOver }]"
      :draggable="!editingTitle"
      :title="$t('pane.terminal.drag-to-tab-tooltip')"
      @click="emit('set-focus')"
      @dragstart="onHeaderDragStart"
      @dragend="onHeaderDragEnd"
      @dragover="onHeaderDragOver"
      @dragenter="onHeaderDragOver"
      @dragleave="onHeaderDragLeave"
      @drop.prevent="onHeaderDrop"
      @contextmenu.prevent="emit('context-menu', $event)"
    >
      <div class="header-main">
        <span v-if="pipeTag" class="pipe-tag">{{ pipeTag }}</span>
        <input
          v-if="editingTitle"
          ref="titleInput"
          class="title-edit"
          v-model="titleDraft"
          @keydown="onTitleKeydown"
          @blur="commitTitleEdit"
          @click.stop
          @dblclick.stop
        />
        <span
          v-else
          class="title"
          :title="$t('pane.terminal.rename-title-tooltip')"
          @dblclick.stop="startTitleEdit"
        >{{ title }}</span>
        <span v-if="isCommander" class="commander-inline" :title="$t('pane.terminal.commander-tooltip')">🎯 Mgr</span>
        <span
          class="status"
          :data-status="displayStatus"
          :title="displayStatus === 'idle' ? $t('pane.terminal.idle-status-tooltip') : ''"
        >{{ displayStatus }}</span>
      </div>
      <div v-if="subtitle" class="header-sub">{{ subtitle }}</div>
    </header>
    <div
      ref="containerRef"
      class="xterm-host"
      :class="{ 'drag-over': isDragOver, 'cli-drag-over': isCliDragOver, 'alt-buffer': terminal.isAltBuffer.value }"
      @mousedown="emit('set-focus')"
      @dragover.prevent="onTerminalDragOver"
      @dragenter.prevent="onTerminalDragOver"
      @dragleave="onTerminalDragLeave"
      @drop.prevent="onTerminalDrop"
    ></div>
    <div v-if="isPreparing" class="prep-overlay" aria-live="polite">
      <div class="prep-panel">
        <div class="prep-spinner" />
        <div class="prep-text">{{ preparingLabel || 'Preparing CLI' }}</div>
      </div>
    </div>
    <!-- Exited CLIs (crash, command-not-found, user quit) get an in-place
         restart: same clean kill+respawn path as onClear. Scrollback with the
         exit message stays readable behind the floating button. -->
    <button
      v-if="displayStatus === 'exited' && !isPreparing"
      class="respawn-btn"
      @click.stop="emit('rebuild-clean')"
    >↻ {{ $t('pane.terminal.respawn') }}</button>
  </div>
</template>

<style scoped>
.pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  background: var(--bg-base);
  border: 1px solid var(--border-muted);
  border-radius: 4px;
  overflow: hidden;
  position: relative;
}
.pipe-tag {
  font-size: 9px;
  font-weight: 700;
  background: var(--accent-muted);
  color: var(--accent-bright);
  padding: 1px 5px;
  border-radius: 3px;
  flex-shrink: 0;
}
.pane:focus-within {
  border-color: var(--accent-emphasis);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent-emphasis) 20%, transparent);
}
.pane.pane-focus {
  border-color: var(--accent-focus);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-focus) 27%, transparent);
}
.pane.pane-focus .pane-header {
  background: var(--bg-elevated);
}
.minimize-btn,
.rebuild-btn {
  position: absolute;
  top: 5px;
  z-index: 10;
  background: none;
  border: none;
  color: var(--text-disabled);
  font-size: 14px;
  cursor: pointer;
  padding: 0 3px;
  line-height: 1;
  border-radius: 3px;
  opacity: 0;
  transition: opacity 0.15s;
}
.minimize-btn {
  right: 6px;
}
.rebuild-btn {
  right: 26px;
}
.rebuild-btn svg {
  width: 14px;
  height: 14px;
}
.pane:hover .minimize-btn,
.pane:hover .rebuild-btn {
  opacity: 1;
}
.minimize-btn:hover,
.rebuild-btn:hover {
  color: var(--text-primary);
  background: var(--bg-muted);
  opacity: 1;
}
.pane-header {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 1px;
  padding: 5px 52px 5px 12px;
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border-muted);
  font-size: 12px;
  color: var(--text-primary);
}
/* Reorder drop target feedback, matching .tab-btn.drag-over in StageTabBar.vue. */
.pane-header.drag-over {
  background: var(--accent-subtle);
  box-shadow: inset 0 0 0 2px var(--accent-focus);
}
.header-main {
  display: flex;
  align-items: center;
  gap: 8px;
}
.header-sub {
  font-size: 10px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.title {
  font-weight: 600;
}
.title-edit {
  font: inherit;
  font-weight: 600;
  color: var(--text-primary);
  background: var(--bg-default);
  border: 1px solid var(--accent-emphasis);
  border-radius: 4px;
  padding: 1px 5px;
  min-width: 0;
  outline: none;
}
.commander-inline {
  font-size: 9px;
  font-weight: 600;
  color: var(--attention-fg);
  background: var(--attention-subtle);
  border: 1px solid var(--attention-muted);
  border-radius: 999px;
  padding: 1px 6px;
  letter-spacing: 0.2px;
  white-space: nowrap;
  flex-shrink: 0;
}
.status {
  margin-left: auto;
  font-size: 10px;
  text-transform: uppercase;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--bg-muted);
  color: var(--text-secondary);
}
.status[data-status='running'] {
  background: var(--success-muted);
  color: var(--success-fg);
}
.status[data-status='starting'] {
  background: var(--attention-muted);
  color: var(--attention-fg);
}
.status[data-status='error'] {
  background: var(--danger-deep);
  color: var(--danger-fg);
}
.status[data-status='exited'] {
  background: var(--bg-muted);
  color: var(--text-primary);
}
.status[data-status='idle'] {
  background: var(--attention-muted);
  color: var(--attention-fg);
}
.xterm-host {
  flex: 1;
  min-height: 0;
  padding: 4px 8px;
  position: relative;
  transition: box-shadow 0.1s;
}
.xterm-host.drag-over,
.xterm-host.cli-drag-over {
  box-shadow: inset 0 0 0 2px var(--accent-focus);
}
.xterm-host.drag-over::after,
.xterm-host.cli-drag-over::after {
  content: 'Drop to insert path';
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--accent-subtle);
  color: var(--accent-bright);
  font-size: 13px;
  font-family: inherit;
  pointer-events: none;
}
.xterm-host.cli-drag-over::after {
  content: 'Drop to paste this pane context';
}
.prep-overlay {
  position: absolute;
  inset: 31px 0 0;
  z-index: 8;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--bg-base) 78%, transparent);
  backdrop-filter: blur(1px);
  pointer-events: auto;
}
.prep-panel {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  max-width: min(78%, 360px);
  padding: 8px 12px;
  border: 1px solid var(--border-muted);
  border-radius: 6px;
  background: color-mix(in srgb, var(--bg-elevated) 94%, transparent);
  color: var(--text-primary);
  box-shadow: 0 8px 24px color-mix(in srgb, var(--bg-inverse) 10%, transparent);
}
.prep-spinner {
  width: 16px;
  height: 16px;
  border-radius: 999px;
  border: 2px solid var(--border-muted);
  border-top-color: var(--accent-emphasis);
  animation: prep-spin 0.8s linear infinite;
  flex: 0 0 auto;
}
.prep-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
}
@keyframes prep-spin {
  to { transform: rotate(360deg); }
}
.respawn-btn {
  position: absolute;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 8;
  padding: 6px 16px;
  border: 1px solid var(--accent-emphasis);
  border-radius: 6px;
  background: var(--accent-emphasis);
  color: var(--text-on-emphasis);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 4px 12px color-mix(in srgb, var(--accent-emphasis) 30%, transparent);
}
.respawn-btn:hover {
  filter: brightness(1.1);
}

/* xterm.js Monaco scrollbar: show track vs thumb contrast in main buffer.
   xterm injects --vscode-scrollbarSlider-background from ITheme but the track
   has no background — add a dim track so the thumb position is distinguishable. */
/* xterm Monaco scrollbar: keep thumb (slider) always visible without a track
   background. Track stays transparent so only the thumb shows as a colored
   strip — white on dark themes, dark on light theme. Avoids the "all gray"
   appearance caused by track + thumb blending to the same shade. */
.xterm-host:not(.alt-buffer) :deep(.xterm-scrollable-element > .invisible) {
  opacity: 0.7 !important;
}
/* Alt buffer (TUI): thumb fills 100% = no useful position info. Hide it. */
.xterm-host.alt-buffer :deep(.xterm-scrollable-element > .invisible) {
  opacity: 0.08 !important;
}
</style>
