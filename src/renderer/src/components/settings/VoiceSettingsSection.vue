<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import SettingsSection from './SettingsSection.vue'
import SettingsCard from './SettingsCard.vue'
import SettingRow from './SettingRow.vue'
import ToggleSwitch from './ToggleSwitch.vue'
import {
  useVoiceSettings,
  VOICE_RECORDING_MODES,
  VOICE_SCRIPTS,
  type VoiceRecordingMode,
  type VoiceScript,
} from '../../voice/voiceSettings'
import type { useBackend } from '../../composables/useBackend'

// Settings → Voice Input. The model status is only asked for while
// voice input is on: with it off this section is one switch and nothing is
// sent to the backend.

const props = defineProps<{ backend: ReturnType<typeof useBackend> }>()
const { t } = useI18n()
const {
  voiceInputEnabled,
  voiceInputDeviceId,
  voiceInputDeviceLabel,
  voiceRecordingMode,
  voiceScript,
  setVoiceInputEnabled,
  setVoiceInputDevice,
  setVoiceRecordingMode,
  setVoiceScript,
} = useVoiceSettings()

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

// ── Microphone device ─────────────────────────────────────────────────────────
// Listed only while voice input is on. The page never opens the mic
// (getUserMedia) to learn device names: before the first voice take the list
// may be unlabeled, and unnamed entries are numbered instead.
interface MicDevice { deviceId: string; label: string }
const devices = ref<MicDevice[]>([])
const devicesLoaded = ref(false)
let listeningDevices = false

async function refreshDevices(): Promise<void> {
  const md = navigator.mediaDevices
  if (!md?.enumerateDevices) return
  try {
    const all = await md.enumerateDevices()
    if (!voiceInputEnabled.value) return
    devices.value = all
      .filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d) => ({ deviceId: d.deviceId, label: d.label }))
    devicesLoaded.value = true
    rematchSavedDevice()
  } catch {
    devices.value = []
  }
}

function onDeviceChange(): void {
  void refreshDevices()
}

function listenDevices(): void {
  if (listeningDevices) return
  listeningDevices = true
  navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange)
}

function unlistenDevices(): void {
  if (!listeningDevices) return
  listeningDevices = false
  navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange)
}

/** A saved id from another origin (dev vs packaged) re-found by its label. */
function rematchSavedDevice(): void {
  const id = voiceInputDeviceId.value
  if (!id || devices.value.some((d) => d.deviceId === id)) return
  const label = voiceInputDeviceLabel.value
  const match = label ? devices.value.find((d) => d.label === label) : undefined
  if (match) setVoiceInputDevice(match.deviceId, match.label)
}

const savedDeviceMissing = computed(
  () => devicesLoaded.value && voiceInputDeviceId.value !== '' && !devices.value.some((d) => d.deviceId === voiceInputDeviceId.value),
)
const hasUnnamedDevice = computed(() => devices.value.some((d) => !d.label))

function deviceName(d: MicDevice, index: number): string {
  return d.label || t('settings.voice.device-unnamed', { n: index + 1 })
}

const deviceDescription = computed(() => {
  if (savedDeviceMissing.value) return t('settings.voice.device-missing-note')
  if (hasUnnamedDevice.value) return t('settings.voice.device-hint')
  return ''
})

function onSelectDevice(e: Event): void {
  const id = (e.target as HTMLSelectElement).value
  const index = devices.value.findIndex((d) => d.deviceId === id)
  setVoiceInputDevice(id, index >= 0 ? devices.value[index].label : '')
}

watch(
  voiceInputEnabled,
  (on) => {
    if (on) {
      subscribeProgress()
      void refreshStatus()
      listenDevices()
      void refreshDevices()
    } else {
      unsubscribeProgress()
      unlistenDevices()
    }
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  unsubscribeProgress()
  unlistenDevices()
})

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
        v-if="voiceInputEnabled"
        data-settings-section="voice-device"
        :title="t('settings.voice.device')"
        :description="deviceDescription"
      >
        <template #control>
          <select
            class="voice-select"
            :aria-label="t('settings.voice.device')"
            :value="voiceInputDeviceId"
            @change="onSelectDevice"
          >
            <option value="">{{ t('settings.voice.device-default') }}</option>
            <option v-for="(d, i) in devices" :key="d.deviceId" :value="d.deviceId">{{ deviceName(d, i) }}</option>
            <option v-if="savedDeviceMissing" :value="voiceInputDeviceId" disabled>
              {{ voiceInputDeviceLabel || t('settings.voice.device') }} {{ t('settings.voice.device-unavailable') }}
            </option>
          </select>
        </template>
      </SettingRow>

      <SettingRow
        v-if="voiceInputEnabled"
        data-settings-section="voice-mode"
        :title="t('settings.voice.mode')"
        :description="t(`settings.voice.mode-${voiceRecordingMode}-hint`)"
      >
        <template #control>
          <select
            class="voice-select"
            :aria-label="t('settings.voice.mode')"
            :value="voiceRecordingMode"
            @change="setVoiceRecordingMode(($event.target as HTMLSelectElement).value as VoiceRecordingMode)"
          >
            <option v-for="m in VOICE_RECORDING_MODES" :key="m" :value="m">{{ t(`settings.voice.mode-${m}`) }}</option>
          </select>
        </template>
      </SettingRow>

      <SettingRow
        v-if="voiceInputEnabled"
        data-settings-section="voice-script"
        :title="t('settings.voice.script')"
        :description="t('settings.voice.script-hint')"
      >
        <template #control>
          <select
            class="voice-select"
            :aria-label="t('settings.voice.script')"
            :value="voiceScript"
            @change="setVoiceScript(($event.target as HTMLSelectElement).value as VoiceScript)"
          >
            <option v-for="s in VOICE_SCRIPTS" :key="s" :value="s">{{ t(`settings.voice.script-${s}`) }}</option>
          </select>
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
.voice-select {
  font-size: var(--font-2xs);
  padding: 4px 8px;
  max-width: 240px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  color: var(--text-primary);
}
.voice-progress {
  width: 120px;
  accent-color: var(--accent-emphasis);
}
</style>
