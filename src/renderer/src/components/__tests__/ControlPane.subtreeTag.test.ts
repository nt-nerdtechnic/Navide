// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import ControlPane from '../ControlPane.vue'

// A parent pane's own status pill only says what ITS terminal is doing. The
// "↳ n" subtree tag beside it says what the panes it spawned are doing — the
// loudest status among all descendants, and how many of them are in it — so a
// folded subtree can no longer hide a child that is still running or parked
// on a permission prompt.

function makeProps(panes: Record<string, unknown>[], collapsed: string[] = []): Record<string, unknown> {
  return {
    backendStatus: 'connected',
    backendUrl: '',
    agentSpecs: [],
    roles: [],
    stages: [],
    panes,
    lineage: lineageOf(panes, new Set(collapsed)),
    pipeline: { state: 'idle' },
    yoloEnabled: false,
    analyzerModel: '',
    analyzerStatus: { available: false, version: '', defaultModel: '', models: [], benchmarkResults: [] },
    autoAnswerEnabled: false,
    existingProject: null
  }
}

/** The rows the sidebar would be handed: parents before children, a collapsed
 *  parent's children left out — the shape that used to hide the signal. */
function lineageOf(panes: Record<string, unknown>[], collapsed: Set<string>) {
  const rows: Record<string, unknown>[] = []
  const walk = (parent: string, depth: number): void => {
    for (const p of panes) {
      if ((p.spawnedBy ?? '') !== parent) continue
      const id = p.id as string
      const hasChildren = panes.some((c) => c.spawnedBy === id)
      rows.push({ id, depth, hasChildren, collapsed: collapsed.has(id), ancestors: [], descendantCount: 0 })
      if (!collapsed.has(id)) walk(id, depth + 1)
    }
  }
  walk('', 0)
  return rows
}

const basePane = { agentLabel: 'Claude', status: 'idle', command: 'claude', origin: 'manual', isMinimized: false, isCommander: false }

describe('ControlPane – subtree status tag on parent pane rows', () => {
  let wrapper: VueWrapper

  function mount(panes: Record<string, unknown>[], collapsed: string[] = []): void {
    sessionStorage.setItem('agentTeam.sidebarTab', 'agents')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapper = shallowMount(ControlPane as any, {
      props: makeProps(panes, collapsed),
      global: { mocks: { $t: (key: string) => key } }
    })
  }

  afterEach(() => {
    wrapper.unmount()
    sessionStorage.clear()
  })


  it('paints the parent with the loudest descendant status and counts how many share it', () => {
    mount([
      { ...basePane, id: 'parent', status: 'idle' },
      { ...basePane, id: 'c1', spawnedBy: 'parent', status: 'idle' },
      { ...basePane, id: 'c2', spawnedBy: 'parent', status: 'running' },
      { ...basePane, id: 'c3', spawnedBy: 'parent', status: 'running' }
    ])
    const tags = wrapper.findAll('.subtree-tag')
    expect(tags).toHaveLength(1)
    expect(tags[0].text()).toBe('↳ 2')
    expect(tags[0].attributes('data-state')).toBe('running')
    // The legend is real i18n (script-side), not the template's $t mock.
    expect(tags[0].attributes('title')).toBe('2 spawned pane(s) running under this one')
    // The parent's own pill is untouched: it is still idle, and can be typed into.
    const parentRow = wrapper.findAll('.agent-item')[0]
    expect(parentRow.find('.status-dot').attributes('data-state')).toBe('idle')
  })

  it('lets awaiting outrank running, so a blocked child is what the parent shows', () => {
    mount([
      { ...basePane, id: 'parent' },
      { ...basePane, id: 'c1', spawnedBy: 'parent', status: 'running' },
      { ...basePane, id: 'c2', spawnedBy: 'parent', status: 'awaiting' }
    ])
    const tag = wrapper.find('.subtree-tag')
    expect(tag.attributes('data-state')).toBe('awaiting')
    expect(tag.text()).toBe('↳ 1')
  })

  it('renders nothing when every descendant is idle, or when a pane has none', () => {
    mount([
      { ...basePane, id: 'parent' },
      { ...basePane, id: 'c1', spawnedBy: 'parent', status: 'idle' },
      { ...basePane, id: 'c2', spawnedBy: 'parent', status: 'exited' },
      { ...basePane, id: 'lone', status: 'running' }
    ])
    expect(wrapper.findAll('.subtree-tag')).toHaveLength(0)
  })

  it('counts grandchildren, and keeps the tag on a collapsed parent', () => {
    mount(
      [
        { ...basePane, id: 'parent' },
        { ...basePane, id: 'child', spawnedBy: 'parent', status: 'idle' },
        { ...basePane, id: 'grandchild', spawnedBy: 'child', status: 'running' }
      ],
      ['parent']
    )
    // Only the collapsed parent is drawn — the running grandchild is off screen.
    expect(wrapper.findAll('.agent-item')).toHaveLength(1)
    const tag = wrapper.find('.subtree-tag')
    expect(tag.exists()).toBe(true)
    expect(tag.text()).toBe('↳ 1')
    expect(tag.attributes('data-state')).toBe('running')
  })

  it('does not paint the tag on the children themselves', () => {
    mount([
      { ...basePane, id: 'parent' },
      { ...basePane, id: 'c1', spawnedBy: 'parent', status: 'running' },
      { ...basePane, id: 'c2', spawnedBy: 'parent', status: 'running' }
    ])
    const items = wrapper.findAll('.agent-item')
    expect(items).toHaveLength(3)
    expect(items[0].find('.subtree-tag').exists()).toBe(true)
    expect(items[1].find('.subtree-tag').exists()).toBe(false)
    expect(items[2].find('.subtree-tag').exists()).toBe(false)
  })
})
