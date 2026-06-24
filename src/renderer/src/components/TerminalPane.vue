<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import { useTerminal } from '../composables/useTerminal'
import { useTheme } from '../composables/useTheme'
import type { useBackend } from '../composables/useBackend'
import { extractDropPaths, shellEscape } from '../lib/drop'

interface Props {
  paneId: string
  title: string
  subtitle?: string
  pipeTag?: string
  isCommander?: boolean
  isFocus?: boolean
  /** True when this pane has a resumable CLI session id — enables the rebuild
   *  button (re-spawns the pane via --resume to recover from render corruption). */
  canRebuild?: boolean
  backend: ReturnType<typeof useBackend>
}

const props = defineProps<Props>()
const emit = defineEmits<{
  (e: 'set-focus'): void
  (e: 'minimize'): void
  (e: 'rebuild'): void
  (e: 'rename', name: string): void
  (e: 'context-menu', ev: MouseEvent): void
}>()
const containerRef = ref<HTMLElement | null>(null)
const isDragOver = ref(false)

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

const terminal = useTerminal(props.paneId, props.backend)
const { theme } = useTheme()
watch(theme, () => terminal.updateXtermTheme())

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
  lastActivityAt: terminal.lastActivityAt,
  lastRawActivityAt: terminal.lastRawActivityAt,
  markBufferPosition: terminal.markBufferPosition,
  recleanBuffer: terminal.recleanBuffer,
  fitTerminal: terminal.fitTerminal
})

function onTerminalDrop(e: DragEvent): void {
  isDragOver.value = false
  const paths = extractDropPaths(e)
  if (!paths.length) return
  terminal.pasteText(paths.map(shellEscape).join(' '))
}

// Drag the pane (by its header) onto a tab to move it into that run group.
function onHeaderDragStart(e: DragEvent): void {
  if (!e.dataTransfer) return
  e.dataTransfer.setData('application/x-pane-id', props.paneId)
  e.dataTransfer.effectAllowed = 'move'
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
    >↻</button>
    <button class="minimize-btn" @click.stop="emit('minimize')" :title="$t('pane.terminal.minimize-tooltip')">⊟</button>
    <header
      class="pane-header"
      :draggable="!editingTitle"
      :title="$t('pane.terminal.drag-to-tab-tooltip')"
      @click="emit('set-focus')"
      @dragstart="onHeaderDragStart"
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
      :class="{ 'drag-over': isDragOver, 'alt-buffer': terminal.isAltBuffer.value }"
      @mousedown="emit('set-focus')"
      @dragover.prevent
      @dragenter.prevent="isDragOver = true"
      @dragleave="isDragOver = false"
      @drop.prevent="onTerminalDrop"
    ></div>
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
.xterm-host.drag-over {
  box-shadow: inset 0 0 0 2px var(--accent-focus);
}
.xterm-host.drag-over::after {
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
