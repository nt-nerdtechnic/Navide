// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import ControlPane from '../ControlPane.vue'

// The sidebar pane row mirrors the 🔇 badge the pane header shows: it reads the
// same `isMuted` view field, so a muted pane is recognisable from the workspace
// tree. Same harness as ControlPane.loopTag.test.ts.

function makeProps(panes: Record<string, unknown>[]): Record<string, unknown> {
  return {
    backendStatus: 'connected',
    backendUrl: '',
    agentSpecs: [],
    roles: [],
    stages: [],
    panes,
    pipeline: { state: 'idle' },
    yoloEnabled: false,
    analyzerModel: '',
    analyzerStatus: { available: false, version: '', defaultModel: '', models: [], benchmarkResults: [] },
    autoAnswerEnabled: false,
    existingProject: null
  }
}

const basePane = { agentLabel: 'Claude', status: 'idle', command: 'claude', origin: 'manual', isMinimized: false, isCommander: false }

describe('ControlPane – 🔇 mute tag on sidebar pane rows', () => {
  let wrapper: VueWrapper

  function mount(panes: Record<string, unknown>[]): void {
    sessionStorage.setItem('agentTeam.sidebarTab', 'agents')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapper = shallowMount(ControlPane as any, {
      props: makeProps(panes),
      global: { mocks: { $t: (key: string) => key } }
    })
  }

  afterEach(() => {
    wrapper.unmount()
    sessionStorage.clear()
  })

  it('renders the tag only on rows whose pane is muted', () => {
    mount([
      { ...basePane, id: 'quiet', isMuted: true },
      { ...basePane, id: 'loud', isMuted: false },
      { ...basePane, id: 'unset' }
    ])
    const items = wrapper.findAll('.agent-item')
    expect(items).toHaveLength(3)
    expect(items[0].find('.muted-tag').exists()).toBe(true)
    expect(items[0].find('.muted-tag').attributes('title')).toBe('pane.terminal.muted-tooltip')
    expect(items[1].find('.muted-tag').exists()).toBe(false)
    expect(items[2].find('.muted-tag').exists()).toBe(false)
  })

  it('coexists with the loop tag on the same row', () => {
    mount([{ ...basePane, id: 'both', isMuted: true, loopActive: true }])
    const row = wrapper.find('.agent-item')
    expect(row.find('.loop-tag').exists()).toBe(true)
    expect(row.find('.muted-tag').exists()).toBe(true)
  })

  it('follows the prop live: appears on mute and leaves on unmute', async () => {
    mount([{ ...basePane, id: 'p' }])
    expect(wrapper.find('.muted-tag').exists()).toBe(false)
    await wrapper.setProps({ panes: [{ ...basePane, id: 'p', isMuted: true }] })
    expect(wrapper.find('.muted-tag').exists()).toBe(true)
    await wrapper.setProps({ panes: [{ ...basePane, id: 'p', isMuted: false }] })
    expect(wrapper.find('.muted-tag').exists()).toBe(false)
  })
})
