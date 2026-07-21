// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { useMiniIdePluginEnabled } from '../useMiniIdePluginEnabled'

function setPlugins(api: unknown): void {
  ;(window as unknown as Record<string, unknown>).agentTeam = { plugins: api }
}

describe('useMiniIdePluginEnabled', () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).agentTeam
  })

  it('starts false and flips true when the main process reports enabled', async () => {
    setPlugins({ isEnabled: vi.fn().mockResolvedValue(true) })
    const enabled = useMiniIdePluginEnabled()
    // Fail-closed until the async IPC resolves.
    expect(enabled.value).toBe(false)
    await flushPromises()
    expect(enabled.value).toBe(true)
  })

  it('stays false when the flag is off', async () => {
    setPlugins({ isEnabled: vi.fn().mockResolvedValue(false) })
    const enabled = useMiniIdePluginEnabled()
    await flushPromises()
    expect(enabled.value).toBe(false)
  })

  it('stays false when the plugins API is unavailable', async () => {
    // No agentTeam on window at all.
    const enabled = useMiniIdePluginEnabled()
    await flushPromises()
    expect(enabled.value).toBe(false)
  })

  it('stays false when the IPC rejects', async () => {
    setPlugins({ isEnabled: vi.fn().mockRejectedValue(new Error('nope')) })
    const enabled = useMiniIdePluginEnabled()
    await flushPromises()
    expect(enabled.value).toBe(false)
  })
})
