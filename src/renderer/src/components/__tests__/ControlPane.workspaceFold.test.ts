// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import ControlPane from '../ControlPane.vue'

// The workspace heading's fold button, and the Alt+click that reaches the same
// action from the caret beside it.
//
// The distinction it exists to keep: the caret folds the PROJECT — heading and
// all — while this folds only what hangs BELOW the heading, leaving the project
// on screen. Collapsing both into one gesture is what the button would degrade
// into if either half stopped being tested, and it would then be a slower
// duplicate of the caret.

const A = '/Users/me/Desktop/alpha'

type Row = {
  id: string
  depth: number
  hasChildren: boolean
  collapsed: boolean
  ancestors: string[]
  descendantCount: number
}

const row = (id: string, extra: Partial<Row> = {}): Row => ({
  id,
  depth: 0,
  hasChildren: false,
  collapsed: false,
  ancestors: [],
  descendantCount: 0,
  ...extra,
})

/** A project with two run groups, the first holding a parent and its child. */
const grouped = (over: Record<string, unknown> = {}) => ({
  path: A,
  label: 'alpha',
  displayPath: '~/Desktop',
  isCurrent: true,
  collapsed: false,
  count: 3,
  paneIds: ['a1', 'a2', 'b1'],
  lineage: [],
  groups: [
    {
      id: 'g1',
      name: 'frontend',
      rows: [
        row('a1', { hasChildren: true, descendantCount: 1 }),
        row('a2', { depth: 1, ancestors: ['a1'] }),
      ],
    },
    { id: 'g2', name: 'backend', rows: [row('b1')] },
  ],
  remote: [],
  ...over,
})

/** A project with no run groups and no lineage — nothing to fold. */
const flat = () => grouped({ count: 1, paneIds: ['a1'], groups: [{ id: '', name: '', rows: [row('a1')] }] })

const panes = [
  { id: 'a1', agentLabel: 'Claude', status: 'running', command: 'claude', origin: 'manual', isMinimized: false, isCommander: false, workspacePath: A },
  { id: 'a2', agentLabel: 'Claude', status: 'running', command: 'claude', origin: 'manual', isMinimized: false, isCommander: false, workspacePath: A, spawnedBy: 'a1' },
  { id: 'b1', agentLabel: 'Claude', status: 'running', command: 'claude', origin: 'manual', isMinimized: false, isCommander: false, workspacePath: A },
]

function mountWith(extra: Record<string, unknown> = {}): VueWrapper {
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
      workspaces: [grouped()],
      ...extra,
    } as never,
    global: { mocks: { $t: (key: string) => key } },
  })
}

describe('ControlPane – folding one workspace', () => {
  let wrapper: VueWrapper
  afterEach(() => wrapper?.unmount())

  it('folds what is below the heading without folding the heading itself', async () => {
    wrapper = mountWith()
    await wrapper.find('.ws-head--current').find('.ws-fold').trigger('click')
    expect(wrapper.emitted('collapse-workspace-subtrees')).toEqual([[A, true]])
    // The project stays open. Were this to fire too, the button would just be
    // a second caret.
    expect(wrapper.emitted('toggle-workspace')).toBeUndefined()
  })

  it('folds the run group headings as well as the subtrees', async () => {
    // Two layers, one press. The groups are the sidebar's own state; only the
    // subtrees have to travel to App, so a button that emitted and stopped
    // would leave the group headings open and look half-broken.
    wrapper = mountWith()
    expect(wrapper.findAll('.ws-grp')).toHaveLength(2)
    await wrapper.find('.ws-fold').trigger('click')
    const carets = wrapper.findAll('.ws-grp-caret')
    expect(carets).toHaveLength(2)
    for (const c of carets) expect(c.text()).toBe('›')
  })

  it('turns into expand once everything below is folded', async () => {
    wrapper = mountWith({
      workspaces: [
        grouped({
          groups: [
            { id: 'g1', name: 'frontend', rows: [row('a1', { hasChildren: true, collapsed: true, descendantCount: 1 })] },
            { id: 'g2', name: 'backend', rows: [row('b1')] },
          ],
        }),
      ],
    })
    const fold = wrapper.find('.ws-fold')
    expect(fold.attributes('title')).toBe('action.collapse-workspace-tree')
    await fold.trigger('click')
    // Groups are folded now and the one subtree arrived already folded, so the
    // next press must be the one that opens it all again.
    expect(wrapper.find('.ws-fold').attributes('title')).toBe('action.expand-workspace-tree')
    await wrapper.find('.ws-fold').trigger('click')
    expect(wrapper.emitted('collapse-workspace-subtrees')).toEqual([[A, true], [A, false]])
  })

  it('offers nothing to press on a project with no groups and no lineage', () => {
    // A flat project has no group heading and no subtree, so the button would
    // do nothing at all. Disabled says so; live-but-inert reads as a bug.
    wrapper = mountWith({ workspaces: [flat()] })
    expect(wrapper.find('.ws-fold').attributes('disabled')).toBeDefined()
  })

  it('stays live for a flat project that still has a subtree', () => {
    wrapper = mountWith({
      workspaces: [
        grouped({
          groups: [
            {
              id: '',
              name: '',
              rows: [row('a1', { hasChildren: true, descendantCount: 1 }), row('a2', { depth: 1, ancestors: ['a1'] })],
            },
          ],
        }),
      ],
    })
    expect(wrapper.find('.ws-fold').attributes('disabled')).toBeUndefined()
  })

  it('reaches the same action from Alt+click on the caret', async () => {
    // The button is what makes the gesture discoverable; this is the fast path
    // for when the pointer is already on the caret.
    wrapper = mountWith()
    await wrapper.find('.ws-caret').trigger('click', { altKey: true })
    expect(wrapper.emitted('collapse-workspace-subtrees')).toEqual([[A, true]])
    // Crucially NOT the plain fold: Alt must replace the gesture, not add to it.
    expect(wrapper.emitted('toggle-workspace')).toBeUndefined()
  })

  it('leaves a plain caret click folding the project, as it always did', async () => {
    wrapper = mountWith()
    await wrapper.find('.ws-caret').trigger('click')
    expect(wrapper.emitted('toggle-workspace')).toEqual([[A]])
    expect(wrapper.emitted('collapse-workspace-subtrees')).toBeUndefined()
  })

  it('does nothing on Alt+click when there is nothing to fold', async () => {
    // Alt+click routes through the same guard as the button. Without it the
    // modifier would emit a write that folds nothing, for every flat project.
    wrapper = mountWith({ workspaces: [flat()] })
    await wrapper.find('.ws-caret').trigger('click', { altKey: true })
    expect(wrapper.emitted('collapse-workspace-subtrees')).toBeUndefined()
    expect(wrapper.emitted('toggle-workspace')).toBeUndefined()
  })

  it('folds only the workspace whose button was pressed', async () => {
    const other = grouped({ path: '/Users/me/Desktop/beta', label: 'beta' })
    wrapper = mountWith({ workspaces: [grouped(), other] })
    await wrapper.findAll('.ws-fold')[1].trigger('click')
    expect(wrapper.emitted('collapse-workspace-subtrees')).toEqual([['/Users/me/Desktop/beta', true]])
  })
})
