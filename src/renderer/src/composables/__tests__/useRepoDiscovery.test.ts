// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockBackend, withScope, flush } from './mockBackend'
import { useRepoDiscovery } from '../useRepoDiscovery'
import type { GitStatus } from '../useGit'

const EMPTY_STATUS: GitStatus = {
  is_git_repo: true,
  branch: '',
  remote_branch: '',
  ahead: 0,
  behind: 0,
  staged: [],
  unstaged: [],
  untracked: [],
  ignored: [],
  operation_in_progress: '',
}

function makeDiscoverResp(repos: { rel_path: string; abs_path: string; branch: string }[]) {
  return { ok: true, repositories: repos }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('useRepoDiscovery', () => {
  it('returns empty list when workspace is empty string', async () => {
    const mock = createMockBackend('connected')
    const { result, scope } = withScope(() =>
      useRepoDiscovery(() => '', mock.backend),
    )
    await flush()
    expect(result.repositories.value).toEqual([])
    scope.stop()
  })

  it('fetches discovered repos and badge on init', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('git.discover_repositories', makeDiscoverResp([
      { rel_path: '.', abs_path: '/ws', branch: 'main' },
      { rel_path: 'sub', abs_path: '/ws/sub', branch: 'dev' },
    ]))
    mock.setResponse('git.status', {
      ...EMPTY_STATUS,
      branch: 'main',
      staged: [{ path: 'a.ts', status: 'M' }],
    })

    const { result, scope } = withScope(() =>
      useRepoDiscovery(() => '/ws', mock.backend),
    )
    await flush()

    expect(result.repositories.value).toHaveLength(2)
    expect(result.repositories.value[0].rel_path).toBe('.')
    expect(result.repositories.value[0].badge.dirtyCount).toBe(1)
    expect(result.repositories.value[0].badge.branch).toBe('main')
    scope.stop()
  })

  it('badge dirtyCount sums staged + unstaged + untracked', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('git.discover_repositories', makeDiscoverResp([
      { rel_path: 'a', abs_path: '/ws/a', branch: 'main' },
    ]))
    mock.setResponse('git.status', {
      ...EMPTY_STATUS,
      staged: [{ path: 'x', status: 'M' }],
      unstaged: [{ path: 'y', status: 'M' }],
      untracked: [{ path: 'z', status: '?' }, { path: 'w', status: '?' }],
    })

    const { result, scope } = withScope(() =>
      useRepoDiscovery(() => '/ws', mock.backend),
    )
    await flush()

    expect(result.repositories.value[0].badge.dirtyCount).toBe(4)
    scope.stop()
  })

  it('refreshes on git.changed broadcast after debounce', async () => {
    vi.useFakeTimers()
    const mock = createMockBackend('connected')
    mock.setResponse('git.discover_repositories', makeDiscoverResp([
      { rel_path: 'a', abs_path: '/ws/a', branch: 'main' },
    ]))
    mock.setResponse('git.status', { ...EMPTY_STATUS, branch: 'main' })

    const { result, scope } = withScope(() =>
      useRepoDiscovery(() => '/ws', mock.backend),
    )
    // Flush the immediate watch trigger (async send chain).
    await vi.runAllTimersAsync()

    expect(result.repositories.value).toHaveLength(1)

    // Update preset to 2 repos, then emit git.changed.
    mock.setResponse('git.discover_repositories', makeDiscoverResp([
      { rel_path: 'a', abs_path: '/ws/a', branch: 'main' },
      { rel_path: 'b', abs_path: '/ws/b', branch: 'feat' },
    ]))
    mock.emit('git.changed', {})

    // Before debounce (400ms) fires, list unchanged.
    expect(result.repositories.value).toHaveLength(1)

    await vi.runAllTimersAsync()
    expect(result.repositories.value).toHaveLength(2)
    scope.stop()
  })

  it('ignores git.changed for an unrelated workspace_path', async () => {
    vi.useFakeTimers()
    const mock = createMockBackend('connected')
    mock.setResponse('git.discover_repositories', makeDiscoverResp([
      { rel_path: 'a', abs_path: '/ws/a', branch: 'main' },
    ]))
    mock.setResponse('git.status', { ...EMPTY_STATUS, branch: 'main' })

    const { result, scope } = withScope(() =>
      useRepoDiscovery(() => '/ws', mock.backend),
    )
    await vi.runAllTimersAsync()
    expect(result.repositories.value).toHaveLength(1)

    mock.setResponse('git.discover_repositories', makeDiscoverResp([
      { rel_path: 'a', abs_path: '/ws/a', branch: 'main' },
      { rel_path: 'b', abs_path: '/ws/b', branch: 'feat' },
    ]))
    // '/ws2' shares the '/ws' string prefix but is NOT under '/ws/'.
    mock.emit('git.changed', { workspace_path: '/ws2' })
    await vi.runAllTimersAsync()

    // No refresh: repository list is unchanged.
    expect(result.repositories.value).toHaveLength(1)
    scope.stop()
  })

  it('refreshes on git.changed for the same workspace_path', async () => {
    vi.useFakeTimers()
    const mock = createMockBackend('connected')
    mock.setResponse('git.discover_repositories', makeDiscoverResp([
      { rel_path: 'a', abs_path: '/ws/a', branch: 'main' },
    ]))
    mock.setResponse('git.status', { ...EMPTY_STATUS, branch: 'main' })

    const { result, scope } = withScope(() =>
      useRepoDiscovery(() => '/ws', mock.backend),
    )
    await vi.runAllTimersAsync()
    expect(result.repositories.value).toHaveLength(1)

    mock.setResponse('git.discover_repositories', makeDiscoverResp([
      { rel_path: 'a', abs_path: '/ws/a', branch: 'main' },
      { rel_path: 'b', abs_path: '/ws/b', branch: 'feat' },
    ]))
    mock.emit('git.changed', { workspace_path: '/ws' })
    await vi.runAllTimersAsync()

    expect(result.repositories.value).toHaveLength(2)
    scope.stop()
  })

  it('refreshes on git.changed for a path nested under the workspace', async () => {
    vi.useFakeTimers()
    const mock = createMockBackend('connected')
    mock.setResponse('git.discover_repositories', makeDiscoverResp([
      { rel_path: 'a', abs_path: '/ws/a', branch: 'main' },
    ]))
    mock.setResponse('git.status', { ...EMPTY_STATUS, branch: 'main' })

    const { result, scope } = withScope(() =>
      useRepoDiscovery(() => '/ws', mock.backend),
    )
    await vi.runAllTimersAsync()
    expect(result.repositories.value).toHaveLength(1)

    mock.setResponse('git.discover_repositories', makeDiscoverResp([
      { rel_path: 'a', abs_path: '/ws/a', branch: 'main' },
      { rel_path: 'b', abs_path: '/ws/b', branch: 'feat' },
    ]))
    mock.emit('git.changed', { workspace_path: '/ws/a' })
    await vi.runAllTimersAsync()

    expect(result.repositories.value).toHaveLength(2)
    scope.stop()
  })

  it('refreshes on git.changed without workspace_path (backward compat)', async () => {
    vi.useFakeTimers()
    const mock = createMockBackend('connected')
    mock.setResponse('git.discover_repositories', makeDiscoverResp([
      { rel_path: 'a', abs_path: '/ws/a', branch: 'main' },
    ]))
    mock.setResponse('git.status', { ...EMPTY_STATUS, branch: 'main' })

    const { result, scope } = withScope(() =>
      useRepoDiscovery(() => '/ws', mock.backend),
    )
    await vi.runAllTimersAsync()
    expect(result.repositories.value).toHaveLength(1)

    mock.setResponse('git.discover_repositories', makeDiscoverResp([
      { rel_path: 'a', abs_path: '/ws/a', branch: 'main' },
      { rel_path: 'b', abs_path: '/ws/b', branch: 'feat' },
    ]))
    mock.emit('git.changed', { some_other_field: true })
    await vi.runAllTimersAsync()

    expect(result.repositories.value).toHaveLength(2)
    scope.stop()
  })

  it('clears repositories when refresh is called with empty workspace', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('git.discover_repositories', makeDiscoverResp([
      { rel_path: 'a', abs_path: '/ws/a', branch: 'main' },
    ]))
    mock.setResponse('git.status', { ...EMPTY_STATUS })

    let ws = '/ws'
    const { result, scope } = withScope(() =>
      useRepoDiscovery(() => ws, mock.backend),
    )
    await flush()
    expect(result.repositories.value).toHaveLength(1)

    ws = ''
    await result.refresh()
    expect(result.repositories.value).toHaveLength(0)
    scope.stop()
  })
})
