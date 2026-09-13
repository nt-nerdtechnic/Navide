// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import ControlPane from '../ControlPane.vue'

// The sidebar pane row mirrors the "∞ Loop" badge the meeting list and pane
// header already show: it reads the same `loopActive` / `loopWaitUntil` view
// fields, so a looping pane is recognisable from the workspace tree without
// switching layout.

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

describe('ControlPane – ∞ Loop tag on sidebar pane rows', () => {
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

  it('renders the tag only on rows whose pane has loopActive', () => {
    mount([
      { ...basePane, id: 'looping', loopActive: true },
      { ...basePane, id: 'plain', loopActive: false },
      { ...basePane, id: 'unset' }
    ])
    const items = wrapper.findAll('.agent-item')
    expect(items).toHaveLength(3)
    expect(items[0].find('.loop-tag').exists()).toBe(true)
    // Icon only — the word was dropped to give the pane name back its width;
    // the tooltip carries the legend instead.
    expect(items[0].find('.loop-tag').text()).toBe('∞')
    expect(items[0].find('.loop-tag').attributes('title')).toBe('pane.terminal.loop-tag-tooltip')
    expect(items[1].find('.loop-tag').exists()).toBe(false)
    expect(items[2].find('.loop-tag').exists()).toBe(false)
    // The rest of the row is untouched: status dot and vendor·role sub-label stay.
    expect(wrapper.findAll('.status-dot')).toHaveLength(3)
    expect(wrapper.findAll('.agent-line-sub')).toHaveLength(3)
  })

  it('marks the tag as waiting while a loop auto-resume is scheduled', () => {
    mount([
      { ...basePane, id: 'waiting', loopActive: true, loopWaitUntil: Date.now() + 60_000 },
      { ...basePane, id: 'active', loopActive: true, loopWaitUntil: null }
    ])
    const tags = wrapper.findAll('.loop-tag')
    expect(tags).toHaveLength(2)
    expect(tags[0].classes()).toContain('waiting')
    expect(tags[1].classes()).not.toContain('waiting')
  })

  it('follows the prop live: tag appears when the loop starts and leaves when it stops', async () => {
    mount([{ ...basePane, id: 'p' }])
    expect(wrapper.find('.loop-tag').exists()).toBe(false)
    await wrapper.setProps({ panes: [{ ...basePane, id: 'p', loopActive: true }] })
    expect(wrapper.find('.loop-tag').exists()).toBe(true)
    await wrapper.setProps({ panes: [{ ...basePane, id: 'p', loopActive: false }] })
    expect(wrapper.find('.loop-tag').exists()).toBe(false)
  })

  it('keeps the tag when the row is expanded (only the sub-label collapses)', async () => {
    mount([{ ...basePane, id: 'p', loopActive: true }])
    await wrapper.find('.agent-line').trigger('click')
    expect(wrapper.find('.agent-item').classes()).toContain('expanded')
    expect(wrapper.find('.agent-line-sub').exists()).toBe(false)
    expect(wrapper.find('.loop-tag').exists()).toBe(true)
  })
})
