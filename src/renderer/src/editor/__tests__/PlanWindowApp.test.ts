// @vitest-environment happy-dom
// Routing tests for the dedicated plan review window: the plans list mounts
// with the workspace from the query string, opening an HTML plan stacks the
// review toolbar above the sandboxed preview, and legacy markdown plans fall
// back to PlanFileView.
import { describe, it, expect, vi } from 'vitest'
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

vi.mock('../PlansPane.vue', () => stub('PlansPane', ['workspacePath', 'backend']))
vi.mock('../PlanReviewToolbar.vue', () => stub('PlanReviewToolbar', ['workspacePath', 'relPath', 'backend']))
vi.mock('../PlanFileView.vue', () => stub('PlanFileView', ['workspacePath', 'relPath', 'backend']))
vi.mock('../FilePreviewPane.vue', () => stub('FilePreviewPane', ['workspacePath', 'relPath', 'name', 'backend']))
vi.mock('../../components/NotificationHost.vue', () => stub('NotificationHost'))

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
    on: vi.fn(() => () => {}),
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

  it('opens an HTML plan with the review toolbar above the sandboxed preview', async () => {
    const wrapper = await mountApp()
    await open(wrapper, '.agent-team/plans/feature_a1b2c3.html')
    const toolbar = wrapper.findComponent({ name: 'PlanReviewToolbar' })
    expect(toolbar.exists()).toBe(true)
    expect(toolbar.props('relPath')).toBe('.agent-team/plans/feature_a1b2c3.html')
    expect(wrapper.findComponent({ name: 'FilePreviewPane' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'PlanFileView' }).exists()).toBe(false)
    expect(wrapper.find('.plan-window-empty').exists()).toBe(false)
  })

  it('remounts the preview when the toolbar reports a plan-meta update', async () => {
    const wrapper = await mountApp()
    await open(wrapper, '.agent-team/plans/feature_a1b2c3.html')
    const before = wrapper.findComponent({ name: 'FilePreviewPane' }).element
    wrapper.findComponent({ name: 'PlanReviewToolbar' }).vm.$emit('updated')
    await flushPromises()
    const after = wrapper.findComponent({ name: 'FilePreviewPane' }).element
    expect(after).not.toBe(before)
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
