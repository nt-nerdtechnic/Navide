// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn(async () => ({ ok: true }))
let grant: string | undefined

vi.mock('@navide/plugin-sdk', () => ({
  createPluginCapabilityClient: () => ({
    capabilities: { invoke },
    events: { subscribe: () => ({ dispose: () => {} }) },
  }),
  createPluginViewRuntimeClient: () => ({
    onBackendStatus: () => ({ dispose: () => {} }),
    onOpenTarget: () => ({ dispose: () => {} }),
  }),
}))

vi.mock('../composables/selectionTargets', () => ({
  fileGrant: () => grant,
  directoryGrant: () => undefined,
  rememberOpenTarget: () => {},
  targetPath: (_workspace: string, path: string) => path,
}))

const { useBackend } = await import('../composables/useBackend')

describe('mini-IDE Git capability mapping', () => {
  beforeEach(() => {
    invoke.mockClear()
    grant = undefined
  })

  it('maps a working-tree diff onto the fixed diff_file operation without the legacy commit field', async () => {
    await useBackend().send('git.diff_file', {
      workspace_path: '/ws', filepath: 'a.ts', staged: false, commit: '',
    })
    expect(invoke).toHaveBeenCalledWith('shell.gitDiffFile', {
      filepath: 'a.ts', staged: false, repositoryPath: '/ws',
    })
  })

  it('maps a commit-scoped diff onto the commit_file_diff operation', async () => {
    await useBackend().send('git.diff_file', {
      workspace_path: '/ws', filepath: 'a.ts', staged: false, commit: 'abc123',
    })
    expect(invoke).toHaveBeenCalledWith('shell.gitCommitFileDiff', {
      commit_hash: 'abc123', filepath: 'a.ts', repositoryPath: '/ws',
    })
  })

  it('drops read-only wire extras the fixed contract does not declare', async () => {
    await useBackend().send('git.status', { workspace_path: '/ws', target_grant: 'grant-1' })
    expect(invoke).toHaveBeenCalledWith('shell.gitStatus', { repositoryPath: '/ws' })
  })

  it('narrows a granted read to the selected file name the Host resolves against', async () => {
    grant = 'file-grant-1'
    await useBackend().send('fs.read_file', {
      workspace_path: '/ws', rel_path: 'docs/en-US/file.md',
    })
    expect(invoke).toHaveBeenCalledWith('fs.readFile', {
      path: 'file.md', selectionGrant: 'file-grant-1',
    })
  })
})
