import { ref, type Ref } from 'vue'
import { onSettingsChanged, settingsGet, settingsSet } from '@navide/plugin-ui/shared'

// Voice input settings. Both default OFF: with voice input off nothing about
// the feature runs — no mic, no voice.* requests, no hotkey (its `when`
// context stays false).

export const VOICE_INPUT_ENABLED_KEY = 'agentTeam.voiceInputEnabled'
export const VOICE_READBACK_ENABLED_KEY = 'agentTeam.voiceReadbackEnabled'
// Chosen microphone: '' is the system default. The label is saved with it
// because Chromium hashes deviceIds per origin (dev vs packaged differ), so
// the label is what lets a saved choice be found again.
export const VOICE_INPUT_DEVICE_KEY = 'agentTeam.voiceInputDeviceId'
export const VOICE_INPUT_DEVICE_LABEL_KEY = 'agentTeam.voiceInputDeviceLabel'

function read(key: string): boolean {
  return settingsGet<boolean>(key, false) === true
}

function readString(key: string): string {
  const v = settingsGet<unknown>(key, '')
  return typeof v === 'string' ? v : ''
}

const voiceInputEnabled = ref(read(VOICE_INPUT_ENABLED_KEY))
const voiceReadbackEnabled = ref(read(VOICE_READBACK_ENABLED_KEY))
const voiceInputDeviceId = ref(readString(VOICE_INPUT_DEVICE_KEY))
const voiceInputDeviceLabel = ref(readString(VOICE_INPUT_DEVICE_LABEL_KEY))

let unsubscribe: (() => void) | null = null

/** Follow writes made by another window (settings are shared app-wide). */
function ensureSubscription(): void {
  if (unsubscribe) return
  unsubscribe = onSettingsChanged((keys) => {
    if (keys.includes(VOICE_INPUT_ENABLED_KEY)) voiceInputEnabled.value = read(VOICE_INPUT_ENABLED_KEY)
    if (keys.includes(VOICE_READBACK_ENABLED_KEY)) voiceReadbackEnabled.value = read(VOICE_READBACK_ENABLED_KEY)
    if (keys.includes(VOICE_INPUT_DEVICE_KEY)) voiceInputDeviceId.value = readString(VOICE_INPUT_DEVICE_KEY)
    if (keys.includes(VOICE_INPUT_DEVICE_LABEL_KEY)) voiceInputDeviceLabel.value = readString(VOICE_INPUT_DEVICE_LABEL_KEY)
  })
}

export function useVoiceSettings(): {
  voiceInputEnabled: Readonly<Ref<boolean>>
  voiceReadbackEnabled: Readonly<Ref<boolean>>
  voiceInputDeviceId: Readonly<Ref<string>>
  voiceInputDeviceLabel: Readonly<Ref<string>>
  setVoiceInputEnabled: (on: boolean) => void
  setVoiceReadbackEnabled: (on: boolean) => void
  setVoiceInputDevice: (id: string, label: string) => void
} {
  ensureSubscription()
  return {
    voiceInputEnabled,
    voiceReadbackEnabled,
    voiceInputDeviceId,
    voiceInputDeviceLabel,
    setVoiceInputEnabled: (on) => {
      voiceInputEnabled.value = on
      settingsSet(VOICE_INPUT_ENABLED_KEY, on)
    },
    setVoiceReadbackEnabled: (on) => {
      voiceReadbackEnabled.value = on
      settingsSet(VOICE_READBACK_ENABLED_KEY, on)
    },
    setVoiceInputDevice: (id, label) => {
      voiceInputDeviceId.value = id
      voiceInputDeviceLabel.value = id ? label : ''
      settingsSet(VOICE_INPUT_DEVICE_KEY, id)
      settingsSet(VOICE_INPUT_DEVICE_LABEL_KEY, id ? label : '')
    },
  }
}
