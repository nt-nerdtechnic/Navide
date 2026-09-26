// @vitest-environment happy-dom
import { effectScope, ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import type { GitTransport } from '#git-feature'
import { useGit } from './useGit'

function setup(isPrepared: () => boolean): {
  send: ReturnType<typeof vi.fn>
  git: ReturnType<typeof useGit>
  scope: ReturnType<typeof effectScope>
} {
  const send = vi.fn(async () => ({ ok: true, payload: { ok: true }, error: null }))
  const transport = {
    status: ref('connected'),
    send,
    on: () => () => undefined,
  } as unknown as GitTransport
  const scope = effectScope()
  const git = scope.run(() => useGit(() => '/workspace', transport, { isPrepared }))!
  return { send, git, scope }
}

describe('useGit close preparation gate', () => {
  const READ_TYPES = new Set([
    'git.status', 'git.log', 'git.branches', 'git.stash_list', 'git.remotes', 'git.tags',
    'git.worktrees', 'git.config_get', 'git.blame', 'git.file_log', 'git.diff_file',
    'git.diff_blame', 'git.diff_branches', 'git.compare_branches', 'git.conflict_stages',
    'git.list_conflicts', 'git.show_commit', 'git.show_file', 'git.check_ignore',
    'git.check_staged', 'git.commit_file_diff', 'git.discover_repositories',
  ])

  it('refuses every mutating request while prepared and keeps reads flowing', async () => {
    let prepared = false
    const { send, git, scope } = setup(() => prepared)
    await flushPromises()
    send.mockClear()
    prepared = true

    await git.stageFile('src/App.ts')
    await git.commit('pending draft')
    await git.fetchRemote()
    await git.setGitConfig('user.name', 'nope')
    expect(send.mock.calls.filter(([type]) => !READ_TYPES.has(type as string))).toEqual([])

    await git.loadStatus()
    await git.loadLog()
    expect(send).toHaveBeenCalledWith('git.status', expect.anything())
    expect(send).toHaveBeenCalledWith('git.log', expect.anything())
    scope.stop()
  })

  it('resumes mutations after release and reports the refusal reason', async () => {
    let prepared = true
    const { send, git, scope } = setup(() => prepared)
    await flushPromises()

    await expect(git.commit('blocked')).resolves.toMatchObject({
      ok: false,
      error: 'Blocked git.commit while the pane is prepared to close.',
    })
    expect(send.mock.calls.filter(([type]) => type === 'git.commit')).toEqual([])

    prepared = false
    send.mockClear()
    await git.commit('allowed')
    expect(send).toHaveBeenCalledWith('git.commit', expect.anything(), 20_000)
    scope.stop()
  })
})
