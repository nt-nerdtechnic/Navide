// @vitest-environment happy-dom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '@navide/plugin-ui/foundation'
import HtmlFilePreview from './HtmlFilePreview.vue'

const state = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock('@navide/plugin-sdk', () => ({
  createPluginCapabilityClient: () => ({ capabilities: { invoke: state.invoke } }),
}))

let wrapper: VueWrapper | null = null

beforeEach(() => {
  state.invoke.mockReset()
  state.invoke.mockResolvedValue({ url: 'navide-resource://preview/report.html' })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

function mountPreview(path: string, name = path.split('/').pop() ?? path): VueWrapper {
  wrapper = mount(HtmlFilePreview, {
    props: { path, name },
    global: { plugins: [i18n] },
  })
  return wrapper
}

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason?: unknown): void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('HtmlFilePreview', () => {
  it.each([
    ['.html', 'report.html', 'HTML'],
    ['.htm', 'report.htm', 'HTM'],
  ])('renders a readonly sandbox preview for %s resources', async (_extension, filename, label) => {
    const view = mountPreview(`/workspace/docs/${filename}`)
    await flushPromises()

    expect(state.invoke).toHaveBeenCalledOnce()
    expect(state.invoke).toHaveBeenCalledWith('fs.previewResource', { path: `/workspace/docs/${filename}` })
    const frame = view.get('iframe.fpv-html-frame')
    expect(frame.attributes('src')).toBe('navide-resource://preview/report.html')
    expect(frame.attributes('sandbox')).toBe('')
    expect(frame.attributes('srcdoc')).toBeUndefined()
    expect(view.get('.fpv-meta').text()).toBe(label)
    expect(view.find('.fpv-hint').exists()).toBe(true)
    expect(view.find('.fpv-open-btn').exists()).toBe(true)
  })

  it('uses preview read only and never calls Plans backend or mutation capabilities', async () => {
    const view = mountPreview('/workspace/docs/report.html')
    await flushPromises()

    expect(view.find('iframe').exists()).toBe(true)
    expect(state.invoke).toHaveBeenCalledOnce()
    expect(state.invoke.mock.calls.some(([method]) => {
      const address = String(method)
      return address.startsWith('plans.') || address.startsWith('storage.') || /^fs\.(write|delete|rename)/.test(address)
    })).toBe(false)
  })

  it('shows a denied preview error without retaining an iframe', async () => {
    state.invoke.mockRejectedValueOnce(new Error('preview denied'))
    const view = mountPreview('/workspace/docs/private.html')
    await flushPromises()

    expect(view.find('iframe').exists()).toBe(false)
    expect(view.get('[role="alert"]').text()).toContain('preview denied')
  })

  it('ignores a delayed response from the previous path', async () => {
    const oldResponse = deferred<{ url: string }>()
    const newResponse = deferred<{ url: string }>()
    state.invoke.mockImplementation((_method: string, args: { path: string }) =>
      args.path === '/workspace/docs/old.html' ? oldResponse.promise : newResponse.promise)

    const view = mountPreview('/workspace/docs/old.html', 'old.html')
    await view.setProps({ path: '/workspace/docs/new.html', name: 'new.html' })
    expect(state.invoke).toHaveBeenCalledTimes(2)

    oldResponse.resolve({ url: 'navide-resource://preview/old.html' })
    await flushPromises()
    expect(view.find('iframe').exists()).toBe(false)

    newResponse.resolve({ url: 'navide-resource://preview/new.html' })
    await flushPromises()
    expect(view.get('iframe').attributes('src')).toBe('navide-resource://preview/new.html')
  })

  it('ignores a delayed response after unmount', async () => {
    const response = deferred<{ url: string }>()
    state.invoke.mockReturnValue(response.promise)
    const view = mountPreview('/workspace/docs/unmounted.html')
    await view.vm.$nextTick()
    view.unmount()

    response.resolve({ url: 'navide-resource://preview/unmounted.html' })
    await flushPromises()
    expect(view.find('iframe').exists()).toBe(false)
  })

  it('opens the original path through the explicit ui.openPath action', async () => {
    const view = mountPreview('/workspace/docs/report.html')
    await flushPromises()
    state.invoke.mockClear()

    await view.get('.fpv-open-btn').trigger('click')
    await flushPromises()

    expect(state.invoke).toHaveBeenCalledOnce()
    expect(state.invoke).toHaveBeenCalledWith('ui.openPath', { path: '/workspace/docs/report.html' })
    expect(state.invoke).not.toHaveBeenCalledWith('ui.openExternal', expect.anything())
  })
})
