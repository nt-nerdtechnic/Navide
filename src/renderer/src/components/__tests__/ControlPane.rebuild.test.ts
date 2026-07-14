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
  panes: [
    {
      id: 'pane-resumable',
      agentKey: 'codex',
      agentLabel: 'Codex',
      status: 'idle',
      command: 'codex',
      origin: 'manual',
      isMinimized: false,
      canRebuild: true
    },
    {
      id: 'pane-not-resumable',
      agentKey: 'shell',
      agentLabel: 'Terminal',
      status: 'idle',
      command: 'zsh',
      origin: 'manual',
      isMinimized: false,
      canRebuild: false
    }
  ],
  pipeline: { state: 'idle' },
  yoloEnabled: false,
  analyzerModel: '',
  analyzerStatus: { available: false, version: '', defaultModel: '', models: [], benchmarkResults: [] },
  autoAnswerEnabled: false,
  existingProject: null,
  canRebuildAll: true,
  rebuildingAll: false
} as unknown as Record<string, unknown>

describe('ControlPane – rebuild control', () => {
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

  it('only renders for panes App marks as rebuildable', () => {
    expect(wrapper.findAll('.agent-rebuild-btn')).toHaveLength(1)
  })

  it('emits the pane id so App can call its existing rebuild implementation', async () => {
    await wrapper.get('.agent-rebuild-btn').trigger('click')
    expect(wrapper.emitted('rebuild')).toEqual([['pane-resumable']])
  })

  it('exposes the same rebuild-all event from the Active agents header', async () => {
    await wrapper.get('.agent-rebuild-all-btn').trigger('click')
    expect(wrapper.emitted('rebuild-all')).toEqual([[]])
  })

  it('disables rebuild-all while App reports a rebuild batch in progress', async () => {
    await wrapper.setProps({ rebuildingAll: true })
    expect(wrapper.get<HTMLButtonElement>('.agent-rebuild-all-btn').element.disabled).toBe(true)
    expect(wrapper.get('.agent-rebuild-all-btn').classes()).toContain('busy')
  })
})
