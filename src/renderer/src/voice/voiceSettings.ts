import { ref, type Ref } from 'vue'
import { onSettingsChanged, settingsGet, settingsSet } from '@navide/plugin-ui/shared'

// Voice input settings. Both default OFF: with voice input off nothing about
// the feature runs — no mic, no voice.* requests, no hotkey (its `when`
// context stays false).

export const VOICE_INPUT_ENABLED_KEY = 'agentTeam.voiceInputEnabled'
export const VOICE_READBACK_ENABLED_KEY = 'agentTeam.voiceReadbackEnabled'

function read(key: string): boolean {
  return settingsGet<boolean>(key, false) === true
}

const voiceInputEnabled = ref(read(VOICE_INPUT_ENABLED_KEY))
const voiceReadbackEnabled = ref(read(VOICE_READBACK_ENABLED_KEY))

let unsubscribe: (() => void) | null = null

/** Follow writes made by another window (settings are shared app-wide). */
function ensureSubscription(): void {
  if (unsubscribe) return
  unsubscribe = onSettingsChanged((keys) => {
    if (keys.includes(VOICE_INPUT_ENABLED_KEY)) voiceInputEnabled.value = read(VOICE_INPUT_ENABLED_KEY)
    if (keys.includes(VOICE_READBACK_ENABLED_KEY)) voiceReadbackEnabled.value = read(VOICE_READBACK_ENABLED_KEY)
  })
}

export function useVoiceSettings(): {
  voiceInputEnabled: Readonly<Ref<boolean>>
  voiceReadbackEnabled: Readonly<Ref<boolean>>
  setVoiceInputEnabled: (on: boolean) => void
  setVoiceReadbackEnabled: (on: boolean) => void
} {
  ensureSubscription()
  return {
    voiceInputEnabled,
    voiceReadbackEnabled,
    setVoiceInputEnabled: (on) => {
      voiceInputEnabled.value = on
      settingsSet(VOICE_INPUT_ENABLED_KEY, on)
    },
    setVoiceReadbackEnabled: (on) => {
      voiceReadbackEnabled.value = on
      settingsSet(VOICE_READBACK_ENABLED_KEY, on)
    },
  }
}
