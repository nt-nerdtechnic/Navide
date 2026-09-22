// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import SharingBundleSection from '../sharing/SharingBundleSection.vue'
import SharingCloudSection from '../sharing/SharingCloudSection.vue'

const inventory = {
  ok: true,
  payload: {
    scopes: {
      prompts: [
        { id: 'p1', label: 'Daily', size: 120, hasSecrets: false, mayLeakInArgsOrUrl: false, eligible: true, reason: '' },
      ],
      mcp: [
        { id: 'srv', label: 'srv', size: 300, hasSecrets: true, mayLeakInArgsOrUrl: false, eligible: true, reason: '' },
        { id: 'leaky', label: 'leaky', size: 90, hasSecrets: false, mayLeakInArgsOrUrl: true, eligible: true, reason: '' },
      ],
      skills: [
        { id: 'native', label: 'native', size: 0, hasSecrets: false, mayLeakInArgsOrUrl: false, eligible: false, reason: 'not managed by Navide' },
      ],
      memory: [],
    },
  },
}

const bundle = {
  bundleVersion: 1,
  scopes: { mcp: { items: { srv: {} } }, prompts: { items: { p1: {} } } },
  redactions: [{ scope: 'mcp', item: 'srv', fields: ['env.TOKEN'] }],
}

function mockBackend(overrides: Record<string, unknown> = {}) {
  const responses: Record<string, unknown> = {
    'share.inventory': inventory,
    'share.export': { ok: true, payload: { bundle } },
    'share.import_preview': {
      ok: true,
      payload: {
        items: [
          { scope: 'prompts', id: 'p1', action: 'overwrite', reason: '' },
          { scope: 'mcp', id: 'srv', action: 'create', reason: '1 value(s) were left out' },
        ],
      },
    },
    'share.import_apply': {
      ok: true,
      payload: {
        ok: true,
        items: [
          { scope: 'prompts', id: 'p1', action: 'overwrite', ok: true, reason: '' },
          { scope: 'mcp', id: 'srv', action: 'create', ok: false, reason: 'the write was refused' },
        ],
      },
    },
    'sync.inventory': { ok: true, payload: { status: 'not-connected', scopes: {}, devices: [], scopeEnabled: {} } },
    'sync.push_items': { ok: true, payload: { scope: 'prompts', results: [{ itemId: 'a', result: 'pushed' }] } },
    ...overrides,
  }
  const send = vi.fn(async (type: string, _payload?: unknown) => responses[type])
  return { backend: { send } as never, send }
}

function stubBridge(content: string) {
  ;(window as unknown as { agentTeam: unknown }).agentTeam = {
    pickFile: vi.fn(async () => ({ ok: true, path: '/tmp/x.navidebundle' })),
    readFileFrom: vi.fn(async () => ({ ok: true, content, newOffset: content.length })),
    saveJson: vi.fn(async () => ({ ok: true, path: '/tmp/out.navidebundle' })),
  }
}

describe('SharingBundleSection', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    i18n.global.locale.value = 'en-US'
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    delete (window as unknown as { agentTeam?: unknown }).agentTeam
    vi.restoreAllMocks()
  })

  it('lists every item, disables the ineligible one and says why', async () => {
    const { backend } = mockBackend()
    wrapper = mount(SharingBundleSection, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    const boxes = wrapper.findAll('input.sh-check')
    expect(boxes).toHaveLength(4)
    const native = wrapper.find('#sh-skills-native')
    expect(native.attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('not managed by Navide')
    expect(wrapper.text()).toContain('Credentials are removed')
  })

  it('warns loudly about an args/url leak and never sweeps that item into select-all', async () => {
    const { backend, send } = mockBackend()
    wrapper = mount(SharingBundleSection, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    expect(wrapper.find('.sh-tag--leak').exists()).toBe(true)
    expect(wrapper.text()).toContain('goes out exactly as written')

    const buttons = wrapper.findAll('button')
    await buttons.find((b) => b.text() === 'Select all')!.trigger('click')
    expect((wrapper.find('#sh-mcp-leaky').element as HTMLInputElement).checked).toBe(false)
    expect((wrapper.find('#sh-mcp-srv').element as HTMLInputElement).checked).toBe(true)

    stubBridge('')
    await buttons.find((b) => b.text() === 'Export to a file')!.trigger('click')
    await flushPromises()
    const call = send.mock.calls.find((c) => c[0] === 'share.export')
    expect(call?.[1]).toMatchObject({ selection: { prompts: ['p1'], mcp: ['srv'] } })
  })

  it('refuses to export with nothing ticked', async () => {
    const { backend, send } = mockBackend()
    wrapper = mount(SharingBundleSection, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    await wrapper.findAll('button').find((b) => b.text() === 'Export to a file')!.trigger('click')
    await flushPromises()
    expect(send.mock.calls.some((c) => c[0] === 'share.export')).toBe(false)
    expect(wrapper.find('.err-msg').text()).toContain('at least one item')
  })

  it('previews an import with nothing ticked and writes nothing until asked', async () => {
    const { backend, send } = mockBackend()
    stubBridge(JSON.stringify(bundle))
    wrapper = mount(SharingBundleSection, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    await wrapper.findAll('button').find((b) => b.text() === 'Import from a file')!.trigger('click')
    await flushPromises()

    expect(send.mock.calls.some((c) => c[0] === 'share.import_preview')).toBe(true)
    expect(send.mock.calls.some((c) => c[0] === 'share.import_apply')).toBe(false)
    const preview = wrapper.find('[data-settings-section="sharing-import-preview"]')
    expect(preview.exists()).toBe(true)
    expect(preview.text()).toContain('Overwrites what is here')
    // The stripped MCP item is flagged before anything is written.
    expect(preview.text()).toContain('Needs credentials')
    expect(preview.text()).toContain('env.TOKEN')
    const boxes = preview.findAll('input.sh-check')
    expect(boxes.every((b) => !(b.element as HTMLInputElement).checked)).toBe(true)
    const apply = preview.findAll('button').find((b) => b.text().startsWith('Apply'))!
    expect(apply.attributes('disabled')).toBeDefined()
  })

  it('applies only the ticked rows and shows each outcome, failures included', async () => {
    const { backend, send } = mockBackend()
    stubBridge(JSON.stringify(bundle))
    wrapper = mount(SharingBundleSection, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()
    await wrapper.findAll('button').find((b) => b.text() === 'Import from a file')!.trigger('click')
    await flushPromises()

    const preview = wrapper.find('[data-settings-section="sharing-import-preview"]')
    for (const box of preview.findAll('input.sh-check')) await box.setValue(true)
    await preview.findAll('button').find((b) => b.text().startsWith('Apply'))!.trigger('click')
    await flushPromises()

    const call = send.mock.calls.find((c) => c[0] === 'share.import_apply')
    expect(call?.[1]).toMatchObject({ selection: { prompts: ['p1'], mcp: ['srv'] } })
    const text = wrapper.text()
    expect(text).toContain('1 of 2 items were written')
    expect(text).toContain('the write was refused')
    expect(wrapper.find('.sh-result-mark--bad').exists()).toBe(true)
    // The stripped item is still flagged after the apply.
    expect(wrapper.find('.sh-results').text()).toContain('Needs credentials')
    // The list is re-read rather than trusted from before the import.
    expect(send.mock.calls.filter((c) => c[0] === 'share.inventory').length).toBe(2)
  })

  it('shows the backend error instead of an empty list when the handler is missing', async () => {
    const { backend } = mockBackend({
      'share.inventory': { ok: false, error: { code: 'UNKNOWN', message: 'no such handler' } },
    })
    wrapper = mount(SharingBundleSection, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()
    expect(wrapper.find('.err-msg').text()).toContain('no such handler')
  })
})

describe('SharingCloudSection', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    i18n.global.locale.value = 'en-US'
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    vi.restoreAllMocks()
  })

  it('offline: says so and points at the bundle instead of drawing an empty table', async () => {
    const { backend } = mockBackend()
    wrapper = mount(SharingCloudSection, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    const offline = wrapper.find('[data-testid="cloud-offline"]')
    expect(offline.exists()).toBe(true)
    expect(offline.text()).toContain('Not signed in')
    expect(offline.text()).toContain('works offline')
    await offline.find('button').trigger('click')
    expect(wrapper.emitted('go-to-bundle')).toHaveLength(1)
    expect(wrapper.find('[role="table"]').exists()).toBe(false)
  })

  it('tells no-key, disabled, unknown-scope and empty apart per scope', async () => {
    const { backend } = mockBackend({
      'sync.inventory': {
        ok: true,
        payload: {
          status: 'ok',
          scopes: {
            prompts: { status: 'no-key', items: [] },
            mcp: { status: 'ok', items: [] },
            skills: { status: 'ok', items: [] },
            memory: { status: 'unknown-scope', items: [] },
          },
          devices: [],
          scopeEnabled: { prompts: true, mcp: false, skills: true, memory: true },
        },
      },
    })
    wrapper = mount(SharingCloudSection, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    const notices = wrapper.findAll('.sc-notice[data-notice]').map((n) => n.attributes('data-notice'))
    expect(notices).toEqual(['no-key', 'disabled', 'empty', 'unknown-scope'])
  })

  it('labels an unreadable record as such, not as diverged, and will not move it', async () => {
    const { backend } = mockBackend({
      'sync.inventory': {
        ok: true,
        payload: {
          status: 'ok',
          scopes: {
            prompts: {
              status: 'ok',
              items: [
                {
                  itemId: 'locked',
                  local: { present: true, fingerprint: 'a' },
                  remote: { present: true, fingerprint: null, readable: false, deviceId: 'deadbeefcafe0000', updatedAt: '2026-09-01' },
                  state: 'diverged',
                },
                {
                  itemId: 'mine',
                  local: { present: true, fingerprint: 'b' },
                  remote: null,
                  state: 'local-only',
                },
              ],
            },
          },
          devices: [{ deviceId: 'deadbeefcafe0000', deviceName: '', lastSeenAt: '2026-09-10', lastWriteAt: '2026-09-01' }],
          scopeEnabled: { prompts: true },
        },
      },
    })
    wrapper = mount(SharingCloudSection, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    const rows = wrapper.findAll('.sc-row:not(.sc-row--head)')
    expect(rows).toHaveLength(2)
    expect(rows[0].find('.sc-badge--unreadable').text()).toContain('Cannot be read')
    expect(rows[0].find('.sc-badge--diverged').exists()).toBe(false)
    expect(rows[0].find('input').attributes('disabled')).toBeDefined()
    expect(rows[1].find('.sc-badge--local-only').text()).toContain('Only on this device')
    // Unnamed device: shown by id prefix, not dropped.
    expect(rows[0].find('.sc-cell--device').text()).toBe('deadbeef')
    expect(wrapper.find('.sc-device-list').text()).toContain('deadbeef')
    expect(wrapper.text()).toContain('Last wrote 2026-09-01')
    expect(wrapper.text()).toContain('Last online 2026-09-10')
  })

  it('pushes exactly the ticked ids of one scope', async () => {
    const { backend, send } = mockBackend({
      'sync.inventory': {
        ok: true,
        payload: {
          status: 'ok',
          scopes: {
            prompts: {
              status: 'ok',
              items: [
                { itemId: 'a', local: { present: true, fingerprint: '1' }, remote: null, state: 'local-only' },
                { itemId: 'b', local: { present: true, fingerprint: '2' }, remote: null, state: 'local-only' },
              ],
            },
          },
          devices: [],
          scopeEnabled: { prompts: true },
        },
      },
    })
    wrapper = mount(SharingCloudSection, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    await wrapper.find('input[aria-label="a"]').setValue(true)
    await wrapper.findAll('button').find((b) => b.text().startsWith('Push these'))!.trigger('click')
    await flushPromises()

    expect(send).toHaveBeenCalledWith('sync.push_items', { scope: 'prompts', itemIds: ['a'] })
    expect(wrapper.text()).toContain('a — sent')
  })
})
