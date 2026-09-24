// @vitest-environment happy-dom
// Settings ▸ Voice Input: voice input is a page of its own, not a block at the
// bottom of General, and the model row states sizes in one unit.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, shallowMount, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { __resetSettingsForTest } from '@navide/plugin-ui/shared/testing'
import SettingsModal from '../SettingsModal.vue'
import VoiceSettingsSection from '../settings/VoiceSettingsSection.vue'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import { useVoiceSettings } from '../../voice/voiceSettings'

type ModalProps = InstanceType<typeof SettingsModal>['$props']

// The real model file: 147,951,465 bytes, which the hint calls "about 148 MB".
const MODEL_BYTES = 147_951_465

describe('Settings ▸ Voice Input tab', { timeout: 15000 }, () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    __resetSettingsForTest()
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })

  async function mountModal(initialTab: ModalProps['initialTab']) {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', {
      deps: [], models: [], model_catalog: [], complete: true, skip: false,
      gate: {}, cli_health: { entries: [], findings: [], needs_attention: false },
    })
    wrapper = shallowMount(SettingsModal, {
      attachTo: document.body,
      props: {
        backend: mock.backend,
        initialTab,
        rolesApi: {} as ModalProps['rolesApi'],
        stagesApi: {} as ModalProps['stagesApi'],
        analyzerApi: {
          analyzerSettings: ref({ backend: 'ollama' }), health: ref(null), pulling: ref(false), pullProgress: ref(null),
          pullError: ref(''), models: ref([]), benchmarking: ref(false), benchmarkProgress: ref(null), benchmarkResults: ref([]),
        } as unknown as ModalProps['analyzerApi'],
        cliProfilesApi: { identityFor: () => null, profilesForAgent: () => [] } as unknown as ModalProps['cliProfilesApi'],
      },
      global: { plugins: [i18n], stubs: { Teleport: true } },
    })
    await flushPromises()
  }

  it('renders VoiceSettingsSection in the Voice tab body', async () => {
    await mountModal('voice')
    const body = wrapper!.get('[data-settings-section="voice"]')
    expect(body.findComponent(VoiceSettingsSection).exists()).toBe(true)
    expect(body.isVisible()).toBe(true)
  })

  it('renders it exactly once, and not in General', async () => {
    await mountModal('general')
    expect(wrapper!.findAllComponents(VoiceSettingsSection)).toHaveLength(1)
    const general = wrapper!.get('.appearance-body')
    expect(general.findComponent(VoiceSettingsSection).exists()).toBe(false)
  })

  it('has a nav label in every locale', () => {
    for (const locale of ['en-US', 'ja-JP', 'zh-TW'] as const) {
      expect(i18n.global.t('settings.nav.voice', {}, { locale })).not.toBe('settings.nav.voice')
    }
    expect(i18n.global.t('settings.nav.voice', {}, { locale: 'zh-TW' })).toBe('語音輸入')
    expect(i18n.global.t('settings.nav.voice', {}, { locale: 'ja-JP' })).toBe('音声入力')
    expect(i18n.global.t('settings.nav.voice', {}, { locale: 'en-US' })).toBe('Voice Input')
  })
})

describe('VoiceSettingsSection model sizes', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    __resetSettingsForTest()
    i18n.global.locale.value = 'en-US'
    useVoiceSettings().setVoiceInputEnabled(true)
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    useVoiceSettings().setVoiceInputEnabled(false)
  })

  it('reports download progress in the decimal MB the hint uses', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('voice.status', { ok: true, sidecar: 'ok', model: { present: false }, gpu: true })
    wrapper = mount(VoiceSettingsSection, {
      props: { backend: mock.backend },
      global: { plugins: [i18n] },
    })
    await flushPromises()
    expect(wrapper.text()).toContain('about 148 MB')

    mock.emit('voice.model.progress', { bytes: 73_000_000, total: MODEL_BYTES, done: false })
    await flushPromises()
    expect(wrapper.text()).toContain('73.0 / 148.0 MB')
    expect(wrapper.text()).not.toContain('141.1')
  })

  it('states a present model in the same unit', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('voice.status', { ok: true, sidecar: 'ok', model: { present: true, bytes: MODEL_BYTES }, gpu: true })
    wrapper = mount(VoiceSettingsSection, {
      props: { backend: mock.backend },
      global: { plugins: [i18n] },
    })
    await flushPromises()
    expect(wrapper.text()).toContain('148.0 MB')
  })
})
