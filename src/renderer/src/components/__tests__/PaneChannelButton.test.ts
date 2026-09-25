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

function seed(opts: {
  configured: boolean
  bound?: boolean
  extra?: Record<string, unknown>[]
  locations?: Record<string, unknown>[]
  bindings?: Record<string, unknown>[]
}): void {
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
        }, ...(opts.extra ?? [])]
      : [],
  })
  mock.setResponse('channels.bindings', {
    ok: true,
    bindings: opts.bindings ?? (opts.bound
      ? [{ pane_id: 'p1', platform: 'telegram', account: 'a', chat_id: '-100', thread_id: '7', title: 'api-refactor' }]
      : []),
  })
  mock.setResponse('channels.pairing.list', { ok: true, requests: [] })
  mock.setResponse('channels.allow.list', { ok: true, entries: [] })
  mock.setResponse('channels.bind', { ok: true, binding: {} })
  mock.setResponse('channels.locations', {
    ok: true,
    locations: opts.locations ?? [{ chat_id: '-100', title: 'Navide', kind: 'supergroup', supports_topics: true }],
  })
}

const q = (sel: string) => document.querySelector(sel) as HTMLElement | null
const qa = (sel: string) => Array.from(document.querySelectorAll(sel)) as HTMLElement[]

async function openPopover(w: VueWrapper): Promise<void> {
  await w.get('[data-testid="channel-connect"]').trigger('click')
  await flushPromises()
}

let lastStore: ReturnType<typeof useChannels> | null = null

async function render(): Promise<VueWrapper> {
  const store = useChannels(mock.backend)
  lastStore = store
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

  it('lists the known chats on open, without picking a platform first', async () => {
    seed({
      configured: true,
      locations: [
        { chat_id: '-100', title: 'Navide', kind: 'supergroup', supports_topics: true },
        { chat_id: '42', title: 'Alice', kind: 'private', supports_topics: false },
      ],
    })
    const w = await render()
    await openPopover(w)
    expect(mock.sent.filter((s) => s.type === 'channels.locations').map((s) => s.payload)).toEqual([{ platform: 'telegram' }])
    const group = q('[data-testid="channel-group"]')!
    expect(group.textContent).toContain('Telegram')
    expect(group.textContent).toContain('@navide_bot')
    const rows = qa('[data-testid="channel-location"]')
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Navide'),
      expect.stringContaining('Alice'),
    ])
    expect(rows[0].textContent).toContain('Group')
    expect(rows[1].textContent).toContain('DM')
    // Only the topic-capable group offers a new topic.
    expect(rows[0].querySelector('[data-testid="channel-bind-new"]')).not.toBeNull()
    expect(rows[1].querySelector('[data-testid="channel-bind-new"]')).toBeNull()
  })

  it('loads every connected platform and greys out the ones that are not', async () => {
    seed({
      configured: true,
      extra: [
        {
          platform: 'discord', configured: true, enabled: true,
          status: { lifecycle: 'ready', connected: true, identity: '' }, config: {},
          capabilities: { threads: true, create_location: false, edit: true, typing: true, buttons: true, text_limit: 2000 },
        },
        {
          platform: 'slack', configured: true, enabled: true,
          status: { lifecycle: 'blocked', connected: false, identity: '' }, config: {}, capabilities: null,
        },
        {
          platform: 'matrix', configured: true, enabled: false,
          status: { lifecycle: 'stopped', connected: false, identity: '' }, config: {}, capabilities: null,
        },
      ],
    })
    const w = await render()
    await openPopover(w)
    expect(mock.sent.filter((s) => s.type === 'channels.locations').map((s) => s.payload)).toEqual([
      { platform: 'telegram' },
      { platform: 'discord' },
    ])
    expect(qa('[data-testid="channel-group"]')).toHaveLength(4)
    const off = qa('[data-testid="channel-platform-off"]').map((r) => r.textContent)
    expect(off).toEqual(['Blocked — check the credentials', 'Off'])
    // Discord cannot create a location, so its topic-capable chat offers no new topic.
    expect(qa('[data-testid="channel-bind-new"]')).toHaveLength(1)
  })

  it('hints to message the bot when a connected platform knows no chat yet', async () => {
    seed({ configured: true, locations: [] })
    const w = await render()
    await openPopover(w)
    expect(q('[data-testid="channel-no-chats"]')?.textContent).toContain('Send the bot a message')
  })

  it('links to channel settings from the footer', async () => {
    seed({ configured: true })
    const w = await render()
    await openPopover(w)
    const link = q('[data-testid="channel-manage"]')!
    expect(link.textContent).toBe('Manage chat settings')
    link.click()
    await flushPromises()
    expect(exec).toHaveBeenCalledWith('workbench.action.openSettingsChannels')
    expect(q('[data-testid="channel-popover"]')).toBeNull()
  })

  it('binds a new topic named after the pane', async () => {
    seed({ configured: true })
    const w = await render()
    await openPopover(w)
    const newBtn = q('[data-testid="channel-bind-new"]')!
    expect(newBtn.textContent).toBe('New topic')
    expect(newBtn.getAttribute('title')).toContain('api-refactor')
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
    await openPopover(w)
    q('[data-testid="channel-bind-existing"]')!.click()
    await flushPromises()
    expect(mock.sent.find((s) => s.type === 'channels.bind')?.payload).toEqual({
      pane_id: 'p1', pane_name: 'api-refactor', platform: 'telegram', mode: 'existing', chat_id: '-100',
    })
    expect(q('[data-testid="channel-popover"]')).toBeNull()
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
    expect(mock.sent.find((s) => s.type === 'channels.unbind')?.payload).toEqual({ pane_id: 'p1', pane_name: 'api-refactor' })
  })

  it('shows a chat held by another pane as taken, and offers it again once released', async () => {
    seed({
      configured: true,
      locations: [{ chat_id: '555', title: 'neillu123', kind: 'direct', supports_topics: false }],
      bindings: [{ pane_id: 'p2', platform: 'telegram', account: 'a', chat_id: '555', thread_id: '', title: 'other-pane' }],
    })
    const w = await render()
    await openPopover(w)
    const row = q('[data-testid="channel-bind-existing"]') as HTMLButtonElement
    expect(row.disabled).toBe(true)
    expect(q('[data-testid="channel-taken"]')?.textContent).toContain('other-pane')
    lastStore!.bindings.value = []
    await flushPromises()
    expect((q('[data-testid="channel-bind-existing"]') as HTMLButtonElement).disabled).toBe(false)
    expect(q('[data-testid="channel-taken"]')).toBeNull()
  })

  it('reloads an open picker when a new chat shows up', async () => {
    seed({ configured: true, locations: [] })
    const w = await render()
    await openPopover(w)
    expect(q('[data-testid="channel-no-chats"]')).not.toBeNull()
    mock.setResponse('channels.locations', {
      ok: true,
      locations: [{ chat_id: '555', title: 'neillu123', kind: 'private', supports_topics: false }],
    })
    await lastStore!.refresh()
    await flushPromises()
    expect(q('[data-testid="channel-no-chats"]')).toBeNull()
    expect(q('[data-testid="channel-bind-existing"]')?.textContent).toContain('neillu123')
  })
})
