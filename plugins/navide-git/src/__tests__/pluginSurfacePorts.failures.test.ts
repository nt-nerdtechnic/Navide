// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPluginCapabilitySdk } from '../pluginSurfacePorts'

afterEach(() => { delete (window as unknown as { nav?: unknown }).nav })

describe('plugin host request failures', () => {
  it('turns a rejected Host action into a failed response instead of throwing (MED-1)', async () => {
    ;(window as unknown as { nav: unknown }).nav = {
      callHostAction: vi.fn(async () => { throw new Error('ipc closed') }),
    }
    const sdk = createPluginCapabilitySdk({
      status: { value: 'connected' }, shell: { value: '' }, autoRestart: { value: null },
      send: vi.fn() as never, on: vi.fn() as never,
    })
    await expect(sdk.hostRequest('git.account', { operation: 'list' })).resolves.toEqual({
      ok: false, payload: null, error: { code: 'BROKER_ERROR', message: 'ipc closed' },
    })
  })
})
