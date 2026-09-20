// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import ControlPane from '../ControlPane.vue'

const workspace = '/workspace/project'
let wrapper: VueWrapper | undefined

function mountMenu(height: number) {
  vi.stubGlobal('innerHeight', 600)
  sessionStorage.setItem('agentTeam.sidebarTab', 'agents')
  const measured = vi.fn()
  const originalRect = HTMLElement.prototype.getBoundingClientRect
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('ws-more-menu')) {
      measured()
      return new DOMRect(96, Number.parseFloat(this.style.top), 168, height)
    }
    return originalRect.call(this)
  })
  wrapper = shallowMount(ControlPane as never, {
    attachTo: document.body,
    props: {
      backendStatus: 'connected', backendUrl: '',
      backend: { send: vi.fn().mockResolvedValue({ payload: { deps: [] } }) },
      agentSpecs: [], roles: [], stages: [], panes: [], pipeline: { state: 'idle' },
      yoloEnabled: false, analyzerModel: '',
      analyzerStatus: { available: false, version: '', defaultModel: '', models: [], benchmarkResults: [] },
      autoAnswerEnabled: false, workspace, existingProject: null,
      workspaces: [{
        path: workspace, label: 'project', displayPath: '/workspace', isCurrent: true,
        collapsed: false, count: 0, paneIds: [], lineage: [],
        groups: [{ id: '', name: '', rows: [] }], remote: [],
      }],
    } as never,
    global: { mocks: { $t: (key: string) => key } },
  })
  const button = wrapper.find('.ws-more').element as HTMLElement
  const anchor = vi.spyOn(button, 'getBoundingClientRect')
    .mockReturnValue(new DOMRect(240, 80, 24, 20))
  const click = () => button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  const menu = () => wrapper!.find('.ws-more-menu').element as HTMLElement
  return { anchor, click, menu, measured }
}

afterEach(() => {
  wrapper?.unmount()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('workspace overflow menu placement', () => {
  it('keeps the normal below-anchor position and horizontal alignment', async () => {
    const h = mountMenu(300)
    h.click()
    await nextTick()
    await nextTick()
    expect(h.menu().style.top).toBe('104px')
    expect(h.menu().style.left).toBe('96px')
  })

  it('keeps the measured lower edge inside the viewport', async () => {
    const h = mountMenu(300)
    h.anchor.mockReturnValue(new DOMRect(240, 560, 24, 20))
    h.click()
    await nextTick()
    await nextTick()
    const top = Number.parseFloat(h.menu().style.top)
    expect(top).toBe(292)
    expect(top + h.menu().getBoundingClientRect().height).toBeLessThanOrEqual(592)
  })

  it('keeps an oversized menu at the top margin and open when its content scrolls', async () => {
    const h = mountMenu(900)
    h.anchor.mockReturnValue(new DOMRect(240, 280, 24, 20))
    h.click()
    await nextTick()
    await nextTick()
    expect(h.menu().style.top).toBe('8px')
    h.menu().dispatchEvent(new Event('scroll'))
    await nextTick()
    expect(wrapper!.find('.ws-more-menu').exists()).toBe(true)
  })

  it('still dismisses when the surrounding workspace list scrolls', async () => {
    const h = mountMenu(300)
    h.click()
    await nextTick()
    document.dispatchEvent(new Event('scroll'))
    await nextTick()
    expect(wrapper!.find('.ws-more-menu').exists()).toBe(false)
  })

  it('does not measure or reopen a menu closed before rendering', async () => {
    const h = mountMenu(300)
    h.click()
    h.click()
    await nextTick()
    await nextTick()
    expect(wrapper!.find('.ws-more-menu').exists()).toBe(false)
    expect(h.measured).not.toHaveBeenCalled()
  })

  it('ignores an older opening when the same workspace closes and reopens', async () => {
    const h = mountMenu(300)
    h.anchor.mockReturnValue(new DOMRect(240, 560, 24, 20))
    h.click()
    h.click()
    h.anchor.mockReturnValue(new DOMRect(240, 80, 24, 20))
    h.click()
    await nextTick()
    await nextTick()
    expect(h.menu().style.top).toBe('104px')
    expect(h.measured).toHaveBeenCalledTimes(1)
  })
})
