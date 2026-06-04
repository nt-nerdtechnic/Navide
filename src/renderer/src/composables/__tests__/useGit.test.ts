// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { useGit } from '../useGit'
import { createMockBackend, withScope, flush } from './mockBackend'

const WS = '/tmp/test-workspace'

const mockStatus = {
  is_git_repo: true,
  branch: 'main',
  remote_branch: 'origin/main',
  ahead: 1,
  behind: 0,
  staged: [{ path: 'src/foo.ts', status: 'M' }],
  unstaged: [],
  untracked: [{ path: 'new.txt', status: '?' }],
}

describe('useGit', () => {
  it('loads status on init when workspace is set', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('git.status', mockStatus)
    mock.setResponse('git.log', { commits: [] })

    const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
    await flush()

    expect(result.gitStatus.value.is_git_repo).toBe(true)
    expect(result.gitStatus.value.branch).toBe('main')
    expect(result.gitStatus.value.staged).toHaveLength(1)
    scope.stop()
  })

  it('returns empty status when workspace is empty', async () => {
    const mock = createMockBackend('connected')

    const { result, scope } = withScope(() => useGit(() => '', mock.backend))
    await flush()

    expect(result.gitStatus.value.is_git_repo).toBe(false)
    expect(mock.sent.find(s => s.type === 'git.status')).toBeUndefined()
    scope.stop()
  })

  it('loads log on init', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('git.status', mockStatus)
    mock.setResponse('git.log', {
      commits: [{ hash: 'abc123', short_hash: 'abc123', message: 'feat: init', branches: ['main'] }],
    })

    const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
    await flush()

    expect(result.gitLog.value).toHaveLength(1)
    expect(result.gitLog.value[0].message).toBe('feat: init')
    scope.stop()
  })

  it('stageFile sends git.stage and reloads status', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('git.status', mockStatus)
    mock.setResponse('git.log', { commits: [] })
    mock.setResponse('git.stage', { ok: true })

    const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
    await flush()

    await result.stageFile('new.txt')
    await flush()

    const stageCall = mock.sent.find(s => s.type === 'git.stage')
    expect(stageCall).toBeDefined()
    expect(stageCall?.payload.files).toEqual(['new.txt'])
    scope.stop()
  })

  it('sets gitError when a write op fails, and clears it on next success', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('git.status', mockStatus)
    mock.setResponse('git.log', { commits: [] })
    mock.setResponse('git.unstage', { ok: false, error: 'could not resolve HEAD' })
    mock.setResponse('git.stage', { ok: true })

    const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
    await flush()

    expect(result.gitError.value).toBe('')

    await result.unstageFiles(['a.txt'])
    await flush()
    expect(result.gitError.value).toBe('could not resolve HEAD')

    // A subsequent successful write clears the prior error.
    await result.stageFile('a.txt')
    await flush()
    expect(result.gitError.value).toBe('')
    scope.stop()
  })

  it('clearGitError resets the error channel', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('git.status', mockStatus)
    mock.setResponse('git.log', { commits: [] })
    mock.setResponse('git.discard', { ok: false, error: 'boom' })

    const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
    await flush()

    await result.discardFiles(['x.txt'])
    await flush()
    expect(result.gitError.value).toBe('boom')

    result.clearGitError()
    expect(result.gitError.value).toBe('')
    scope.stop()
  })

  it('commit sends git.commit and reloads on success', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('git.status', mockStatus)
    mock.setResponse('git.log', { commits: [] })
    mock.setResponse('git.commit', { ok: true, hash: 'abc1234' })

    const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
    await flush()

    const commitResult = await result.commit('feat: test commit')
    await flush()

    expect(commitResult.ok).toBe(true)
    const commitCall = mock.sent.find(s => s.type === 'git.commit')
    expect(commitCall?.payload.message).toBe('feat: test commit')
    scope.stop()
  })

  it('commit returns error when backend reports failure', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('git.status', mockStatus)
    mock.setResponse('git.log', { commits: [] })
    mock.setResponse('git.commit', { ok: false, error: 'nothing to commit' })

    const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
    await flush()

    const commitResult = await result.commit('empty commit')
    expect(commitResult.ok).toBe(false)
    expect(commitResult.error).toBeTruthy()
    scope.stop()
  })

  it('refreshes on git.changed broadcast', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('git.status', mockStatus)
    mock.setResponse('git.log', { commits: [] })

    const { scope } = withScope(() => useGit(() => WS, mock.backend))
    await flush()

    const countBefore = mock.sent.filter(s => s.type === 'git.status').length

    mock.emit('git.changed', { workspace_path: WS })
    await flush()

    const countAfter = mock.sent.filter(s => s.type === 'git.status').length
    expect(countAfter).toBeGreaterThan(countBefore)
    scope.stop()
  })

  it('does not refresh on git.changed for different workspace', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('git.status', mockStatus)
    mock.setResponse('git.log', { commits: [] })

    const { scope } = withScope(() => useGit(() => WS, mock.backend))
    await flush()

    const countBefore = mock.sent.filter(s => s.type === 'git.status').length

    mock.emit('git.changed', { workspace_path: '/other/path' })
    await flush()

    const countAfter = mock.sent.filter(s => s.type === 'git.status').length
    expect(countAfter).toBe(countBefore)
    scope.stop()
  })

  it('applyPatch sends git.apply_patch with reverse/cached flags', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('git.status', mockStatus)
    mock.setResponse('git.log', { commits: [] })
    mock.setResponse('git.apply_patch', { ok: true })

    const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
    await flush()

    const r = await result.applyPatch('PATCH', true, false)
    await flush()

    expect(r.ok).toBe(true)
    const call = mock.sent.find(s => s.type === 'git.apply_patch')
    expect(call?.payload).toMatchObject({ patch: 'PATCH', reverse: true, cached: false })
    scope.stop()
  })

  it('cloneRepo sends git.clone and returns the cloned path', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('git.status', mockStatus)
    mock.setResponse('git.log', { commits: [] })
    mock.setResponse('git.clone', { ok: true, path: '/tmp/cloned/repo' })

    const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
    await flush()

    const r = await result.cloneRepo('https://example.com/x.git', '/tmp/cloned/repo')
    expect(r.ok).toBe(true)
    expect(r.path).toBe('/tmp/cloned/repo')
    const call = mock.sent.find(s => s.type === 'git.clone')
    expect(call?.payload).toMatchObject({ url: 'https://example.com/x.git', target_dir: '/tmp/cloned/repo' })
    scope.stop()
  })

  it('addToGitignore sends git.ignore with the pattern', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('git.status', mockStatus)
    mock.setResponse('git.log', { commits: [] })
    mock.setResponse('git.ignore', { ok: true })

    const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
    await flush()

    await result.addToGitignore('node_modules/')
    const call = mock.sent.find(s => s.type === 'git.ignore')
    expect(call?.payload.pattern).toBe('node_modules/')
    scope.stop()
  })

  it('abortOperation sends git.abort with the op', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('git.status', mockStatus)
    mock.setResponse('git.log', { commits: [] })
    mock.setResponse('git.abort', { ok: true })

    const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
    await flush()

    await result.abortOperation('rebase')
    const call = mock.sent.find(s => s.type === 'git.abort')
    expect(call?.payload.op).toBe('rebase')
    scope.stop()
  })

  it('stashApply sends git.stash_apply with the index', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('git.status', mockStatus)
    mock.setResponse('git.log', { commits: [] })
    mock.setResponse('git.stash_apply', { ok: true })

    const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
    await flush()

    await result.stashApply(2)
    const call = mock.sent.find(s => s.type === 'git.stash_apply')
    expect(call?.payload.index).toBe(2)
    scope.stop()
  })

  it('pullRebase and pushForce send their message types', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('git.status', mockStatus)
    mock.setResponse('git.log', { commits: [] })
    mock.setResponse('git.pull_rebase', { ok: true, output: 'rebased', error: '' })
    mock.setResponse('git.push_force', { ok: true, output: 'forced', error: '' })

    const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
    await flush()

    const pr = await result.pullRebase()
    const pf = await result.pushForce()
    expect(pr.ok).toBe(true)
    expect(pf.ok).toBe(true)
    expect(mock.sent.find(s => s.type === 'git.pull_rebase')).toBeDefined()
    expect(mock.sent.find(s => s.type === 'git.push_force')).toBeDefined()
    scope.stop()
  })
})
