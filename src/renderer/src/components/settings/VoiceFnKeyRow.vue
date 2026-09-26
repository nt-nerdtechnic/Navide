<script setup lang="ts">
// Settings → Voice Input → the fn (🌐) key (macOS only). Shown while the
// dictation shortcut is fn (recorded in the Shortcut row above): voiceWiring
// subscribes to the fn relay then, and the main process runs its helper only
// while someone is subscribed. The row shows that helper's state and the two
// things a user may have to fix by hand: Input Monitoring access, and macOS's
// own "Press 🌐 key to" action.
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { isMacPlatform, onUserRulesChanged } from '@navide/plugin-ui/shared'
import SettingRow from './SettingRow.vue'
import { useVoiceSettings } from '../../voice/voiceSettings'
import { holdToTalkFnRules } from '../../voice/holdToTalkKey'
import type { FnKeyStatus } from '../../../../shared/fnKey'

const { t } = useI18n()
const { voiceFnKeyEnabled } = useVoiceSettings()
// Hidden off macOS: there is no fn helper there.
const api = isMacPlatform() ? window.agentTeam?.fnKey : undefined

// Re-read whenever the rules change (this row or the Shortcuts tab).
const rulesTick = ref(0)
const stopRules = onUserRulesChanged(() => rulesTick.value++)
const fnBound = computed(() => {
  void rulesTick.value
  return holdToTalkFnRules(voiceFnKeyEnabled.value).length > 0
})

const status = ref<FnKeyStatus | null>(null)
let offStatus: (() => void) | null = null

watch(
  fnBound,
  (on) => {
    if (!api) return
    if (on && !offStatus) {
      offStatus = api.onStatus((s) => (status.value = s))
      void api.status().then((s) => (status.value = s), () => {})
    } else if (!on) {
      offStatus?.()
      offStatus = null
      status.value = null
    }
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  offStatus?.()
  stopRules()
})

const statusLine = computed(() => {
  const phase = status.value?.phase
  if (!phase || phase === 'off' || phase === 'unsupported') return ''
  return t(`settings.voice.fn-status-${phase}`)
})

const usageConflict = computed(() => {
  const s = status.value
  if (s?.phase !== 'ready' || s.fnUsage === null || s.fnUsage === 0) return ''
  const action = [1, 2, 3].includes(s.fnUsage) ? t(`settings.voice.fn-usage-${s.fnUsage}`) : t('settings.voice.fn-usage-unknown')
  return t('settings.voice.fn-usage-conflict', { action })
})

/** Asks macOS for access (its prompt appears the first time only), then
 *  starts the helper if access is there now. */
async function requestAccess(): Promise<void> {
  if (api) status.value = await api.requestPermission()
}

async function retry(): Promise<void> {
  if (!api) return
  await api.unsubscribe()
  status.value = await api.subscribe()
}

function openSettings(which: 'input-monitoring' | 'keyboard'): void {
  void api?.openSettings(which)
}
</script>

<template>
  <SettingRow
    v-if="api && fnBound"
    data-settings-section="voice-fn-key"
    :title="t('settings.voice.fn-key')"
    :description="t('settings.voice.fn-key-hint')"
  />
  <div v-if="api && fnBound && statusLine" class="fn-status" data-testid="voice-fn-status">
    <p :class="{ 'fn-warning': status?.phase === 'no-permission' || status?.phase === 'failed' || status?.phase === 'missing' }">{{ statusLine }}</p>
    <p v-if="status?.phase === 'no-permission'" class="fn-actions">
      <button type="button" class="fn-btn" @click="openSettings('input-monitoring')">{{ t('settings.voice.fn-open-input-monitoring') }}</button>
      <button type="button" class="fn-btn" data-testid="voice-fn-check" @click="requestAccess">{{ t('settings.voice.fn-check-again') }}</button>
    </p>
    <p v-if="status?.phase === 'failed' || status?.phase === 'missing'" class="fn-actions">
      <button type="button" class="fn-btn" @click="retry">{{ t('settings.voice.fn-retry') }}</button>
    </p>
    <template v-if="usageConflict">
      <p class="fn-warning" data-testid="voice-fn-usage">{{ usageConflict }}</p>
      <p class="fn-actions">
        <button type="button" class="fn-btn" @click="openSettings('keyboard')">{{ t('settings.voice.fn-open-keyboard-settings') }}</button>
      </p>
    </template>
  </div>
</template>

<style scoped>
.fn-status p {
  margin: 0;
  padding: 0 var(--space-row-x) var(--space-row-y);
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
}
.fn-status .fn-warning { color: var(--warning-fg); }
.fn-actions { display: flex; gap: 4px; }
.fn-btn {
  font-size: var(--font-2xs);
  padding: 4px 10px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.fn-btn:hover { color: var(--text-primary); border-color: var(--accent-emphasis); }
</style>
