// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import ControlPane from '../ControlPane.vue'

// The sidebar row as a two-band drop target: the middle of the row nests the
// dragged pane under it ('nest-pane'), the edges keep the reorder that was
// there first ('reorder-pane'). A row the helper would refuse — the dragged
// pane's own descendant, a pane in another workspace — gets no nest
// affordance when the sidebar knows the batch (it started the drag).
// happy-dom has no layout, so the boxes are stubbed: every <li> is LI_HEIGHT
// tall as if expanded with detail lines, and its .agent-line (the name line
// the band is measured on) is the top ROW_HEIGHT of it.

const WS = '/ws/a'
const pane = (id: string, spawnedBy?: string, workspacePath = WS) => ({
  id,
  agentLabel: id,
  status: 'running',
  command: 'claude',
  origin: 'manual',
  isMinimized: false,
  isCommander: false,
  workspacePath,
  ...(spawnedBy ? { spawnedBy } : {}),
})

const minimalProps = {
  backendStatus: 'connected',
  backendUrl: '',
  agentSpecs: [],
  roles: [],
  stages: [],
  panes: [pane('pane-a'), pane('pane-a1', 'pane-a'), pane('pane-b'), pane('pane-x', undefined, '/ws/x')],
  pipeline: { state: 'idle' },
  yoloEnabled: false,
  analyzerModel: '',
  analyzerStatus: { available: false, version: '', defaultModel: '', models: [], benchmarkResults: [] },
  autoAnswerEnabled: false,
  existingProject: null
} as unknown as Record<string, unknown>

const ROW_HEIGHT = 20
const LI_HEIGHT = 80

/** DragEvent stand-in with the pointer at `clientY` inside a row whose box is
 *  stubbed to start at 0 and be ROW_HEIGHT tall. */
function dragEvent(type: string, paneId: string | null, clientY = 0): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(ev, {
    clientY,
    dataTransfer: {
      types: paneId === null ? [] : ['application/x-pane-id'],
      getData: (t: string) => (t === 'application/x-pane-id' ? (paneId ?? '') : ''),
      setData: vi.fn(),
      effectAllowed: ''
    }
  })
  return ev
}

const MIDDLE = ROW_HEIGHT / 2
const TOP_EDGE = 1
/** Inside the <li> but below the name line — on an expanded row's details. */
const DETAIL_LINES = LI_HEIGHT - ROW_HEIGHT / 2

describe('ControlPane – nest-pane drop on the middle band of a row', () => {
  let wrapper: VueWrapper

  beforeEach(() => {
    sessionStorage.setItem('agentTeam.sidebarTab', 'agents')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapper = shallowMount(ControlPane as any, {
      props: minimalProps,
      global: { mocks: { $t: (key: string) => key } }
    })
    const box = (height: number): DOMRect =>
      ({ top: 0, height, bottom: height, left: 0, right: 100, width: 100, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    for (const row of wrapper.findAll('.agent-item')) {
      ;(row.element as HTMLElement).getBoundingClientRect = () => box(LI_HEIGHT)
      ;(row.element.querySelector('.agent-line') as HTMLElement).getBoundingClientRect = () => box(ROW_HEIGHT)
    }
  })

  afterEach(() => {
    wrapper.unmount()
    sessionStorage.clear()
  })

  function row(id: string): HTMLElement {
    const found = wrapper.findAll('.agent-item').find((r) => r.text().includes(id))
    if (!found) throw new Error(`no row for ${id}`)
    return found.element as HTMLElement
  }
  const classesOf = (id: string): string[] => Array.from(row(id).classList)

  it('emits nest-pane when dropped on the middle band, reorder-pane on the edge', async () => {
    row('pane-b').dispatchEvent(dragEvent('drop', 'pane-a', MIDDLE))
    row('pane-b').dispatchEvent(dragEvent('drop', 'pane-a', TOP_EDGE))
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('nest-pane')).toEqual([['pane-a', 'pane-b']])
    expect(wrapper.emitted('reorder-pane')).toEqual([['pane-a', 'pane-b']])
  })

  it('measures the band on the name line, so an expanded row’s detail lines reorder', async () => {
    row('pane-b').dispatchEvent(dragEvent('drop', 'pane-a', DETAIL_LINES))
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('nest-pane')).toBeUndefined()
    expect(wrapper.emitted('reorder-pane')).toEqual([['pane-a', 'pane-b']])
  })

  it('shows the nest affordance in the middle band and the reorder ring at the edge', async () => {
    row('pane-b').dispatchEvent(dragEvent('dragover', 'pane-a', MIDDLE))
    await wrapper.vm.$nextTick()
    expect(classesOf('pane-b')).toContain('agent-item--nest')
    expect(classesOf('pane-b')).not.toContain('drag-over')

    row('pane-b').dispatchEvent(dragEvent('dragover', 'pane-a', TOP_EDGE))
    await wrapper.vm.$nextTick()
    expect(classesOf('pane-b')).toContain('drag-over')
    expect(classesOf('pane-b')).not.toContain('agent-item--nest')

    row('pane-b').dispatchEvent(dragEvent('dragleave', 'pane-a', TOP_EDGE))
    await wrapper.vm.$nextTick()
    expect(classesOf('pane-b')).not.toContain('drag-over')
  })

  it('gives no nest affordance to a descendant of the pane the sidebar is dragging', async () => {
    const line = wrapper.findAll('.agent-item .agent-line').find((l) => l.text().includes('pane-a'))!
    line.element.dispatchEvent(dragEvent('dragstart', 'pane-a'))
    const ev = dragEvent('dragover', 'pane-a', MIDDLE)
    row('pane-a1').dispatchEvent(ev)
    await wrapper.vm.$nextTick()
    expect(classesOf('pane-a1')).not.toContain('agent-item--nest')
    expect(ev.defaultPrevented).toBe(false)
    // The edge still reorders: refusing to nest does not refuse the drag.
    row('pane-a1').dispatchEvent(dragEvent('dragover', 'pane-a', TOP_EDGE))
    await wrapper.vm.$nextTick()
    expect(classesOf('pane-a1')).toContain('drag-over')
    line.element.dispatchEvent(dragEvent('dragend', 'pane-a'))
  })

  it('gives no nest affordance to a row in another workspace', async () => {
    const line = wrapper.findAll('.agent-item .agent-line').find((l) => l.text().includes('pane-b'))!
    line.element.dispatchEvent(dragEvent('dragstart', 'pane-b'))
    const ev = dragEvent('dragover', 'pane-b', MIDDLE)
    row('pane-x').dispatchEvent(ev)
    await wrapper.vm.$nextTick()
    expect(classesOf('pane-x')).not.toContain('agent-item--nest')
    expect(ev.defaultPrevented).toBe(false)
    line.element.dispatchEvent(dragEvent('dragend', 'pane-b'))
  })

  it('clears the nest affordance on dragend', async () => {
    const line = wrapper.findAll('.agent-item .agent-line').find((l) => l.text().includes('pane-a'))!
    line.element.dispatchEvent(dragEvent('dragstart', 'pane-a'))
    row('pane-b').dispatchEvent(dragEvent('dragover', 'pane-a', MIDDLE))
    await wrapper.vm.$nextTick()
    expect(classesOf('pane-b')).toContain('agent-item--nest')
    line.element.dispatchEvent(dragEvent('dragend', 'pane-a'))
    await wrapper.vm.$nextTick()
    expect(classesOf('pane-b')).not.toContain('agent-item--nest')
  })
})

describe('ControlPane – root-pane drop on a run group header', () => {
  const path = '/ws/a'
  const groupedWorkspace = {
    path,
    label: 'a',
    displayPath: '~/a',
    isCurrent: true,
    collapsed: false,
    count: 3,
    paneIds: ['pane-a', 'pane-a1', 'pane-b'],
    lineage: [],
    groups: [
      { id: 'g1', name: 'Run 1', rows: [
        { id: 'pane-a', depth: 0, hasChildren: true, collapsed: false },
        { id: 'pane-a1', depth: 1, hasChildren: false, collapsed: false }
      ] },
      { id: 'g2', name: 'Run 2', rows: [
        { id: 'pane-b', depth: 0, hasChildren: false, collapsed: false }
      ] }
    ]
  }
  let wrapper: VueWrapper

  beforeEach(() => {
    sessionStorage.setItem('agentTeam.sidebarTab', 'agents')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapper = shallowMount(ControlPane as any, {
      props: {
        ...minimalProps,
        panes: [
          { ...pane('pane-a'), runGroupId: 'g1' },
          { ...pane('pane-a1', 'pane-a'), runGroupId: 'g1' },
          { ...pane('pane-b'), runGroupId: 'g2' }
        ],
        workspace: path,
        workspaces: [groupedWorkspace]
      },
      global: { mocks: { $t: (key: string) => key } }
    })
  })

  afterEach(() => {
    wrapper.unmount()
    sessionStorage.clear()
  })

  function header(name: string): HTMLElement {
    const found = wrapper.findAll('.ws-grp').find((h) => h.text().includes(name))
    if (!found) throw new Error(`no group header ${name}`)
    return found.element as HTMLElement
  }

  it('emits root-pane with the header’s workspace and group on drop', async () => {
    header('Run 2').dispatchEvent(dragEvent('drop', 'pane-a1'))
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('root-pane')).toEqual([['pane-a1', path, 'g2']])
  })

  it('highlights the header while a nested pane hovers it, and clears on dragleave', async () => {
    header('Run 2').dispatchEvent(dragEvent('dragover', 'pane-a1'))
    await wrapper.vm.$nextTick()
    expect(Array.from(header('Run 2').classList)).toContain('ws-grp--drop')
    header('Run 2').dispatchEvent(dragEvent('dragleave', 'pane-a1'))
    await wrapper.vm.$nextTick()
    expect(Array.from(header('Run 2').classList)).not.toContain('ws-grp--drop')
  })

  it('gives no affordance to the header of the group a sidebar-dragged root already sits in', async () => {
    const line = wrapper.findAll('.agent-item .agent-line').find((l) => l.text().includes('pane-b'))!
    line.element.dispatchEvent(dragEvent('dragstart', 'pane-b'))
    const ev = dragEvent('dragover', 'pane-b')
    header('Run 2').dispatchEvent(ev)
    await wrapper.vm.$nextTick()
    expect(Array.from(header('Run 2').classList)).not.toContain('ws-grp--drop')
    expect(ev.defaultPrevented).toBe(false)
    line.element.dispatchEvent(dragEvent('dragend', 'pane-b'))
  })

  it('ignores a drop without a pane-id payload', async () => {
    header('Run 2').dispatchEvent(dragEvent('drop', null))
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('root-pane')).toBeUndefined()
  })
})
