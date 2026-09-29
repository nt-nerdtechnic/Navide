// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@navide/plugin-sdk', () => ({
  createPluginCapabilityClient: () => ({
    capabilities: { invoke },
    events: { subscribe: () => ({ dispose() {} }) },
  }),
  createPluginViewRuntimeClient: () => ({
    onBackendStatus: () => ({ dispose() {} }),
    onOpenTarget: () => ({ dispose() {} }),
    ready() {},
  }),
}))

describe('useBackend error mapping', () => {
  it('keeps the error code the Host reported instead of flattening it', async () => {
    const { useBackend } = await import('../useBackend')
    invoke.mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'CAPABILITY_DENIED' }))
    const res = await useBackend().send('fs.stat_path', { rel_path: 'a.txt' })
    expect(res.ok).toBe(false)
    expect(res.error).toEqual({ code: 'CAPABILITY_DENIED', message: 'denied' })
  })

  it('falls back to CAPABILITY_ERROR for errors without a string code', async () => {
    const { useBackend } = await import('../useBackend')
    invoke.mockRejectedValueOnce(new Error('boom'))
    const res = await useBackend().send('fs.stat_path', { rel_path: 'a.txt' })
    expect(res.error).toEqual({ code: 'CAPABILITY_ERROR', message: 'boom' })
  })
})
