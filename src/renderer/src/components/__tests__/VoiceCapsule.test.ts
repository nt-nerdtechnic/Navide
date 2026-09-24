// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import VoiceCapsule from '../VoiceCapsule.vue'
import type { VoiceCapsuleState } from '../../composables/useVoiceInput'

let wrapper: VueWrapper

function state(over: Partial<VoiceCapsuleState>): VoiceCapsuleState {
  return {
    phase: 'idle', paneId: 'p1', text: '', countdownEndsAt: 0, hold: null, handsFree: false,
    capEndsAt: 0, level: 0, deviceFallback: false, awaitingSend: false, error: null, ...over,
  }
}

function render(s: VoiceCapsuleState): VueWrapper {
  wrapper = mount(VoiceCapsule, { props: { state: s }, global: { plugins: [i18n] } })
  return wrapper
}

beforeEach(() => {
  i18n.global.locale.value = 'en-US'
  // The capsule hides itself without a pane to sit on.
  const pane = document.createElement('div')
  pane.dataset.paneId = 'p1'
  document.body.appendChild(pane)
})
afterEach(() => {
  wrapper?.unmount()
  document.body.innerHTML = ''
})

describe('VoiceCapsule', () => {
  it('a capped transcript offers send and discard instead of a countdown', async () => {
    render(state({ phase: 'countdown', text: '幫我跑測試', awaitingSend: true }))
    expect(wrapper.text()).toContain('Time limit reached — send it?')
    expect(wrapper.find('.vc-bar').exists()).toBe(false)
    const [send, discard] = wrapper.findAll('button')
    await send.trigger('click')
    expect(wrapper.emitted('send')).toHaveLength(1)
    await discard.trigger('click')
    expect(wrapper.emitted('dismiss')).toHaveLength(1)
  })

  it('an ordinary countdown keeps its bar and no buttons', () => {
    render(state({ phase: 'countdown', text: '幫我跑測試', countdownEndsAt: Date.now() + 1_000 }))
    expect(wrapper.find('.vc-bar').exists()).toBe(true)
    expect(wrapper.findAll('button')).toHaveLength(0)
  })

  it('names the stand-in microphone while recording', () => {
    render(state({ phase: 'recording', deviceFallback: true }))
    expect(wrapper.text()).toContain('Chosen microphone unavailable — using the system default')
  })
})
