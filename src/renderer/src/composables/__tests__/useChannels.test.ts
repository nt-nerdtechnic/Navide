// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { createMockBackend, flush } from './mockBackend'
import { useChannels } from '../useChannels'

function seed(mock: ReturnType<typeof createMockBackend>): void {
  mock.setResponse('channels.list', {
    ok: true,
    enabled: true,
    platforms: [
      {
        platform: 'telegram',
        configured: true,
        enabled: true,
        status: { lifecycle: 'ready', connected: true, identity: '@navide_bot' },
        config: { permission_relay: false },
        capabilities: { threads: true, create_location: true, edit: true, typing: true, buttons: true, text_limit: 4000 },
      },
    ],
  })
  mock.setResponse('channels.bindings', {
    ok: true,
    bindings: [{ pane_id: 'p1', platform: 'telegram', account: 'a', chat_id: '-100', thread_id: '7', title: 'api-refactor' }],
  })
  mock.setResponse('channels.pairing.list', { ok: true, requests: [] })
  mock.setResponse('channels.allow.list', { ok: true, entries: [] })
}

describe('useChannels', () => {
  it('loads platforms and bindings when connected', async () => {
    const mock = createMockBackend('connected')
    seed(mock)
    const store = useChannels(mock.backend)
    await flush()
    expect(mock.sent.map((s) => s.type)).toEqual(
      expect.arrayContaining(['channels.list', 'channels.bindings', 'channels.pairing.list', 'channels.allow.list'])
    )
    expect(store.platformState('telegram')?.status.identity).toBe('@navide_bot')
    expect(store.platformState('telegram')?.status.last_error).toBe('')
    expect(store.configuredPlatforms.value.map((p) => p.platform)).toEqual(['telegram'])
    expect(store.bindingFor('p1')?.title).toBe('api-refactor')
    expect(store.bindingFor('p2')).toBeNull()
  })

  it('shares one store per backend', () => {
    const mock = createMockBackend('disconnected')
    expect(useChannels(mock.backend)).toBe(useChannels(mock.backend))
  })

  it('waits for the connection before fetching, then fetches on connect', async () => {
    const mock = createMockBackend('disconnected')
    seed(mock)
    const store = useChannels(mock.backend)
    await flush()
    expect(mock.sent).toHaveLength(0)
    mock.status.value = 'connected'
    await flush()
    expect(store.loaded.value).toBe(true)
  })

  it('re-fetches on channels.changed and patches status in place on channels.status', async () => {
    const mock = createMockBackend('connected')
    seed(mock)
    const store = useChannels(mock.backend)
    await flush()
    mock.sent.length = 0
    mock.emit('channels.changed', {})
    await flush()
    expect(mock.sent.some((s) => s.type === 'channels.list')).toBe(true)

    mock.sent.length = 0
    mock.emit('channels.status', { platform: 'telegram', status: { lifecycle: 'blocked', last_error: 'bad token' } })
    expect(store.platformState('telegram')?.status.lifecycle).toBe('blocked')
    expect(store.platformState('telegram')?.status.last_error).toBe('bad token')
    expect(mock.sent).toHaveLength(0)
  })

  it('sends mutations with the contract payloads and reports backend errors', async () => {
    const mock = createMockBackend('connected')
    seed(mock)
    const store = useChannels(mock.backend)
    await flush()

    await store.configure('slack', { permission_relay: false }, { app_token: 'xapp', bot_token: 'xoxb' })
    await store.configure('telegram', { permission_relay: true })
    await store.bind({ pane_id: 'p2', pane_name: 'docs', platform: 'telegram', mode: 'new', chat_id: '-100', title: 'docs' })
    await store.unbind('p1')
    await store.approvePairing('telegram', 'K7Q2M9XA')
    await store.setGlobalEnabled(false)
    const types = mock.sent.map((s) => s.type)
    expect(mock.sent.find((s) => s.type === 'channels.configure')?.payload).toEqual({
      platform: 'slack',
      config: { permission_relay: false },
      secret: { app_token: 'xapp', bot_token: 'xoxb' },
    })
    expect(mock.sent.filter((s) => s.type === 'channels.configure')[1].payload).not.toHaveProperty('secret')
    expect(types).toEqual(expect.arrayContaining(['channels.bind', 'channels.unbind', 'channels.pairing.approve', 'channels.set_global_enabled']))
    expect(mock.sent.find((s) => s.type === 'channels.unbind')?.payload).toEqual({ pane_id: 'p1' })

    mock.setResponse('channels.remove', { ok: false, error: 'nope' })
    expect(await store.remove('telegram')).toEqual({ ok: false, error: 'nope' })
    mock.setRejection('channels.set_enabled', 'ws not open')
    expect(await store.setEnabled('telegram', false)).toEqual({ ok: false, error: 'ws not open' })
  })

  it('releases a binding only for a bound pane that really closed, and carries it over on replacement', async () => {
    const mock = createMockBackend('connected')
    seed(mock)
    const store = useChannels(mock.backend)
    await flush()
    mock.sent.length = 0
    store.paneClosed('unbound-pane')
    store.paneReplaced('unbound-pane', 'p9')
    expect(mock.sent).toHaveLength(0)
    store.paneReplaced('p1', 'p1b')
    store.paneClosed('p1')
    expect(mock.sent).toEqual([
      expect.objectContaining({ type: 'channels.rebind', payload: { from_pane_id: 'p1', to_pane_id: 'p1b' } }),
      expect.objectContaining({ type: 'channels.unbind', payload: { pane_id: 'p1' } }),
    ])
  })

  it('still asks the backend when bindings have not loaded yet', () => {
    const mock = createMockBackend('disconnected')
    const store = useChannels(mock.backend)
    store.paneClosed('p1')
    expect(mock.sent.map((s) => s.type)).toEqual(['channels.unbind'])
  })
})
