// @vitest-environment happy-dom
// Workspace self-evolution entry on the sidebar heading: each heading has its
// own badge (on / running / off / failed) and the badge, the ⋯ menu row and
// the right-click menu row all open the panel of THAT heading's workspace.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import { effectScope, ref } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import ControlPane from '../ControlPane.vue'
import {
  __resetEvolveForTest,
  setEvolveBadge,
  useEvolve,
  useEvolveBadges,
  type EvolveBadge,
} from '../../composables/useEvolve'
import type { useBackend } from '../../composables/useBackend'

const A = '/Users/me/Desktop/alpha'
const B = '/Users/me/Desktop/beta'

const wsRow = (path: string, label: string) => ({
  path,
  label,
  displayPath: '~/Desktop',
  isCurrent: true,
  collapsed: false,
  count: 1,
  paneIds: [],
  lineage: [],
  groups: [{ id: '', name: '', rows: [] }],
  remote: [],
})

const panes = [
  { id: 'a1', agentLabel: 'Claude', status: 'running', command: 'claude', origin: 'manual', isMinimized: false, isCommander: false, workspacePath: A },
  { id: 'b1', agentLabel: 'Claude', status: 'running', command: 'claude', origin: 'manual', isMinimized: false, isCommander: false, workspacePath: B },
]

const badge = (over: Partial<EvolveBadge> = {}): EvolveBadge => ({
  enabled: false,
  running: false,
  running_since: null,
  next_run_at: null,
  last_status: null,
  ...over,
})

const sent: { type: string; payload: Record<string, unknown> }[] = []

function evolveBackend(): ReturnType<typeof useBackend> {
  return {
    status: ref('connected'),
    send: vi.fn(async (type: string, payload: Record<string, unknown>) => {
      sent.push({ type, payload })
      return { id: 'r', type, ok: true, payload: { ok: true, badges: {} }, error: null, timestamp: '' }
    }),
    on: () => () => {},
  } as unknown as ReturnType<typeof useBackend>
}

function mountWith(): VueWrapper {
  sessionStorage.setItem('agentTeam.sidebarTab', 'agents')
  return shallowMount(ControlPane as never, {
    attachTo: document.body,
    props: {
      backendStatus: 'connected',
      backendUrl: '',
      backend: { send: vi.fn().mockResolvedValue({ payload: { deps: [] } }) },
      agentSpecs: [{ agentKey: 'claude', label: 'Claude Code' }],
      roles: [],
      stages: [],
      panes,
      pipeline: { state: 'idle' },
      yoloEnabled: false,
      analyzerModel: '',
      analyzerStatus: { available: false, version: '', defaultModel: '', models: [], benchmarkResults: [] },
      autoAnswerEnabled: false,
      workspace: A,
      existingProject: null,
      workspaces: [wsRow(A, 'alpha'), wsRow(B, 'beta')],
    } as never,
    global: { mocks: { $t: (key: string) => key } },
  })
}

const badgeOf = (wrapper: VueWrapper, n: number) => wrapper.findAll('.ws-head')[n].get('[data-test="evolve-badge"]')

describe('ControlPane – workspace self-evolution entry', () => {
  let wrapper: VueWrapper
  let scope: ReturnType<typeof effectScope>

  beforeEach(() => {
    i18n.global.locale.value = 'zh-TW'
    sent.length = 0
    __resetEvolveForTest()
    scope = effectScope()
    scope.run(() => useEvolve(evolveBackend()))
  })
  afterEach(() => {
    wrapper?.unmount()
    scope.stop()
  })

  it('asks the backend for the badge of every heading', async () => {
    wrapper = mountWith()
    await flushPromises()
    expect(sent).toEqual([{ type: 'evolve.badges', payload: { workspaces: [A, B] } }])
  })

  it('shows each workspace its own badge state', async () => {
    setEvolveBadge(A, badge({ enabled: true, next_run_at: Date.now() + 60_000 }))
    setEvolveBadge(B, badge())
    wrapper = mountWith()
    await flushPromises()
    expect(badgeOf(wrapper, 0).attributes('data-state')).toBe('on')
    expect(badgeOf(wrapper, 1).attributes('data-state')).toBe('off')
    expect(badgeOf(wrapper, 1).text()).toContain('自我優化 關')

    setEvolveBadge(B, badge({ enabled: true, running: true, running_since: Date.now() }))
    await flushPromises()
    expect(badgeOf(wrapper, 1).attributes('data-state')).toBe('running')
    expect(badgeOf(wrapper, 0).attributes('data-state')).toBe('on')

    setEvolveBadge(A, badge({ enabled: true, last_status: 'error' }))
    await flushPromises()
    expect(badgeOf(wrapper, 0).attributes('data-state')).toBe('failed')
  })

  it('opens the clicked heading workspace panel from the badge, without switching workspace', async () => {
    wrapper = mountWith()
    await badgeOf(wrapper, 1).trigger('click')
    expect(useEvolveBadges().panelWorkspace.value).toBe(B)
    expect(wrapper.emitted('switch-to-workspace')).toBeUndefined()
  })

  it('opens it from the ⋯ menu', async () => {
    wrapper = mountWith()
    await wrapper.findAll('.ws-head')[1].find('.ws-more').trigger('click')
    const item = wrapper.get('[data-test="evolve-menu"]')
    expect(item.text()).toContain('evolve.menu.open')
    await item.trigger('click')
    expect(useEvolveBadges().panelWorkspace.value).toBe(B)
    expect(wrapper.find('.ws-more-menu').exists()).toBe(false)
  })

  it('marks the ⋯ row when the workspace has it enabled', async () => {
    setEvolveBadge(A, badge({ enabled: true }))
    wrapper = mountWith()
    await wrapper.findAll('.ws-head')[0].find('.ws-more').trigger('click')
    expect(wrapper.get('[data-test="evolve-menu"]').text()).toContain('evolve.menu.enabled')
  })

  it('opens it from the right-click menu', async () => {
    wrapper = mountWith()
    await wrapper.findAll('.ws-head')[0].trigger('contextmenu')
    await wrapper.get('[data-test="evolve-ctx"]').trigger('click')
    expect(useEvolveBadges().panelWorkspace.value).toBe(A)
    expect(wrapper.find('.ws-ctx-menu').exists()).toBe(false)
  })
})
