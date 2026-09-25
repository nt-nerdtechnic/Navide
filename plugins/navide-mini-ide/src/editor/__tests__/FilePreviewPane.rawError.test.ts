// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import FilePreviewPane from '../FilePreviewPane.vue'
import { i18n } from '@navide/plugin-ui/foundation'

vi.mock('../../composables/native', () => ({ native: { openPath: vi.fn() } }))

i18n.global.locale.value = 'en-US'

const resourceUrl = (relPath: string): string => `navide-preview://resource/${encodeURIComponent(relPath)}`

type Send = (type: string, payload: Record<string, unknown>) => Promise<unknown>
const okResource: Send = async (type, payload) =>
  type === 'fs.preview_resource'
    ? { ok: true, payload: { url: resourceUrl(String(payload.rel_path)) }, error: null }
    : { ok: true, payload: null, error: null }
const unavailableResource: Send = async () =>
  ({ ok: false, payload: null, error: { code: 'CAPABILITY_ERROR', message: 'Access denied' } })

let send = vi.fn(okResource)

function mountPane(relPath: string) {
  return mount(FilePreviewPane, {
    props: {
      workspacePath: '/ws',
      relPath,
      name: relPath.split('/').pop()!,
      backend: { send } as never,
    },
    global: { plugins: [i18n] },
  })
}

function fakeResponse(bytes: Uint8Array, total: number) {
  return {
    ok: true,
    status: 206,
    headers: {
      get: (key: string) =>
        key.toLowerCase() === 'content-range' ? `bytes 0-${bytes.length - 1}/${total}` : null,
    },
    arrayBuffer: async () => bytes.slice().buffer,
  }
}
const forbidden = async () => ({ ok: false, status: 403, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) })
const fetchMock = vi.fn(async () => fakeResponse(new Uint8Array(0), 0) as unknown)

beforeEach(() => {
  send = vi.fn(okResource)
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () => fakeResponse(new Uint8Array(0), 0))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('FilePreviewPane – raw load failure', () => {
  it.each([
    ['photo.png', 'img.fpv-img'],
    ['clip.mp4', 'video.fpv-video'],
    ['song.mp3', 'audio.fpv-audio'],
  ])('shows an error instead of a blank area when %s fails to load', async (relPath, selector) => {
    const wrapper = mountPane(relPath)
    await flushPromises()
    expect(wrapper.find('.fpv-raw-error').exists()).toBe(false)
    await wrapper.find(selector).trigger('error')
    expect(wrapper.find('.fpv-raw-error').text()).toContain('Could not load this file for preview.')
    expect(wrapper.find(selector).exists()).toBe(false)
  })

  it('shows an error with the HTTP status when the PDF probe is rejected', async () => {
    Object.defineProperty(navigator, 'pdfViewerEnabled', { value: true, configurable: true })
    fetchMock.mockImplementation(forbidden)
    const wrapper = mountPane('doc.pdf')
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledWith(resourceUrl('doc.pdf'), { headers: { Range: 'bytes=0-0' } })
    expect(wrapper.find('.fpv-raw-error').text()).toContain('(HTTP 403)')
    expect(wrapper.find('iframe.fpv-pdf-frame').exists()).toBe(false)
  })

  it('shows no error when the PDF probe succeeds', async () => {
    Object.defineProperty(navigator, 'pdfViewerEnabled', { value: true, configurable: true })
    const wrapper = mountPane('doc.pdf')
    await flushPromises()
    expect(wrapper.find('.fpv-raw-error').exists()).toBe(false)
    expect(wrapper.find('iframe.fpv-pdf-frame').exists()).toBe(true)
  })

  it('treats a 416 PDF probe as an empty file, not an error', async () => {
    Object.defineProperty(navigator, 'pdfViewerEnabled', { value: true, configurable: true })
    fetchMock.mockImplementation(async () => ({
      ok: false,
      status: 416,
      headers: { get: (key: string) => (key.toLowerCase() === 'content-range' ? 'bytes */0' : null) },
      arrayBuffer: async () => new ArrayBuffer(0),
    }))
    const wrapper = mountPane('empty.pdf')
    await flushPromises()
    expect(wrapper.find('.fpv-raw-error').exists()).toBe(false)
    expect(wrapper.find('iframe.fpv-pdf-frame').exists()).toBe(true)
  })

  it('clears the error when switching to another file', async () => {
    const wrapper = mountPane('broken.png')
    await flushPromises()
    await wrapper.find('img.fpv-img').trigger('error')
    expect(wrapper.find('.fpv-raw-error').exists()).toBe(true)

    await wrapper.setProps({ relPath: 'ok.png', name: 'ok.png' })
    await flushPromises()
    expect(wrapper.find('.fpv-raw-error').exists()).toBe(false)
    expect(wrapper.find('img.fpv-img').attributes('src')).toBe(resourceUrl('ok.png'))
  })

  it('retry re-runs the PDF probe and clears the error once it succeeds', async () => {
    Object.defineProperty(navigator, 'pdfViewerEnabled', { value: true, configurable: true })
    fetchMock.mockImplementation(forbidden)
    const wrapper = mountPane('doc.pdf')
    await flushPromises()
    expect(wrapper.find('.fpv-raw-error').text()).toContain('(HTTP 403)')
    const probesBefore = fetchMock.mock.calls.length

    fetchMock.mockImplementation(async () => fakeResponse(new Uint8Array(1), 1))
    await wrapper.find('.fpv-retry-btn').trigger('click')
    await flushPromises()
    expect(fetchMock.mock.calls.length).toBe(probesBefore + 1)
    expect(wrapper.find('.fpv-raw-error').exists()).toBe(false)
    expect(wrapper.find('iframe.fpv-pdf-frame').exists()).toBe(true)
  })

  it('retry remounts a failed image so it loads again', async () => {
    const wrapper = mountPane('photo.png')
    await flushPromises()
    await wrapper.find('img.fpv-img').trigger('error')
    expect(wrapper.find('.fpv-retry-btn').text()).toBe('Retry')

    await wrapper.find('.fpv-retry-btn').trigger('click')
    expect(wrapper.find('.fpv-raw-error').exists()).toBe(false)
    expect(wrapper.find('img.fpv-img').exists()).toBe(true)
  })

  it('shows the error when the Host refuses the preview resource, and retry asks again', async () => {
    send = vi.fn(unavailableResource)
    const wrapper = mountPane('photo.png')
    await flushPromises()
    expect(wrapper.find('.fpv-raw-error').text()).toContain('(Access denied)')
    expect(wrapper.find('img.fpv-img').exists()).toBe(false)

    send.mockImplementation(okResource)
    await wrapper.find('.fpv-retry-btn').trigger('click')
    await flushPromises()
    expect(send).toHaveBeenCalledTimes(2)
    expect(wrapper.find('.fpv-raw-error').exists()).toBe(false)
    expect(wrapper.find('img.fpv-img').attributes('src')).toBe(resourceUrl('photo.png'))
  })
})
