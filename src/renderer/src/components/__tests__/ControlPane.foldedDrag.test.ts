// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import ControlPane from '../ControlPane.vue'
import { PANE_BATCH_MIME } from '@navide/terminal'

// Dragging a folded row carries its hidden subtree: the batch MIME lists the
// parent and every descendant, and 'select-panes' asks App to make that the
// multi-selection so the drop side (which resolves the batch from the
// selection) moves the same set. An expanded parent keeps the single-pane
// drag it always had.

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
const panes = [
  { ...basePane, id: 'parent' },
  { ...basePane, id: 'child', spawnedBy: 'parent' },
  { ...basePane, id: 'grandchild', spawnedBy: 'child' },
  { ...basePane, id: 'other' },
  { ...basePane, id: 'other-kid', spawnedBy: 'other' }
]

function dragStart(): { ev: Event; data: Map<string, string> } {
  const data = new Map<string, string>()
  const ev = new Event('dragstart', { bubbles: true, cancelable: true })
  Object.assign(ev, {
    dataTransfer: {
      types: [],
      getData: (t: string) => data.get(t) ?? '',
      setData: (t: string, v: string) => { data.set(t, v) },
      setDragImage: vi.fn(),
      effectAllowed: ''
    }
  })
  return { ev, data }
}

describe('ControlPane – dragging a folded row carries its subtree', () => {
  let wrapper: VueWrapper

  function mount(collapsed: string[], selected: string[] = []): void {
    sessionStorage.setItem('agentTeam.sidebarTab', 'agents')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapper = shallowMount(ControlPane as any, {
      props: { ...makeProps(panes, collapsed), selectedPaneIds: new Set(selected) },
      global: { mocks: { $t: (key: string) => key } }
    })
  }

  afterEach(() => {
    wrapper.unmount()
    sessionStorage.clear()
  })

  function line(idx: number): HTMLElement {
    return wrapper.findAll('.agent-item .agent-line')[idx].element as HTMLElement
  }

  it('writes the batch MIME with every descendant and selects them', async () => {
    mount(['parent'])
    const { ev, data } = dragStart()
    line(0).dispatchEvent(ev)
    await wrapper.vm.$nextTick()
    expect(data.get('application/x-pane-id')).toBe('parent')
    expect(data.get(PANE_BATCH_MIME)).toBe('parent\nchild\ngrandchild')
    expect(wrapper.emitted('select-panes')).toEqual([[['parent', 'child', 'grandchild']]])
  })

  it('leaves an expanded parent as a single-pane drag', async () => {
    mount([])
    const { ev, data } = dragStart()
    line(0).dispatchEvent(ev)
    await wrapper.vm.$nextTick()
    expect(data.has(PANE_BATCH_MIME)).toBe(false)
    expect(wrapper.emitted('select-panes')).toBeUndefined()
  })

  it('adds only the dragged row\'s subtree to an existing multi-selection', async () => {
    // 'other' is an expanded parent in the selection: its child must NOT be
    // swept in — only the folded row being dragged stands for its subtree.
    mount(['parent'], ['other', 'parent'])
    const { ev, data } = dragStart()
    line(0).dispatchEvent(ev)
    await wrapper.vm.$nextTick()
    expect(data.get(PANE_BATCH_MIME)).toBe('parent\nchild\ngrandchild\nother')
    expect(wrapper.emitted('select-panes')).toEqual([[['parent', 'child', 'grandchild', 'other']]])
  })

  it('does not re-emit when the selection already holds the subtree', async () => {
    mount(['parent'], ['parent', 'child', 'grandchild'])
    const { ev, data } = dragStart()
    line(0).dispatchEvent(ev)
    await wrapper.vm.$nextTick()
    expect(data.get(PANE_BATCH_MIME)).toBe('parent\nchild\ngrandchild')
    expect(wrapper.emitted('select-panes')).toBeUndefined()
  })

  it('hands the whole subtree to the cross-window dragend handoff', async () => {
    const cliPaneDragEnd = vi.fn()
    ;(window as unknown as { agentTeam: unknown }).agentTeam = { cliPaneDragEnd }
    try {
      mount(['parent'])
      line(0).dispatchEvent(dragStart().ev)
      const end = new Event('dragend', { bubbles: true })
      Object.assign(end, { dataTransfer: { dropEffect: 'none' }, screenX: 10, screenY: 20 })
      line(0).dispatchEvent(end)
      await wrapper.vm.$nextTick()
      expect(cliPaneDragEnd).toHaveBeenCalledWith('parent', 10, 20, ['parent', 'child', 'grandchild'])
    } finally {
      delete (window as unknown as { agentTeam?: unknown }).agentTeam
    }
  })
})
