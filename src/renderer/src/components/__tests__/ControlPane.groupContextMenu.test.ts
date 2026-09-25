// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import ControlPane from '../ControlPane.vue'

// A right-click on a run-group heading hands App.vue the workspace and the
// group, so it can open the same menu a stage tab opens. The ungrouped
// section travels as '' — App maps it to the tab bar's 'manual' key.

const panes = [
  { id: 'p1', agentLabel: 'A', status: 'idle', command: 'c', origin: 'manual', isMinimized: false, isCommander: false },
  { id: 'p2', agentLabel: 'B', status: 'idle', command: 'c', origin: 'manual', isMinimized: false, isCommander: false }
]

const ws = (path: string, groups: unknown[]) => ({
  path,
  label: path.split('/').pop(),
  displayPath: path,
  isCurrent: true,
  collapsed: false,
  count: 2, paneIds: [],
  lineage: [],
  groups
})

function mountWith(workspaces: unknown[]): VueWrapper {
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
      workspace: '/w/one',
      existingProject: null,
      workspaces,
    } as never,
    global: { mocks: { $t: (key: string) => key } }
  })
}

describe('ControlPane – run-group heading right-click', () => {
  let wrapper: VueWrapper
  afterEach(() => wrapper?.unmount())

  it('emits the workspace and group id for a named group and for the ungrouped section', async () => {
    wrapper = mountWith([
      ws('/w/one', [
        { id: 'g1', name: 'Run 1', rows: [{ id: 'p1', depth: 0, hasChildren: false, collapsed: false }] },
        { id: '', name: '', rows: [{ id: 'p2', depth: 0, hasChildren: false, collapsed: false }] }
      ])
    ])
    const heads = wrapper.findAll('.ws-grp')
    expect(heads).toHaveLength(2)
    await heads[0].trigger('contextmenu')
    await heads[1].trigger('contextmenu')
    const emitted = wrapper.emitted('group-context-menu') as unknown[][]
    expect(emitted.map((e) => e.slice(0, 2))).toEqual([['/w/one', 'g1'], ['/w/one', '']])
    expect(emitted[0][2]).toBeInstanceOf(Event)
  })

  it('suppresses the native copy/paste menu on the heading', () => {
    wrapper = mountWith([
      ws('/w/one', [{ id: 'g1', name: 'Run 1', rows: [{ id: 'p1', depth: 0, hasChildren: false, collapsed: false }] }])
    ])
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    wrapper.find('.ws-grp').element.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
  })

  it('names the heading\'s own workspace when the sidebar holds several', async () => {
    wrapper = mountWith([
      ws('/w/one', [{ id: 'g1', name: 'Run 1', rows: [{ id: 'p1', depth: 0, hasChildren: false, collapsed: false }] }]),
      ws('/w/two', [{ id: 'g9', name: 'Other', rows: [{ id: 'p2', depth: 0, hasChildren: false, collapsed: false }] }])
    ])
    const heads = wrapper.findAll('.ws-grp')
    await heads[heads.length - 1].trigger('contextmenu')
    expect((wrapper.emitted('group-context-menu') as unknown[][])[0].slice(0, 2)).toEqual(['/w/two', 'g9'])
  })
})
