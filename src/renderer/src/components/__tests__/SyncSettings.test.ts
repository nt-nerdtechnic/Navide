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
  return { backend: { send } as never, send }
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
})
