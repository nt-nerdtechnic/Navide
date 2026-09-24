// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Fresh modules per test: voiceSettings holds module-level refs and a settings
// subscription that the settings reset would otherwise silently drop.
async function load() {
  vi.resetModules()
  const shared = await import('@navide/plugin-ui/shared')
  const testing = await import('@navide/plugin-ui/shared/testing')
  testing.__resetSettingsForTest()
  const { createMockBackend } = await import('../../composables/__tests__/mockBackend')
  const mod = await import('../voiceSettings')
  return { shared, testing, createMockBackend, mod }
}

describe('voice input device setting', () => {
  let ctx: Awaited<ReturnType<typeof load>>

  // The fresh module graph is imported here rather than in each test: under
  // load the import alone can exceed the 5 s test timeout, and a timed-out
  // test's still-pending import then races the next test's resetModules.
  beforeEach(async () => {
    ctx = await load()
  }, 60_000)
  afterEach(() => {
    ctx.testing.__resetSettingsForTest()
  })

  it('defaults to the system default', () => {
    const { mod } = ctx
    const s = mod.useVoiceSettings()
    expect(s.voiceInputDeviceId.value).toBe('')
    expect(s.voiceInputDeviceLabel.value).toBe('')
  })

  it('persists the chosen id and its label to the settings store', () => {
    const { mod, shared } = ctx
    const s = mod.useVoiceSettings()
    s.setVoiceInputDevice('mic-1', 'USB Mic')
    expect(s.voiceInputDeviceId.value).toBe('mic-1')
    expect(s.voiceInputDeviceLabel.value).toBe('USB Mic')
    expect(shared.settingsGet(mod.VOICE_INPUT_DEVICE_KEY, null)).toBe('mic-1')
    expect(shared.settingsGet(mod.VOICE_INPUT_DEVICE_LABEL_KEY, null)).toBe('USB Mic')
    expect(localStorage.getItem(mod.VOICE_INPUT_DEVICE_KEY)).toBeNull()

    s.setVoiceInputDevice('', 'ignored')
    expect(s.voiceInputDeviceId.value).toBe('')
    expect(shared.settingsGet(mod.VOICE_INPUT_DEVICE_KEY, null)).toBe('')
    expect(shared.settingsGet(mod.VOICE_INPUT_DEVICE_LABEL_KEY, null)).toBe('')
  })

  it('follows a choice made in another window', () => {
    const { mod, shared, createMockBackend } = ctx
    const { backend, emit } = createMockBackend('connected')
    shared.initSettingsBackend(backend)
    const s = mod.useVoiceSettings()
    emit('ui.settings_changed', {
      settings: { [mod.VOICE_INPUT_DEVICE_KEY]: 'mic-2', [mod.VOICE_INPUT_DEVICE_LABEL_KEY]: 'Desk Mic' },
    })
    expect(s.voiceInputDeviceId.value).toBe('mic-2')
    expect(s.voiceInputDeviceLabel.value).toBe('Desk Mic')
  })
})
