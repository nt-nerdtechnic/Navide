// @vitest-environment happy-dom
// Routing tests for the dedicated plan review window: the plans list mounts
// with the workspace from the query string, opening an HTML plan stacks the
// review toolbar above the interactive srcdoc preview (PlanDocPreview),
// in-document interactions route into the toolbar's exposed write paths, and
// legacy markdown plans fall back to PlanFileView.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { ref } from 'vue'
import PlanWindowApp from '../../PlanWindowApp.vue'
import { i18n } from '../../i18n'
import { resolvePlanStore } from '../../composables/planStore'

i18n.global.locale.value = 'en-US'

// The app reads workspace_path from the window query string at setup time.
window.history.replaceState({}, '', '/?window=plans&workspace_path=/tmp/demo-ws')

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

// Spies for the methods the window calls on its children via template refs.
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
const plansPaneSpies = vi.hoisted(() => ({ closeActiveOverlay: vi.fn(() => false) }))

// Notify mock: section-delete confirms host-side; default accept.
const toastMock = vi.hoisted(() => vi.fn())
const confirmMock = vi.hoisted(() => vi.fn(async () => true))
vi.mock('../../composables/useNotify', () => ({
  useNotify: () => ({ toast: toastMock, alert: vi.fn(), confirm: confirmMock }),
}))

// Backing file state for the body write path (section edit/delete).
const fsState = vi.hoisted(() => ({ content: '', writes: [] as string[] }))

// Listener bus backing the useBackend mock's on(); lets tests simulate
// backend server-push broadcasts (plans.changed).
const backendBus = vi.hoisted(() => {
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
vi.mock('../PlanFileView.vue', () => stub('PlanFileView', ['workspacePath', 'relPath', 'backend']))
vi.mock('../FilePreviewPane.vue', () => stub('FilePreviewPane', ['workspacePath', 'relPath', 'name', 'backend']))
vi.mock('../../components/NotificationHost.vue', () => stub('NotificationHost'))

beforeEach(() => {
  toolbarSpies.cycleTodo.mockClear()
  toolbarSpies.toggleSkipTodo.mockClear()
  toolbarSpies.startNoteWithAnchor.mockClear()
  toolbarSpies.closeActiveOverlay.mockReset().mockReturnValue(false)
  previewSpies.scrollToAnchor.mockClear()
  previewSpies.isEditing.mockReset().mockReturnValue(false)
  previewSpies.cancelEdit.mockClear()
  plansPaneSpies.closeActiveOverlay.mockReset().mockReturnValue(false)
  toastMock.mockClear()
  confirmMock.mockReset().mockResolvedValue(true)
  fsState.content = ''
  fsState.writes.length = 0
  backendBus.listeners.clear()
})

vi.mock('../../composables/useBackend', () => ({
  useBackend: () => ({
    status: ref('connected'),
    wsUrl: ref(''),
    httpUrl: ref('http://127.0.0.1:1'),
    shell: ref(''),
    port: ref(0),
    pid: ref(0),
    lastError: ref(''),
    send: vi.fn(async (type: string, payload: Record<string, unknown>) => {
      if (type === 'fs.read_file') return { payload: { ok: true, content: fsState.content, mtime: 1 } }
      if (type === 'fs.write_file') {
        fsState.writes.push(payload.content as string)
        return { payload: { ok: true, mtime: 2 } }
      }
      return { payload: { ok: true } }
    }),
    on: backendBus.on,
    restart: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  }),
}))

vi.mock('../../lib/settings', () => ({
  initSettingsBackend: vi.fn(),
  settingsGet: vi.fn((_key: string, def: unknown) => def),
  settingsSet: vi.fn(),
  onSettingsChanged: vi.fn(() => () => {}),
}))

vi.mock('../../composables/useTheme', () => ({
  useTheme: () => ({ theme: ref('dark'), setTheme: vi.fn(), loadTheme: vi.fn() }),
}))

// Track mounted apps so each is unmounted after its test — PlanWindowApp
// registers a window keydown listener (ESC), which would otherwise leak across
// tests and fire stale handlers.
const mountedApps: VueWrapper[] = []
async function mountApp(): Promise<VueWrapper> {
  const wrapper = mount(PlanWindowApp, { global: { plugins: [i18n] } })
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

describe('PlanWindowApp', () => {
  it('mounts PlansPane for the workspace and starts on the empty state', async () => {
    const wrapper = await mountApp()
    const pane = wrapper.findComponent({ name: 'PlansPane' })
    expect(pane.exists()).toBe(true)
    expect(pane.props('workspacePath')).toBe('/tmp/demo-ws')
    expect(wrapper.find('.plan-window-empty').exists()).toBe(true)
    expect(document.title).toBe('Plans · demo-ws')
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
    expect(wrapper.find('.plan-window-empty').exists()).toBe(false)
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
    // Reload happens in place — the preview is not remounted, so the frame
    // can restore its scroll position.
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

  it('forwards toolbar outline picks to the preview scroller', async () => {
    const wrapper = await mountApp()
    await open(wrapper, '.agent-team/plans/feature_a1b2c3.html')
    wrapper.findComponent({ name: 'PlanReviewToolbar' }).vm.$emit('scroll-to-anchor', 'Goals')
    expect(previewSpies.scrollToAnchor).toHaveBeenCalledWith('Goals')
  })

  it('bumps the preview refresh on a matching plans.changed broadcast', async () => {
    const wrapper = await mountApp()
    await open(wrapper, '.agent-team/plans/feature_a1b2c3.html')
    expect(wrapper.findComponent({ name: 'PlanDocPreview' }).props('refresh')).toBe(0)

    backendBus.emit('plans.changed', { workspace_path: '/tmp/demo-ws' })
    await flushPromises()
    expect(wrapper.findComponent({ name: 'PlanDocPreview' }).props('refresh')).toBe(1)

    // A broadcast for another workspace does not touch the preview.
    backendBus.emit('plans.changed', { workspace_path: '/tmp/other-ws' })
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

  it('shows a read-only snapshot preview with a banner and restores the live plan on close', async () => {
    const wrapper = await mountApp()
    await open(wrapper, '.agent-team/plans/feature_a1b2c3.html')

    const snapshotRel = '.agent-team/plans/.history/feature_a1b2c3/20260601T080000_draft.html'
    wrapper
      .findComponent({ name: 'PlanReviewToolbar' })
      .vm.$emit('preview-snapshot', { relPath: snapshotRel, label: '2026-06-01 · draft' })
    await flushPromises()

    // Snapshot mode: banner + label + read-only note, no toolbar, preview on
    // the snapshot rel path.
    const banner = wrapper.find('.plan-snapshot-banner')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain('2026-06-01 · draft')
    expect(banner.text()).toContain('Read-only snapshot')
    expect(wrapper.findComponent({ name: 'PlanReviewToolbar' }).exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'PlanDocPreview' }).props('relPath')).toBe(snapshotRel)

    await wrapper.find('.plan-snapshot-close').trigger('click')
    await flushPromises()

    expect(wrapper.find('.plan-snapshot-banner').exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'PlanReviewToolbar' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'PlanDocPreview' }).props('relPath')).toBe(
      '.agent-team/plans/feature_a1b2c3.html',
    )
  })

  it('clears the snapshot preview when another doc is opened', async () => {
    const wrapper = await mountApp()
    await open(wrapper, '.agent-team/plans/feature_a1b2c3.html')
    wrapper.findComponent({ name: 'PlanReviewToolbar' }).vm.$emit('preview-snapshot', {
      relPath: '.agent-team/plans/.history/feature_a1b2c3/20260601T080000_draft.html',
      label: '2026-06-01 · draft',
    })
    await flushPromises()
    expect(wrapper.find('.plan-snapshot-banner').exists()).toBe(true)

    await open(wrapper, '.agent-team/plans/other_d4e5f6.html')
    expect(wrapper.find('.plan-snapshot-banner').exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'PlanDocPreview' }).props('relPath')).toBe(
      '.agent-team/plans/other_d4e5f6.html',
    )
  })

  it('falls back to PlanFileView for legacy markdown plans', async () => {
    const wrapper = await mountApp()
    await open(wrapper, '.cursor/plans/legacy-feature.plan.md')
    const view = wrapper.findComponent({ name: 'PlanFileView' })
    expect(view.exists()).toBe(true)
    expect(view.props('relPath')).toBe('.cursor/plans/legacy-feature.plan.md')
    expect(wrapper.findComponent({ name: 'PlanReviewToolbar' }).exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'FilePreviewPane' }).exists()).toBe(false)
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

describe('PlanWindowApp – inline section edit/delete', () => {
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
    expect(written).not.toContain('bad()')
    expect(written).not.toContain('old goal')
    // plan-meta and other sections are untouched.
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
      // The host sanitizes before handing the body to the store: no onclick.
      expect(body).toEqual({ kind: 'html', sanitized: '<p>clean</p>' })
      expect(fsState.writes).toHaveLength(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('confirms a section-delete before writing, and writes nothing when declined', async () => {
    fsState.content = BODY_DOC
    confirmMock.mockResolvedValueOnce(false)
    const wrapper = await mountApp()
    await open(wrapper, '.agent-team/plans/feature_a1b2c3.html')
    const preview = wrapper.findComponent({ name: 'PlanDocPreview' })

    preview.vm.$emit('section-delete', 'Risks')
    await flushPromises()
    expect(fsState.writes).toHaveLength(0)

    preview.vm.$emit('section-delete', 'Risks')
    await flushPromises()
    expect(fsState.writes).toHaveLength(1)
    expect(fsState.writes[0]).not.toContain('<h2>Risks</h2>')
    expect(fsState.writes[0]).toContain('<h2>Goals</h2>')
  })
})

describe('PlanWindowApp – ESC overlay priority', () => {
  function pressEsc(): void {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  }

  it('cancels an in-frame section edit before closing the window', async () => {
    previewSpies.isEditing.mockReturnValue(true)
    const wrapper = await mountApp()
    await open(wrapper, '.agent-team/plans/feature_a1b2c3.html')
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {})
    pressEsc()
    expect(previewSpies.cancelEdit).toHaveBeenCalled()
    expect(closeSpy).not.toHaveBeenCalled()
    closeSpy.mockRestore()
  })

  it('closes the plan-list overlay before the window', async () => {
    plansPaneSpies.closeActiveOverlay.mockReturnValue(true)
    const wrapper = await mountApp()
    await open(wrapper, '.agent-team/plans/feature_a1b2c3.html')
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {})
    pressEsc()
    expect(plansPaneSpies.closeActiveOverlay).toHaveBeenCalled()
    expect(closeSpy).not.toHaveBeenCalled()
    closeSpy.mockRestore()
  })

  it('closes an unsent toolbar overlay before the window', async () => {
    toolbarSpies.closeActiveOverlay.mockReturnValue(true)
    const wrapper = await mountApp()
    await open(wrapper, '.agent-team/plans/feature_a1b2c3.html')
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {})
    pressEsc()
    expect(toolbarSpies.closeActiveOverlay).toHaveBeenCalled()
    expect(closeSpy).not.toHaveBeenCalled()
    closeSpy.mockRestore()
  })

  it('closes the window when no overlay is active', async () => {
    const wrapper = await mountApp()
    await open(wrapper, '.agent-team/plans/feature_a1b2c3.html')
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {})
    pressEsc()
    expect(closeSpy).toHaveBeenCalled()
    closeSpy.mockRestore()
  })
})
