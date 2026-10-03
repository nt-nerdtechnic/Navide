// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import ChannelsPane from '../settings/ChannelsPane.vue'

const mac = vi.hoisted(() => ({ value: true }))
vi.mock('@navide/plugin-ui/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@navide/plugin-ui/shared')>()),
  isMacPlatform: () => mac.value,
}))

let wrapper: VueWrapper | undefined
let mock: ReturnType<typeof createMockBackend>
// The clipboard quick add may read, and what the link guide copies.
const clip = { text: '', written: [] as string[], reads: 0 }
const openExternal = vi.fn(async (_url: string) => ({ ok: true }))

function seed(): void {
  mock.setResponse('channels.list', {
    ok: true,
    enabled: true,
    platforms: [
      {
        platform: 'telegram',
        configured: true,
        enabled: true,
        status: { lifecycle: 'blocked', connected: false, identity: '@navide_bot', last_error: 'token rejected' },
        config: { permission_relay: false },
        capabilities: null,
      },
    ],
  })
  mock.setResponse('channels.bindings', { ok: true, bindings: [] })
  mock.setResponse('channels.pairing.list', {
    ok: true,
    requests: [{ platform: 'telegram', code: 'K7Q2M9XA', sender_id: '42', sender_name: 'neil', created_at: 1 }],
  })
  mock.setResponse('channels.allow.list', {
    ok: true,
    entries: [{ platform: 'telegram', sender_id: '7', sender_name: 'amy', added_at: 1 }],
  })
}

async function render(): Promise<VueWrapper> {
  wrapper = mount(ChannelsPane, { props: { backend: mock.backend }, global: { plugins: [i18n] } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  i18n.global.locale.value = 'en-US'
  mac.value = true
  mock = createMockBackend('connected')
  seed()
  clip.text = ''
  clip.written = []
  clip.reads = 0
  Object.defineProperty(navigator, 'clipboard', {
    value: {
      readText: async () => {
        clip.reads += 1
        return clip.text
      },
      writeText: async (text: string) => {
        clip.written.push(text)
      },
    },
    configurable: true,
  })
  openExternal.mockClear()
  ;(window as unknown as { agentTeam?: unknown }).agentTeam = { openExternal }
})
afterEach(() => {
  wrapper?.unmount()
  delete (window as unknown as { agentTeam?: unknown }).agentTeam
})

describe('ChannelsPane', () => {
  it('renders every platform in order, with iMessage only on macOS', async () => {
    const w = await render()
    expect(w.findAll('[data-platform]').map((c) => c.attributes('data-platform'))).toEqual([
      'telegram', 'discord', 'slack', 'feishu', 'dingtalk', 'matrix', 'mattermost', 'imessage',
    ])
    w.unmount()
    mac.value = false
    mock = createMockBackend('connected')
    seed()
    const w2 = await render()
    expect(w2.find('[data-platform="imessage"]').exists()).toBe(false)
  })

  it('shows a status pill and the last error on the collapsed card, no global banner', async () => {
    const w = await render()
    const tg = w.get('[data-platform="telegram"]')
    expect(tg.get('[data-testid="channel-status"]').text()).toContain('Blocked')
    expect(tg.get('[data-testid="channel-status"]').classes()).toContain('bad')
    expect(tg.get('[data-testid="channel-last-error"]').text()).toBe('token rejected')
    const slack = w.get('[data-platform="slack"]')
    expect(slack.get('[data-testid="channel-status"]').text()).toBe('Not set up')
    expect(slack.text()).not.toContain('App-level token + Bot token')
    expect(w.text()).not.toContain('Claude Code --channels')
  })

  it('shows the connected bot identity in the pill', async () => {
    mock.setResponse('channels.list', {
      ok: true,
      enabled: true,
      platforms: [{
        platform: 'telegram', configured: true, enabled: true,
        status: { lifecycle: 'ready', connected: true, identity: '@navide_bot', last_error: '' },
        config: {}, capabilities: null,
      }],
    })
    const w = await render()
    const pill = w.get('[data-platform="telegram"] [data-testid="channel-status"]')
    expect(pill.text()).toBe('Connected @navide_bot')
    expect(pill.classes()).toContain('ok')
    expect(w.find('[data-platform="telegram"] [data-testid="channel-last-error"]').exists()).toBe(false)
  })

  it('the connect form reveals what the platform needs, its hint and the single-receiver note', async () => {
    const w = await render()
    const slack = w.get('[data-platform="slack"]')
    expect(slack.find('[data-testid="channel-needs"]').exists()).toBe(false)
    await slack.get('[data-testid="channel-manage"]').trigger('click')
    expect(slack.get('[data-testid="channel-needs"]').text()).toContain('App-level token + Bot token')
    expect(slack.get('[data-testid="channel-hint"]').text()).toContain('xapp-')
    expect(slack.get('[data-testid="channel-single-receiver"]').text()).toContain('Claude Code --channels')
    const mx = w.get('[data-platform="matrix"]')
    await mx.get('[data-testid="channel-manage"]').trigger('click')
    expect(mx.find('[data-testid="channel-single-receiver"]').exists()).toBe(false)
  })

  it('sorts configured platforms first', async () => {
    mock.setResponse('channels.list', {
      ok: true,
      enabled: true,
      platforms: [{
        platform: 'matrix', configured: true, enabled: false,
        status: { lifecycle: 'stopped', connected: false, identity: '', last_error: '' },
        config: {}, capabilities: null,
      }],
    })
    const w = await render()
    expect(w.findAll('[data-platform]').map((c) => c.attributes('data-platform')).slice(0, 2)).toEqual(['matrix', 'telegram'])
    expect(w.get('[data-platform="matrix"] [data-testid="channel-status"]').text()).toBe('Off')
  })

  it('badges a platform with pending pairing requests', async () => {
    const w = await render()
    expect(w.get('[data-platform="telegram"] [data-testid="channel-pending"]').text()).toBe('1 pending')
    expect(w.find('[data-platform="slack"] [data-testid="channel-pending"]').exists()).toBe(false)
  })

  it('hides the pairing and allowlist sections when they are empty', async () => {
    mock.setResponse('channels.pairing.list', { ok: true, requests: [] })
    mock.setResponse('channels.allow.list', { ok: true, entries: [] })
    const w = await render()
    expect(w.text()).not.toContain('Pending pairing requests')
    expect(w.text()).not.toContain('Allowed senders')
    expect(w.find('[data-testid="channel-pending"]').exists()).toBe(false)
  })

  it('never shows a stored secret — only a masked placeholder — and omits an unchanged secret on save', async () => {
    const w = await render()
    const tg = w.get('[data-platform="telegram"]')
    await tg.get('[data-testid="channel-manage"]').trigger('click')
    const input = tg.get('input[name="token"]')
    expect(input.attributes('type')).toBe('password')
    expect((input.element as HTMLInputElement).value).toBe('')
    expect(input.attributes('placeholder')).toContain('••••')
    await tg.get('form').trigger('submit')
    await flushPromises()
    const sent = mock.sent.find((s) => s.type === 'channels.configure')
    expect(sent?.payload).toEqual({ platform: 'telegram', config: {} })
  })

  it('requires the secret for a new platform and sends it once, through quick add', async () => {
    mock.setResponse('channels.quick_add', { ok: true, account: 'default', name: '', identity: '', link: null })
    const w = await render()
    const card = w.get('[data-platform="feishu"]')
    await card.get('[data-testid="channel-manage"]').trigger('click')
    expect(card.get('[data-testid="channel-hint"]').text()).toContain('@mention')
    await card.get('form').trigger('submit')
    await flushPromises()
    expect(mock.sent.some((s) => s.type === 'channels.quick_add' || s.type === 'channels.configure')).toBe(false)
    expect(card.text()).toContain('Fill in')
    await card.get('input[name="app_id"]').setValue('cli_x')
    await card.get('input[name="app_secret"]').setValue('s3cret')
    await card.get('form').trigger('submit')
    await flushPromises()
    // Feishu's link guide has no link to open: no invite is asked for, the guide shows once connected.
    expect(mock.sent.find((s) => s.type === 'channels.quick_add')?.payload).toEqual({
      platform: 'feishu',
      config: { domain: 'feishu' },
      secret: { app_id: 'cli_x', app_secret: 's3cret' },
    })
    expect(mock.sent.some((s) => s.type === 'channels.configure')).toBe(false)
    expect(card.find('form').exists()).toBe(false)
    expect(card.find('[data-testid="channel-quick-steps"]').exists()).toBe(false)
  })

  it('sends an empty secret for iMessage, which has no token', async () => {
    const w = await render()
    const card = w.get('[data-platform="imessage"]')
    await card.get('[data-testid="channel-manage"]').trigger('click')
    await card.get('form').trigger('submit')
    await flushPromises()
    expect(mock.sent.find((s) => s.type === 'channels.configure')?.payload).toEqual({
      platform: 'imessage',
      config: {},
      secret: {},
    })
  })

  it('approves and rejects pairing requests and removes allowlist entries', async () => {
    const w = await render()
    await w.get('[data-testid="pairing-approve"]').trigger('click')
    await flushPromises()
    expect(mock.sent.find((s) => s.type === 'channels.pairing.approve')?.payload).toEqual({ platform: 'telegram', code: 'K7Q2M9XA' })
    await w.get('[data-testid="pairing-reject"]').trigger('click')
    await flushPromises()
    expect(mock.sent.find((s) => s.type === 'channels.pairing.reject')?.payload).toEqual({ platform: 'telegram', code: 'K7Q2M9XA' })
    await w.get('[data-testid="allow-remove"]').trigger('click')
    await flushPromises()
    expect(mock.sent.find((s) => s.type === 'channels.allow.remove')?.payload).toEqual({ platform: 'telegram', sender_id: '7' })
  })

  it('a single bot names no bot on pairing requests or allowed senders', async () => {
    const w = await render()
    expect(w.find('[data-testid="pairing-bot"]').exists()).toBe(false)
    expect(w.find('[data-testid="allow-bot"]').exists()).toBe(false)
    expect(w.get('[data-testid="allow-row"]').text()).toContain('Telegram · 7')
  })

  it('the kill switch turns every channel off', async () => {
    const w = await render()
    await w.get('[data-testid="channels-global-toggle"]').trigger('click')
    await flushPromises()
    expect(mock.sent.find((s) => s.type === 'channels.set_global_enabled')?.payload).toEqual({ enabled: false })
  })

  it('has no permission-relay switch: the relay is always on', async () => {
    const w = await render()
    const tg = w.get('[data-platform="telegram"]')
    await tg.get('[data-testid="channel-manage"]').trigger('click')
    expect(tg.find('[data-testid="channel-relay"]').exists()).toBe(false)
  })

  describe('several bots on one platform', () => {
    const ready = { lifecycle: 'ready', connected: true, identity: '' }

    function seedTwoBots(): void {
      mock.setResponse('channels.list', {
        ok: true,
        enabled: true,
        platforms: [{
          platform: 'telegram', configured: true, enabled: true, status: { ...ready, identity: '@main_bot' }, config: {}, capabilities: null,
          accounts: [
            { account: 'default', name: '', configured: true, enabled: true, status: { ...ready, identity: '@main_bot' }, config: {}, capabilities: null },
            { account: 'bot-b1', name: 'Ops', configured: true, enabled: false, status: { ...ready, lifecycle: 'stopped', connected: false }, config: { name: 'Ops' }, capabilities: null },
          ],
        }],
      })
      mock.setResponse('channels.bindings', {
        ok: true,
        bindings: [
          { pane_id: 'p1', platform: 'telegram', account: 'bot-b1', chat_id: '-1', thread_id: '', title: 'a' },
          { pane_id: 'p2', platform: 'telegram', account: 'bot-b1', chat_id: '-2', thread_id: '', title: 'b' },
          { pane_id: 'p3', platform: 'telegram', account: 'default', chat_id: '-3', thread_id: '', title: 'c' },
        ],
      })
      mock.setResponse('channels.locations', { ok: true, locations: [] })
    }

    const bot = (w: VueWrapper, account: string) => w.get(`[data-platform="telegram"] [data-account="${account}"]`)

    it('lists every bot under its platform with its own status and switch', async () => {
      seedTwoBots()
      const w = await render()
      expect(w.findAll('[data-platform="telegram"] [data-testid="channel-bot"]').map((b) => b.attributes('data-account')))
        .toEqual(['default', 'bot-b1'])
      expect(bot(w, 'default').get('[data-testid="channel-bot-name"]').text()).toBe('Main bot')
      expect(bot(w, 'default').get('[data-testid="channel-status"]').text()).toBe('Connected @main_bot')
      expect(bot(w, 'bot-b1').get('[data-testid="channel-bot-name"]').text()).toBe('Ops')
      expect(bot(w, 'bot-b1').get('[data-testid="channel-status"]').text()).toBe('Off')
      await bot(w, 'bot-b1').get('button[role="switch"]').trigger('click')
      await flushPromises()
      expect(mock.sent.find((s) => s.type === 'channels.set_enabled')?.payload).toEqual({
        platform: 'telegram', account: 'bot-b1', enabled: true,
      })
    })

    it('adds a bot with its own id, name (under Advanced) and token', async () => {
      seedTwoBots()
      mock.setResponse('channels.quick_add', { ok: false, error: 'nope', reason: 'invalid' })
      const w = await render()
      await w.get('[data-platform="telegram"] [data-testid="channel-add-bot"]').trigger('click')
      const added = w.findAll('[data-platform="telegram"] [data-testid="channel-bot"]')[2]
      expect(added.attributes('data-account')).toMatch(/^bot-[0-9a-f]{6}$/)
      await added.get('form').trigger('submit')
      await flushPromises()
      expect(mock.sent.some((s) => s.type === 'channels.quick_add')).toBe(false)
      expect(added.text()).toContain('Fill in')
      expect(added.get('[data-testid="channel-advanced"]').find('input[name="name"]').exists()).toBe(true)
      await added.get('input[name="name"]').setValue('  Night shift ')
      await added.get('input[name="token"]').setValue('123:abc')
      await added.get('form').trigger('submit')
      await flushPromises()
      expect(mock.sent.find((s) => s.type === 'channels.quick_add')?.payload).toEqual({
        platform: 'telegram', account: added.attributes('data-account'),
        config: { name: 'Night shift' }, secret: { token: '123:abc' }, link_target: 'direct',
      })
      expect(mock.sent.some((s) => s.type === 'channels.configure')).toBe(false)
    })

    it('renames a bot without touching its credential', async () => {
      seedTwoBots()
      const w = await render()
      await bot(w, 'bot-b1').get('[data-testid="channel-rename"]').trigger('click')
      await bot(w, 'bot-b1').get('input[name="bot-name"]').setValue('Night shift')
      await bot(w, 'bot-b1').get('.ch-rename').trigger('submit')
      await flushPromises()
      expect(mock.sent.find((s) => s.type === 'channels.rename_account')?.payload).toEqual({
        platform: 'telegram', account: 'bot-b1', name: 'Night shift',
      })
      expect(mock.sent.some((s) => s.type === 'channels.configure')).toBe(false)
    })

    it('removes one bot only after confirming, naming how many panes it disconnects', async () => {
      seedTwoBots()
      const w = await render()
      await bot(w, 'bot-b1').get('[data-testid="channel-manage"]').trigger('click')
      await bot(w, 'bot-b1').get('[data-testid="channel-remove"]').trigger('click')
      expect(mock.sent.some((s) => s.type === 'channels.remove')).toBe(false)
      expect(bot(w, 'bot-b1').get('[data-testid="channel-remove-ask"]').text()).toContain('2 pane(s)')
      await bot(w, 'bot-b1').get('[data-testid="channel-remove-confirm"]').trigger('click')
      await flushPromises()
      expect(mock.sent.find((s) => s.type === 'channels.remove')?.payload).toEqual({ platform: 'telegram', account: 'bot-b1' })
    })

    it('names the bot of each pairing request and allowed sender, and removes per bot', async () => {
      seedTwoBots()
      mock.setResponse('channels.pairing.list', {
        ok: true,
        requests: [{ platform: 'telegram', account: 'bot-b1', code: 'K7Q2M9XA', sender_id: '42', sender_name: 'neil', created_at: 1 }],
      })
      mock.setResponse('channels.allow.list', {
        ok: true,
        entries: [
          { platform: 'telegram', account: 'default', sender_id: '7', sender_name: 'amy', added_at: 1 },
          { platform: 'telegram', account: 'bot-b1', sender_id: '8', sender_name: 'bob', added_at: 2 },
        ],
      })
      const w = await render()
      expect(w.get('[data-testid="pairing-bot"]').text()).toBe('Ops')
      expect(w.findAll('[data-testid="allow-bot"]').map((e) => e.text())).toEqual(['Main bot', 'Ops'])
      await w.findAll('[data-testid="allow-remove"]')[1].trigger('click')
      await flushPromises()
      expect(mock.sent.find((s) => s.type === 'channels.allow.remove')?.payload).toEqual({
        platform: 'telegram', sender_id: '8', account: 'bot-b1',
      })
    })

    it('removing the only bot removes the platform, as before', async () => {
      const w = await render()
      const tg = w.get('[data-platform="telegram"]')
      await tg.get('[data-testid="channel-manage"]').trigger('click')
      await tg.get('[data-testid="channel-remove"]').trigger('click')
      await tg.get('[data-testid="channel-remove-confirm"]').trigger('click')
      await flushPromises()
      expect(mock.sent.find((s) => s.type === 'channels.remove')?.payload).toEqual({ platform: 'telegram' })
    })
  })

  describe('linking guide on a connected card', () => {
    function seedConnected(locations: Record<string, unknown>[]): void {
      mock.setResponse('channels.list', {
        ok: true,
        enabled: true,
        platforms: [{
          platform: 'telegram', configured: true, enabled: true,
          status: { lifecycle: 'ready', connected: true, identity: '@navide_bot' }, config: {}, capabilities: null,
        }],
      })
      mock.setResponse('channels.pairing.list', { ok: true, requests: [] })
      mock.setResponse('channels.locations', { ok: true, locations })
    }

    it('shows the next step while the bot knows no chat', async () => {
      seedConnected([])
      const w = await render()
      const tg = w.get('[data-platform="telegram"]')
      expect(tg.get('[data-testid="channel-next-step"]').text()).toBe('Next: link your chat account')
      expect(tg.findAll('[data-testid="channel-link-action"]').map((a) => a.text())).toEqual(['Open in Telegram (DM)', 'Add to a group'])
      // Platforms that are not connected get no guide.
      expect(w.get('[data-platform="slack"]').find('[data-testid="channel-link-block"]').exists()).toBe(false)
    })

    it('shows why the chats could not be loaded, and retries', async () => {
      seedConnected([])
      mock.setResponse('channels.locations', { ok: false, error: 'adapter exploded' })
      const w = await render()
      const tg = w.get('[data-platform="telegram"]')
      expect(tg.get('[data-testid="channel-link-block"] [role="alert"]').text()).toContain('adapter exploded')
      mock.setResponse('channels.locations', { ok: true, locations: [] })
      await tg.get('[data-testid="channel-link-retry"]').trigger('click')
      await flushPromises()
      expect(tg.find('[role="alert"]').exists()).toBe(false)
      expect(tg.get('[data-testid="channel-next-step"]').text()).toBe('Next: link your chat account')
    })

    it('collapses to a summary once a chat is linked, with a button to link another', async () => {
      seedConnected([])
      const w = await render()
      mock.setResponse('channels.locations', { ok: true, locations: [{ chat_id: '42', title: 'neil', kind: 'private', supports_topics: false }] })
      mock.emit('channels.linked', { platform: 'telegram', chat_id: '42', title: 'neil', kind: 'direct' })
      await flushPromises()
      const tg = w.get('[data-platform="telegram"]')
      expect(tg.find('[data-testid="channel-next-step"]').exists()).toBe(false)
      expect(tg.get('[data-testid="channel-linked-summary"]').text()).toContain('1 chat(s) linked')
      expect(tg.find('[data-testid="channel-link-guide"]').exists()).toBe(false)
      mock.setResponse('channels.link.create', { ok: true, code: 'ABCD2345', target: 'group', expires_at: Date.now() / 1000 + 600, url: null })
      await tg.get('[data-testid="channel-link-account"]').trigger('click')
      await tg.findAll('[data-testid="channel-link-action"]')[1].trigger('click')
      await flushPromises()
      expect(mock.sent.find((m) => m.type === 'channels.link.create')?.payload).toEqual({ platform: 'telegram', target: 'group' })
      expect(tg.get('[data-testid="channel-link-code"]').text()).toBe('/start ABCD2345')
    })
  })

  describe('quick add', () => {
    // Made up, and assembled at runtime so secret scanners do not flag it.
    const TG_TOKEN = ['123456789', ['AAHk3x', 'ZyQwErTyUiOpAsDfGhJkLzXcVbNm'].join('-')].join(':')
    const expires = () => Date.now() / 1000 + 600

    /** Telegram (or `platform`) not set up yet, with nothing else configured. */
    function seedEmpty(): void {
      mock.setResponse('channels.list', { ok: true, enabled: true, platforms: [] })
      mock.setResponse('channels.pairing.list', { ok: true, requests: [] })
      mock.setResponse('channels.allow.list', { ok: true, entries: [] })
    }

    /** After the quick add: the backend lists the bot connected, knowing no chat yet. */
    function seedAdded(platform: string, identity: string): void {
      mock.setResponse('channels.list', {
        ok: true,
        enabled: true,
        platforms: [{
          platform, configured: true, enabled: true,
          status: { lifecycle: 'ready', connected: true, identity }, config: { name: identity }, capabilities: null,
          accounts: [{
            account: 'default', name: identity, configured: true, enabled: true,
            status: { lifecycle: 'ready', connected: true, identity }, config: { name: identity }, capabilities: null,
          }],
        }],
      })
      mock.setResponse('channels.locations', { ok: true, locations: [] })
    }

    /** Hold `channels.quick_add` until the returned release() is called. */
    function holdQuickAdd(): () => void {
      const send = mock.backend.send
      let release!: () => void
      const gate = new Promise<void>((r) => { release = r })
      ;(mock.backend as { send: typeof send }).send = (async (type: string, payload?: Record<string, unknown>, timeoutMs?: number) => {
        if (type === 'channels.quick_add') await gate
        return send(type, payload, timeoutMs)
      }) as typeof send
      return release
    }

    const steps = (card: ReturnType<VueWrapper['get']>) => card.get('[data-testid="channel-quick-steps"]')

    it('Telegram: verifies, opens the deep link, waits for Start, then shows done', async () => {
      seedEmpty()
      clip.text = `  ${TG_TOKEN}\n`
      const w = await render()
      expect(clip.reads).toBe(0) // never read until a button is pressed
      const tg = w.get('[data-platform="telegram"]')
      await tg.get('[data-testid="channel-manage"]').trigger('click')
      await flushPromises()
      expect(clip.reads).toBe(1)
      expect((tg.get('input[name="token"]').element as HTMLInputElement).value).toBe(TG_TOKEN)
      expect(tg.find('[data-testid="channel-save"]').exists()).toBe(false)
      expect(tg.get('[data-testid="channel-quick-add"]').text()).toBe('Quick add')

      const release = holdQuickAdd()
      mock.setResponse('channels.quick_add', {
        ok: true, platform: 'telegram', account: 'default', name: '@quick_bot', identity: '@quick_bot',
        link: { platform: 'telegram', code: 'QK7M2XAB', target: 'direct', expires_at: expires(), url: 'https://t.me/quick_bot?start=QK7M2XAB' },
      })
      await tg.get('form').trigger('submit')
      await flushPromises()
      expect(tg.get('[data-testid="channel-quick-add"]').text()).toBe('Verifying…')
      expect(steps(tg).attributes('data-step')).toBe('verifying')
      expect(steps(tg).get('li.current').text()).toBe('Verifying')

      seedAdded('telegram', '@quick_bot')
      release()
      await flushPromises()
      const sent = mock.sent.find((m) => m.type === 'channels.quick_add')
      expect(sent?.payload).toEqual({ platform: 'telegram', config: {}, secret: { token: TG_TOKEN }, link_target: 'direct' })
      expect(sent?.timeoutMs).toBe(45_000) // outlasts the backend's worst case (see QUICK_ADD_TIMEOUT_MS)
      expect(mock.sent.some((m) => m.type === 'channels.configure' || m.type === 'channels.link.create')).toBe(false)
      expect(openExternal).toHaveBeenCalledWith('https://t.me/quick_bot?start=QK7M2XAB')
      expect(clip.written).toEqual([]) // the deep link carries the code: nothing to paste
      expect(steps(tg).attributes('data-step')).toBe('waiting')
      expect(steps(tg).get('li.current').text()).toBe('Waiting for you to tap Start in the app')
      expect(steps(tg).findAll('li.past').map((l) => l.text())).toEqual(['Verifying', 'Opening Telegram'])
      expect(tg.get('[data-testid="channel-link-code"]').text()).toBe('/start QK7M2XAB')
      expect(tg.get('[data-testid="channel-bot-name"]').text()).toBe('@quick_bot')

      mock.setResponse('channels.locations', { ok: true, locations: [{ chat_id: '42', title: 'neil', kind: 'private', supports_topics: false }] })
      mock.emit('channels.linked', { platform: 'telegram', code: 'QK7M2XAB', chat_id: '42', title: 'neil', kind: 'direct', confirmed: true })
      await flushPromises()
      expect(steps(tg).attributes('data-step')).toBe('done')
      expect(steps(tg).get('li.current').text()).toBe('Done')
      expect(tg.get('[data-testid="channel-linked-summary"]').text()).toContain('1 chat(s) linked')
      expect(openExternal).toHaveBeenCalledTimes(1)
    })

    it('Discord: copies the link command before opening the install link, and says to paste it', async () => {
      seedEmpty()
      const w = await render()
      const dc = w.get('[data-platform="discord"]')
      await dc.get('[data-testid="channel-manage"]').trigger('click')
      await dc.get('input[name="token"]').setValue('discord-token')
      mock.setResponse('channels.quick_add', {
        ok: true, platform: 'discord', account: 'default', name: '@navide', identity: '@navide',
        link: { platform: 'discord', code: 'DC4X7QAB', target: 'group', expires_at: expires(), url: 'https://discord.com/oauth2/authorize?client_id=1' },
      })
      seedAdded('discord', '@navide')
      let copiedBeforeOpen = false
      openExternal.mockImplementationOnce(async () => {
        copiedBeforeOpen = clip.written.includes('link DC4X7QAB')
        return { ok: true }
      })
      await dc.get('form').trigger('submit')
      await flushPromises()
      expect(mock.sent.find((m) => m.type === 'channels.quick_add')?.payload).toMatchObject({ link_target: 'group' })
      expect(copiedBeforeOpen).toBe(true)
      expect(openExternal).toHaveBeenCalledWith('https://discord.com/oauth2/authorize?client_id=1')
      expect(steps(dc).get('li.current').text()).toBe('Waiting for you to paste the link code in the app')
      expect(dc.get('[data-testid="channel-quick-copied"]').text()).toContain('paste it to the bot in Discord')
    })

    it('does not say the code was copied when the clipboard refused it', async () => {
      seedEmpty()
      const w = await render()
      const dc = w.get('[data-platform="discord"]')
      await dc.get('[data-testid="channel-manage"]').trigger('click')
      await dc.get('input[name="token"]').setValue('discord-token')
      mock.setResponse('channels.quick_add', {
        ok: true, platform: 'discord', account: 'default', name: '@navide', identity: '@navide',
        link: { platform: 'discord', code: 'DC4X7QAB', target: 'group', expires_at: expires(), url: 'https://discord.com/oauth2/authorize?client_id=1' },
      })
      seedAdded('discord', '@navide')
      Object.defineProperty(navigator, 'clipboard', {
        value: { readText: async () => '', writeText: async () => { throw new Error('denied') } },
        configurable: true,
      })
      await dc.get('form').trigger('submit')
      await flushPromises()
      expect(openExternal).toHaveBeenCalledWith('https://discord.com/oauth2/authorize?client_id=1')
      expect(steps(dc).attributes('data-step')).toBe('waiting')
      expect(dc.find('[data-testid="channel-quick-copied"]').exists()).toBe(false)
      expect(dc.get('[data-testid="channel-link-code"]').text()).toBe('link DC4X7QAB')
    })

    it('sends one quick add when pressed twice while the clipboard is being read', async () => {
      seedEmpty()
      const w = await render()
      const tg = w.get('[data-platform="telegram"]')
      await tg.get('[data-testid="channel-manage"]').trigger('click')
      await flushPromises()
      let finishRead!: (text: string) => void
      const read = new Promise<string>((r) => { finishRead = r })
      Object.defineProperty(navigator, 'clipboard', {
        value: { readText: () => read, writeText: async () => {} },
        configurable: true,
      })
      mock.setResponse('channels.quick_add', { ok: false, reason: 'invalid', error: 'x' })
      await tg.get('form').trigger('submit')
      await tg.get('form').trigger('submit')
      finishRead(TG_TOKEN)
      await flushPromises()
      expect(mock.sent.filter((m) => m.type === 'channels.quick_add')).toHaveLength(1)
    })

    it('shows why the platform refused the token and keeps the form', async () => {
      seedEmpty()
      const w = await render()
      const tg = w.get('[data-platform="telegram"]')
      await tg.get('[data-testid="channel-manage"]').trigger('click')
      await tg.get('input[name="token"]').setValue(TG_TOKEN)
      mock.setResponse('channels.quick_add', { ok: false, reason: 'rejected', error: 'Unauthorized' })
      await tg.get('form').trigger('submit')
      await flushPromises()
      expect(tg.get('form [role="alert"]').text()).toBe('Telegram rejected the credential: Unauthorized')
      expect(tg.find('[data-testid="channel-quick-steps"]').exists()).toBe(false)
      expect(tg.get('[data-testid="channel-quick-add"]').text()).toBe('Quick add')
      expect(openExternal).not.toHaveBeenCalled()

      mock.setResponse('channels.quick_add', { ok: false, reason: 'timeout', error: 'no answer' })
      await tg.get('form').trigger('submit')
      await flushPromises()
      expect(tg.get('form [role="alert"]').text()).toContain('Telegram did not answer in time')
    })

    it('ignores a clipboard that does not look like the token, and never overwrites a typed one', async () => {
      seedEmpty()
      clip.text = 'my bank password'
      const w = await render()
      const tg = w.get('[data-platform="telegram"]')
      await tg.get('[data-testid="channel-manage"]').trigger('click')
      await flushPromises()
      expect((tg.get('input[name="token"]').element as HTMLInputElement).value).toBe('')
      expect(w.text()).not.toContain('my bank password')
      await tg.get('input[name="token"]').setValue('typed:token')
      clip.text = TG_TOKEN
      mock.setResponse('channels.quick_add', { ok: false, reason: 'invalid', error: 'x' })
      await tg.get('form').trigger('submit')
      await flushPromises()
      expect(mock.sent.find((m) => m.type === 'channels.quick_add')?.payload).toMatchObject({ secret: { token: 'typed:token' } })
    })

    it('fills an empty token from the clipboard when Quick add is pressed', async () => {
      seedEmpty()
      const w = await render()
      const tg = w.get('[data-platform="telegram"]')
      await tg.get('[data-testid="channel-manage"]').trigger('click')
      await flushPromises()
      clip.text = TG_TOKEN
      mock.setResponse('channels.quick_add', { ok: false, reason: 'invalid', error: 'x' })
      await tg.get('form').trigger('submit')
      await flushPromises()
      expect(mock.sent.find((m) => m.type === 'channels.quick_add')?.payload).toMatchObject({ secret: { token: TG_TOKEN } })
    })

    it('Slack: routes xapp- and xoxb- to their own fields and links the manifest template', async () => {
      seedEmpty()
      clip.text = 'xoxb-1234-5678-abcdEFGH'
      const w = await render()
      const sl = w.get('[data-platform="slack"]')
      await sl.get('[data-testid="channel-manage"]').trigger('click')
      await flushPromises()
      expect((sl.get('input[name="bot_token"]').element as HTMLInputElement).value).toBe('xoxb-1234-5678-abcdEFGH')
      expect((sl.get('input[name="app_token"]').element as HTMLInputElement).value).toBe('')
      const link = sl.get('[data-testid="channel-setup-link"]')
      expect(link.text()).toBe('Create the Slack app from a template')
      const url = new URL(link.attributes('href')!)
      expect(url.origin + url.pathname).toBe('https://api.slack.com/apps')
      expect(url.searchParams.get('new_app')).toBe('1')
      const manifest = JSON.parse(url.searchParams.get('manifest_json')!)
      expect(manifest.settings.socket_mode_enabled).toBe(true)
      await link.trigger('click')
      expect(openExternal).toHaveBeenCalledWith(link.attributes('href'))
    })

    it('iMessage keeps its plain save; an existing bot keeps configure', async () => {
      const w = await render()
      const im = w.get('[data-platform="imessage"]')
      await im.get('[data-testid="channel-manage"]').trigger('click')
      expect(im.find('[data-testid="channel-quick-add"]').exists()).toBe(false)
      expect(im.find('[data-testid="channel-save"]').exists()).toBe(true)
      const tg = w.get('[data-platform="telegram"]')
      await tg.get('[data-testid="channel-manage"]').trigger('click')
      expect(tg.find('[data-testid="channel-quick-add"]').exists()).toBe(false)
      expect(tg.find('[data-testid="channel-setup-link"]').exists()).toBe(false)
      expect(clip.reads).toBe(0)
    })
  })
})
