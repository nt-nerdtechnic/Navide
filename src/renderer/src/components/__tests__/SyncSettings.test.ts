// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import SyncSettings from '../SyncSettings.vue'

const conflict = {
  scope: 'prompts',
  itemId: 'p1',
  local: { id: 'p1', prompt: 'mine' },
  remote: { id: 'p1', prompt: 'theirs' },
  remoteRev: 4,
  remoteDevice: 'laptop',
  seenAt: 1,
}

function mockBackend(overrides: Record<string, unknown> = {}) {
  const responses: Record<string, unknown> = {
    'sync.status': {
      ok: true,
      payload: {
        available: ['prompts', 'mcp', 'skills', 'memory'],
        scopes: { prompts: false, mcp: false, skills: false, memory: false },
        hasKey: true,
        conflicts: 0,
        link: { state: 'connected' },
      },
    },
    'sync.conflicts': { ok: true, payload: { conflicts: [] } },
    'sync.set_scope': {
      ok: true,
      payload: { scopes: { prompts: true, mcp: false, skills: false, memory: false } },
    },
    'sync.now': { ok: true, payload: { results: [] } },
    'sync.resolve': { ok: true, payload: { ok: true, conflicts: [] } },
    ...overrides,
  }
  const send = vi.fn(async (type: string, _payload?: unknown) => responses[type])
  const handlers = new Map<string, Set<(payload: unknown) => void>>()
  const on = vi.fn((type: string, fn: (payload: unknown) => void) => {
    if (!handlers.has(type)) handlers.set(type, new Set())
    handlers.get(type)!.add(fn)
    return () => handlers.get(type)?.delete(fn)
  })
  const emit = (type: string, payload: unknown) => handlers.get(type)?.forEach((fn) => fn(payload))
  return { backend: { send, on } as never, send, on, emit, handlers }
}

describe('SyncSettings', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    i18n.global.locale.value = 'en-US'
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    vi.restoreAllMocks()
  })

  it('lists every scope with its switch off until someone turns it on', async () => {
    const { backend } = mockBackend()
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    const switches = wrapper.findAll('button[role="switch"]')
    expect(switches).toHaveLength(4)
    expect(switches.every((s) => s.attributes('aria-checked') === 'false')).toBe(true)
  })

  it('turning a scope on sends exactly that scope', async () => {
    const { backend, send } = mockBackend()
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    await wrapper.findAll('button[role="switch"]')[0].trigger('click')
    await flushPromises()

    expect(send).toHaveBeenCalledWith('sync.set_scope', { scope: 'prompts', enabled: true })
  })

  it('shows both sides of a conflict and offers neither as the default', async () => {
    const { backend } = mockBackend({
      'sync.conflicts': { ok: true, payload: { conflicts: [conflict] } },
    })
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    const text = wrapper.text()
    expect(text).toContain('mine')
    expect(text).toContain('theirs')
    expect(text).toContain('laptop')
    // Two buttons, one per side: nothing is pre-selected for the user.
    const sides = wrapper.findAll('.sync-conflict-side button')
    expect(sides).toHaveLength(2)
  })

  it('answering a conflict says which side to keep', async () => {
    const { backend, send } = mockBackend({
      'sync.conflicts': { ok: true, payload: { conflicts: [conflict] } },
    })
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    await wrapper.findAll('.sync-conflict-side button')[1].trigger('click')
    await flushPromises()

    expect(send).toHaveBeenCalledWith('sync.resolve', {
      scope: 'prompts',
      itemId: 'p1',
      keep: 'remote',
    })
  })

  it('says "not connected" rather than looking broken when the link is down', async () => {
    const { backend } = mockBackend({
      'sync.status': {
        ok: true,
        payload: {
          available: ['prompts'],
          scopes: { prompts: true },
          hasKey: true,
          conflicts: 0,
          link: { state: 'unreachable' },
        },
      },
    })
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    expect(wrapper.find('.sync-note').text()).toContain('Not connected')
    expect(wrapper.find('.err-msg').exists()).toBe(false)
  })

  it('a connected device with no key says so instead of silently syncing nothing', async () => {
    const { backend } = mockBackend({
      'sync.status': {
        ok: true,
        payload: {
          available: ['prompts'],
          scopes: { prompts: true },
          hasKey: false,
          conflicts: 0,
          link: { state: 'connected' },
        },
      },
    })
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    expect(wrapper.find('.sync-note').text()).toContain('no sync key')
  })

  // The credentials adapter is complete and tested but its review is not, and
  // it is the one scope that puts a CLI credential on the wire. Holding it out
  // of READY is the whole gate: the Accounts pane reads the cloud side only
  // while `scopes.credentials` is on, so a scope that cannot be switched on
  // leaves nothing downstream able to reach a credential either. Re-adding it
  // to READY without finishing that review is what this test exists to catch.
  it('lists credentials but does not let it be turned on', async () => {
    const { backend, send } = mockBackend({
      'sync.status': {
        ok: true,
        payload: {
          available: ['prompts', 'mcp', 'skills', 'memory', 'credentials'],
          scopes: { prompts: false, mcp: false, skills: false, memory: false, credentials: false },
          hasKey: true,
          conflicts: 0,
          link: { state: 'connected' },
        },
      },
    })
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    const switches = wrapper.findAll('button[role="switch"]')
    expect(switches).toHaveLength(5)
    // Still listed, so the section does not silently disappear…
    expect(wrapper.text()).toContain('Credentials')
    // …but described as unavailable rather than by what it would sync.
    expect(wrapper.text()).toContain('Not syncable yet.')
    expect(wrapper.text()).not.toContain('never removes it from the cloud')
    expect(switches[4].attributes('disabled')).toBeDefined()

    await switches[4].trigger('click')
    await flushPromises()
    expect(send).not.toHaveBeenCalledWith('sync.set_scope', {
      scope: 'credentials',
      enabled: true,
    })
  })

  // K-2: a credentials switch left on by an older build used to show ON and
  // disabled, so it could never be switched off. Off must stay reachable;
  // on must stay unreachable.
  it('lets a credentials switch left on be turned off, and never back on', async () => {
    const { backend, send } = mockBackend({
      'sync.status': {
        ok: true,
        payload: {
          available: ['prompts', 'credentials'],
          scopes: { prompts: false, credentials: true },
          hasKey: true,
          conflicts: 0,
          link: { state: 'connected' },
        },
      },
      'sync.set_scope': { ok: true, payload: { scopes: { prompts: false, credentials: false } } },
    })
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    let creds = wrapper.findAll('button[role="switch"]')[1]
    expect(creds.attributes('aria-checked')).toBe('true')
    expect(creds.attributes('disabled')).toBeUndefined()
    await creds.trigger('click')
    await flushPromises()
    expect(send).toHaveBeenCalledWith('sync.set_scope', { scope: 'credentials', enabled: false })

    creds = wrapper.findAll('button[role="switch"]')[1]
    expect(creds.attributes('aria-checked')).toBe('false')
    expect(creds.attributes('disabled')).toBeDefined()
    await creds.trigger('click')
    await flushPromises()
    expect(send).not.toHaveBeenCalledWith('sync.set_scope', {
      scope: 'credentials',
      enabled: true,
    })
  })

  it('still lets the four reviewed scopes be turned on', async () => {
    const { backend, send } = mockBackend({
      'sync.status': {
        ok: true,
        payload: {
          available: ['prompts', 'mcp', 'skills', 'memory', 'credentials'],
          scopes: { prompts: false, mcp: false, skills: false, memory: false, credentials: false },
          hasKey: true,
          conflicts: 0,
          link: { state: 'connected' },
        },
      },
    })
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    const switches = wrapper.findAll('button[role="switch"]')
    for (const [index, scope] of ['prompts', 'mcp', 'skills', 'memory'].entries()) {
      expect(switches[index].attributes('disabled')).toBeUndefined()
      await switches[index].trigger('click')
      await flushPromises()
      expect(send).toHaveBeenCalledWith('sync.set_scope', { scope, enabled: true })
    }
  })

  it('shows a sealed conflict by slot, never by content', async () => {
    const { backend } = mockBackend({
      'sync.conflicts': {
        ok: true,
        payload: {
          conflicts: [
            {
              scope: 'credentials',
              itemId: 'c-0123456789abcdef0123456789abcdef',
              local: { agentKey: 'claude', slotId: '__default__' },
              remote: { sealed: true },
              remoteRev: 7,
              remoteDevice: 'laptop',
              seenAt: 1,
              sealed: true,
            },
          ],
        },
      },
    })
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    const bodies = wrapper.findAll('.sync-side-body').map((b) => b.text())
    expect(bodies).toEqual(['claude / __default__', '(credential — not shown)'])
    expect(wrapper.text()).not.toContain('agentKey')
    expect(wrapper.findAll('.sync-conflict-side button')).toHaveLength(2)
  })

  // C-3: an MCP record carries its secrets in env and headers; a conflict
  // preview names them but never shows their values, in the text or the hover.
  it('masks MCP env and header values in a conflict preview', async () => {
    const { backend } = mockBackend({
      'sync.conflicts': {
        ok: true,
        payload: {
          conflicts: [
            {
              scope: 'mcp',
              itemId: 'github',
              local: { name: 'github', command: 'npx', env: { GITHUB_TOKEN: 'ghp_localsecret' } },
              remote: {
                name: 'github',
                url: 'https://x.example',
                headers: { Authorization: 'Bearer remotesecret' },
              },
              remoteRev: 2,
              remoteDevice: 'laptop',
              seenAt: 1,
            },
          ],
        },
      },
    })
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    const html = wrapper.html()
    expect(html).not.toContain('ghp_localsecret')
    expect(html).not.toContain('remotesecret')
    expect(wrapper.text()).toContain('GITHUB_TOKEN')
    expect(wrapper.text()).toContain('Authorization')
    expect(wrapper.text()).toContain('npx')
  })

  // X-5: "Sync now" used to look only at resp.ok, so a scope that failed,
  // was skipped or left items behind looked exactly like one that synced.
  it('shows what each scope did after "Sync now", not only that the call returned', async () => {
    const { backend } = mockBackend({
      'sync.now': {
        ok: true,
        payload: {
          results: [
            { scope: 'prompts', error: 'server said no' },
            { scope: 'mcp', skipped: 'no-key' },
            {
              scope: 'skills',
              pulled: 1,
              pushed: 2,
              conflicts: 0,
              held: ['waiting-skill'],
              refused: ['refused-skill'],
              tooLarge: ['huge-skill'],
            },
            { scope: 'memory', skipped: 'disabled' },
          ],
        },
      },
    })
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    await wrapper.get('.sync-actions button').trigger('click')
    await flushPromises()

    const rows = wrapper.findAll('.sync-result')
    // A switched-off scope says nothing: off is the default, not news.
    expect(rows).toHaveLength(3)
    expect(rows[0].text()).toContain('Prompts')
    expect(rows[0].text()).toContain('server said no')
    expect(rows[0].find('.sync-result-error').exists()).toBe(true)
    expect(rows[1].text()).toContain('no sync key')
    expect(rows[2].text()).toContain('Pulled 1, pushed 2')
    expect(rows[2].text()).toContain('waiting-skill')
    expect(rows[2].text()).toContain('refused-skill')
    expect(rows[2].text()).toContain('huge-skill')
  })

  it('says "not connected" when Sync now could not reach the server', async () => {
    const { backend } = mockBackend({
      'sync.now': { ok: true, payload: { results: [{ scope: 'all', skipped: 'not-connected' }] } },
    })
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    await wrapper.get('.sync-actions button').trigger('click')
    await flushPromises()

    const rows = wrapper.findAll('.sync-result')
    expect(rows).toHaveLength(1)
    expect(rows[0].text()).toContain('All sections')
    expect(rows[0].text()).toContain('not connected')
  })

  it('shows each scope\'s last result from sync.status on open', async () => {
    const { backend } = mockBackend({
      'sync.status': {
        ok: true,
        payload: {
          available: ['prompts', 'memory'],
          scopes: { prompts: true, memory: true },
          hasKey: true,
          link: { state: 'connected' },
          last: {
            prompts: { scope: 'prompts', ok: true, pulled: 3, pushed: 0, conflicts: 0, at: 1 },
            memory: { scope: 'memory', ok: true, pulled: 0, pushed: 0, tooLarge: ['CLAUDE.md'] },
          },
        },
      },
    })
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    const rows = wrapper.findAll('.sync-result')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('Pulled 3, pushed 0')
    expect(rows[1].text()).toContain('CLAUDE.md')
  })

  // A round the backend runs on its own (after a local save, on reconnect)
  // must show up without reopening Settings.
  it('updates live on sync.result and reloads the conflicts', async () => {
    const { backend, send, emit, handlers } = mockBackend()
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()
    const conflictLoads = () => send.mock.calls.filter(([type]) => type === 'sync.conflicts').length
    const before = conflictLoads()

    emit('sync.result', {
      scope: 'mcp',
      ok: false,
      error: 'page too large',
      pulled: 0,
      pushed: 0,
      conflicts: 1,
      held: [],
      refused: [],
      tooLarge: [],
      at: 2,
    })
    await flushPromises()

    const rows = wrapper.findAll('.sync-result')
    expect(rows).toHaveLength(1)
    expect(rows[0].text()).toContain('MCP')
    expect(rows[0].text()).toContain('page too large')
    expect(conflictLoads()).toBe(before + 1)

    wrapper.unmount()
    wrapper = undefined
    expect(handlers.get('sync.result')?.size ?? 0).toBe(0)
  })

  it('shows the active key by id and rotates only on the second click', async () => {
    const { backend, send } = mockBackend({
      'sync.status': {
        ok: true,
        payload: {
          available: ['prompts'],
          scopes: { prompts: false },
          hasKey: true,
          keyId: 'abcdef0123456789',
          legacyRingPending: false,
          conflicts: 0,
          link: { state: 'connected' },
        },
      },
      'sync.rotate_key': { ok: true, payload: { keyId: 'fedcba9876543210', results: [] } },
    })
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    const row = wrapper.get('.sync-key-row')
    expect(row.text()).toContain('abcdef01')
    expect(row.text()).not.toContain('abcdef0123456789') // the id is shortened, and it is only an id
    const rotate = row.findAll('button')[0]
    expect(rotate.text()).toBe('Rotate key')
    await rotate.trigger('click')
    expect(send).not.toHaveBeenCalledWith('sync.rotate_key', {}, 60_000)
    expect(row.findAll('button')[0].text()).toBe('Rotate now')
    await row.findAll('button')[0].trigger('click')
    await flushPromises()
    expect(send).toHaveBeenCalledWith('sync.rotate_key', {}, 60_000)
  })

  it('offers to adopt a key from before accounts were bound, and only then', async () => {
    const { backend, send } = mockBackend({
      'sync.status': {
        ok: true,
        payload: {
          available: ['prompts'],
          scopes: { prompts: false },
          hasKey: false,
          keyId: '',
          legacyRingPending: true,
          conflicts: 0,
          link: { state: 'connected' },
        },
      },
      'sync.adopt_legacy_key': { ok: true, payload: { results: [] } },
    })
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    const legacy = wrapper.get('.sync-key-legacy')
    expect(legacy.text()).toContain('before accounts were bound')
    expect(wrapper.find('.sync-key-row').exists()).toBe(false) // nothing to rotate yet
    await legacy.get('button').trigger('click')
    await flushPromises()
    expect(send).toHaveBeenCalledWith('sync.adopt_legacy_key', {}, 30_000)
  })
})
