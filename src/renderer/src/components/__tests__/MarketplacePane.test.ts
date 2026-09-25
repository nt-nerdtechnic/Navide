// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { i18n, useNotify } from '@navide/plugin-ui/foundation'
import SettingsNavItem from '../settings/SettingsNavItem.vue'
import { usePluginUpdates } from '../../composables/usePluginUpdates'
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

function demoDetail(overrides: Record<string, unknown> = {}) {
  return {
    namespace: 'acme',
    name: 'demo',
    identity: 'acme.demo',
    display_name: 'Demo',
    description: 'A demo extension',
    categories: ['tools'],
    latest_version: '1.1.0',
    updated_at: '2026-09-01T00:00:00Z',
    download_count: 42,
    rating_average: 4.5,
    rating_count: 2,
    featured: false,
    publisher: 'acme',
    host_target: 'darwin-arm64',
    latest_installable_version: '1.1.0',
    versions: [
      {
        version: '1.1.0',
        published_at: '2026-09-01T00:00:00Z',
        target: 'universal',
        yanked: false,
        trust_tier: 'signed-verified',
        capabilities: ['fs', 'ui'],
        sensitive_capabilities: ['fs'],
        download_count: 40,
        installable: true,
      },
      {
        version: '1.0.0',
        published_at: '2026-08-01T00:00:00Z',
        target: 'universal',
        yanked: true,
        trust_tier: 'signed-verified',
        capabilities: [],
        sensitive_capabilities: [],
        download_count: 2,
        installable: true,
      },
    ],
    readme: '# Demo\n\nHello **world**.\n\n<script>window.__pwned = 1</script>\n<img src=x onerror="window.__pwned = 2">',
    ...overrides,
  }
}

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
    checkUpdates: vi.fn().mockResolvedValue([]),
    marketplaceDetail: vi.fn().mockResolvedValue(demoDetail()),
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
    // Both pages refresh the inventory on mount, so model the install itself
    // rather than counting listInstalled calls.
    let committed = false
    const api = mockPlugins({
      listInstalled: vi.fn(async () =>
        committed ? [{ id: 'acme.demo', requires: [], sensitive: [] }] : []
      ),
      commitInstall: vi.fn(async () => {
        committed = true
        return { id: 'acme.demo', requires: [] }
      }),
    })
    wrapper = mount(PluginPages, { global: { plugins: [i18n] } })
    await flushPromises()
    // The Marketplace now lists on mount, so scope to the Extensions page.
    expect(wrapper.find('.extensions-pane [data-id="acme.demo"]').exists()).toBe(false)
    expect(wrapper.get('.ext-empty').text()).toContain('No plugins installed')

    await wrapper.get('.ext-search button').trigger('click')
    await flushPromises()
    await wrapper.get('.ext-install').trigger('click')
    await flushPromises()

    expect(api.commitInstall).toHaveBeenCalledWith('acme.demo', {})
    expect(wrapper.get('.extensions-pane [data-id="acme.demo"]').text()).toContain('acme.demo')
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

  it('loads a default listing on mount, sorted by downloads, with a loading state first', async () => {
    let resolveSearch!: (value: unknown) => void
    const api = mockPlugins({
      marketplaceSearch: vi.fn().mockReturnValue(new Promise((resolve) => (resolveSearch = resolve))),
    })
    wrapper = mountMarketplace()
    await flushPromises()
    expect(wrapper.find('.mkt-loading').exists()).toBe(true)
    expect(api.marketplaceSearch).toHaveBeenCalledWith(undefined, 'downloads')

    resolveSearch({ items: [], total: 0, offset: 0, limit: 20 })
    await flushPromises()
    expect(wrapper.find('.mkt-loading').exists()).toBe(false)
    expect(wrapper.get('.mkt-empty').text()).toContain('No extensions are published yet')
  })

  it('shows the actual registry error when the listing fails', async () => {
    mockPlugins({
      marketplaceSearch: vi
        .fn()
        .mockRejectedValueOnce(
          new Error(
            "Error invoking remote method 'plugins:marketplaceSearch': Error: marketplace search failed: HTTP 502"
          )
        )
        .mockResolvedValue({ items: [], total: 0, offset: 0, limit: 20 }),
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    wrapper = mountMarketplace()
    await flushPromises()
    const error = wrapper.get('.mkt-list-error')
    expect(error.attributes('role')).toBe('alert')
    expect(error.text()).toContain('marketplace search failed: HTTP 502')
    // Electron's wrapper is logged, not shown.
    expect(error.text()).not.toContain('Error invoking remote method')
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('Error invoking remote method'))

    await error.get('.mkt-retry').trigger('click')
    await flushPromises()
    expect(wrapper.find('.mkt-list-error').exists()).toBe(false)
    expect(wrapper.find('.mkt-empty').exists()).toBe(true)
    consoleError.mockRestore()
  })

  it('says nothing matched a query rather than showing a blank list', async () => {
    mockPlugins({
      marketplaceSearch: vi.fn().mockResolvedValue({ items: [], total: 0, offset: 0, limit: 20 }),
    })
    wrapper = mountMarketplace()
    await flushPromises()
    await wrapper.get('.ext-search input').setValue('zzz')
    await wrapper.get('.ext-search button').trigger('click')
    await flushPromises()
    expect(wrapper.get('.mkt-empty').text()).toContain('zzz')
  })

  it('marks installed items and offers Update only when the main process reports one', async () => {
    const api = mockPlugins({
      marketplaceSearch: vi.fn().mockResolvedValue({
        items: [
          { ...demoDetail(), identity: 'acme.demo' },
          { ...demoDetail(), name: 'other', identity: 'acme.other', display_name: 'Other' },
          { ...demoDetail(), name: 'fresh', identity: 'acme.fresh', display_name: 'Fresh' },
        ],
        total: 3,
        offset: 0,
        limit: 20,
      }),
      listInstalled: vi.fn().mockResolvedValue([
        { id: 'acme.demo', requires: [], sensitive: [], packageVersion: '1.0.0', provenance: 'official-registry' },
        { id: 'acme.other', requires: [], sensitive: [], packageVersion: '1.1.0', provenance: 'official-registry' },
      ]),
      checkUpdates: vi.fn().mockResolvedValue([
        { id: 'acme.demo', namespace: 'acme', name: 'demo', installedVersion: '1.0.0', latestVersion: '1.1.0' },
      ]),
    })
    wrapper = mountMarketplace()
    await flushPromises()

    const demo = wrapper.get('[data-id="acme.demo"]')
    expect(demo.find('.ext-update-badge').exists()).toBe(true)
    expect(demo.find('.ext-install').exists()).toBe(false)
    const other = wrapper.get('[data-id="acme.other"]')
    expect(other.find('.ext-installed-badge').exists()).toBe(true)
    expect(other.find('.ext-update').exists()).toBe(false)
    expect(other.find('.ext-install').exists()).toBe(false)
    expect(wrapper.get('[data-id="acme.fresh"]').find('.ext-install').exists()).toBe(true)

    await demo.get('.ext-update').trigger('click')
    await flushPromises()
    // Update pins the newest version the main process found installable here.
    expect(api.prepareInstall).toHaveBeenCalledWith({ namespace: 'acme', name: 'demo', version: '1.1.0' })
    expect(api.commitInstall).toHaveBeenCalledWith('acme.demo', {})
    // The button does not also open the detail view.
    expect(api.marketplaceDetail).not.toHaveBeenCalled()
    // Committing re-checks updates so the badge can clear.
    expect(api.checkUpdates).toHaveBeenCalledTimes(2)
  })

  it('opens a detail view with README, permissions and versions, rendering README as text only', async () => {
    const api = mockPlugins()
    wrapper = mountMarketplace()
    await flushPromises()
    await wrapper.get('[data-id="acme.demo"]').trigger('click')
    await flushPromises()

    expect(api.marketplaceDetail).toHaveBeenCalledWith({ namespace: 'acme', name: 'demo' })
    const view = wrapper.get('[data-detail-id="acme.demo"]')
    expect(view.text()).toContain('Publisher')
    expect(view.text()).toContain('42 downloads')
    expect(view.text()).toContain('Version 1.1.0')
    expect(view.text()).toContain('4.5')
    expect(view.get('.mkt-readme h3').text()).toBe('Demo')
    expect(view.get('.mkt-readme strong').text()).toBe('world')
    // Raw HTML in a README stays inert text — no element is created from it.
    expect(view.find('.mkt-readme script').exists()).toBe(false)
    expect(view.find('.mkt-readme img').exists()).toBe(false)
    expect(view.get('.mkt-readme').text()).toContain('<script>')
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined()
    // Permissions of the latest version, sensitive ones flagged.
    expect(view.findAll('.mkt-cap').map((c) => c.text())).toEqual([
      expect.stringContaining('fs'),
      'ui',
    ])
    expect(view.get('.mkt-cap--sensitive').text()).toContain('fs')
    expect(view.findAll('.mkt-versions tr')).toHaveLength(2)
    expect(view.get('.mkt-yanked').text()).toContain('1.0.0')

    await view.get('.ext-install').trigger('click')
    await flushPromises()
    expect(api.prepareInstall).toHaveBeenCalledWith({ namespace: 'acme', name: 'demo', version: '1.1.0' })
    expect(api.commitInstall).toHaveBeenCalledWith('acme.demo', {})

    await wrapper.get('.mkt-back').trigger('click')
    expect(wrapper.find('[data-detail-id]').exists()).toBe(false)
    expect(wrapper.find('[data-id="acme.demo"]').exists()).toBe(true)
  })

  it('offers update and uninstall in the detail view of an installed extension', async () => {
    const api = mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([
        { id: 'acme.demo', requires: [], sensitive: [], packageVersion: '1.0.0', provenance: 'official-registry' },
      ]),
      checkUpdates: vi.fn().mockResolvedValue([
        { id: 'acme.demo', namespace: 'acme', name: 'demo', installedVersion: '1.0.0', latestVersion: '1.1.0' },
      ]),
    })
    wrapper = mountMarketplace()
    await flushPromises()
    await wrapper.get('[data-id="acme.demo"]').trigger('click')
    await flushPromises()

    const view = wrapper.get('[data-detail-id="acme.demo"]')
    expect(view.get('.mkt-installed').text()).toContain('1.0.0')
    expect(view.get('.ext-update').text()).toContain('1.1.0')
    expect(view.find('.ext-install').exists()).toBe(false)

    // Cancel keeps the plugin…
    await view.get('.ext-uninstall').trigger('click')
    await flushPromises()
    expect(useNotify().dialog.value?.kind).toBe('confirm')
    expect(useNotify().dialog.value?.danger).toBe(true)
    useNotify().resolveDialog(false)
    await flushPromises()
    expect(api.remove).not.toHaveBeenCalled()

    // …confirming removes it.
    await view.get('.ext-uninstall').trigger('click')
    await flushPromises()
    useNotify().resolveDialog(true)
    await flushPromises()
    expect(api.remove).toHaveBeenCalledWith('acme.demo')
  })

  it('shows the detail error and a README fallback', async () => {
    mockPlugins({
      marketplaceDetail: vi
        .fn()
        .mockRejectedValueOnce(new Error('marketplace detail failed: HTTP 404'))
        .mockResolvedValue(demoDetail({ readme: null })),
    })
    wrapper = mountMarketplace()
    await flushPromises()
    await wrapper.get('[data-id="acme.demo"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('.mkt-detail-error').text()).toContain('HTTP 404')

    await wrapper.get('.mkt-back').trigger('click')
    await wrapper.get('[data-id="acme.demo"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('.mkt-no-readme').text()).toContain('no README')
  })

  it('offers Update on the Extensions page and routes it through the trust dialog', async () => {
    const api = mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([
        { id: 'acme.demo', requires: [], sensitive: [], packageVersion: '1.0.0', provenance: 'official-registry' },
      ]),
      checkUpdates: vi.fn().mockResolvedValue([
        { id: 'acme.demo', namespace: 'acme', name: 'demo', installedVersion: '1.0.0', latestVersion: '1.1.0' },
      ]),
      prepareInstall: vi.fn().mockResolvedValue({
        id: 'acme.demo',
        version: '1.1.0',
        trustTier: 'signed-verified',
        sensitive: ['fs'],
        containsBackendExecutable: false,
        requiresConfirmation: true,
      }),
    })
    wrapper = mount(ExtensionsPane, { global: { plugins: [i18n] } })
    await flushPromises()
    const row = wrapper.get('[data-id="acme.demo"]')
    expect(row.get('.ext-update-badge').text()).toContain('1.1.0')

    await row.get('.ext-update').trigger('click')
    await flushPromises()
    expect(api.prepareInstall).toHaveBeenCalledWith({ namespace: 'acme', name: 'demo', version: '1.1.0' })
    expect(api.commitInstall).not.toHaveBeenCalled()
    await wrapper.get('.ext-trust-dialog .ext-confirm-risk').trigger('click')
    await flushPromises()
    expect(api.commitInstall).toHaveBeenCalledWith('acme.demo', {
      publisherConfirmed: false,
      riskConfirmed: true,
    })
  })

  it('marks a listing the main process found not installable here and offers no Install', async () => {
    mockPlugins({
      marketplaceSearch: vi.fn().mockResolvedValue({
        items: [{ ...demoDetail(), latest_targets: ['win32-x64'], installable: false }],
        total: 1,
        offset: 0,
        limit: 20,
      }),
    })
    wrapper = mountMarketplace()
    await flushPromises()
    const row = wrapper.get('[data-id="acme.demo"]')
    expect(row.get('.ext-unavailable-badge').text()).toContain('Not available for this platform')
    expect(row.find('.ext-install').exists()).toBe(false)
  })

  it('does not pick another platform\'s row as the install target in the detail view', async () => {
    const api = mockPlugins({
      marketplaceDetail: vi.fn().mockResolvedValue(
        demoDetail({
          latest_version: '2.0.0',
          latest_installable_version: '1.1.0',
          versions: [
            {
              version: '2.0.0',
              published_at: '2026-09-10T00:00:00Z',
              target: 'win32-x64',
              yanked: false,
              trust_tier: 'signed-verified',
              capabilities: ['shell'],
              sensitive_capabilities: ['shell'],
              download_count: 1,
              installable: false,
            },
            {
              version: '1.1.0',
              published_at: '2026-09-01T00:00:00Z',
              target: 'universal',
              yanked: false,
              trust_tier: 'signed-verified',
              capabilities: ['ui'],
              sensitive_capabilities: [],
              download_count: 3,
              installable: true,
            },
          ],
        })
      ),
    })
    wrapper = mountMarketplace()
    await flushPromises()
    await wrapper.get('[data-id="acme.demo"]').trigger('click')
    await flushPromises()

    const view = wrapper.get('[data-detail-id="acme.demo"]')
    expect(view.get('.mkt-unavailable').text()).toContain('2.0.0')
    expect(view.get('.mkt-unavailable').text()).toContain('darwin-arm64')
    expect(view.get('.mkt-unavailable').text()).toContain('win32-x64')
    // Permissions describe what would actually be installed.
    expect(view.findAll('.mkt-cap').map((c) => c.text())).toEqual(['ui'])
    expect(view.get('.mkt-other-target').text()).toContain('Not for this platform (win32-x64)')
    // The button names the version it installs when it is not the header's.
    expect(view.get('.ext-install').text()).toBe('Install 1.1.0')
    await view.get('.ext-install').trigger('click')
    await flushPromises()
    expect(api.prepareInstall).toHaveBeenCalledWith({ namespace: 'acme', name: 'demo', version: '1.1.0' })
  })

  it('offers no Install in the detail view when no version targets this platform', async () => {
    mockPlugins({
      marketplaceDetail: vi.fn().mockResolvedValue(
        demoDetail({
          latest_installable_version: null,
          versions: [
            {
              version: '1.1.0',
              published_at: '2026-09-01T00:00:00Z',
              target: 'linux-x64',
              yanked: false,
              trust_tier: 'signed-verified',
              capabilities: [],
              sensitive_capabilities: [],
              download_count: 1,
              installable: false,
            },
          ],
        })
      ),
    })
    wrapper = mountMarketplace()
    await flushPromises()
    await wrapper.get('[data-id="acme.demo"]').trigger('click')
    await flushPromises()
    const view = wrapper.get('[data-detail-id="acme.demo"]')
    expect(view.find('.ext-install').exists()).toBe(false)
    expect(view.get('.mkt-unavailable').text()).toContain('linux-x64')
  })

  it('propagates pushed update counts to the nav badge and the Extensions page', async () => {
    let push!: (updates: unknown[]) => void
    const update = { id: 'acme.demo', namespace: 'acme', name: 'demo', installedVersion: '1.0.0', latestVersion: '1.1.0' }
    mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([
        { id: 'acme.demo', requires: [], sensitive: [], packageVersion: '1.0.0', provenance: 'official-registry' },
      ]),
      // The page's own check fails; the pushed answer still shows.
      checkUpdates: vi.fn().mockRejectedValue(new Error('offline')),
      pendingUpdates: vi.fn().mockResolvedValue([]),
      onUpdatesChanged: vi.fn((handler: (updates: unknown[]) => void) => {
        push = handler
        return () => {}
      }),
    })
    const pluginUpdates = usePluginUpdates()
    const stop = pluginUpdates.subscribe()
    const Host = defineComponent({
      setup() {
        return () =>
          h('div', [
            h(SettingsNavItem, { label: 'Extensions', badge: pluginUpdates.count.value }),
            h(ExtensionsPane),
          ])
      },
    })
    wrapper = mount(Host, { global: { plugins: [i18n] } })
    await flushPromises()
    expect(wrapper.find('.settings-nav-item-badge').exists()).toBe(false)
    expect(wrapper.find('.ext-updates-summary').exists()).toBe(false)

    push([update])
    await flushPromises()
    expect(wrapper.get('.settings-nav-item-badge').text()).toBe('1')
    expect(wrapper.get('.ext-updates-summary').text()).toContain('1')
    expect(wrapper.find('[data-id="acme.demo"] .ext-update').exists()).toBe(true)

    push([])
    await flushPromises()
    expect(wrapper.find('.settings-nav-item-badge').exists()).toBe(false)
    stop()
  })

  it('seeds the count from the main process cache on subscribe', async () => {
    mockPlugins({
      pendingUpdates: vi.fn().mockResolvedValue([
        { id: 'acme.demo', namespace: 'acme', name: 'demo', installedVersion: '1.0.0', latestVersion: '1.1.0' },
        { id: 'acme.two', namespace: 'acme', name: 'two', installedVersion: '1.0.0', latestVersion: '2.0.0' },
      ]),
      onUpdatesChanged: vi.fn(() => () => {}),
    })
    const pluginUpdates = usePluginUpdates()
    const stop = pluginUpdates.subscribe()
    await flushPromises()
    expect(pluginUpdates.count.value).toBe(2)
    stop()
  })

  it('formats counts with the app locale and shows the rating on list cards', async () => {
    mockPlugins({
      marketplaceSearch: vi.fn().mockResolvedValue({
        items: [{ ...demoDetail(), download_count: 18234, rating_average: 4.66 }],
        total: 1,
        offset: 0,
        limit: 20,
      }),
    })
    wrapper = mountMarketplace()
    await flushPromises()
    const row = wrapper.get('[data-id="acme.demo"]')
    expect(row.text()).toContain('18,234 downloads')
    expect(row.get('.mkt-card-rating').text()).toBe('★ 4.7')
  })
})
