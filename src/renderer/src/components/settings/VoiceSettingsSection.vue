<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import SettingsSection from './SettingsSection.vue'
import SettingsCard from './SettingsCard.vue'
import SettingRow from './SettingRow.vue'
import ToggleSwitch from './ToggleSwitch.vue'
import { useVoiceSettings } from '../../voice/voiceSettings'
import type { useBackend } from '../../composables/useBackend'

// Settings → Voice Input. The model status is only asked for while
// voice input is on: with it off this section is two switches and nothing is
// sent to the backend.

const props = defineProps<{ backend: ReturnType<typeof useBackend> }>()
const { t } = useI18n()
const { voiceInputEnabled, voiceReadbackEnabled, setVoiceInputEnabled, setVoiceReadbackEnabled } = useVoiceSettings()

interface VoiceStatus {
  ok?: boolean
  sidecar?: 'ok' | 'missing'
  model?: { present?: boolean; bytes?: number; path?: string }
  gpu?: boolean | null
}
interface Progress { bytes: number; total: number; done: boolean; error?: string }

const status = ref<VoiceStatus | null>(null)
const statusError = ref(false)
const progress = ref<Progress | null>(null)
let offProgress: (() => void) | null = null

async function refreshStatus(): Promise<void> {
  try {
    const res = await props.backend.send<VoiceStatus>('voice.status', {}, 10_000)
    status.value = res.ok ? res.payload : null
    statusError.value = !res.ok
  } catch {
    statusError.value = true
  }
}

function subscribeProgress(): void {
  if (offProgress) return
  offProgress = props.backend.on('voice.model.progress', (payload) => {
    const p = payload as Partial<Progress>
    progress.value = { bytes: p.bytes ?? 0, total: p.total ?? 0, done: p.done === true, error: p.error }
    if (p.done) void refreshStatus()
  })
}

function unsubscribeProgress(): void {
  offProgress?.()
  offProgress = null
}

watch(
  voiceInputEnabled,
  (on) => {
    if (on) {
      subscribeProgress()
      void refreshStatus()
    } else {
      unsubscribeProgress()
    }
  },
  { immediate: true },
)
onBeforeUnmount(unsubscribeProgress)

const downloading = computed(() => progress.value !== null && !progress.value.done)

async function download(): Promise<void> {
  progress.value = { bytes: 0, total: 0, done: false }
  try {
    const res = await props.backend.send<{ ok?: boolean; reason?: string }>('voice.model.download', {}, 10_000)
    if (!res.ok || res.payload?.ok === false) {
      progress.value = { bytes: 0, total: 0, done: true, error: res.payload?.reason ?? res.error?.message ?? 'failed' }
    }
  } catch (err) {
    progress.value = { bytes: 0, total: 0, done: true, error: err instanceof Error ? err.message : String(err) }
  }
}

// Decimal megabytes, the unit the "about 148 MB" hint is written in; MiB here
// would show the same file as 141.1 MB next to it.
function mb(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1)
}

const modelLine = computed(() => {
  if (statusError.value) return t('settings.voice.status-unavailable')
  const s = status.value
  if (!s) return t('settings.voice.status-checking')
  if (s.sidecar === 'missing') return t('settings.voice.sidecar-missing')
  if (!s.model?.present) return t('settings.voice.model-missing')
  const gpu = s.gpu === true ? t('settings.voice.gpu-on') : s.gpu === false ? t('settings.voice.gpu-off') : ''
  return [t('settings.voice.model-ready', { size: mb(s.model.bytes ?? 0) }), gpu].filter(Boolean).join(' · ')
})

const progressLine = computed(() => {
  const p = progress.value
  if (!p) return ''
  if (p.error) return t('settings.voice.download-failed', { error: p.error })
  if (p.done) return t('settings.voice.download-done')
  if (p.total > 0) {
    return t('settings.voice.download-progress', {
      done: mb(p.bytes),
      total: mb(p.total),
      pct: Math.floor((p.bytes / p.total) * 100),
    })
  }
  return t('settings.voice.download-starting')
})

const canDownload = computed(
  () => !downloading.value && status.value?.sidecar === 'ok' && status.value?.model?.present === false,
)
</script>

<template>
  <SettingsSection :label="t('settings.voice.section')">
    <SettingsCard>
      <SettingRow
        data-settings-section="voice-input"
        :title="t('settings.voice.enabled')"
        :description="t('settings.voice.enabled-hint')"
      >
        <template #control>
          <ToggleSwitch
            :model-value="voiceInputEnabled"
            :aria-label="t('settings.voice.enabled')"
            @update:model-value="(v: boolean) => setVoiceInputEnabled(v)"
          />
        </template>
      </SettingRow>

      <SettingRow
        data-settings-section="voice-readback"
        :title="t('settings.voice.readback')"
        :description="t('settings.voice.readback-hint')"
      >
        <template #control>
          <ToggleSwitch
            :model-value="voiceReadbackEnabled"
            :aria-label="t('settings.voice.readback')"
            @update:model-value="(v: boolean) => setVoiceReadbackEnabled(v)"
          />
        </template>
      </SettingRow>

      <SettingRow
        v-if="voiceInputEnabled"
        data-settings-section="voice-model"
        :title="t('settings.voice.model')"
        :description="progressLine ? `${modelLine} — ${progressLine}` : modelLine"
      >
        <template #control>
          <progress
            v-if="downloading && progress && progress.total > 0"
            class="voice-progress"
            :value="progress.bytes"
            :max="progress.total"
          />
          <button class="voice-btn" :disabled="!canDownload" @click="download">
            {{ downloading ? t('settings.voice.downloading') : t('settings.voice.download') }}
          </button>
          <button class="voice-btn" :disabled="downloading" @click="refreshStatus">
            {{ t('settings.voice.recheck') }}
          </button>
        </template>
      </SettingRow>
    </SettingsCard>
  </SettingsSection>
</template>

<style scoped>
.voice-btn {
  font-size: var(--font-2xs);
  padding: 4px 10px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.voice-btn:hover:not(:disabled) { color: var(--text-primary); border-color: var(--accent-emphasis); }
.voice-btn:disabled { opacity: 0.5; cursor: default; }
.voice-progress {
  width: 120px;
  accent-color: var(--accent-emphasis);
}
</style>
