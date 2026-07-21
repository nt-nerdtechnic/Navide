// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ExtensionsPane from '../ExtensionsPane.vue'

function mockPlugins(overrides: Record<string, unknown> = {}) {
  const api = {
    listInstalled: vi.fn().mockResolvedValue([
      { id: 'navide.mini-ide', requires: ['fs', 'git', 'terminal'], sensitive: ['fs', 'terminal'] },
    ]),
    marketplaceSearch: vi.fn().mockResolvedValue({
      items: [
        {
          namespace: 'acme',
          name: 'demo',
          identity: 'acme.demo',
          display_name: 'Demo',
          description: null,
          categories: [],
          latest_version: '1.0.0',
          download_count: 0,
          rating_average: 0,
          featured: false,
        },
      ],
      total: 1,
      offset: 0,
      limit: 20,
    }),
    prepareInstall: vi
      .fn()
      .mockResolvedValue({
        id: 'acme.demo',
        version: '1.0.0',
        trustTier: 'unsigned',
        sensitive: [],
        requiresConfirmation: false,
      }),
    commitInstall: vi.fn().mockResolvedValue({ id: 'acme.demo', requires: [] }),
    remove: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  }
  ;(window as unknown as Record<string, unknown>).agentTeam = { plugins: api }
  return api
}

describe('ExtensionsPane', () => {
  let wrapper: VueWrapper | undefined

  afterEach(() => {
    wrapper?.unmount()
    delete (window as unknown as Record<string, unknown>).agentTeam
  })

  it('renders the installed list with sensitive-capability badges', async () => {
    mockPlugins()
    wrapper = mount(ExtensionsPane)
    await flushPromises()
    const row = wrapper.get('[data-id="navide.mini-ide"]')
    expect(row.text()).toContain('navide.mini-ide')
    expect(row.find('.ext-sensitive').exists()).toBe(true)
    expect(row.find('.ext-sensitive').text()).toContain('fs, terminal')
  })

  it('searches the marketplace and installs a non-sensitive plugin directly', async () => {
    const api = mockPlugins()
    wrapper = mount(ExtensionsPane)
    await flushPromises()

    await wrapper.get('.ext-search button').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-id="acme.demo"]').text()).toContain('Demo')

    await wrapper.get('.ext-install').trigger('click')
    await flushPromises()
    expect(api.prepareInstall).toHaveBeenCalledWith({ namespace: 'acme', name: 'demo' })
    // Non-sensitive → commit runs without a confirmation dialog.
    expect(api.commitInstall).toHaveBeenCalledWith('acme.demo')
    expect(wrapper.find('.ext-trust-dialog').exists()).toBe(false)
  })

  it('gates a sensitive install behind a trust confirmation dialog', async () => {
    const api = mockPlugins({
      prepareInstall: vi.fn().mockResolvedValue({
        id: 'acme.demo',
        version: '1.0.0',
        trustTier: 'unsigned',
        sensitive: ['fs'],
        requiresConfirmation: true,
      }),
    })
    wrapper = mount(ExtensionsPane)
    await flushPromises()
    await wrapper.get('.ext-search button').trigger('click')
    await flushPromises()

    await wrapper.get('.ext-install').trigger('click')
    await flushPromises()
    // Dialog is shown and nothing is committed yet.
    expect(wrapper.find('.ext-trust-dialog').exists()).toBe(true)
    expect(api.commitInstall).not.toHaveBeenCalled()

    await wrapper.get('.ext-confirm').trigger('click')
    await flushPromises()
    expect(api.commitInstall).toHaveBeenCalledWith('acme.demo')
    expect(wrapper.find('.ext-trust-dialog').exists()).toBe(false)
  })

  it('shows an unsigned warning (never a verified badge) for an unsigned install', async () => {
    mockPlugins({
      prepareInstall: vi.fn().mockResolvedValue({
        id: 'acme.demo',
        version: '1.0.0',
        trustTier: 'unsigned',
        sensitive: ['fs'],
        requiresConfirmation: true,
      }),
    })
    wrapper = mount(ExtensionsPane)
    await flushPromises()
    await wrapper.get('.ext-search button').trigger('click')
    await flushPromises()
    await wrapper.get('.ext-install').trigger('click')
    await flushPromises()

    const dialog = wrapper.get('.ext-trust-dialog')
    // Unsigned must surface the unsigned/unverified badge and NEVER the verified one.
    expect(dialog.find('.ext-unsigned').exists()).toBe(true)
    expect(dialog.find('.ext-verified').exists()).toBe(false)
    expect(dialog.find('.ext-unsigned').text()).toContain('not cryptographically verified')
  })

  it('shows a verified badge only for a signed-verified install', async () => {
    mockPlugins({
      prepareInstall: vi.fn().mockResolvedValue({
        id: 'acme.demo',
        version: '1.0.0',
        trustTier: 'signed-verified',
        sensitive: ['fs'],
        requiresConfirmation: true,
      }),
    })
    wrapper = mount(ExtensionsPane)
    await flushPromises()
    await wrapper.get('.ext-search button').trigger('click')
    await flushPromises()
    await wrapper.get('.ext-install').trigger('click')
    await flushPromises()

    const dialog = wrapper.get('.ext-trust-dialog')
    expect(dialog.find('.ext-verified').exists()).toBe(true)
    expect(dialog.find('.ext-unsigned').exists()).toBe(false)
  })

  it('cancelling the trust dialog does not install', async () => {
    const api = mockPlugins({
      prepareInstall: vi.fn().mockResolvedValue({
        id: 'acme.demo',
        version: '1.0.0',
        trustTier: 'unsigned',
        sensitive: ['fs'],
        requiresConfirmation: true,
      }),
    })
    wrapper = mount(ExtensionsPane)
    await flushPromises()
    await wrapper.get('.ext-search button').trigger('click')
    await flushPromises()
    await wrapper.get('.ext-install').trigger('click')
    await flushPromises()

    await wrapper.get('.ext-cancel').trigger('click')
    await flushPromises()
    expect(api.commitInstall).not.toHaveBeenCalled()
    expect(wrapper.find('.ext-trust-dialog').exists()).toBe(false)
  })

  it('removes an installed plugin', async () => {
    const api = mockPlugins()
    wrapper = mount(ExtensionsPane)
    await flushPromises()
    await wrapper.get('[data-id="navide.mini-ide"] .ext-remove').trigger('click')
    await flushPromises()
    expect(api.remove).toHaveBeenCalledWith('navide.mini-ide')
  })
})
