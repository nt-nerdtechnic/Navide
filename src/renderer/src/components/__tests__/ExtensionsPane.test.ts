// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import ExtensionsPane from '../ExtensionsPane.vue'

function mountExtensions() {
  return mount(ExtensionsPane, { global: { plugins: [i18n] } })
}

function mockPlugins(overrides: Record<string, unknown> = {}) {
  const api = {
    listInstalled: vi.fn().mockResolvedValue([
      { id: 'navide.mini-ide', requires: ['fs', 'git', 'terminal'], sensitive: ['fs', 'terminal'] },
    ]),
    listFactoryPackages: vi.fn().mockResolvedValue([]),
    restoreFactoryPackage: vi.fn().mockResolvedValue({ ok: true }),
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
    wrapper = mountExtensions()
    await flushPromises()
    const row = wrapper.get('[data-id="navide.mini-ide"]')
    expect(row.text()).toContain('navide.mini-ide')
    expect(row.find('.ext-sensitive').exists()).toBe(true)
    expect(row.find('.ext-sensitive').text()).toContain('fs, terminal')
  })

  it('shows an opted-out bundled Git package and restores it explicitly', async () => {
    const listFactoryPackages = vi
      .fn()
      .mockResolvedValueOnce([
        { id: 'navide.git', version: '0.1.0', active: false, optedOut: true },
      ])
      .mockResolvedValueOnce([
        { id: 'navide.git', version: '0.1.0', active: true, optedOut: false },
      ])
    const api = mockPlugins({ listFactoryPackages })
    wrapper = mountExtensions()
    await flushPromises()

    const row = wrapper.get('[data-factory-id="navide.git"]')
    expect(row.text()).toContain('Bundled Git')
    expect(row.text()).toContain('Removed')
    await row.get('.ext-restore').trigger('click')
    await flushPromises()

    expect(api.restoreFactoryPackage).toHaveBeenCalledWith('navide.git')
    expect(wrapper.get('[data-factory-id="navide.git"]').text()).toContain('Active')
  })

  it('shows an active factory Git package only in the Bundled section', async () => {
    mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([
        {
          id: 'navide.git',
          requires: ['fs', 'ui', 'shell'],
          sensitive: ['fs', 'shell'],
          provenance: 'factory-bundled',
        },
      ]),
      listFactoryPackages: vi.fn().mockResolvedValue([
        { id: 'navide.git', version: '0.1.0', active: true, optedOut: false },
      ]),
    })
    wrapper = mountExtensions()
    await flushPromises()

    expect(wrapper.get('[data-factory-id="navide.git"]').text()).toContain('Active')
    expect(wrapper.find('[data-id="navide.git"]').exists()).toBe(false)
  })

  it('shows Bundled Git Manifest Permissions and its exact package-version grant', async () => {
    mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([
        {
          id: 'navide.git',
          requires: ['fs', 'shell'],
          sensitive: ['fs', 'shell'],
          packageVersion: '2.0.0',
          manifestPermissions: { system: ['fs'], shell: 'allowlist' },
          packageVersionGrant: {
            packageVersion: '2.0.0',
            system: ['fs'],
            shell: 'allowlist',
          },
          provenance: 'factory-bundled',
        },
      ]),
      listFactoryPackages: vi.fn().mockResolvedValue([
        { id: 'navide.git', version: '2.0.0', active: true, optedOut: false },
      ]),
    })
    wrapper = mountExtensions()
    await flushPromises()

    const row = wrapper.get('[data-factory-id="navide.git"]')
    expect(row.find('.ext-manifest-permissions').text()).toContain('fs')
    expect(row.find('.ext-manifest-permissions').text()).toContain('allowlist')
    expect(row.find('.ext-package-grant').text()).toContain('2.0.0')
    expect(row.find('.ext-package-grant').text()).toContain('fs')
    expect(wrapper.find('[data-id="navide.git"]').exists()).toBe(false)
  })

  it('shows no matching Grant for a Bundled package version without a grant', async () => {
    mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([
        {
          id: 'navide.git',
          requires: [],
          sensitive: [],
          packageVersion: '2.0.0',
          manifestPermissions: { system: ['fs'] },
          packageVersionGrant: null,
          provenance: 'factory-bundled',
        },
      ]),
      listFactoryPackages: vi.fn().mockResolvedValue([
        { id: 'navide.git', version: '2.0.0', active: true, optedOut: false },
      ]),
    })
    wrapper = mountExtensions()
    await flushPromises()

    expect(wrapper.get('[data-factory-id="navide.git"] .ext-package-grant').text()).toContain(
      'No matching grant'
    )
  })

  it('shows and removes a backend-only package with no capabilities', async () => {
    const listInstalled = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'acme.backend', requires: [], sensitive: [] }])
      .mockResolvedValueOnce([])
    const api = mockPlugins({ listInstalled })
    wrapper = mountExtensions()
    await flushPromises()

    expect(wrapper.get('[data-id="acme.backend"]').text()).toContain('acme.backend')
    await wrapper.get('[data-id="acme.backend"] .ext-remove').trigger('click')
    await flushPromises()

    expect(api.remove).toHaveBeenCalledWith('acme.backend')
    expect(wrapper.find('[data-id="acme.backend"]').exists()).toBe(false)
    expect(wrapper.get('.ext-empty').text()).toContain('No plugins installed')
  })




  it('keeps the Developer Mode local-unpacked warning visible in inventory', async () => {
    mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([
        {
          id: 'acme.local',
          requires: [],
          sensitive: [],
          provenance: 'developer-local-unpacked',
          warning: 'Unsigned local unpacked plugin — Developer Mode only',
        },
      ]),
    })
    wrapper = mountExtensions()
    await flushPromises()
    expect(wrapper.get('[data-id="acme.local"] .ext-dev-warning').text()).toContain(
      'Developer Mode only'
    )
  })

  it('shows each plugin its own manifest permissions and package-version grant', async () => {
    mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([
        {
          id: 'acme.v2',
          packageVersion: '2.4.0',
          requires: ['fs'],
          sensitive: ['fs'],
          manifestPermissions: { system: ['fs'], shell: 'allowlist' },
          packageVersionGrant: {
            packageVersion: '2.4.0',
            system: ['fs', 'ui'],
            shell: 'allowlist',
            highRiskShellConfirmed: true,
          },
        },
      ]),
    })
    wrapper = mountExtensions()
    await flushPromises()

    const row = wrapper.get('[data-id="acme.v2"]')
    expect(row.find('.ext-manifest-permissions').text()).toContain('fs')
    expect(row.find('.ext-manifest-permissions').text()).toContain('allowlist')
    expect(row.find('.ext-package-grant').text()).toContain('2.4.0')
    expect(row.find('.ext-package-grant').text()).toContain('ui')
  })

  it('distinguishes an installed package with no matching grant', async () => {
    mockPlugins({
      listInstalled: vi.fn().mockResolvedValue([
        {
          id: 'acme.v2',
          packageVersion: '2.4.0',
          requires: [],
          sensitive: [],
          manifestPermissions: { system: ['fs'] },
          packageVersionGrant: null,
        },
      ]),
    })
    wrapper = mountExtensions()
    await flushPromises()

    expect(wrapper.get('.ext-package-grant').text()).toContain('No matching grant')
  })





  it('removes an installed plugin', async () => {
    const api = mockPlugins()
    wrapper = mountExtensions()
    await flushPromises()
    await wrapper.get('[data-id="navide.mini-ide"] .ext-remove').trigger('click')
    await flushPromises()
    expect(api.remove).toHaveBeenCalledWith('navide.mini-ide')
  })
})
