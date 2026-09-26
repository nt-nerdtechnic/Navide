<script setup lang="ts">
// What a shortcut recorder says while it listens, so no key press goes
// unanswered: that it is listening, why the last press recorded nothing (see
// useKeyChordRecorder's notice), and — on a hold-to-talk recorder, which also
// takes fn (🌐) — whether fn can be seen right now, with the fix when it cannot.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatKeySpec } from '@navide/plugin-ui/shared'
import type { KeyRecorderNotice } from '../../composables/useKeyChordRecorder'
import type { FnKeyRecorder } from '../../voice/fnKeyRecorder'

const props = defineProps<{
  notice: KeyRecorderNotice | null
  /** Present on a hold-to-talk recorder only. */
  fn?: FnKeyRecorder
}>()
const { t } = useI18n()

const listening = computed(() => {
  if (!props.fn) return t('settings.keybindings.recorder-listening')
  return props.fn.available ? t('settings.keybindings.recorder-listening-fn') : t('settings.keybindings.recorder-listening-no-fn')
})

const noticeText = computed(() => {
  const n = props.notice
  if (!n) return ''
  const key = n.key ? formatKeySpec(n.key) : ''
  switch (n.reason) {
    case 'composing':
      return t('settings.keybindings.recorder-notice-composing')
    case 'unidentified':
      return t('settings.keybindings.recorder-notice-unidentified')
    case 'modifier-held':
      if (!key) return t('settings.keybindings.recorder-notice-modifiers-held')
      return n.loneAllowed
        ? t('settings.keybindings.recorder-notice-modifier-held-lone', { key })
        : t('settings.keybindings.recorder-notice-modifier-held', { key })
    case 'modifier-only':
      return t('settings.keybindings.recorder-notice-modifier-only', { key })
    default:
      return ''
  }
})

// fn phases worth a line: ready needs none (the listening line covers it) and
// off only flashes by before the first status arrives.
const FN_PHASES = new Set(['starting', 'no-permission', 'request-failed', 'restarting', 'failed', 'missing'])
const fnPhase = computed(() => {
  const phase = props.fn?.listening.value ? props.fn.status.value?.phase : undefined
  return phase && FN_PHASES.has(phase) ? phase : ''
})
const fnNeedsAccess = computed(() => fnPhase.value === 'no-permission' || fnPhase.value === 'request-failed')
const fnProblem = computed(() => fnNeedsAccess.value || fnPhase.value === 'failed' || fnPhase.value === 'missing')
</script>

<template>
  <div class="krf" data-testid="key-recorder-feedback">
    <p class="krf-line" data-testid="key-recorder-listening">{{ listening }}</p>
    <p v-if="noticeText" class="krf-line krf-warning" data-testid="key-recorder-notice">{{ noticeText }}</p>
    <template v-if="fn && fnPhase">
      <p class="krf-line" :class="{ 'krf-warning': fnProblem }" data-testid="key-recorder-fn-status">
        {{ t(`settings.voice.fn-status-${fnPhase}`) }}
      </p>
      <p v-if="fnNeedsAccess" class="krf-line krf-actions">
        <button type="button" class="krf-btn" data-testid="key-recorder-fn-open" @click="fn.openSettings('input-monitoring')">
          {{ t('settings.voice.fn-open-input-monitoring') }}
        </button>
        <button type="button" class="krf-btn" data-testid="key-recorder-fn-check" @click="fn.requestPermission()">
          {{ t('settings.voice.fn-check-again') }}
        </button>
      </p>
      <p v-else-if="fnPhase === 'failed' || fnPhase === 'missing'" class="krf-line krf-actions">
        <button type="button" class="krf-btn" data-testid="key-recorder-fn-retry" @click="fn.retry()">
          {{ t('settings.voice.fn-retry') }}
        </button>
      </p>
    </template>
  </div>
</template>

<style scoped>
.krf-line {
  margin: 0;
  padding: 0 var(--space-row-x) var(--space-row-y);
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
}
.krf-warning { color: var(--warning-fg); }
.krf-actions { display: flex; gap: 4px; }
.krf-btn {
  font-size: var(--font-2xs);
  padding: 4px 10px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.krf-btn:hover { color: var(--text-primary); border-color: var(--accent-emphasis); }
</style>
