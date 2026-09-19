// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import ControlPane from '../ControlPane.vue'

// The run group heading's fold button, and the Alt+click that reaches the same
// action from the caret beside it — the twin of ControlPane.workspaceFold one
// level down.
//
// The distinction it exists to keep is the same one the workspace button
// keeps: the caret folds the GROUP — heading and all — while this folds only
// the subtrees hanging below it, leaving the group on screen. If either half
// stopped being tested the two would collapse into one gesture, and the button
// would be a slower duplicate of the caret.

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

/** A project with two run groups: the first holds a parent and its child, the
 *  second holds a lone leaf — so only one of the two headings has anything to
 *  fold. */
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

describe('ControlPane – folding one run group', () => {
  let wrapper: VueWrapper
  afterEach(() => wrapper?.unmount())

  it('shows the button only on a heading that has a subtree below it', () => {
    // A group of leaves gets no button at all rather than a disabled one: at
    // this depth a flat group is the common case, and a permanently dead
    // control on every heading is noise the row cannot afford.
    wrapper = mountWith()
    expect(wrapper.findAll('.ws-grp')).toHaveLength(2)
    expect(wrapper.findAll('.ws-grp-fold')).toHaveLength(1)
  })

  it('folds what is below the heading without folding the group itself', async () => {
    wrapper = mountWith()
    await wrapper.find('.ws-grp-fold').trigger('click')
    expect(wrapper.emitted('collapse-pane-subtrees')).toEqual([[A, ['a1'], true]])
    // The heading stays open. Were the group to fold too, the button would
    // just be a second caret.
    const carets = wrapper.findAll('.ws-grp-caret')
    for (const c of carets) expect(c.text()).toBe('⌄')
  })

  it('names only the rows that have children', async () => {
    // A leaf carries no subtree, so a persisted collapsed flag on one records
    // a state the sidebar can never show — the reason App writes parents only.
    wrapper = mountWith({
      workspaces: [
        grouped({
          groups: [
            {
              id: 'g1',
              name: 'frontend',
              rows: [
                row('a1', { hasChildren: true, descendantCount: 1 }),
                row('a2', { depth: 1, ancestors: ['a1'] }),
                row('b1'),
              ],
            },
          ],
        }),
      ],
    })
    await wrapper.find('.ws-grp-fold').trigger('click')
    expect(wrapper.emitted('collapse-pane-subtrees')).toEqual([[A, ['a1'], true]])
  })

  it('turns into expand once everything inside is folded', async () => {
    wrapper = mountWith({
      workspaces: [
        grouped({
          groups: [
            {
              id: 'g1',
              name: 'frontend',
              rows: [
                row('a1', { hasChildren: true, collapsed: true, descendantCount: 1 }),
              ],
            },
            { id: 'g2', name: 'backend', rows: [row('b1')] },
          ],
        }),
      ],
    })
    const fold = wrapper.find('.ws-grp-fold')
    expect(fold.attributes('title')).toBe('action.expand-group-tree')
    await fold.trigger('click')
    expect(wrapper.emitted('collapse-pane-subtrees')).toEqual([[A, ['a1'], false]])
  })

  it('reaches the same action from Alt+click on the group caret', async () => {
    // The button makes the gesture discoverable; this is the fast path for
    // when the pointer is already on the caret — the workspace caret's rule,
    // kept identical one level down.
    wrapper = mountWith()
    await wrapper.findAll('.ws-grp-caret')[0].trigger('click', { altKey: true })
    expect(wrapper.emitted('collapse-pane-subtrees')).toEqual([[A, ['a1'], true]])
    // Alt REPLACES the gesture; the group must not fold as well.
    expect(wrapper.findAll('.ws-grp-caret')[0].text()).toBe('⌄')
  })

  it('leaves a plain caret click folding the group, as it always did', async () => {
    wrapper = mountWith()
    const caret = wrapper.findAll('.ws-grp-caret')[0]
    await caret.trigger('click')
    expect(wrapper.findAll('.ws-grp-caret')[0].text()).toBe('›')
    expect(wrapper.emitted('collapse-pane-subtrees')).toBeUndefined()
  })

  it('does nothing on Alt+click over a group with nothing to fold', async () => {
    // Without the guard the modifier would emit a write that folds nothing,
    // for every flat group — and it must not silently fall back to folding the
    // group, which would make Alt mean two different things on two headings.
    wrapper = mountWith()
    await wrapper.findAll('.ws-grp-caret')[1].trigger('click', { altKey: true })
    expect(wrapper.emitted('collapse-pane-subtrees')).toBeUndefined()
    expect(wrapper.findAll('.ws-grp-caret')[1].text()).toBe('⌄')
  })

  it('folds only the group whose button was pressed', async () => {
    wrapper = mountWith({
      workspaces: [
        grouped({
          groups: [
            {
              id: 'g1',
              name: 'frontend',
              rows: [row('a1', { hasChildren: true, descendantCount: 1 }), row('a2', { depth: 1, ancestors: ['a1'] })],
            },
            {
              id: 'g2',
              name: 'backend',
              rows: [row('b1', { hasChildren: true, descendantCount: 1 }), row('b2', { depth: 1, ancestors: ['b1'] })],
            },
          ],
        }),
      ],
      panes: [...panes, { id: 'b2', agentLabel: 'Claude', status: 'running', command: 'claude', origin: 'manual', isMinimized: false, isCommander: false, workspacePath: A, spawnedBy: 'b1' }],
    })
    await wrapper.findAll('.ws-grp-fold')[1].trigger('click')
    expect(wrapper.emitted('collapse-pane-subtrees')).toEqual([[A, ['b1'], true]])
  })

  it('offers the Alt hint on a caret that has something to fold, and not otherwise', () => {
    wrapper = mountWith()
    const carets = wrapper.findAll('.ws-grp-caret')
    expect(carets[0].attributes('title')).toContain('action.fold-workspace-hint')
    expect(carets[1].attributes('title')).toBe('action.collapse-subtree')
  })

  it('leaves the ＋ button on the heading beside it', () => {
    // The fold button takes the auto margin that used to sit on ＋. If that
    // handoff ever drops the ＋, the group loses its own entry point.
    wrapper = mountWith()
    const heading = wrapper.findAll('.ws-grp')[0]
    expect(heading.find('.ws-grp-fold').exists()).toBe(true)
    expect(heading.find('.ws-grp-add').exists()).toBe(true)
  })
})
