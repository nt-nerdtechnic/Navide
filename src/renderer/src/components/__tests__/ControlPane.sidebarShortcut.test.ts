// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import ControlPane from '../ControlPane.vue'

// Regression coverage for the Cmd+1/2/3 sidebar-tab shortcut (ControlPane
// `onSidebarTabShortcut`). The bug: pressing the bare Cmd key fires a keydown
// with key='Meta'; parseInt('Meta') is NaN, which slips past the range check
// (NaN comparisons are always false) and set the tab to SIDEBAR_TABS[NaN] ===
// undefined, blanking the panel. The handler listens on `document`, so we drive
// it with real KeyboardEvents and read the active tab off the rendered nav.

// Minimal props: keep `backend` undefined so the Explorer/Git child panes (both
// `v-if="backend"`) never render, and seed the tab to 'explorer' so the heavy
// pipeline block (`v-if="sidebarTab === 'pipeline'"`) stays unmounted. The only
// DOM we assert on is the always-rendered `.tab-btn` nav.
const minimalProps = {
  backendStatus: 'connected',
  backendUrl: '',
  agentSpecs: [],
  roles: [],
  stages: [],
  panes: [],
  pipeline: { state: 'idle' },
  yoloEnabled: false,
  analyzerModel: '',
  analyzerStatus: {},
  autoAnswerEnabled: false,
  existingProject: null
} as unknown as Record<string, unknown>

function keydown(init: KeyboardEventInit): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }))
}

/** Active sidebar tab read off the nav: 0=explorer, 1=pipeline, 2=git, 3=plans. */
function activeTab(wrapper: VueWrapper): 'explorer' | 'pipeline' | 'git' | 'plans' | null {
  const order = ['explorer', 'pipeline', 'git', 'plans'] as const
  const btns = wrapper.findAll('.sidebar-tabs .tab-btn')
  const idx = btns.findIndex((b) => b.classes().includes('active'))
  return idx >= 0 ? order[idx] : null
}

describe('ControlPane – Cmd+number sidebar shortcut', () => {
  let wrapper: VueWrapper

  beforeEach(() => {
    sessionStorage.setItem('agentTeam.sidebarTab', 'explorer')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapper = shallowMount(ControlPane as any, { props: minimalProps })
  })

  afterEach(() => {
    wrapper.unmount()
    sessionStorage.clear()
  })

  it('starts on the explorer tab', () => {
    expect(activeTab(wrapper)).toBe('explorer')
  })

  it('bare Cmd (key=Meta) does NOT change or blank the tab', async () => {
    keydown({ key: 'Meta', metaKey: true })
    await wrapper.vm.$nextTick()
    // The fix: NaN index is rejected, so the active tab is untouched (not null).
    expect(activeTab(wrapper)).toBe('explorer')
  })

  it('Cmd+3 switches to the git tab', async () => {
    keydown({ key: '3', metaKey: true })
    await wrapper.vm.$nextTick()
    expect(activeTab(wrapper)).toBe('git')
  })

  it('Cmd+4 switches to the plans tab', async () => {
    keydown({ key: '4', metaKey: true })
    await wrapper.vm.$nextTick()
    expect(activeTab(wrapper)).toBe('plans')
  })

  it('Cmd+1 switches back to the explorer tab', async () => {
    keydown({ key: '3', metaKey: true })
    await wrapper.vm.$nextTick()
    keydown({ key: '1', metaKey: true })
    await wrapper.vm.$nextTick()
    expect(activeTab(wrapper)).toBe('explorer')
  })

  it('out-of-range Cmd+5 is ignored', async () => {
    keydown({ key: '5', metaKey: true })
    await wrapper.vm.$nextTick()
    expect(activeTab(wrapper)).toBe('explorer')
  })

  it('Cmd+Shift+3 is ignored (modifier guard keeps OS screenshot binding free)', async () => {
    keydown({ key: '3', metaKey: true, shiftKey: true })
    await wrapper.vm.$nextTick()
    expect(activeTab(wrapper)).toBe('explorer')
  })
})
