// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import MarketplacePane from '../MarketplacePane.vue'
import ExtensionsPane from '../ExtensionsPane.vue'

function mountMarketplace() {
  return mount(MarketplacePane, { global: { plugins: [i18n] } })
}

/** Both plugin pages at once, the way the settings modal keeps them mounted. */
const PluginPages = defineComponent({
  setup() {
    return () => h('div', [h(MarketplacePane), h(ExtensionsPane)])
  },
})

function mockPlugins(overrides: Record<string, unknown> = {}) {
  const api = {
    listInstalled: vi.fn().mockResolvedValue([]),
    listFactoryPackages: vi.fn().mockResolvedValue([]),
    restoreFactoryPackage: vi.fn().mockResolvedValue({ ok: true }),
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
        containsBackendExecutable: false,
        requiresConfirmation: false,
      }),
    commitInstall: vi.fn().mockResolvedValue({ id: 'acme.demo', requires: [] }),
    remove: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  }
  ;(window as unknown as Record<string, unknown>).agentTeam = { plugins: api }
  return api
}

describe('MarketplacePane', () => {
  let wrapper: VueWrapper | undefined

  afterEach(() => {
    wrapper?.unmount()
    delete (window as unknown as Record<string, unknown>).agentTeam
  })

  it('searches the marketplace and installs a non-sensitive plugin directly', async () => {
    const api = mockPlugins()
    wrapper = mountMarketplace()
    await flushPromises()

    await wrapper.get('.ext-search button').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-id="acme.demo"]').text()).toContain('Demo')

    await wrapper.get('.ext-install').trigger('click')
    await flushPromises()
    expect(api.prepareInstall).toHaveBeenCalledWith({ namespace: 'acme', name: 'demo' })
    // Non-sensitive → commit runs without a confirmation dialog.
    expect(api.commitInstall).toHaveBeenCalledWith('acme.demo', {})
    expect(wrapper.find('.ext-trust-dialog').exists()).toBe(false)
  })

  it('shows a committed install in the Extensions inventory without remounting it', async () => {
    // The two pages are separate components; the inventory they read is not.
    // Before the split this was free — one component held both lists — so this
    // is the case that would silently break: install succeeds, no error, and
    // the Extensions page still shows "No plugins installed".
    const api = mockPlugins({
      listInstalled: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValue([{ id: 'acme.demo', requires: [], sensitive: [] }]),
    })
    wrapper = mount(PluginPages, { global: { plugins: [i18n] } })
    await flushPromises()
    expect(wrapper.find('[data-id="acme.demo"]').exists()).toBe(false)
    expect(wrapper.get('.ext-empty').text()).toContain('No plugins installed')

    await wrapper.get('.ext-search button').trigger('click')
    await flushPromises()
    await wrapper.get('.ext-install').trigger('click')
    await flushPromises()

    expect(api.commitInstall).toHaveBeenCalledWith('acme.demo', {})
    expect(wrapper.get('[data-id="acme.demo"]').text()).toContain('acme.demo')
    expect(wrapper.find('.ext-empty').exists()).toBe(false)
  })

  it('gates a sensitive install behind a trust confirmation dialog', async () => {
    const api = mockPlugins({
      prepareInstall: vi.fn().mockResolvedValue({
        id: 'acme.demo',
        version: '1.0.0',
        trustTier: 'unsigned',
        sensitive: ['fs'],
        containsBackendExecutable: false,
        requiresConfirmation: true,
      }),
    })
    wrapper = mountMarketplace()
    await flushPromises()
    await wrapper.get('.ext-search button').trigger('click')
    await flushPromises()

    await wrapper.get('.ext-install').trigger('click')
    await flushPromises()
    // Dialog is shown and nothing is committed yet.
    expect(wrapper.find('.ext-trust-dialog').exists()).toBe(true)
    expect(api.commitInstall).not.toHaveBeenCalled()

    await wrapper.get('.ext-confirm-risk').trigger('click')
    await flushPromises()
    expect(api.commitInstall).toHaveBeenCalledWith('acme.demo', {
      publisherConfirmed: false,
      riskConfirmed: true,
    })
    expect(wrapper.find('.ext-trust-dialog').exists()).toBe(false)
  })

  it('keeps publisher consent separate from capability and backend risk approval', async () => {
    const api = mockPlugins({
      prepareInstall: vi.fn().mockResolvedValue({
        id: 'acme.demo',
        version: '1.0.0',
        publisherId: 'acme',
        trustTier: 'signed-verified',
        sensitive: ['fs'],
        containsBackendExecutable: false,
        requiresConfirmation: true,
        requiresPublisherTrust: true,
        requiresRiskConfirmation: true,
      }),
    })
    wrapper = mountMarketplace()
    await flushPromises()
    await wrapper.get('.ext-search button').trigger('click')
    await flushPromises()
    await wrapper.get('.ext-install').trigger('click')
    await flushPromises()

    expect(wrapper.get('.ext-publisher-risk').text()).toContain('acme')
    expect(api.commitInstall).not.toHaveBeenCalled()
    await wrapper.get('.ext-confirm-publisher').trigger('click')
    await flushPromises()
    expect(wrapper.find('.ext-backend-risk').exists()).toBe(false)
    expect(wrapper.text()).toContain('requests sensitive capabilities')
    expect(api.commitInstall).not.toHaveBeenCalled()

    await wrapper.get('.ext-confirm-risk').trigger('click')
    await flushPromises()
    expect(api.commitInstall).toHaveBeenCalledWith('acme.demo', {
      publisherConfirmed: true,
      riskConfirmed: true,
    })
  })

  it('shows an unsigned warning (never a verified badge) for an unsigned install', async () => {
    mockPlugins({
      prepareInstall: vi.fn().mockResolvedValue({
        id: 'acme.demo',
        version: '1.0.0',
        trustTier: 'unsigned',
        sensitive: ['fs'],
        containsBackendExecutable: false,
        requiresConfirmation: true,
      }),
    })
    wrapper = mountMarketplace()
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
        containsBackendExecutable: false,
        requiresConfirmation: true,
      }),
    })
    wrapper = mountMarketplace()
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
        containsBackendExecutable: false,
        requiresConfirmation: true,
      }),
    })
    wrapper = mountMarketplace()
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

  it('warns about a backend executable even when permissions are empty', async () => {
    const api = mockPlugins({
      prepareInstall: vi.fn().mockResolvedValue({
        id: 'acme.demo',
        version: '1.0.0',
        trustTier: 'signed-verified',
        sensitive: [],
        containsBackendExecutable: true,
        requiresConfirmation: true,
      }),
    })
    wrapper = mountMarketplace()
    await flushPromises()
    await wrapper.get('.ext-search button').trigger('click')
    await flushPromises()
    await wrapper.get('.ext-install').trigger('click')
    await flushPromises()

    const dialog = wrapper.get('.ext-trust-dialog')
    expect(dialog.get('.ext-backend-risk').text()).toContain('native backend executable')
    expect(dialog.text()).not.toContain('requests sensitive capabilities')
    expect(api.commitInstall).not.toHaveBeenCalled()

    await dialog.get('.ext-confirm-risk').trigger('click')
    await flushPromises()
    expect(api.commitInstall).toHaveBeenCalledWith('acme.demo', {
      publisherConfirmed: false,
      riskConfirmed: true,
    })
  })
})
