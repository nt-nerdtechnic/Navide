// @vitest-environment happy-dom
// Routing tests for the dedicated plan review window: the plans list mounts
// with the workspace from the query string, opening an HTML plan stacks the
// review toolbar above the interactive srcdoc preview (PlanDocPreview),
// in-document interactions route into the toolbar's exposed write paths, and
// legacy markdown plans fall back to PlanFileView.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { ref } from 'vue'
import PlanWindowApp from '../../PlanWindowApp.vue'
import { i18n } from '../../i18n'

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
}))
const previewSpies = vi.hoisted(() => ({ scrollToAnchor: vi.fn() }))

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

vi.mock('../PlansPane.vue', () => stub('PlansPane', ['workspacePath', 'backend']))
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
  previewSpies.scrollToAnchor.mockClear()
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
    send: vi.fn(async () => ({ payload: { ok: true } })),
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

async function mountApp(): Promise<VueWrapper> {
  const wrapper = mount(PlanWindowApp, { global: { plugins: [i18n] } })
  await flushPromises()
  return wrapper
}

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
