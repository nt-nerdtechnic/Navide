import { describe, it, expect, vi } from 'vitest'
import { loadImageDataUrl } from '../imageData'

function mockBackend(resp: unknown, throws = false) {
  return {
    send: vi.fn(async () => {
      if (throws) throw new Error('ws closed')
      return resp
    }),
  } as unknown as Parameters<typeof loadImageDataUrl>[0]
}

describe('loadImageDataUrl', () => {
  it('returns the data URL on success', async () => {
    const backend = mockBackend({ ok: true, payload: { ok: true, data_url: 'data:image/png;base64,AAAA' } })
    expect(await loadImageDataUrl(backend, '/ws', 'pic.png')).toBe('data:image/png;base64,AAAA')
  })

  it('returns empty string when backend reports failure', async () => {
    const backend = mockBackend({ ok: true, payload: { ok: false } })
    expect(await loadImageDataUrl(backend, '/ws', 'pic.png')).toBe('')
  })

  it('returns empty string on transport error', async () => {
    const backend = mockBackend(null, true)
    expect(await loadImageDataUrl(backend, '/ws', 'pic.png')).toBe('')
  })

  it('sends fs.read_image with workspace_path and rel_path', async () => {
    const backend = mockBackend({ ok: true, payload: { ok: true, data_url: 'data:,' } })
    await loadImageDataUrl(backend, '/ws', 'a/b.png')
    expect(backend.send).toHaveBeenCalledWith('fs.read_image', { workspace_path: '/ws', rel_path: 'a/b.png' })
  })
})
