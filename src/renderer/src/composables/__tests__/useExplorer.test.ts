// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest'
import { ref } from 'vue'
import { useExplorer, type FsEntry } from '../useExplorer'
import type { GitStatus } from '../useGit'
import { createMockBackend, withScope, flush } from './mockBackend'

function entries(): FsEntry[] {
  return [
    { name: 'src', rel_path: 'src', is_dir: true, is_hidden: false, is_noise: false },
    { name: 'README.md', rel_path: 'README.md', is_dir: false, is_hidden: false, is_noise: false },
  ]
}

describe('useExplorer', () => {
  beforeEach(() => {
    try { sessionStorage.clear() } catch { /* ignore */ }
  })

  it('loadDir caches entries from fs.list_dir', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('fs.list_dir', { ok: true, entries: entries() })
    const wp = ref('/ws')
    const { result, scope } = withScope(() => useExplorer(mock.backend, wp))
    await result.loadDir('')
    expect(result.childrenCache.value.get('')).toHaveLength(2)
    expect(mock.sent.some((s) => s.type === 'fs.list_dir')).toBe(true)
    scope.stop()
  })

  it('surfaces an error when the backend reports failure', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('fs.list_dir', null, { ok: false, error: { code: 'X', message: 'boom' } })
    const wp = ref('/ws')
    const { result, scope } = withScope(() => useExplorer(mock.backend, wp))
    await result.loadDir('')
    expect(result.error.value).toBeTruthy()
    expect(result.childrenCache.value.get('')).toEqual([])
    scope.stop()
  })

  it('toggleDir expands and lazy-loads, collapse keeps no children walk', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('fs.list_dir', { ok: true, entries: entries() })
    const wp = ref('/ws')
    const { result, scope } = withScope(() => useExplorer(mock.backend, wp))
    await result.toggleDir('src')
    expect(result.isExpanded('src')).toBe(true)
    expect(result.childrenCache.value.has('src')).toBe(true)
    await result.toggleDir('src')
    expect(result.isExpanded('src')).toBe(false)
    scope.stop()
  })

  it('setShowHidden persists and reloads with show_hidden=true', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('fs.list_dir', { ok: true, entries: entries() })
    const wp = ref('/ws')
    const { result, scope } = withScope(() => useExplorer(mock.backend, wp))
    result.setShowHidden(true)
    await flush()
    expect(result.showHidden.value).toBe(true)
    expect(sessionStorage.getItem('agentTeam.explorerShowHidden')).toBe('1')
    const last = mock.sent.filter((s) => s.type === 'fs.list_dir').at(-1)
    expect((last?.payload as { show_hidden?: boolean }).show_hidden).toBe(true)
    scope.stop()
  })

  it('git.changed triggers a visible refresh', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('fs.list_dir', { ok: true, entries: entries() })
    const wp = ref('/ws')
    const { result, scope } = withScope(() => useExplorer(mock.backend, wp))
    await result.loadDir('')
    const before = mock.sent.filter((s) => s.type === 'fs.list_dir').length
    mock.emit('git.changed', { workspace_path: '/ws' })
    await flush()
    const after = mock.sent.filter((s) => s.type === 'fs.list_dir').length
    expect(after).toBeGreaterThan(before)
    scope.stop()
  })

  it('buildStatusMap: staged wins, untracked → U, unstaged → letter', () => {
    const mock = createMockBackend('connected')
    const wp = ref('/ws')
    const { result, scope } = withScope(() => useExplorer(mock.backend, wp))
    const status = {
      staged: [{ path: 'a.ts', status: 'M' }],
      unstaged: [{ path: 'a.ts', status: 'M' }, { path: 'b.ts', status: 'M' }],
      untracked: [{ path: 'c.ts', status: '?' }],
    } as unknown as GitStatus
    const map = result.buildStatusMap(status)
    expect(map.get('a.ts')).toEqual({ letter: 'M', staged: true })   // staged overrides unstaged
    expect(map.get('b.ts')).toEqual({ letter: 'M', staged: false })
    expect(map.get('c.ts')).toEqual({ letter: 'U', staged: false })
    expect(result.buildStatusMap(null).size).toBe(0)
    scope.stop()
  })
})
