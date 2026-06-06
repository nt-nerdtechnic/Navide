<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
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
  backend: ReturnType<typeof useBackend>
}

const props = defineProps<Props>()
const emit = defineEmits<{
  (e: 'set-focus'): void
  (e: 'minimize'): void
}>()
const containerRef = ref<HTMLElement | null>(null)
const isDragOver = ref(false)

const terminal = useTerminal(props.paneId, props.backend)
const { theme } = useTheme()
watch(theme, () => terminal.updateXtermTheme())

// Clock tick so the "running → idle" computed becomes reactive against time.
// 5 s granularity is fine — we only need to flip the badge once after 30 s
// of cleaned-text silence.
const nowTick = ref<number>(Date.now())
const tickInterval = window.setInterval(() => { nowTick.value = Date.now() }, 5000)
onUnmounted(() => window.clearInterval(tickInterval))

// Idle window for the "still alive but agent done" state. Cleaned text means
// the agent printed something semantically meaningful — TUI spinners and token
// counts don't count, so this hits as soon as the turn ends and the CLI sits
// at an interactive prompt.
const PROMPT_IDLE_MS = 30_000

const displayStatus = computed<string>(() => {
  const base = terminal.status.value
  if (base !== 'running') return base
  const lastAt = terminal.lastActivityAt.value
  // No activity ever yet → still "starting" semantically.
  if (lastAt === 0) return 'running'
  return nowTick.value - lastAt > PROMPT_IDLE_MS ? 'idle' : 'running'
})

defineExpose({
  spawn: terminal.spawn,
  interrupt: terminal.interrupt,
  kill: terminal.kill,
  focus: terminal.focus,
  status: terminal.status,
  displayStatus,
  sessionId: terminal.sessionId,
  tmuxName: terminal.tmuxName,
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

onMounted(() => {
  if (containerRef.value) terminal.mount(containerRef.value)
})
</script>

<template>
  <div :class="['pane', { 'pane-focus': isFocus }]">
    <button class="minimize-btn" @click.stop="emit('minimize')" title="Minimize to sidebar">⊟</button>
    <header class="pane-header" @click="emit('set-focus')">
      <span v-if="pipeTag" class="pipe-tag">{{ pipeTag }}</span>
      <span class="title">{{ title }}</span>
      <span v-if="subtitle" class="subtitle">{{ subtitle }}</span>
      <span
        class="status"
        :data-status="displayStatus"
        :title="displayStatus === 'idle' ? 'Process still alive, but agent has finished the last turn and is at an interactive prompt' : ''"
      >{{ displayStatus }}</span>
    </header>
    <div v-if="isCommander" class="manager-row">
      <span class="manager-tag" title="Global Commander — coordinates across stages, decides ---STAGE-DONE---">🎯 Commander</span>
    </div>
    <div
      ref="containerRef"
      class="xterm-host"
      :class="{ 'drag-over': isDragOver }"
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
  box-shadow: 0 0 0 1px #1f6feb33;
}
.pane.pane-focus {
  border-color: var(--accent-focus);
  box-shadow: 0 0 0 2px #388bfd44;
}
.pane.pane-focus .pane-header {
  background: var(--bg-elevated);
}
.minimize-btn {
  position: absolute;
  top: 5px;
  right: 6px;
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
.pane:hover .minimize-btn {
  opacity: 1;
}
.minimize-btn:hover {
  color: var(--text-primary);
  background: var(--bg-muted);
  opacity: 1;
}
.pane-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 32px 6px 12px;
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border-muted);
  font-size: 12px;
  color: var(--text-primary);
}
.title {
  font-weight: 600;
}
.manager-row {
  /* Own row below header so the 🎯 Manager pill doesn't squeeze the title /
   * subtitle / status into wrapping. */
  padding: 4px 12px 6px;
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border-muted);
}
.manager-tag {
  display: inline-block;
  font-size: 10px;
  font-weight: 600;
  color: var(--attention-fg);
  background: var(--attention-subtle);
  border: 1px solid var(--attention-muted);
  border-radius: 10px;
  padding: 1px 8px;
  letter-spacing: 0.3px;
}
.subtitle {
  color: var(--text-secondary);
  font-size: 11px;
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
</style>
