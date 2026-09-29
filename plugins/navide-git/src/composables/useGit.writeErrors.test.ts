// @vitest-environment happy-dom
import { effectScope, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { GitTransport } from '#git-feature'
import { useGit } from './useGit'

describe('useGit write failures', () => {
  it('reports the transport error instead of "no response" when a write is refused', async () => {
    const transport = {
      status: ref('connected'),
      on: () => () => undefined,
      send: vi.fn(async () => ({
        ok: false,
        payload: null,
        error: { code: 'CAPABILITY_DENIED', message: 'workspace path does not match the Host binding' },
      })),
    } as unknown as GitTransport
    const scope = effectScope()
    const git = scope.run(() => useGit(() => '/workspace', transport))!
    const result = await git.stageFiles(['a.txt'])
    expect(result.ok).toBe(false)
    expect(result.error).toBe('workspace path does not match the Host binding')
    expect(git.gitError.value).toContain('workspace path does not match the Host binding')
    scope.stop()
  })
})
