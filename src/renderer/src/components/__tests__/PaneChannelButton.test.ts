// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import { useChannels } from '../../composables/useChannels'
import { useGuard } from '../../composables/useGuard'
import { settingsSet } from '@navide/plugin-ui/shared'
import { __resetSettingsForTest } from '@navide/plugin-ui/shared/testing'
import PaneChannelButton from '../PaneChannelButton.vue'

const exec = vi.hoisted(() => vi.fn())
vi.mock('@navide/plugin-ui/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@navide/plugin-ui/shared')>()),
  executeCommand: exec,
}))

let wrapper: VueWrapper | undefined
let mock: ReturnType<typeof createMockBackend>

function seed(opts: { configured: boolean; bound?: boolean }): void {
  mock.setResponse('channels.list', {
    ok: true,
    enabled: true,
    platforms: opts.configured
      ? [{
          platform: 'telegram',
          configured: true,
          enabled: true,
          status: { lifecycle: 'ready', connected: true, identity: '@navide_bot' },
          config: {},
          capabilities: { threads: true, create_location: true, edit: true, typing: true, buttons: true, text_limit: 4000 },
        }]
      : [],
  })
  mock.setResponse('channels.bindings', {
    ok: true,
    bindings: opts.bound
      ? [{ pane_id: 'p1', platform: 'telegram', account: 'a', chat_id: '-100', thread_id: '7', title: 'api-refactor' }]
      : [],
  })
  mock.setResponse('channels.pairing.list', { ok: true, requests: [] })
  mock.setResponse('channels.allow.list', { ok: true, entries: [] })
  mock.setResponse('channels.bind', { ok: true, binding: {} })
  mock.setResponse('channels.locations', {
    ok: true,
    locations: [{ chat_id: '-100', title: 'Navide', kind: 'supergroup', supports_topics: true }],
  })
}

async function render(): Promise<VueWrapper> {
  const store = useChannels(mock.backend)
  wrapper = mount(PaneChannelButton, {
    props: { paneId: 'p1', paneName: 'api-refactor', store },
    global: { plugins: [i18n] },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  i18n.global.locale.value = 'en-US'
  exec.mockReset()
  mock = createMockBackend('connected')
})
afterEach(() => {
  wrapper?.unmount()
  document.body.innerHTML = ''
})

describe('PaneChannelButton', () => {
  it('opens Settings → Channels when no platform is configured', async () => {
    seed({ configured: false })
    const w = await render()
    const btn = w.get('[data-testid="channel-connect"]')
    // An SVG icon button like its header neighbours, labelled by tooltip, not a text glyph.
    expect(btn.find('svg').exists()).toBe(true)
    expect(btn.text()).toBe('')
    expect(btn.attributes('title')).toBe('Connect to a chat')
    await btn.trigger('click')
    expect(exec).toHaveBeenCalledWith('workbench.action.openSettingsChannels')
    expect(document.querySelector('[data-testid="channel-popover"]')).toBeNull()
  })

  it('binds a new topic named after the pane', async () => {
    seed({ configured: true })
    const w = await render()
    await w.get('[data-testid="channel-connect"]').trigger('click')
    ;(document.querySelector('[data-testid="channel-platform"]') as HTMLElement).click()
    await flushPromises()
    const newBtn = document.querySelector('[data-testid="channel-bind-new"]') as HTMLElement
    expect(newBtn.textContent).toContain('api-refactor')
    newBtn.click()
    await flushPromises()
    expect(mock.sent.find((s) => s.type === 'channels.locations')?.payload).toEqual({ platform: 'telegram' })
    expect(mock.sent.find((s) => s.type === 'channels.bind')?.payload).toEqual({
      pane_id: 'p1', pane_name: 'api-refactor', platform: 'telegram', mode: 'new', chat_id: '-100', title: 'api-refactor',
    })
    expect(document.querySelector('[data-testid="channel-popover"]')).toBeNull()
  })

  it('binds an existing chat', async () => {
    seed({ configured: true })
    const w = await render()
    await w.get('[data-testid="channel-connect"]').trigger('click')
    ;(document.querySelector('[data-testid="channel-platform"]') as HTMLElement).click()
    await flushPromises()
    ;(document.querySelector('[data-testid="channel-bind-existing"]') as HTMLElement).click()
    await flushPromises()
    expect(mock.sent.find((s) => s.type === 'channels.bind')?.payload).toEqual({
      pane_id: 'p1', pane_name: 'api-refactor', platform: 'telegram', mode: 'existing', chat_id: '-100',
    })
  })

  describe('Guard warning for a CLI Guard cannot block', () => {
    async function renderFor(agentKey: string, support: Record<string, string>): Promise<VueWrapper> {
      mock.setResponse('guard.status', { enabled: true, counts: {}, hook_support: support })
      mock.setResponse('guard.taint.list', { panes: [] })
      const store = useChannels(mock.backend)
      const guardStore = useGuard(mock.backend)
      wrapper = mount(PaneChannelButton, {
        props: { paneId: 'p1', paneName: 'api-refactor', agentKey, store, guardStore },
        global: { plugins: [i18n] },
        attachTo: document.body,
      })
      await flushPromises()
      await wrapper.get('[data-testid="channel-connect"]').trigger('click')
      return wrapper
    }
    const warning = () => document.querySelector('[data-testid="channel-guard-warning"]')

    beforeEach(() => {
      __resetSettingsForTest()
      seed({ configured: true })
    })

    it('warns when the vendor has no hook and runs in YOLO', async () => {
      settingsSet('agentTeam.yolo', '1')
      await renderFor('cursor', { cursor: 'none', claude: 'block' })
      expect(warning()?.textContent).toContain('cannot block this CLI')
    })

    it('stays quiet for a vendor Guard can block', async () => {
      settingsSet('agentTeam.yolo', '1')
      await renderFor('claude', { cursor: 'none', claude: 'block' })
      expect(warning()).toBeNull()
    })

    it('stays quiet when YOLO is off', async () => {
      settingsSet('agentTeam.yolo', '0')
      await renderFor('cursor', { cursor: 'none' })
      expect(warning()).toBeNull()
    })
  })

  it('shows a chip for a bound pane and unbinds from it', async () => {
    seed({ configured: true, bound: true })
    const w = await render()
    expect(w.find('[data-testid="channel-connect"]').exists()).toBe(false)
    expect(w.get('[data-testid="channel-chip"]').text()).toContain('Telegram · api-refactor')
    await w.get('[data-testid="channel-unbind"]').trigger('click')
    await flushPromises()
    expect(mock.sent.find((s) => s.type === 'channels.unbind')?.payload).toEqual({ pane_id: 'p1' })
  })
})
