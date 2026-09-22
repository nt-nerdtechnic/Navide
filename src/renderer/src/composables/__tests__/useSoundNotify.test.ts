// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetSettingsForTest } from '@navide/plugin-ui/shared/testing'
import { settingsGet } from '@navide/plugin-ui/shared'
import {
  NOTIFY_SOUND_ENABLED_KEY,
  notifySoundEnabled,
  playAttentionSound,
  playDoneSound,
  setNotifySoundEnabled,
} from '../useSoundNotify'

// The module keeps one lazily-created AudioContext, so "did a sound play" is
// observed on the oscillators it schedules rather than on construction.
const oscStart = vi.fn()

class FakeAudioContext {
  state = 'running'
  currentTime = 0
  destination = {}
  resume = vi.fn()
  createOscillator() {
    return {
      type: 'sine',
      frequency: { value: 0 },
      connect: vi.fn(),
      start: oscStart,
      stop: vi.fn(),
    }
  }
  createGain() {
    return {
      connect: vi.fn(),
      gain: {
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
    }
  }
}

describe('useSoundNotify — sound toggle', () => {
  beforeEach(() => {
    __resetSettingsForTest()
    oscStart.mockClear()
    vi.stubGlobal('AudioContext', FakeAudioContext)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('defaults to enabled when nothing was ever saved', () => {
    expect(notifySoundEnabled()).toBe(true)
  })

  it('plays both tones of the done chime when enabled', () => {
    playDoneSound()
    expect(oscStart).toHaveBeenCalledTimes(2)
  })

  it('plays nothing when disabled', () => {
    setNotifySoundEnabled(false)
    expect(settingsGet(NOTIFY_SOUND_ENABLED_KEY, true)).toBe(false)
    playDoneSound()
    playAttentionSound()
    expect(oscStart).not.toHaveBeenCalled()
  })

  it('re-enabling resumes playback', () => {
    setNotifySoundEnabled(false)
    playAttentionSound()
    setNotifySoundEnabled(true)
    playAttentionSound()
    expect(oscStart).toHaveBeenCalledTimes(2)
  })
})
