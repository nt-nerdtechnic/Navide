// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'

const nav = {
  callCapability: vi.fn(async (_namespace: string, method: string) => ({
    reqId: 'test',
    ok: true,
    result: method === 'readEditorPreferences' ? { preferences: {} } : { found: false },
  })),
  on: vi.fn(() => vi.fn()),
  ready: vi.fn(),
  hideSelf: vi.fn(),
  registerReceiver: vi.fn(async () => ({ receiverId: 'receiver-1' })),
  listReceiverLeftContributions: vi.fn(async () => []),
  openReceiverLeft: vi.fn(async () => undefined),
  acceptExistingReceiverOffer: vi.fn(async () => ({ accepted: true, itemId: 'item-1' })),
  onReceiverOffer: vi.fn(() => vi.fn()),
  onReceiverEditorTarget: vi.fn(() => vi.fn()),
  onReceiverCloseGuard: vi.fn(() => vi.fn()),
  mountReceiver: vi.fn(async () => ({ itemId: 'item-1' })),
  requestCloseReceiver: vi.fn(async () => ({ closed: true as const })),
  requestCloseReceiverTransaction: vi.fn(async () => ({ closed: true as const })),
  abortReceiverItem: vi.fn(async () => undefined),
  onReceiverItemClosed: vi.fn(() => vi.fn()),
  disposeReceiver: vi.fn(async () => undefined),
  onOpenTarget: vi.fn(() => vi.fn()),
}

;(globalThis as unknown as { nav: typeof nav }).nav = nav

let wrapper: VueWrapper | null = null

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  window.history.replaceState(null, '', '/')
})

// The host loads the view with the workspace's alias in the entry query
// (frontendPluginManager miniIdeQuery), which MiniIdeApp reads at setup.
async function mountWithQuery(query: string): Promise<VueWrapper> {
  window.history.replaceState(null, '', `/?${query}`)
  const MiniIdeApp = (await import('../MiniIdeApp.vue')).default
  wrapper = mount(MiniIdeApp, {
    shallow: true,
    attachTo: document.body,
    global: { mocks: { $t: (key: string) => key }, plugins: [i18n] },
  })
  await flushPromises()
  return wrapper
}

describe('MiniIdeApp workspace alias', () => {
  it('titles the window and the Explorer with the alias the host passed', async () => {
    const w = await mountWithQuery('workspace_path=%2Fws%2Fagent-team&workspace_display_name=%20Navide%20')

    expect(w.get('.ide-titlebar-name').text()).toBe('Navide')
    expect(w.get('explorer-pane-stub').attributes('workspace-display-name')).toBe('Navide')
  })

  it('falls back to the folder name when no alias is passed', async () => {
    const w = await mountWithQuery('workspace_path=%2Fws%2Fagent-team')

    expect(w.get('.ide-titlebar-name').text()).toBe('agent-team')
    expect(w.get('explorer-pane-stub').attributes('workspace-display-name')).toBe('agent-team')
  })
})
