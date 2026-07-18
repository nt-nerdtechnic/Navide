// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import ControlPane from '../ControlPane.vue'

const minimalProps = {
  backendStatus: 'connected',
  backendUrl: '',
  agentSpecs: [],
  roles: [],
  stages: [],
  panes: [],
  pipeline: { state: 'idle' },
  yoloEnabled: false,
  analyzerModel: '',
  analyzerStatus: { available: false, version: '', defaultModel: '', models: [], benchmarkResults: [] },
  autoAnswerEnabled: false,
  existingProject: null
} as unknown as Record<string, unknown>

describe('ControlPane – open plans button', () => {
  let wrapper: VueWrapper

  beforeEach(() => {
    sessionStorage.setItem('agentTeam.sidebarTab', 'pipeline')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapper = shallowMount(ControlPane as any, {
      props: minimalProps,
      global: { mocks: { $t: (key: string) => key } }
    })
  })

  afterEach(() => {
    wrapper.unmount()
    sessionStorage.clear()
  })

  it('renders the plans button in the Pipelines section header', () => {
    expect(wrapper.find('.plans-btn').exists()).toBe(true)
  })

  it('emits open-plans so App can open the plan review window', async () => {
    await wrapper.get('.plans-btn').trigger('click')
    expect(wrapper.emitted('open-plans')).toEqual([[]])
  })
})
