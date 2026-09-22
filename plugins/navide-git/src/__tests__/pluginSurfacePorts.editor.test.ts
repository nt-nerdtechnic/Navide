import { describe, expect, it, vi } from 'vitest'
import { createPluginGitUiPort, type PluginCapabilitySdk } from '../pluginSurfacePorts'

function sdkWith(response: unknown) {
  const request = vi.fn(async () => response as never)
  return {
    sdk: { request } as unknown as PluginCapabilitySdk,
    request,
  }
}

describe('navide.git editor port compatibility', () => {
  it('keeps legacy empty-success responses as opened true', async () => {
    const { sdk, request } = sdkWith({ ok: true, payload: {}, error: null })

    await expect(createPluginGitUiPort(sdk).openInEditor({
      workspacePath: '/repo', filepath: 'src/main.ts',
    })).resolves.toEqual({ opened: true })
    expect(request).toHaveBeenCalledWith('ui.open_in_editor', {
      workspace_path: '/repo', filepath: 'src/main.ts',
    })
  })

  it('preserves explicit opened false and rejects transport errors', async () => {
    const refused = sdkWith({ ok: true, payload: { opened: false, error: 'refused' }, error: null })
    await expect(createPluginGitUiPort(refused.sdk).openInEditor({
      workspacePath: '/repo', filepath: 'src/main.ts',
    })).resolves.toEqual({ opened: false, error: 'refused' })

    const failed = sdkWith({ ok: false, payload: null, error: { code: 'BACKEND_ERROR', message: 'bridge failed' } })
    await expect(createPluginGitUiPort(failed.sdk).openInEditor({
      workspacePath: '/repo', filepath: 'src/main.ts',
    })).rejects.toThrow('bridge failed')
  })
})
