<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useTerminal } from '../composables/useTerminal'
import type { useBackend } from '../composables/useBackend'

interface Props {
  paneId: string
  title: string
  subtitle?: string
  isManager?: boolean
  isFocus?: boolean
  backend: ReturnType<typeof useBackend>
}

const props = defineProps<Props>()
const emit = defineEmits<{
  (e: 'set-focus'): void
  (e: 'minimize'): void
}>()
const containerRef = ref<HTMLElement | null>(null)

const terminal = useTerminal(props.paneId, props.backend)

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
  error: terminal.error,
  lastCommand: terminal.lastCommand,
  cleanBuffer: terminal.cleanBuffer,
  lastActivityAt: terminal.lastActivityAt,
  lastRawActivityAt: terminal.lastRawActivityAt,
  markBufferPosition: terminal.markBufferPosition,
  recleanBuffer: terminal.recleanBuffer,
  fitTerminal: terminal.fitTerminal
})

onMounted(() => {
  if (containerRef.value) terminal.mount(containerRef.value)
})
</script>

<template>
  <div :class="['pane', { 'pane-focus': isFocus }]">
    <button class="minimize-btn" @click.stop="emit('minimize')" title="最小化到 sidebar">⊟</button>
    <header class="pane-header" @click="emit('set-focus')">
      <span class="title">{{ title }}</span>
      <span v-if="subtitle" class="subtitle">{{ subtitle }}</span>
      <span
        class="status"
        :data-status="displayStatus"
        :title="displayStatus === 'idle' ? '處理程序仍存活，但 agent 已完成上一輪、停在互動 prompt' : ''"
      >{{ displayStatus }}</span>
    </header>
    <div v-if="isManager" class="manager-row">
      <span class="manager-tag" title="本階段的 Manager — 控場、決定 ---STAGE-DONE---">🎯 Manager</span>
    </div>
    <div ref="containerRef" class="xterm-host"></div>
  </div>
</template>

<style scoped>
.pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  background: #0d1117;
  border: 1px solid #21262d;
  border-radius: 4px;
  overflow: hidden;
  position: relative;
}
.pane:focus-within {
  border-color: #1f6feb;
  box-shadow: 0 0 0 1px #1f6feb33;
}
.pane.pane-focus {
  border-color: #388bfd;
  box-shadow: 0 0 0 2px #388bfd44;
}
.pane.pane-focus .pane-header {
  background: #1a2332;
}
.minimize-btn {
  position: absolute;
  top: 5px;
  right: 6px;
  z-index: 10;
  background: none;
  border: none;
  color: #484f58;
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
  color: #c9d1d9;
  background: #21262d;
  opacity: 1;
}
.pane-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 32px 6px 12px;
  background: #161b22;
  border-bottom: 1px solid #21262d;
  font-size: 12px;
  color: #c9d1d9;
}
.title {
  font-weight: 600;
}
.manager-row {
  /* Own row below header so the 🎯 Manager pill doesn't squeeze the title /
   * subtitle / status into wrapping. */
  padding: 4px 12px 6px;
  background: #161b22;
  border-bottom: 1px solid #21262d;
}
.manager-tag {
  display: inline-block;
  font-size: 10px;
  font-weight: 600;
  color: #d8b46d;
  background: rgba(216, 180, 109, 0.12);
  border: 1px solid rgba(216, 180, 109, 0.35);
  border-radius: 10px;
  padding: 1px 8px;
  letter-spacing: 0.3px;
}
.subtitle {
  color: #8b949e;
  font-size: 11px;
}
.status {
  margin-left: auto;
  font-size: 10px;
  text-transform: uppercase;
  padding: 2px 8px;
  border-radius: 999px;
  background: #21262d;
  color: #8b949e;
}
.status[data-status='running'] {
  background: #1f6f43;
  color: #d2f4dc;
}
.status[data-status='starting'] {
  background: #6f5b1f;
  color: #f4ecd2;
}
.status[data-status='error'] {
  background: #6f1f1f;
  color: #f4d2d2;
}
.status[data-status='exited'] {
  background: #3a3a3a;
  color: #c9d1d9;
}
.status[data-status='idle'] {
  background: #6f5b1f;
  color: #f4ecd2;
}
.xterm-host {
  flex: 1;
  min-height: 0;
  padding: 4px 8px;
}
</style>
