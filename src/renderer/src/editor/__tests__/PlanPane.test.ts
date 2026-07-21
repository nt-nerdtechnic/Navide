// @vitest-environment happy-dom
// Routing tests for the embedded plan review pane (main-window Plans tab).
// Ported from PlanWindowApp.test.ts: the plans list mounts with the workspace
// passed as a prop, opening an HTML plan stacks the review toolbar above the
// interactive srcdoc preview (PlanDocPreview), in-document interactions route
// into the toolbar's exposed write paths, and legacy markdown plans fall back to
// PlanFileView. Unlike the window variant, PlanPane owns no window lifecycle:
// backend + workspace arrive as props, and ESC only cancels overlays (it never
// closes a window).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import PlanPane from '../PlanPane.vue'
import { i18n } from '../../i18n'
import { resolvePlanStore } from '../../composables/planStore'

i18n.global.locale.value = 'en-US'

function stub(name: string, props: string[] = []) {
  return {
    __esModule: true,
    default: defineComponent({
      name,
      props,
      inheritAttrs: false,
      render: () => h('div', { class: `stub-${name}` }),
    }),
  }
}

// Spies for the methods the pane calls on its children via template refs.
const toolbarSpies = vi.hoisted(() => ({
  cycleTodo: vi.fn(),
  toggleSkipTodo: vi.fn(),
  startNoteWithAnchor: vi.fn(),
  closeActiveOverlay: vi.fn(() => false),
}))
const previewSpies = vi.hoisted(() => ({
  scrollToAnchor: vi.fn(),
  isEditing: vi.fn(() => false),
  cancelEdit: vi.fn(),
}))
const mdBodySpies = vi.hoisted(() => ({
  scrollToAnchor: vi.fn(),
  isEditing: vi.fn(() => false),
  cancelEdit: vi.fn(),
}))
const plansPaneSpies = vi.hoisted(() => ({ closeActiveOverlay: vi.fn(() => false) }))

// Notify mock: section-delete confirms host-side; default accept.
const toastMock = vi.hoisted(() => vi.fn())
const confirmMock = vi.hoisted(() => vi.fn(async () => true))
vi.mock('../../composables/useNotify', () => ({
  useNotify: () => ({ toast: toastMock, alert: vi.fn(), confirm: confirmMock }),
}))

// Backing file state for the body write path (section edit/delete) and the
// markdown frontmatter probe (readMeta).
const fsState = vi.hoisted(() => ({ content: '', writes: [] as string[] }))

// Listener bus + fake backend passed as the `backend` prop; lets tests simulate
// backend server-push broadcasts (plans.changed) and back the fs.read/write.
const fakeBackend = vi.hoisted(() => {
  const listeners = new Map<string, Set<(p: unknown) => void>>()
  return {
    listeners,
    on(type: string, cb: (p: unknown) => void): () => void {
      let set = listeners.get(type)
      if (!set) {
        set = new Set()
        listeners.set(type, set)
      }
      set.add(cb)
      return () => set!.delete(cb)
    },
    emit(type: string, payload: unknown): void {
      listeners.get(type)?.forEach((cb) => cb(payload))
    },
    send: vi.fn(async (type: string, payload: Record<string, unknown>) => {
      if (type === 'fs.read_file') return { payload: { ok: true, content: fsState.content, mtime: 1 } }
      if (type === 'fs.write_file') {
        fsState.writes.push(payload.content as string)
        return { payload: { ok: true, mtime: 2 } }
      }
      return { payload: { ok: true } }
    }),
  }
})

vi.mock('../PlansPane.vue', () => ({
  __esModule: true,
  default: defineComponent({
    name: 'PlansPane',
    props: ['workspacePath', 'backend'],
    inheritAttrs: false,
    setup(_, { expose }) {
      expose(plansPaneSpies)
      return () => h('div', { class: 'stub-PlansPane' })
    },
  }),
}))
vi.mock('../PlanReviewToolbar.vue', () => ({
  __esModule: true,
  default: defineComponent({
    name: 'PlanReviewToolbar',
    props: ['workspacePath', 'relPath', 'backend'],
    inheritAttrs: false,
    setup(_, { expose }) {
      expose(toolbarSpies)
      return () => h('div', { class: 'stub-PlanReviewToolbar' })
    },
  }),
}))
vi.mock('../PlanDocPreview.vue', () => ({
  __esModule: true,
  default: defineComponent({
    name: 'PlanDocPreview',
    props: ['workspacePath', 'relPath', 'backend', 'refresh'],
    inheritAttrs: false,
    setup(_, { expose }) {
      expose(previewSpies)
      return () => h('div', { class: 'stub-PlanDocPreview' })
    },
  }),
}))
vi.mock('../PlanMarkdownBody.vue', () => ({
  __esModule: true,
  default: defineComponent({
    name: 'PlanMarkdownBody',
    props: ['workspacePath', 'relPath', 'backend', 'refresh'],
    inheritAttrs: false,
    setup(_, { expose }) {
      expose(mdBodySpies)
      return () => h('div', { class: 'stub-PlanMarkdownBody' })
    },
  }),
}))
vi.mock('../PlanFileView.vue', () => stub('PlanFileView', ['workspacePath', 'relPath', 'backend']))
vi.mock('../FilePreviewPane.vue', () => stub('FilePreviewPane', ['workspacePath', 'relPath', 'name', 'backend']))

beforeEach(() => {
  toolbarSpies.cycleTodo.mockClear()
  toolbarSpies.toggleSkipTodo.mockClear()
  toolbarSpies.startNoteWithAnchor.mockClear()
  toolbarSpies.closeActiveOverlay.mockReset().mockReturnValue(false)
  previewSpies.scrollToAnchor.mockClear()
  previewSpies.isEditing.mockReset().mockReturnValue(false)
  previewSpies.cancelEdit.mockClear()
  mdBodySpies.scrollToAnchor.mockClear()
  mdBodySpies.isEditing.mockReset().mockReturnValue(false)
  mdBodySpies.cancelEdit.mockClear()
  plansPaneSpies.closeActiveOverlay.mockReset().mockReturnValue(false)
  toastMock.mockClear()
  confirmMock.mockReset().mockResolvedValue(true)
  fsState.content = ''
  fsState.writes.length = 0
  fakeBackend.listeners.clear()
})

// Track mounted panes so each is unmounted after its test — PlanPane registers a
// window keydown listener (ESC), which would otherwise leak across tests.
const mountedApps: VueWrapper[] = []
async function mountApp(workspacePath = '/tmp/demo-ws'): Promise<VueWrapper> {
  const wrapper = mount(PlanPane, {
    props: { workspacePath, backend: fakeBackend as never },
    global: { plugins: [i18n] },
  })
  mountedApps.push(wrapper)
  await flushPromises()
  return wrapper
}

afterEach(() => {
  while (mountedApps.length) mountedApps.pop()!.unmount()
})

async function open(wrapper: VueWrapper, filepath: string): Promise<void> {
  wrapper
    .findComponent({ name: 'PlansPane' })
    .vm.$emit('open-file', { filepath, name: filepath.split('/').pop() ?? filepath })
  await flushPromises()
}

// A valid markdown plan (frontmatter meta) — the routing probe reads this via
// the store and mounts the shared toolbar + PlanMarkdownBody.
const MD_PLAN = `---
name: MD Plan
overview: ov
todos:
  - id: t1
    content: First
    status: pending
stage: in-review
---

## Phase A

Body A.
`

describe('PlanPane', () => {
  it('mounts PlansPane for the workspace prop and starts on the list (no doc view)', async () => {
    const wrapper = await mountApp()
    const pane = wrapper.findComponent({ name: 'PlansPane' })
    expect(pane.exists()).toBe(true)
    expect(pane.props('workspacePath')).toBe('/tmp/demo-ws')
    // Drill-down default: the list is shown, no doc view / back bar yet.
    expect(wrapper.find('.plan-pane-doc-view').exists()).toBe(false)
    expect(wrapper.find('.plan-pane-back').exists()).toBe(false)
  })

  it('drills into a plan and back to the list', async () => {
    const wrapper = await mountApp()
    // List → open a plan → doc view with the back bar appears.
    await open(wrapper, '.agent-team/plans/feature_a1b2c3.html')
    expect(wrapper.find('.plan-pane-doc-view').exists()).toBe(true)
    const back = wrapper.find('.plan-pane-back')
    expect(back.exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'PlanDocPreview' }).exists()).toBe(true)
    // Back → doc view torn down, list shown again.
    await back.trigger('click')
    await flushPromises()
    expect(wrapper.find('.plan-pane-doc-view').exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'PlanDocPreview' }).exists()).toBe(false)
  })

  it('opens an HTML plan with the review toolbar above the interactive preview', async () => {
    const wrapper = await mountApp()
    await open(wrapper, '.agent-team/plans/feature_a1b2c3.html')
    const toolbar = wrapper.findComponent({ name: 'PlanReviewToolbar' })
    expect(toolbar.exists()).toBe(true)
    expect(toolbar.props('relPath')).toBe('.agent-team/plans/feature_a1b2c3.html')
    const preview = wrapper.findComponent({ name: 'PlanDocPreview' })
    expect(preview.exists()).toBe(true)
    expect(preview.props('relPath')).toBe('.agent-team/plans/feature_a1b2c3.html')
    expect(wrapper.findComponent({ name: 'FilePreviewPane' }).exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'PlanFileView' }).exists()).toBe(false)
  })

  it('keeps non-plan HTML docs on the plain sandboxed FilePreviewPane', async () => {
    const wrapper = await mountApp()
    await open(wrapper, '.agent-team/plans/_template.html')
    expect(wrapper.findComponent({ name: 'FilePreviewPane' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'PlanDocPreview' }).exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'PlanReviewToolbar' }).exists()).toBe(false)
  })

  it('bumps the preview refresh in place when the toolbar reports a meta update', async () => {
    const wrapper = await mountApp()
    await open(wrapper, '.agent-team/plans/feature_a1b2c3.html')
    const before = wrapper.findComponent({ name: 'PlanDocPreview' })
    expect(before.props('refresh')).toBe(0)
    wrapper.findComponent({ name: 'PlanReviewToolbar' }).vm.$emit('updated')
    await flushPromises()
    const after = wrapper.findComponent({ name: 'PlanDocPreview' })
    expect(after.props('refresh')).toBe(1)
    expect(after.element).toBe(before.element)
  })

  it('routes validated in-document interactions into the toolbar write paths', async () => {
    const wrapper = await mountApp()
    await open(wrapper, '.agent-team/plans/feature_a1b2c3.html')
    const preview = wrapper.findComponent({ name: 'PlanDocPreview' })
    preview.vm.$emit('todo-clicked', { todoId: 'phase-b', alt: false })
    expect(toolbarSpies.cycleTodo).toHaveBeenCalledWith('phase-b')
    preview.vm.$emit('todo-clicked', { todoId: 'phase-b', alt: true })
    expect(toolbarSpies.toggleSkipTodo).toHaveBeenCalledWith('phase-b')
    preview.vm.$emit('section-comment', 'Risks')
    expect(toolbarSpies.startNoteWithAnchor).toHaveBeenCalledWith('Risks')
  })

  it('bumps the preview refresh on a matching plans.changed broadcast only', async () => {
    const wrapper = await mountApp()
    await open(wrapper, '.agent-team/plans/feature_a1b2c3.html')
    expect(wrapper.findComponent({ name: 'PlanDocPreview' }).props('refresh')).toBe(0)

    fakeBackend.emit('plans.changed', { workspace_path: '/tmp/demo-ws' })
    await flushPromises()
    expect(wrapper.findComponent({ name: 'PlanDocPreview' }).props('refresh')).toBe(1)

    fakeBackend.emit('plans.changed', { workspace_path: '/tmp/other-ws' })
    await flushPromises()
    expect(wrapper.findComponent({ name: 'PlanDocPreview' }).props('refresh')).toBe(1)
  })

  it('opens the editor window at the clicked file:line reference', async () => {
    const openEditorWindow = vi.fn(async () => ({ ok: true }))
    ;(window as unknown as { agentTeam?: unknown }).agentTeam = { openEditorWindow }
    try {
      const wrapper = await mountApp()
      await open(wrapper, '.agent-team/plans/feature_a1b2c3.html')
      wrapper
        .findComponent({ name: 'PlanDocPreview' })
        .vm.$emit('open-code', { path: 'src/renderer/src/App.vue', line: 42 })
      expect(openEditorWindow).toHaveBeenCalledWith({
        workspace_path: '/tmp/demo-ws',
        filepath: 'src/renderer/src/App.vue',
        line: 42,
      })
    } finally {
      delete (window as unknown as { agentTeam?: unknown }).agentTeam
    }
  })

  it('falls back to PlanFileView for plain markdown with no frontmatter meta', async () => {
    fsState.content = '# Plain doc\n\nNo frontmatter here.\n'
    const wrapper = await mountApp()
    await open(wrapper, '.cursor/plans/legacy-feature.plan.md')
    const view = wrapper.findComponent({ name: 'PlanFileView' })
    expect(view.exists()).toBe(true)
    expect(view.props('relPath')).toBe('.cursor/plans/legacy-feature.plan.md')
    expect(wrapper.findComponent({ name: 'PlanReviewToolbar' }).exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'PlanMarkdownBody' }).exists()).toBe(false)
  })

  it('opens a markdown plan (valid meta) with the shared toolbar above the markdown body', async () => {
    fsState.content = MD_PLAN
    const wrapper = await mountApp()
    await open(wrapper, '.cursor/plans/feature.plan.md')
    expect(wrapper.findComponent({ name: 'PlanReviewToolbar' }).exists()).toBe(true)
    const body = wrapper.findComponent({ name: 'PlanMarkdownBody' })
    expect(body.exists()).toBe(true)
    expect(body.props('relPath')).toBe('.cursor/plans/feature.plan.md')
    expect(wrapper.findComponent({ name: 'PlanDocPreview' }).exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'PlanFileView' }).exists()).toBe(false)
  })
})

const BODY_DOC = [
  '<html><head>',
  '<script type="application/json" id="plan-meta">',
  '{"schemaVersion":1,"name":"F"}',
  '</scr' + 'ipt>',
  '</head><body>',
  '<header><h1>F</h1></header>',
  '<section><h2>Goals</h2><p>old goal</p></section>',
  '<section><h2>Risks</h2><ul><li>r1</li></ul></section>',
  '</body></html>',
].join('\n')

describe('PlanPane – inline section edit/delete', () => {
  it('sanitizes untrusted section-edit html and writes only the section body', async () => {
    fsState.content = BODY_DOC
    const wrapper = await mountApp()
    await open(wrapper, '.agent-team/plans/feature_a1b2c3.html')
    wrapper.findComponent({ name: 'PlanDocPreview' }).vm.$emit('section-edit', {
      anchor: 'Goals',
      html: '<p onclick="steal()">clean</p><script>bad()</scr' + 'ipt>',
    })
    await flushPromises()
    expect(fsState.writes).toHaveLength(1)
    const written = fsState.writes[0]
    expect(written).toContain('<p>clean</p>')
    expect(written).not.toContain('onclick')
    expect(written).not.toContain('old goal')
    expect(written).toContain('{"schemaVersion":1,"name":"F"}')
    expect(written).toContain('<h2>Risks</h2>')
  })

  it('routes a section-edit through the store with host-sanitized html', async () => {
    fsState.content = BODY_DOC
    const store = resolvePlanStore('.agent-team/plans/feature_a1b2c3.html')
    const spy = vi.spyOn(store, 'replaceSectionBody')
    try {
      const wrapper = await mountApp()
      await open(wrapper, '.agent-team/plans/feature_a1b2c3.html')
      wrapper.findComponent({ name: 'PlanDocPreview' }).vm.$emit('section-edit', {
        anchor: 'Goals',
        html: '<p onclick="steal()">clean</p>',
      })
      await flushPromises()
      expect(spy).toHaveBeenCalledTimes(1)
      const [, anchor, body] = spy.mock.calls[0]
      expect(anchor).toBe('Goals')
      expect(body).toEqual({ kind: 'html', sanitized: '<p>clean</p>' })
    } finally {
      spy.mockRestore()
    }
  })
})

describe('PlanPane – ESC overlay priority (no window close)', () => {
  function pressEsc(): boolean {
    const ev = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    window.dispatchEvent(ev)
    return ev.defaultPrevented
  }

  it('cancels an in-frame section edit on ESC', async () => {
    previewSpies.isEditing.mockReturnValue(true)
    const wrapper = await mountApp()
    await open(wrapper, '.agent-team/plans/feature_a1b2c3.html')
    expect(pressEsc()).toBe(true)
    expect(previewSpies.cancelEdit).toHaveBeenCalled()
  })

  it('closes the plan-list overlay on ESC before anything else', async () => {
    plansPaneSpies.closeActiveOverlay.mockReturnValue(true)
    const wrapper = await mountApp()
    await open(wrapper, '.agent-team/plans/feature_a1b2c3.html')
    expect(pressEsc()).toBe(true)
    expect(plansPaneSpies.closeActiveOverlay).toHaveBeenCalled()
  })

  it('drills back to the list on ESC when a doc is open and no overlay is active', async () => {
    const wrapper = await mountApp()
    await open(wrapper, '.agent-team/plans/feature_a1b2c3.html')
    expect(wrapper.find('.plan-pane-doc-view').exists()).toBe(true)
    expect(pressEsc()).toBe(true)
    await flushPromises()
    expect(wrapper.find('.plan-pane-doc-view').exists()).toBe(false)
  })

  it('lets ESC through (no preventDefault, no window close) on the list — this is an embedded pane', async () => {
    await mountApp()
    // No doc open, no overlay: ESC is a no-op that never closes anything.
    expect(pressEsc()).toBe(false)
  })
})
