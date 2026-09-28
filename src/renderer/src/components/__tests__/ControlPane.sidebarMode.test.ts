// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import ControlPane from '../ControlPane.vue'

const HERE = '/tmp/here'
const THERE = '/tmp/there'

function lineageOf(ids: string[]): Record<string, unknown>[] {
  return ids.map((id) => ({
    id,
    depth: 0,
    hasChildren: false,
    collapsed: false,
    ancestors: [],
    descendantCount: 0
  }))
}

function pane(id: string, workspacePath: string): Record<string, unknown> {
  return {
    id,
    agentKey: 'codex',
    agentLabel: id,
    roleKey: '',
    roleLabel: '',
    stageId: '',
    status: 'idle',
    command: 'codex',
    injectionStatus: 'none',
    origin: 'manual',
    workspacePath,
    isMinimized: false
  }
}

function workspaceRow(path: string, paneIds: string[]): Record<string, unknown> {
  return {
    path,
    label: path.split('/').pop(),
    displayPath: path,
    isCurrent: true,
    collapsed: false,
    count: paneIds.length,
    paneIds,
    lineage: lineageOf(paneIds),
    groups: [{ id: 'g1', name: 'QA', rows: lineageOf(paneIds) }]
  }
}

const PANES = [pane('p-here', HERE), pane('p-there', THERE)]

function mountPane(extra: Record<string, unknown>, attach = false): VueWrapper {
  sessionStorage.setItem('agentTeam.sidebarTab', 'agents')
  return shallowMount(ControlPane as never, {
    // Only the bubbling test needs a real document: an unattached wrapper's
    // events never leave it, so nothing on `document` can hear them.
    attachTo: attach ? document.body : undefined,
    props: {
      backendStatus: 'connected',
      backendUrl: '',
      agentSpecs: [],
      roles: [],
      stages: [],
      panes: PANES,
      lineage: lineageOf(['p-here', 'p-there']),
      workspace: HERE,
      pipeline: { state: 'idle' },
      yoloEnabled: false,
      analyzerModel: '',
      analyzerStatus: {
        available: false,
        version: '',
        defaultModel: '',
        models: [],
        benchmarkResults: []
      },
      autoAnswerEnabled: false,
      existingProject: null,
      ...extra
    } as never,
    global: { mocks: { $t: (key: string) => key } }
  })
}

describe('ControlPane – sidebar mode switch', () => {
  let wrapper: VueWrapper | null = null

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    sessionStorage.clear()
  })

  it('draws the workspace layers in workspace mode', () => {
    wrapper = mountPane({ workspaces: [workspaceRow(HERE, ['p-here'])] })
    expect(wrapper.findAll('.ws-head').length).toBe(1)
    expect(wrapper.findAll('.ws-grp').length).toBe(1)
    expect(wrapper.find('.hdr-fold-ws').exists()).toBe(true)
    expect(wrapper.find('.ws-strip').exists()).toBe(true)
  })

  it('drops workspace rows, run groups, the rail and the fold-all button in free mode', () => {
    wrapper = mountPane({
      workspaces: [workspaceRow(HERE, ['p-here'])],
      sidebarMode: 'free'
    })
    expect(wrapper.findAll('.ws-head').length).toBe(0)
    expect(wrapper.findAll('.ws-grp').length).toBe(0)
    expect(wrapper.find('.ws-strip').exists()).toBe(false)
    // Its own v-if watches localWorkspaceRows, so it goes on its own.
    expect(wrapper.find('.hdr-fold-ws').exists()).toBe(false)
    // Every pane still has a row — indentation is lineage, not grouping.
    expect(wrapper.findAll('.agent-item').length).toBe(2)
  })

  it('reports each segment click so App can persist the choice', async () => {
    wrapper = mountPane({ workspaces: [workspaceRow(HERE, ['p-here'])] })
    const segments = wrapper.findAll('.sidebar-mode-seg')
    expect(segments.length).toBe(2)
    expect(segments[0].attributes('aria-pressed')).toBe('true')
    await segments[1].trigger('click')
    expect(wrapper.emitted('update:sidebarMode')?.[0]).toEqual(['free'])
  })

  it('keeps the no-workspace fallback out of free mode', () => {
    // rebuild-all + history and the running tally belong to a window that has
    // no workspace at all. Flattening the list must not summon them.
    wrapper = mountPane({
      workspaces: [workspaceRow(HERE, ['p-here'])],
      sidebarMode: 'free'
    })
    expect(wrapper.find('.agent-header-actions').exists()).toBe(false)
    expect(wrapper.find('.sidebar-mode').exists()).toBe(true)

    wrapper.unmount()
    wrapper = mountPane({ workspaces: [], sidebarMode: 'free' })
    expect(wrapper.find('.agent-header-actions').exists()).toBe(true)
    expect(wrapper.find('.lbl').text()).toBe('label.active-agents')
    expect(wrapper.find('.sidebar-mode').exists()).toBe(false)
  })

  it('hides the switch in a detached window, which holds one workspace', () => {
    wrapper = mountPane({
      workspaces: [workspaceRow(HERE, ['p-here'])],
      detachedWindow: true
    })
    expect(wrapper.find('.sidebar-mode').exists()).toBe(false)
    expect(wrapper.find('.lbl').text()).toBe('label.workspace')
  })

  it('tags only the panes that come from another workspace', () => {
    wrapper = mountPane({
      workspaces: [workspaceRow(HERE, ['p-here'])],
      sidebarMode: 'free'
    })
    const tags = wrapper.findAll('.ws-tag')
    expect(tags.length).toBe(1)
    expect(tags[0].text()).toBe('there')
  })

  it('carries no tags in workspace mode, where the heading says it already', () => {
    wrapper = mountPane({ workspaces: [workspaceRow(HERE, ['p-here'])] })
    expect(wrapper.findAll('.ws-tag').length).toBe(0)
  })

  it('turns the header ＋ into "open an agent here" in free mode', async () => {
    wrapper = mountPane({
      workspaces: [workspaceRow(HERE, ['p-here'])],
      sidebarMode: 'free'
    })
    const add = wrapper.find('.hdr-add-ws')
    expect(add.attributes('aria-label')).toBe('action.new-agent-here')
    await add.trigger('click')
    expect(wrapper.emitted('open-workspace-picker')).toBeUndefined()
    expect(add.attributes('aria-expanded')).toBe('true')
    // The roster itself must reach the screen: it lives outside the workspace
    // rows free mode removes.
    expect(wrapper.find('.ws-add-menu').exists()).toBe(true)
  })

  it('leaves the header ＋ as the workspace picker in workspace mode', async () => {
    wrapper = mountPane({ workspaces: [workspaceRow(HERE, ['p-here'])] })
    const add = wrapper.find('.hdr-add-ws')
    expect(add.attributes('aria-label')).toBe('action.open-workspace-picker')
    await add.trigger('click')
    expect(wrapper.emitted('open-workspace-picker')?.length).toBe(1)
  })

  it('stops the free-mode ＋ click from reaching the document', async () => {
    // The menu installs an outside-click listener on `document` the moment it
    // opens. In a real browser the microtask checkpoint between listeners runs
    // that watcher WHILE the opening click is still bubbling, so a click that
    // is allowed through reaches the listener and shuts the menu again — the
    // button looked dead. happy-dom dispatches listeners without that
    // checkpoint and cannot reproduce it, so this asserts the thing that does
    // distinguish the two: the click must not leave the button.
    wrapper = mountPane(
      {
        workspaces: [workspaceRow(HERE, ['p-here'])],
        sidebarMode: 'free'
      },
      true
    )
    const onDocumentClick = vi.fn()
    document.addEventListener('click', onDocumentClick)
    try {
      const add = wrapper.find('.hdr-add-ws')
      add.element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await nextTick()
      expect(onDocumentClick).not.toHaveBeenCalled()
      expect(add.attributes('aria-expanded')).toBe('true')
    } finally {
      document.removeEventListener('click', onDocumentClick)
    }
  })
})
