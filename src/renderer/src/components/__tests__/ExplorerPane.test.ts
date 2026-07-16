// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import ExplorerPane from '../ExplorerPane.vue'
import { i18n } from '../../i18n'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import type { BackendStatus } from '../../composables/useBackend'

// Stub useNotify so toast/alert/confirm calls don't throw.
vi.mock('../../composables/useNotify', () => ({
  useNotify: () => ({ toast: vi.fn(), alert: vi.fn(), confirm: vi.fn() }),
}))

const FILE_ENTRY = {
  name: 'readme.md',
  rel_path: 'readme.md',
  is_dir: false,
  is_hidden: false,
  is_noise: false,
}

const DIR_ENTRY = {
  name: 'src',
  rel_path: 'src',
  is_dir: true,
  is_hidden: false,
  is_noise: false,
}

function mountPane(backend: unknown) {
  return mount(ExplorerPane, {
    props: { workspacePath: '/ws', backend: backend as never },
    global: { plugins: [i18n] },
  })
}

function listDirCalls(sent: { type: string }[]): number {
  return sent.filter((s) => s.type === 'fs.list_dir').length
}

describe('ExplorerPane – connection states', () => {
  it('shows "Waiting for backend…" instead of "No items" while not connected', async () => {
    const { backend, sent } = createMockBackend('connecting' as BackendStatus)
    const wrapper = mountPane(backend)
    await flushPromises()
    expect(wrapper.text()).toContain('Waiting for backend')
    expect(wrapper.text()).not.toContain('No items')
    expect(listDirCalls(sent)).toBe(0)
  })

  it('runs the initial load once the backend connects', async () => {
    const { backend, status, setResponse, sent } = createMockBackend('connecting' as BackendStatus)
    setResponse('fs.list_dir', { ok: true, entries: [FILE_ENTRY] })
    const wrapper = mountPane(backend)
    await flushPromises()
    expect(listDirCalls(sent)).toBe(0)

    status.value = 'connected'
    await nextTick()
    await flushPromises()
    expect(listDirCalls(sent)).toBe(1)
    expect(wrapper.text()).toContain('readme.md')
  })

  it('shows "No items" only for a genuinely empty directory result', async () => {
    const { backend, setResponse } = createMockBackend('connected' as BackendStatus)
    setResponse('fs.list_dir', { ok: true, entries: [] })
    const wrapper = mountPane(backend)
    await flushPromises()
    expect(wrapper.text()).toContain('No items to display')
    expect(wrapper.text()).not.toContain('Waiting for backend')
  })

  it('renders a truncated note when the listing was capped by the backend', async () => {
    const { backend, setResponse } = createMockBackend('connected' as BackendStatus)
    setResponse('fs.list_dir', { ok: true, entries: [FILE_ENTRY], truncated: true })
    const wrapper = mountPane(backend)
    await flushPromises()
    expect(wrapper.text()).toContain('List truncated')
    expect(wrapper.find('.exp-note.truncated').exists()).toBe(true)
  })

  it('renders an inline error note when expanding a dir fails', async () => {
    const { backend, setResponse } = createMockBackend('connected' as BackendStatus)
    setResponse('fs.list_dir', { ok: true, entries: [DIR_ENTRY] })
    const wrapper = mountPane(backend)
    await flushPromises()

    setResponse('fs.list_dir', { ok: false, error: 'permission denied' })
    await wrapper.find('.exp-row').trigger('click') // expand 'src'
    await flushPromises()

    const note = wrapper.find('.exp-note.error')
    expect(note.exists()).toBe(true)
    expect(note.text()).toContain('Cannot load directory')
    expect(note.text()).toContain('permission denied')
  })

  it('re-runs the initial load on reconnect after a failed load', async () => {
    const { backend, status, setResponse, sent } = createMockBackend('connected' as BackendStatus)
    setResponse('fs.list_dir', { ok: false, error: 'boom' })
    const wrapper = mountPane(backend)
    await flushPromises()
    expect(listDirCalls(sent)).toBe(1)
    expect(wrapper.text()).toContain('boom')

    // Socket drops: the failed tree reads as "waiting", not an empty dir.
    status.value = 'disconnected'
    await nextTick()
    expect(wrapper.text()).toContain('Waiting for backend')

    // Reconnect: initial load runs again and the tree renders.
    setResponse('fs.list_dir', { ok: true, entries: [FILE_ENTRY] })
    status.value = 'connected'
    await nextTick()
    await flushPromises()
    expect(listDirCalls(sent)).toBe(2)
    expect(wrapper.text()).toContain('readme.md')
  })
})
