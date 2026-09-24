<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { CAP_WARNING_MS, COUNTDOWN_MS, voiceErrorI18nKey, type VoiceCapsuleState } from '../composables/useVoiceInput'

// The voice input capsule: a small pill pinned to the bottom of the target
// pane. Positioned from the pane's own rect (found by its data-pane-id) rather
// than rendered inside TerminalPane, so the pane component stays untouched.

const props = defineProps<{ state: VoiceCapsuleState }>()
const emit = defineEmits<{ withdraw: []; dismiss: [] }>()
const { t } = useI18n()

const rect = ref<{ left: number; top: number; width: number } | null>(null)
const remaining = ref(1)
/** Whole seconds left before the cap, in its last CAP_WARNING_MS; else 0. */
const capSeconds = ref(0)
let frame = 0

function measure(): void {
  const id = props.state.paneId
  const el = id ? document.querySelector(`[data-pane-id="${CSS.escape(id)}"]`) : null
  if (!el) {
    rect.value = null
    return
  }
  const r = el.getBoundingClientRect()
  rect.value = { left: r.left, top: r.bottom, width: r.width }
}

// Re-measured every frame while shown: panes move with layout changes, window
// resizes and sidebar drags, and the capsule is only up for a few seconds.
function tick(): void {
  measure()
  if (props.state.phase === 'countdown') {
    const left = props.state.countdownEndsAt - Date.now()
    remaining.value = Math.max(0, Math.min(1, left / COUNTDOWN_MS))
  }
  const capLeft = props.state.phase === 'recording' && props.state.capEndsAt ? props.state.capEndsAt - Date.now() : Infinity
  capSeconds.value = capLeft <= CAP_WARNING_MS ? Math.max(0, Math.ceil(capLeft / 1000)) : 0
  frame = requestAnimationFrame(tick)
}

watch(
  () => props.state.phase !== 'idle',
  (shown) => {
    cancelAnimationFrame(frame)
    if (shown) tick()
  },
  { immediate: true },
)
onBeforeUnmount(() => cancelAnimationFrame(frame))

const style = computed(() => {
  if (!rect.value) return { display: 'none' }
  return {
    left: `${rect.value.left + rect.value.width / 2}px`,
    top: `${rect.value.top - 12}px`,
    maxWidth: `${Math.max(160, rect.value.width - 24)}px`,
  }
})

// Not a failure: the press was spent granting mic access; the next one records.
const isNotice = computed(() => props.state.phase === 'error' && props.state.error?.key === 'mic-authorized')

const errorText = computed(() => {
  const e = props.state.error
  if (!e) return ''
  if (e.reason) return t(`msg.reason-${e.reason.key}`, e.reason.params ?? {})
  return t(voiceErrorI18nKey(e.key), { code: e.key, ...(e.params ?? {}) })
})
</script>

<template>
  <div
    v-if="state.phase !== 'idle'"
    class="voice-capsule"
    :class="[`voice-capsule--${state.phase}`, { 'voice-capsule--notice': isNotice }]"
    :style="style"
    role="status"
    aria-live="polite"
  >
    <template v-if="state.phase === 'starting'">
      <span class="vc-dot vc-dot--idle" />
      <span>{{ t('voice.capsule.starting') }}</span>
    </template>
    <template v-else-if="state.phase === 'recording'">
      <span class="vc-dot vc-dot--rec" />
      <span class="vc-meter" aria-hidden="true"><span class="vc-meter-fill" :style="{ transform: `scaleX(${state.level})` }" /></span>
      <span>{{ t(state.handsFree ? 'voice.capsule.recording-hands-free' : 'voice.capsule.recording') }}</span>
      <span v-if="capSeconds > 0" class="vc-hint vc-cap">{{ t('voice.capsule.cap-left', { s: capSeconds }) }}</span>
      <span class="vc-hint">{{ t('voice.capsule.esc-cancel') }}</span>
    </template>
    <template v-else-if="state.phase === 'transcribing'">
      <span class="vc-spinner" />
      <span>{{ t('voice.capsule.transcribing') }}</span>
    </template>
    <template v-else-if="state.phase === 'countdown'">
      <span class="vc-text">{{ state.text }}</span>
      <span class="vc-hint">{{ t('voice.capsule.esc-cancel') }}</span>
      <span class="vc-bar" :style="{ transform: `scaleX(${remaining})` }" />
    </template>
    <template v-else-if="state.phase === 'delivering'">
      <span class="vc-spinner" />
      <span>{{ t('voice.capsule.delivering') }}</span>
    </template>
    <template v-else-if="state.phase === 'held'">
      <span class="vc-dot vc-dot--held" />
      <span>{{ t('voice.capsule.held', { reason: state.hold ? t(`msg.hold-${state.hold.key}`, { n: state.hold.n ?? 0 }) : '' }) }}</span>
      <button type="button" class="vc-action" @click="emit('withdraw')">✕ {{ t('voice.capsule.withdraw') }}</button>
    </template>
    <template v-else-if="state.phase === 'error'">
      <span class="vc-dot" :class="isNotice ? 'vc-dot--idle' : 'vc-dot--error'" />
      <span>{{ errorText }}</span>
      <button type="button" class="vc-action" :aria-label="t('voice.capsule.dismiss')" @click="emit('dismiss')">✕</button>
    </template>
  </div>
</template>

<style scoped>
.voice-capsule {
  position: fixed;
  z-index: 60;
  transform: translate(-50%, -100%);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  overflow: hidden;
  border: 1px solid var(--border-default);
  border-radius: 999px;
  background: var(--bg-elevated);
  color: var(--text-primary);
  font-size: var(--font-xs);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
  pointer-events: none;
}
.vc-action {
  flex-shrink: 0;
  padding: 1px 8px;
  border: 1px solid var(--border-default);
  border-radius: 999px;
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  cursor: pointer;
  pointer-events: auto;
}
.vc-action:hover { color: var(--text-primary); border-color: var(--accent-emphasis); }
.voice-capsule--error { border-color: var(--danger-fg); }
.voice-capsule--notice { border-color: var(--accent-emphasis); }
.voice-capsule--held { border-color: var(--attention-fg); }
.vc-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vc-hint {
  flex-shrink: 0;
  color: var(--text-secondary);
  font-size: var(--font-2xs);
}
.vc-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.vc-dot--idle { background: var(--text-secondary); }
.vc-dot--rec { background: var(--danger-fg); animation: vc-pulse 1s ease-in-out infinite; }
.vc-dot--held { background: var(--attention-fg); }
.vc-dot--error { background: var(--danger-fg); }
.vc-spinner {
  flex-shrink: 0;
  width: 10px;
  height: 10px;
  border: 2px solid var(--border-muted);
  border-top-color: var(--accent-emphasis);
  border-radius: 50%;
  animation: vc-spin 0.8s linear infinite;
}
.vc-bar {
  position: absolute;
  left: 0;
  bottom: 0;
  width: 100%;
  height: 2px;
  background: var(--accent-emphasis);
  transform-origin: left;
}
.vc-meter {
  flex-shrink: 0;
  width: 28px;
  height: 4px;
  overflow: hidden;
  border-radius: 2px;
  background: var(--border-muted);
}
.vc-meter-fill {
  display: block;
  width: 100%;
  height: 100%;
  background: var(--success-fg, var(--accent-emphasis));
  transform-origin: left;
  transition: transform 0.12s linear;
}
.vc-cap { color: var(--attention-fg); }
@keyframes vc-pulse { 50% { opacity: 0.35; } }
@keyframes vc-spin { to { transform: rotate(360deg); } }
</style>
