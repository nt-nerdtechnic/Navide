// @vitest-environment happy-dom
// The voice capsule while dictating: committed text solid, the tentative tail
// faded, both only while a take records or transcribes; plus its hints.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import VoiceCapsule from '../VoiceCapsule.vue'
import type { VoiceCapsuleState } from '../../composables/useVoiceInput'

function makeState(over: Partial<VoiceCapsuleState> = {}): VoiceCapsuleState {
  return reactive<VoiceCapsuleState>({
    phase: 'recording',
    paneId: 'p1',
    committed: '',
    tentative: '',
    handsFree: false,
    capEndsAt: Date.now() + 60_000,
    level: 0.5,
    deviceFallback: false,
    deviceLabel: '',
    error: null,
    ...over,
  })
}

describe('VoiceCapsule live text', () => {
  let wrapper: VueWrapper | undefined
  let pane: HTMLElement

  beforeEach(() => {
    i18n.global.locale.value = 'en-US'
    pane = document.createElement('div')
    pane.setAttribute('data-pane-id', 'p1')
    document.body.appendChild(pane)
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    pane.remove()
  })

  it('shows committed text and the tentative tail in separate spans, keeping the level meter', async () => {
    const state = makeState({ committed: '幫我跑', tentative: '測試' })
    wrapper = mount(VoiceCapsule, { props: { state }, global: { plugins: [i18n] } })
    await nextTick()
    expect(wrapper.get('.vc-committed').text()).toBe('幫我跑')
    expect(wrapper.get('.vc-tentative').text()).toBe('測試')
    expect(wrapper.find('.vc-meter').exists()).toBe(true)
    expect(wrapper.classes()).toContain('voice-capsule--live')

    state.committed = '幫我跑測試'
    state.tentative = ''
    await nextTick()
    expect(wrapper.get('.vc-committed').text()).toBe('幫我跑測試')
    expect(wrapper.get('.vc-tentative').text()).toBe('')
  })

  it('an undelivered transcript stays readable with a Copy button', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const state = makeState({ phase: 'error', error: { key: 'insert-failed', text: '幫我跑測試' } })
    wrapper = mount(VoiceCapsule, { props: { state }, global: { plugins: [i18n] } })
    await nextTick()
    expect(wrapper.get('.vc-kept').text()).toBe('幫我跑測試')
    const copy = wrapper.findAll('button.vc-action').find((b) => b.text() === 'Copy')!
    await copy.trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith('幫我跑測試')
    expect(copy.text()).toBe('Copied')
  })

  it('has no text block before any words arrive, nor on an error', async () => {
    const state = makeState()
    wrapper = mount(VoiceCapsule, { props: { state }, global: { plugins: [i18n] } })
    await nextTick()
    expect(wrapper.find('.vc-live').exists()).toBe(false)
    state.phase = 'error'
    state.error = { key: 'no-speech' }
    state.committed = 'stale'
    await nextTick()
    expect(wrapper.find('.vc-live').exists()).toBe(false)
  })

  it('names the stand-in microphone while recording', async () => {
    wrapper = mount(VoiceCapsule, { props: { state: makeState({ deviceFallback: true }) }, global: { plugins: [i18n] } })
    await nextTick()
    expect(wrapper.text()).toContain('Chosen microphone unavailable — using the system default')
  })

  it('names the device a fallback records from when it is known', async () => {
    wrapper = mount(VoiceCapsule, {
      props: { state: makeState({ deviceFallback: true, deviceLabel: 'MacBook Pro Microphone' }) },
      global: { plugins: [i18n] },
    })
    await nextTick()
    expect(wrapper.text()).toContain('Chosen microphone unavailable — using “MacBook Pro Microphone”')
  })

  it('names the microphone in a mic error', async () => {
    i18n.global.locale.value = 'zh-TW'
    wrapper = mount(VoiceCapsule, {
      props: { state: makeState({ phase: 'error', error: { key: 'mic-silent-device', params: { device: 'Neil’s AirPods 4' } } }) },
      global: { plugins: [i18n] },
    })
    await nextTick()
    expect(wrapper.text()).toContain('麥克風「Neil’s AirPods 4」沒有收到聲音')
  })
})
