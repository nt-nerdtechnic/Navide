// @vitest-environment happy-dom
// The legacy-recovery Plans window's title: the alias the user gave the
// workspace (resolved by the Host and handed over in
// `?workspace_display_name=`) wins over the folder name. Keeps its own harness
// rather than widening the locale one.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { ref, defineComponent, h } from 'vue'
import PlanWindowApp from '../../PlanWindowApp.vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { __resetSettingsForTest } from '../../../../../packages/plugin-ui/src/shared/testing'

vi.mock('../../composables/useBackend', () => ({
  useBackend: () => ({
    status: ref('connected'),
    wsUrl: ref(''),
    httpUrl: ref('http://127.0.0.1:1'),
    shell: ref(''),
    port: ref(0),
    pid: ref(0),
    lastError: ref(''),
    send: vi.fn(async (type: string) => {
      if (type === 'ui.settings.get') return { ok: true, payload: { settings: {} } }
      return { ok: true, payload: { ok: true } }
    }),
    on: vi.fn(() => () => undefined),
  }),
}))

vi.mock('../../plugins/plans/resolvePlanRoot', () => ({
  resolvePlanRoot: vi.fn(async () => '/Users/dev/projects/agent-team'),
}))

vi.mock('@navide/plugin-shell', () => ({
  AiCliDock: defineComponent({ name: 'AiCliDock', render: () => h('div', { class: 'stub-dock' }) }),
  aiTerminalPaneId: vi.fn(() => 'dock-id'),
  buildPlanCliContext: vi.fn(async () => ''),
}))

vi.mock('../../editor/PlansPane.vue', () => ({
  default: defineComponent({ name: 'PlansPane', render: () => h('div', { class: 'stub-plans-pane' }) }),
}))

const WS = '%2FUsers%2Fdev%2Fprojects%2Fagent-team'

function mountApp(search: string): VueWrapper {
  window.history.replaceState({}, '', `http://localhost:3000/${search}`)
  return mount(PlanWindowApp, { global: { plugins: [i18n] } })
}

describe('PlanWindowApp – workspace display name', () => {
  beforeEach(() => {
    __resetSettingsForTest()
    document.title = 'untouched'
    window.agentTeam = {
      ...(window.agentTeam ?? {}),
      onLanguageChanged: () => undefined,
    } as unknown as typeof window.agentTeam
  })

  it('titles the window with the alias the Host resolved, padding trimmed', () => {
    const wrapper = mountApp(`?window=plans&workspace_path=${WS}&workspace_display_name=%20%20Navide%20%20`)
    expect(document.title).toBe('Navide — Plans')
    wrapper.unmount()
  })

  it('falls back to the folder name when the alias is absent or blank', () => {
    for (const search of [
      `?window=plans&workspace_path=${WS}`,
      `?window=plans&workspace_path=${WS}&workspace_display_name=`,
      `?window=plans&workspace_path=${WS}&workspace_display_name=%20%20`,
    ]) {
      document.title = 'untouched'
      const wrapper = mountApp(search)
      expect(document.title, search).toBe('agent-team — Plans')
      wrapper.unmount()
    }
  })
})
