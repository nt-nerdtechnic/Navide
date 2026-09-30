// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import { useChannels } from '../../composables/useChannels'
import ChannelMonitorModal from '../ChannelMonitorModal.vue'

let wrapper: VueWrapper | undefined
let mock: ReturnType<typeof createMockBackend>

function seed(bindings: Record<string, unknown>[], lifecycle = 'ready'): void {
  mock.setResponse('channels.list', {
    ok: true,
    enabled: true,
    platforms: [{
      platform: 'telegram',
      configured: true,
      enabled: true,
      status: { lifecycle, connected: lifecycle === 'ready', identity: '@navide_bot' },
      config: {},
      capabilities: null,
    }],
  })
  mock.setResponse('channels.bindings', { ok: true, bindings })
  mock.setResponse('channels.pairing.list', { ok: true, requests: [] })
  mock.setResponse('channels.allow.list', { ok: true, entries: [] })
  mock.setResponse('channels.unbind', { ok: true })
}

const binding = { pane_id: 'p1', platform: 'telegram', account: 'a', chat_id: '-100', thread_id: '7', title: 'api-refactor' }

async function render(open = true) {
  const store = useChannels(mock.backend)
  await store.refresh()
  wrapper = mount(ChannelMonitorModal, {
    props: { open, store, paneLabel: (id: string) => (id === 'p1' ? 'Claude 1' : id) },
    global: { plugins: [i18n] },
    attachTo: document.body,
  })
  await flushPromises()
  return store
}

const q = (sel: string) => document.querySelector(sel) as HTMLElement | null

describe('ChannelMonitorModal', () => {
  beforeEach(() => {
    i18n.global.locale.value = 'en-US'
    mock = createMockBackend('connected')
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    document.body.innerHTML = ''
  })

  it('renders nothing while closed', async () => {
    seed([binding])
    await render(false)
    expect(q('[data-testid="channel-monitor"]')).toBeNull()
  })

  it('lists each link with pane, channel and status', async () => {
    seed([binding])
    await render()
    const rows = document.querySelectorAll('[data-testid="channel-monitor-row"]')
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('Claude 1')
    expect(rows[0].textContent).toContain('Telegram · api-refactor')
    expect(rows[0].textContent).toContain(i18n.global.t('channels.lifecycle.ready'))
  })

  it('draws its own header mark instead of the Cloud one', async () => {
    seed([binding])
    await render()
    expect(q('.cmon-mark svg')).not.toBeNull()
    expect(q('.nv-cloud-mark')).toBeNull()
  })

  it('marks a blocked platform row with the error tone', async () => {
    seed([binding], 'blocked')
    await render()
    expect(q('.cmon-dot')!.classList.contains('err')).toBe(true)
  })

  it('shows the empty state without bindings', async () => {
    seed([])
    await render()
    expect(q('[data-testid="channel-monitor-empty"]')).not.toBeNull()
  })

  it('updates when the backend pushes a status change', async () => {
    seed([binding])
    await render()
    mock.emit('channels.status', { platform: 'telegram', status: { lifecycle: 'blocked', connected: false } })
    await flushPromises()
    expect(q('[data-testid="channel-monitor-row"]')!.textContent).toContain(i18n.global.t('channels.lifecycle.blocked'))
  })

  it('emits focus-pane when a row is clicked', async () => {
    seed([binding])
    await render()
    q('[data-testid="channel-monitor-go"]')!.click()
    expect(wrapper!.emitted('focus-pane')![0]).toEqual(['p1'])
  })

  it('unbinds the pane without a confirmation step', async () => {
    seed([binding])
    await render()
    q('[data-testid="channel-monitor-unlink"]')!.click()
    await flushPromises()
    const sent = mock.sent.filter((s) => s.type === 'channels.unbind')
    expect(sent).toHaveLength(1)
    expect(sent[0].payload).toMatchObject({ pane_id: 'p1' })
  })

  it('files auto child topics under their root pane, without a disconnect of their own', async () => {
    const child = { ...binding, pane_id: 'c1', thread_id: '8', title: '↳ worker', parent_pane_id: 'p1', auto: true }
    const grandchild = { ...binding, pane_id: 'g1', thread_id: '9', title: '↳ helper', parent_pane_id: 'c1', auto: true }
    seed([binding, child, grandchild])
    await render()
    expect(document.querySelectorAll('[data-testid="channel-monitor-row"]')).toHaveLength(1)
    const children = document.querySelectorAll('[data-testid="channel-monitor-child"]')
    expect(children).toHaveLength(2)
    expect(children[0].textContent).toContain(i18n.global.t('channels.monitor.auto-child'))
    expect(children[1].textContent).toContain('g1')
    expect(document.querySelectorAll('[data-testid="channel-monitor-unlink"]')).toHaveLength(1)
    ;(children[0].querySelector('[data-testid="channel-monitor-go"]') as HTMLElement).click()
    expect(wrapper!.emitted('focus-pane')![0]).toEqual(['c1'])
  })

  it('keeps an auto topic whose parent is no longer bound as its own row', async () => {
    seed([{ ...binding, pane_id: 'c1', parent_pane_id: 'gone', auto: true }])
    await render()
    expect(document.querySelectorAll('[data-testid="channel-monitor-row"]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-testid="channel-monitor-child"]')).toHaveLength(0)
  })

  it('emits close from the X button and the backdrop', async () => {
    seed([binding])
    await render()
    q('[data-testid="channel-monitor-close"]')!.click()
    q('[data-testid="channel-monitor"]')!.click()
    expect(wrapper!.emitted('close')).toHaveLength(2)
  })
})
