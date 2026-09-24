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
})
afterEach(() => wrapper?.unmount())

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
    expect(sent?.payload).toEqual({ platform: 'telegram', config: { permission_relay: false } })
  })

  it('requires the secret for a new platform and sends it once', async () => {
    const w = await render()
    const card = w.get('[data-platform="feishu"]')
    await card.get('[data-testid="channel-manage"]').trigger('click')
    expect(card.get('[data-testid="channel-hint"]').text()).toContain('@mention')
    await card.get('form').trigger('submit')
    expect(mock.sent.some((s) => s.type === 'channels.configure')).toBe(false)
    expect(card.text()).toContain('Fill in')
    await card.get('input[name="app_id"]').setValue('cli_x')
    await card.get('input[name="app_secret"]').setValue('s3cret')
    await card.get('form').trigger('submit')
    await flushPromises()
    expect(mock.sent.find((s) => s.type === 'channels.configure')?.payload).toEqual({
      platform: 'feishu',
      config: { domain: 'feishu', permission_relay: true },
      secret: { app_id: 'cli_x', app_secret: 's3cret' },
    })
  })

  it('sends an empty secret for iMessage, which has no token', async () => {
    const w = await render()
    const card = w.get('[data-platform="imessage"]')
    await card.get('[data-testid="channel-manage"]').trigger('click')
    await card.get('form').trigger('submit')
    await flushPromises()
    expect(mock.sent.find((s) => s.type === 'channels.configure')?.payload).toEqual({
      platform: 'imessage',
      config: { permission_relay: true },
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

  it('the kill switch turns every channel off', async () => {
    const w = await render()
    await w.get('[data-testid="channels-global-toggle"]').trigger('click')
    await flushPromises()
    expect(mock.sent.find((s) => s.type === 'channels.set_global_enabled')?.payload).toEqual({ enabled: false })
  })

  it('toggles permission relay on a configured platform', async () => {
    const w = await render()
    const tg = w.get('[data-platform="telegram"]')
    await tg.get('[data-testid="channel-manage"]').trigger('click')
    await tg.get('[data-testid="channel-relay"]').trigger('click')
    await flushPromises()
    expect(mock.sent.find((s) => s.type === 'channels.configure')?.payload).toEqual({
      platform: 'telegram',
      config: { permission_relay: true },
    })
  })
})
