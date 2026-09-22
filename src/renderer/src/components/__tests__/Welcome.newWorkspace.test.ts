// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import Welcome from '../Welcome.vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import type { NewWorkspaceResult } from '../../../../shared/workspaceCreate'

describe('Welcome – New… names the workspace folder', () => {
  let wrapper: VueWrapper | undefined
  let newWorkspace: ReturnType<typeof vi.fn>
  let focusWorkspaceWindow: ReturnType<typeof vi.fn>

  beforeEach(() => {
    newWorkspace = vi.fn()
    focusWorkspaceWindow = vi.fn().mockResolvedValue(false)
    ;(window as unknown as Record<string, unknown>).agentTeam = {
      newWorkspace,
      focusWorkspaceWindow,
      listOpenWorkspaces: vi.fn().mockResolvedValue([]),
      onOpenWorkspacesChanged: () => () => {},
    }
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    delete (window as unknown as Record<string, unknown>).agentTeam
  })

  async function mountWelcome() {
    const mock = createMockBackend('connected')
    mock.setResponse('workspace.list_recent', { recent: [], path: '/tmp/recent.json' })
    wrapper = mount(Welcome, {
      props: { backend: mock.backend as never },
      global: { plugins: [i18n] },
    })
    await flushPromises()
    return mock
  }

  async function clickNew(result: NewWorkspaceResult): Promise<void> {
    newWorkspace.mockResolvedValue(result)
    await wrapper!.findAll('.w-open-btns button')[1].trigger('click')
    await flushPromises()
  }

  it('opens the folder the user named', async () => {
    await mountWelcome()
    await clickNew({ ok: true, path: '/Users/me/checkout-service' })
    expect(wrapper!.emitted('select')).toEqual([['/Users/me/checkout-service']])
    expect(wrapper!.find('.w-open .w-error').exists()).toBe(false)
  })

  it('stays quiet when the user cancels the dialog', async () => {
    await mountWelcome()
    await clickNew({ ok: false, reason: 'canceled' })
    expect(wrapper!.emitted('select')).toBeUndefined()
    expect(wrapper!.find('.w-open .w-error').exists()).toBe(false)
  })

  it('names the clashing folder instead of failing silently', async () => {
    await mountWelcome()
    await clickNew({ ok: false, reason: 'exists', path: '/Users/me/taken' })
    const msg = wrapper!.find('.w-open .w-error')
    expect(msg.exists()).toBe(true)
    expect(msg.text()).toContain('taken')
    expect(wrapper!.emitted('select')).toBeUndefined()
  })

  it.each([
    ['denied', '/private/locked'],
    ['failed', '/Volumes/full/proj'],
  ] as const)('reports a %s outcome with its path', async (reason, path) => {
    await mountWelcome()
    await clickNew({ ok: false, reason, path })
    const msg = wrapper!.find('.w-open .w-error')
    expect(msg.exists()).toBe(true)
    expect(msg.text()).toContain(path)
  })

  it('clears a previous failure when the next attempt succeeds', async () => {
    await mountWelcome()
    await clickNew({ ok: false, reason: 'exists', path: '/Users/me/taken' })
    expect(wrapper!.find('.w-open .w-error').exists()).toBe(true)
    await clickNew({ ok: true, path: '/Users/me/fresh' })
    expect(wrapper!.find('.w-open .w-error').exists()).toBe(false)
    expect(wrapper!.emitted('select')).toEqual([['/Users/me/fresh']])
  })

  it('re-enables the button after a failure so the user can retry', async () => {
    await mountWelcome()
    await clickNew({ ok: false, reason: 'failed', path: '/x' })
    const button = wrapper!.findAll('.w-open-btns button')[1]
    expect(button.attributes('disabled')).toBeUndefined()
  })

  it('focuses the other window rather than opening a duplicate', async () => {
    await mountWelcome()
    focusWorkspaceWindow.mockResolvedValue(true)
    await clickNew({ ok: true, path: '/Users/me/already-open' })
    expect(wrapper!.emitted('select')).toBeUndefined()
  })
})
