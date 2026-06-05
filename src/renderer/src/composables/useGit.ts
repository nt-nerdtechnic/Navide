import { ref, computed, watch, onScopeDispose } from 'vue'
import type { useBackend } from './useBackend'

export interface GitFileEntry {
  path: string
  status: string
}

export interface GitStatus {
  is_git_repo: boolean
  branch: string
  remote_branch: string
  ahead: number
  behind: number
  staged: GitFileEntry[]
  unstaged: GitFileEntry[]
  untracked: GitFileEntry[]
  ignored: GitFileEntry[]
  operation_in_progress: string // '' | 'merge' | 'rebase' | 'cherry-pick'
}

export type IgnoreTarget = 'project' | 'nested' | 'local' | 'global'

export interface CheckIgnoreResult {
  ok: boolean
  ignored: boolean
  tracked: boolean
  source: string
  line: number
  pattern: string
  error?: string
}

export interface GitCommit {
  hash: string
  short_hash: string
  message: string
  branches: string[]
  parents: string[]
}

export interface GitBranch {
  name: string
  is_current: boolean
  is_remote: boolean
  tracking: string
}

export interface GitStashEntry {
  index: number
  ref: string
  message: string
}

export interface GitRemote {
  name: string
  fetch_url: string
  push_url: string
}

export interface GitTag {
  name: string
  commit_hash: string
  message: string
}

export interface GitWorktree {
  path: string
  head: string
  branch: string
  is_main: boolean
}

export interface BlameEntry {
  short_hash: string
  author: string
  date: string
  line_no: number
  content: string
}

export interface DiffBlameLine {
  kind: ' ' | '-' | '+'
  old_no: number | null
  new_no: number | null
  text: string
  author: string
  date: string
  committed: boolean
}

export interface DiffBlameHunk {
  header: string
  lines: DiffBlameLine[]
}

export interface GitCommitDetail {
  hash: string
  short_hash: string
  author_name: string
  author_email: string
  date: string
  message: string
  body: string
  files: string[]
}

const emptyStatus = (): GitStatus => ({
  is_git_repo: false,
  branch: '',
  remote_branch: '',
  ahead: 0,
  behind: 0,
  staged: [],
  unstaged: [],
  untracked: [],
  ignored: [],
  operation_in_progress: '',
})

export function useGit(
  workspacePath: () => string,
  backend: ReturnType<typeof useBackend>,
) {
  const { send, on } = backend

  const gitStatus = ref<GitStatus>(emptyStatus())
  const showIgnored = ref(false)
  const gitLog = ref<GitCommit[]>([])
  // History view scope (SourceTree-style): 'all' shows every branch's commits as
  // a multi-lane DAG, 'current' shows only HEAD's ancestry. logLimit grows via
  // loadMoreLog() to page through history without breaking the graph.
  const LOG_PAGE = 50
  const LOG_SCOPE_KEY = 'agentTeam.git.logScope'
  const loadLogScope = (): 'all' | 'current' => {
    try {
      return localStorage.getItem(LOG_SCOPE_KEY) === 'current' ? 'current' : 'all'
    } catch {
      return 'all'
    }
  }
  const logScope = ref<'all' | 'current'>(loadLogScope())
  const logLimit = ref(LOG_PAGE)
  const gitBranches = ref<GitBranch[]>([])
  const gitStashes = ref<GitStashEntry[]>([])
  const gitRemotes = ref<GitRemote[]>([])
  const gitTags = ref<GitTag[]>([])
  const gitWorktrees = ref<GitWorktree[]>([])
  const gitConfig = ref<Record<string, string>>({})
  const isLoadingStatus = ref(false)
  const isLoadingLog = ref(false)
  const isCommitting = ref(false)
  const isSyncing = ref(false)
  const isFetching = ref(false)
  const isGenerating = ref(false)
  const syncOutput = ref('')
  const syncError = ref('')
  // Single error channel for write operations: captures both ws-not-open
  // rejections and backend {ok:false} responses so failures are never silent.
  const gitError = ref('')
  function clearGitError(): void { gitError.value = '' }
  async function runWrite(
    type: string,
    payload: Record<string, unknown>,
  ): Promise<{ ok: boolean; error?: string }> {
    gitError.value = ''
    try {
      const resp = await send<{ ok: boolean; error?: string }>(type, payload)
      const r = resp.payload ?? { ok: false, error: 'no response' }
      if (!r.ok) gitError.value = r.error || `${type} failed`
      return r
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gitError.value = `${type}: ${msg}`
      return { ok: false, error: msg }
    }
  }

  async function loadStatus(): Promise<void> {
    const ws = workspacePath()
    if (!ws) {
      gitStatus.value = emptyStatus()
      return
    }
    isLoadingStatus.value = true
    try {
      const resp = await send<GitStatus>('git.status', {
        workspace_path: ws,
        include_ignored: showIgnored.value,
      })
      if (resp.ok && resp.payload) {
        gitStatus.value = resp.payload
      }
    } finally {
      isLoadingStatus.value = false
    }
  }

  async function loadLog(): Promise<void> {
    const ws = workspacePath()
    if (!ws) {
      gitLog.value = []
      return
    }
    isLoadingLog.value = true
    try {
      const resp = await send<{ commits: GitCommit[] }>('git.log', {
        workspace_path: ws,
        n: logLimit.value,
        all: logScope.value === 'all',
      })
      if (resp.ok && resp.payload) {
        gitLog.value = resp.payload.commits ?? []
      }
    } finally {
      isLoadingLog.value = false
    }
  }

  // Whether more commits may exist beyond what's loaded (full page came back).
  const canLoadMoreLog = computed(() => gitLog.value.length >= logLimit.value)

  async function loadMoreLog(): Promise<void> {
    logLimit.value += LOG_PAGE
    await loadLog()
  }

  async function setLogScope(scope: 'all' | 'current'): Promise<void> {
    if (logScope.value === scope) return
    logScope.value = scope
    logLimit.value = LOG_PAGE
    try { localStorage.setItem(LOG_SCOPE_KEY, scope) } catch { /* ignore */ }
    await loadLog()
  }

  async function compareBranches(base: string, compare: string): Promise<{ ok: boolean; stat: string; files: string[]; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, stat: '', files: [], error: 'no workspace' }
    const resp = await send<{ ok: boolean; stat: string; files: string[]; error?: string }>(
      'git.compare_branches', { workspace_path: ws, base, compare }
    )
    return resp.payload ?? { ok: false, stat: '', files: [], error: 'no response' }
  }

  async function rebaseOn(branch: string): Promise<{ ok: boolean; output?: string; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    const resp = await send<{ ok: boolean; output: string; error: string }>('git.rebase', { workspace_path: ws, branch })
    if (resp.ok && resp.payload?.ok) { await loadStatus(); await loadLog() }
    return resp.payload ?? { ok: false, error: 'no response' }
  }

  async function restoreFileFromBranch(branch: string, filepath: string): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    const resp = await send<{ ok: boolean; error?: string }>('git.restore_from_branch', { workspace_path: ws, branch, filepath })
    if (resp.ok && resp.payload?.ok) await loadStatus()
    return resp.payload ?? { ok: false, error: 'no response' }
  }

  async function cleanUntracked(dry_run: boolean): Promise<{ ok: boolean; files: string[]; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, files: [], error: 'no workspace' }
    const resp = await send<{ ok: boolean; files: string[]; dry_run: boolean; error?: string }>(
      'git.clean', { workspace_path: ws, dry_run }
    )
    if (resp.ok && resp.payload?.ok && !dry_run) await loadStatus()
    return resp.payload ? { ok: resp.payload.ok, files: resp.payload.files ?? [], error: resp.payload.error } : { ok: false, files: [], error: 'no response' }
  }

  async function showCommit(commit_hash: string): Promise<GitCommitDetail | null> {
    const ws = workspacePath()
    if (!ws) return null
    const resp = await send<GitCommitDetail & { ok: boolean; error?: string }>('git.show_commit', { workspace_path: ws, commit_hash })
    if (resp.ok && resp.payload?.ok) return resp.payload as GitCommitDetail
    return null
  }

  async function pushUpstream(branch: string, remote = 'origin'): Promise<{ ok: boolean; output?: string; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    const resp = await send<{ ok: boolean; output: string; error: string }>(
      'git.push_upstream', { workspace_path: ws, branch, remote }, 30_000
    )
    if (resp.ok && resp.payload?.ok) await loadStatus()
    return resp.payload ?? { ok: false, error: 'no response' }
  }

  async function loadWorktrees(): Promise<void> {
    const ws = workspacePath()
    if (!ws) { gitWorktrees.value = []; return }
    const resp = await send<{ worktrees: GitWorktree[] }>('git.worktrees', { workspace_path: ws })
    if (resp.ok && resp.payload) gitWorktrees.value = resp.payload.worktrees ?? []
  }

  async function addWorktree(worktree_path: string, branch: string, new_branch = false): Promise<{ ok: boolean; output?: string; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    const resp = await send<{ ok: boolean; output: string; error: string }>(
      'git.add_worktree', { workspace_path: ws, worktree_path, branch, new_branch }
    )
    if (resp.ok && resp.payload?.ok) await loadWorktrees()
    return resp.payload ?? { ok: false, error: 'no response' }
  }

  async function removeWorktree(worktree_path: string, force = false): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    const resp = await send<{ ok: boolean; error: string }>('git.remove_worktree', { workspace_path: ws, worktree_path, force })
    if (resp.ok && resp.payload?.ok) await loadWorktrees()
    return resp.payload ?? { ok: false, error: 'no response' }
  }

  const gitConfigAllowedKeys = ref<string[]>([])

  async function loadGitConfig(): Promise<void> {
    const ws = workspacePath()
    if (!ws) { gitConfig.value = {}; return }
    const resp = await send<{ ok: boolean; config: Record<string, string>; allowed_keys?: string[] }>('git.config_get', { workspace_path: ws })
    if (resp.ok && resp.payload?.ok) {
      gitConfig.value = resp.payload.config ?? {}
      if (resp.payload.allowed_keys) gitConfigAllowedKeys.value = resp.payload.allowed_keys
    }
  }

  async function setGitConfig(key: string, value: string): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    const resp = await send<{ ok: boolean; error?: string }>('git.config_set', { workspace_path: ws, key, value })
    if (resp.ok && resp.payload?.ok) await loadGitConfig()
    return resp.payload ?? { ok: false, error: 'no response' }
  }

  async function blameFile(filepath: string): Promise<BlameEntry[]> {
    const ws = workspacePath()
    if (!ws) return []
    const resp = await send<{ ok: boolean; lines: BlameEntry[] }>('git.blame', { workspace_path: ws, filepath })
    return resp.ok && resp.payload?.ok ? resp.payload.lines ?? [] : []
  }

  async function loadTags(): Promise<void> {
    const ws = workspacePath()
    if (!ws) { gitTags.value = []; return }
    const resp = await send<{ tags: GitTag[] }>('git.tags', { workspace_path: ws })
    if (resp.ok && resp.payload) gitTags.value = resp.payload.tags ?? []
  }

  async function createTag(name: string, message = '', commit_hash = ''): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    const resp = await send<{ ok: boolean; error?: string }>('git.create_tag', { workspace_path: ws, name, message, commit_hash })
    if (resp.ok && resp.payload?.ok) await loadTags()
    return resp.payload ?? { ok: false, error: 'no response' }
  }

  async function deleteTag(name: string): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    const resp = await send<{ ok: boolean; error?: string }>('git.delete_tag', { workspace_path: ws, name })
    if (resp.ok && resp.payload?.ok) await loadTags()
    return resp.payload ?? { ok: false, error: 'no response' }
  }

  async function cherryPick(commit_hash: string): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    const resp = await send<{ ok: boolean; error?: string }>('git.cherry_pick', { workspace_path: ws, commit_hash })
    if (resp.ok && resp.payload?.ok) { await loadStatus(); await loadLog() }
    return resp.payload ?? { ok: false, error: 'no response' }
  }

  async function fileLog(filepath: string, n = 15): Promise<GitCommit[]> {
    const ws = workspacePath()
    if (!ws) return []
    const resp = await send<{ commits: GitCommit[] }>('git.file_log', { workspace_path: ws, filepath, n })
    return resp.ok && resp.payload ? resp.payload.commits ?? [] : []
  }

  async function showFile(filepath: string, rev = 'HEAD'): Promise<{ ok: boolean; content: string; error: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, content: '', error: 'no workspace' }
    const resp = await send<{ ok: boolean; content: string; error: string }>('git.show_file', { workspace_path: ws, filepath, rev })
    return resp.payload ?? { ok: false, content: '', error: 'no response' }
  }

  async function resolveConflictOurs(filepath: string): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    const resp = await send<{ ok: boolean; error?: string }>('git.resolve_ours', { workspace_path: ws, filepath })
    if (resp.ok && resp.payload?.ok) await loadStatus()
    return resp.payload ?? { ok: false, error: 'no response' }
  }

  async function resolveConflictTheirs(filepath: string): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    const resp = await send<{ ok: boolean; error?: string }>('git.resolve_theirs', { workspace_path: ws, filepath })
    if (resp.ok && resp.payload?.ok) await loadStatus()
    return resp.payload ?? { ok: false, error: 'no response' }
  }

  async function loadRemotes(): Promise<void> {
    const ws = workspacePath()
    if (!ws) { gitRemotes.value = []; return }
    const resp = await send<{ remotes: GitRemote[] }>('git.remotes', { workspace_path: ws })
    if (resp.ok && resp.payload) gitRemotes.value = resp.payload.remotes ?? []
  }

  async function diffFile(filepath: string, staged = false): Promise<string> {
    const ws = workspacePath()
    if (!ws) return ''
    const resp = await send<{ ok: boolean; diff: string }>('git.diff_file', { workspace_path: ws, filepath, staged })
    return resp.ok && resp.payload?.ok ? (resp.payload.diff ?? '') : ''
  }

  async function diffBlame(filepath: string, staged = false): Promise<DiffBlameHunk[]> {
    const ws = workspacePath()
    if (!ws) return []
    const resp = await send<{ ok: boolean; hunks: DiffBlameHunk[] }>('git.diff_blame', { workspace_path: ws, filepath, staged })
    return resp.ok && resp.payload?.ok ? (resp.payload.hunks ?? []) : []
  }

  async function mergeBranch(branch: string): Promise<{ ok: boolean; output?: string; error?: string; conflict_files?: string[] }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    const resp = await send<{ ok: boolean; output: string; error: string; conflict_files: string[] }>('git.merge', { workspace_path: ws, branch })
    if (resp.ok && resp.payload?.ok) { await loadStatus(); await loadLog(); await loadBranches() }
    else if (resp.ok && resp.payload && !resp.payload.ok) { await loadStatus() }
    return resp.payload ?? { ok: false, error: 'no response' }
  }

  async function mergeInto(target: string): Promise<{ ok: boolean; output?: string; error?: string; conflict_files?: string[]; source_branch?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    const resp = await send<{ ok: boolean; output: string; error: string; conflict_files: string[]; source_branch: string }>('git.merge_into', { workspace_path: ws, target })
    if (resp.ok && resp.payload?.ok) { await loadStatus(); await loadLog(); await loadBranches() }
    else if (resp.ok && resp.payload && !resp.payload.ok) { await loadStatus() }
    return resp.payload ?? { ok: false, error: 'no response' }
  }

  async function revertCommit(commit_hash: string): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    const resp = await send<{ ok: boolean; error?: string }>('git.revert', { workspace_path: ws, commit_hash })
    if (resp.ok && resp.payload?.ok) { await loadStatus(); await loadLog() }
    return resp.payload ?? { ok: false, error: 'no response' }
  }

  async function addRemote(name: string, url: string): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    const resp = await send<{ ok: boolean; error?: string }>('git.add_remote', { workspace_path: ws, name, url })
    if (resp.ok && resp.payload?.ok) await loadRemotes()
    return resp.payload ?? { ok: false, error: 'no response' }
  }

  async function removeRemote(name: string): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    const resp = await send<{ ok: boolean; error?: string }>('git.remove_remote', { workspace_path: ws, name })
    if (resp.ok && resp.payload?.ok) await loadRemotes()
    return resp.payload ?? { ok: false, error: 'no response' }
  }

  async function loadBranches(): Promise<void> {
    const ws = workspacePath()
    if (!ws) { gitBranches.value = []; return }
    const resp = await send<{ ok: boolean; branches: GitBranch[] }>('git.branches', { workspace_path: ws })
    if (resp.ok && resp.payload?.ok) gitBranches.value = resp.payload.branches ?? []
  }

  async function loadStashes(): Promise<void> {
    const ws = workspacePath()
    if (!ws) { gitStashes.value = []; return }
    const resp = await send<{ stashes: GitStashEntry[] }>('git.stash_list', { workspace_path: ws })
    if (resp.ok && resp.payload) gitStashes.value = resp.payload.stashes ?? []
  }

  async function discardFile(path: string): Promise<void> {
    const ws = workspacePath()
    if (!ws) return
    await runWrite('git.discard', { workspace_path: ws, files: [path] })
    await loadStatus()
  }

  async function fetchRemote(): Promise<{ ok: boolean; output: string; error: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, output: '', error: 'no workspace' }
    isFetching.value = true
    try {
      const resp = await send<{ ok: boolean; output: string; error: string }>('git.fetch', { workspace_path: ws }, 30_000)
      await loadStatus()
      await loadBranches()
      return resp.payload ?? { ok: false, output: '', error: 'no response' }
    } finally {
      isFetching.value = false
    }
  }

  async function pullOnly(): Promise<{ ok: boolean; output: string; error: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, output: '', error: 'no workspace' }
    const resp = await send<{ ok: boolean; output: string; error: string }>('git.pull', { workspace_path: ws }, 30_000)
    await loadStatus()
    return resp.payload ?? { ok: false, output: '', error: 'no response' }
  }

  async function pushOnly(remote = '', branch = ''): Promise<{ ok: boolean; output: string; error: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, output: '', error: 'no workspace' }
    const resp = await send<{ ok: boolean; output: string; error: string }>('git.push', { workspace_path: ws, remote, branch }, 30_000)
    await loadStatus()
    return resp.payload ?? { ok: false, output: '', error: 'no response' }
  }

  async function createBranch(name: string): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    const resp = await send<{ ok: boolean; error?: string }>('git.create_branch', { workspace_path: ws, name, switch_to: true })
    if (resp.ok && resp.payload?.ok) { await loadStatus(); await loadBranches() }
    return resp.payload ?? { ok: false, error: 'no response' }
  }

  async function switchBranch(name: string): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    const resp = await send<{ ok: boolean; error?: string }>('git.switch_branch', { workspace_path: ws, name })
    if (resp.ok && resp.payload?.ok) { await loadStatus(); await loadBranches(); await loadLog() }
    return resp.payload ?? { ok: false, error: 'no response' }
  }

  async function checkoutRemoteBranch(remote_ref: string): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    const resp = await send<{ ok: boolean; error?: string }>('git.checkout_remote_branch', { workspace_path: ws, remote_ref })
    if (resp.ok && resp.payload?.ok) { await loadStatus(); await loadBranches(); await loadLog() }
    return resp.payload ?? { ok: false, error: 'no response' }
  }

  async function deleteBranch(name: string, force = false): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    const resp = await send<{ ok: boolean; error?: string }>('git.delete_branch', { workspace_path: ws, name, force })
    if (resp.ok && resp.payload?.ok) await loadBranches()
    return resp.payload ?? { ok: false, error: 'no response' }
  }

  async function stashPush(message = '', paths?: string[]): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    const resp = await send<{ ok: boolean; error?: string }>('git.stash', { workspace_path: ws, message, paths })
    if (resp.ok && resp.payload?.ok) { await loadStatus(); await loadStashes() }
    return resp.payload ?? { ok: false, error: 'no response' }
  }

  async function stashPop(index = 0): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    const resp = await send<{ ok: boolean; error?: string }>('git.stash_pop', { workspace_path: ws, index })
    if (resp.ok && resp.payload?.ok) { await loadStatus(); await loadStashes() }
    return resp.payload ?? { ok: false, error: 'no response' }
  }

  async function stashDrop(index: number): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    const resp = await send<{ ok: boolean; error?: string }>('git.stash_drop', { workspace_path: ws, index })
    if (resp.ok && resp.payload?.ok) await loadStashes()
    return resp.payload ?? { ok: false, error: 'no response' }
  }

  async function amendCommit(message = ''): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    const resp = await send<{ ok: boolean; error?: string }>('git.amend', { workspace_path: ws, message })
    if (resp.ok && resp.payload?.ok) { await loadStatus(); await loadLog() }
    return resp.payload ?? { ok: false, error: 'no response' }
  }

  async function undoLastCommit(): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    const resp = await send<{ ok: boolean; error?: string }>('git.undo_commit', { workspace_path: ws })
    if (resp.ok && resp.payload?.ok) { await loadStatus(); await loadLog() }
    return resp.payload ?? { ok: false, error: 'no response' }
  }

  const isInitializing = ref(false)

  async function initRepo(createGitignore = true): Promise<{ ok: boolean; error?: string; gitignore_created?: boolean }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    isInitializing.value = true
    try {
      const resp = await send<{ ok: boolean; error?: string; gitignore_created?: boolean }>(
        'git.init',
        { workspace_path: ws, create_gitignore: createGitignore },
      )
      if (resp.ok && resp.payload?.ok) {
        await loadStatus()
        await loadLog()
        return { ok: true, gitignore_created: resp.payload.gitignore_created }
      }
      return { ok: false, error: resp.payload?.error || resp.error?.message || 'git init failed' }
    } finally {
      isInitializing.value = false
    }
  }

  async function stageFile(path: string): Promise<void> {
    const ws = workspacePath()
    if (!ws) return
    await runWrite('git.stage', { workspace_path: ws, files: [path] })
    await loadStatus()
  }

  async function unstageFile(path: string): Promise<void> {
    const ws = workspacePath()
    if (!ws) return
    await runWrite('git.unstage', { workspace_path: ws, files: [path] })
    await loadStatus()
  }

  async function stageAll(): Promise<void> {
    const ws = workspacePath()
    if (!ws) return
    await runWrite('git.stage_all', { workspace_path: ws })
    await loadStatus()
  }

  async function stageFiles(paths: string[]): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    if (!paths.length) return { ok: true }
    const r = await runWrite('git.stage', { workspace_path: ws, files: paths })
    await loadStatus()
    return r
  }

  async function unstageFiles(paths: string[]): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    if (!paths.length) return { ok: true }
    const r = await runWrite('git.unstage', { workspace_path: ws, files: paths })
    await loadStatus()
    return r
  }

  async function discardFiles(paths: string[]): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    if (!paths.length) return { ok: true }
    const r = await runWrite('git.discard', { workspace_path: ws, files: paths })
    await loadStatus()
    return r
  }

  async function commit(message: string, all = false): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    isCommitting.value = true
    try {
      const resp = await send<{ ok: boolean; error?: string; hash?: string }>(
        'git.commit',
        { workspace_path: ws, message, all },
      )
      if (resp.ok && resp.payload?.ok) {
        await loadStatus()
        await loadLog()
        return { ok: true }
      }
      return { ok: false, error: resp.payload?.error || resp.error?.message || 'commit failed' }
    } finally {
      isCommitting.value = false
    }
  }

  async function sync(): Promise<void> {
    const ws = workspacePath()
    if (!ws) return
    isSyncing.value = true
    syncOutput.value = ''
    syncError.value = ''
    try {
      const resp = await send<{ ok: boolean; pull_output: string; push_output: string; error: string }>(
        'git.sync',
        { workspace_path: ws },
        30_000,
      )
      if (resp.ok && resp.payload) {
        const { pull_output, push_output, error } = resp.payload
        syncOutput.value = [pull_output, push_output].filter(Boolean).join('\n').trim()
        syncError.value = error || ''
        await loadStatus()
        await loadLog()
      }
    } finally {
      isSyncing.value = false
    }
  }

  async function generateMessage(
    model: string,
    attemptCount = 0,
  ): Promise<{ ok: boolean; message: string; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, message: '', error: 'no workspace' }
    isGenerating.value = true
    try {
      const resp = await send<{ ok: boolean; message: string; error?: string }>(
        'git.generate_message',
        { workspace_path: ws, model, attempt_count: attemptCount },
        45_000,
      )
      if (resp.ok && resp.payload?.ok) {
        return { ok: true, message: resp.payload.message }
      }
      return { ok: false, message: '', error: resp.payload?.error || resp.error?.message || 'generation failed' }
    } finally {
      isGenerating.value = false
    }
  }

  async function checkStaged(): Promise<{ ok: boolean; errorCount: number; summary: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: true, errorCount: 0, summary: '' }
    try {
      const resp = await send<{ ok: boolean; error_count: number; summary: string }>(
        'git.check_staged',
        { workspace_path: ws },
        35_000,
      )
      if (resp.payload) {
        return { ok: resp.payload.ok, errorCount: resp.payload.error_count, summary: resp.payload.summary }
      }
      return { ok: true, errorCount: 0, summary: '' }
    } catch {
      return { ok: true, errorCount: 0, summary: '' }
    }
  }

  // Hunk / line-level staging: apply a frontend-built patch to the index.
  // reverse=true unstages; cached=false applies to the working tree (discard).
  async function applyPatch(
    patch: string,
    reverse = false,
    cached = true,
  ): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    const resp = await send<{ ok: boolean; error?: string }>('git.apply_patch', {
      workspace_path: ws,
      patch,
      reverse,
      cached,
    })
    if (resp.ok && resp.payload?.ok) await loadStatus()
    return resp.payload ?? { ok: false, error: 'no response' }
  }

  async function connectToRemote(
    url: string,
  ): Promise<{ ok: boolean; branch?: string; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    const resp = await send<{ ok: boolean; branch?: string; error?: string }>(
      'git.connect_to_remote',
      { workspace_path: ws, url },
      60_000,
    )
    return resp.payload ?? { ok: false, error: 'no response' }
  }

  async function cloneRepo(
    url: string,
    target_dir: string,
  ): Promise<{ ok: boolean; path?: string; error?: string }> {
    const resp = await send<{ ok: boolean; path: string; error?: string }>('git.clone', {
      url,
      target_dir,
    })
    return resp.payload ?? { ok: false, error: 'no response' }
  }

  async function addToGitignore(
    pattern: string,
    target: IgnoreTarget = 'project',
    untrack = true,
  ): Promise<{ ok: boolean; error?: string; target_file?: string; untracked?: string[] }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    const resp = await send<{ ok: boolean; error?: string; target_file?: string; untracked?: string[] }>(
      'git.ignore',
      { workspace_path: ws, pattern, target, untrack },
    )
    if (resp.ok && resp.payload?.ok) await loadStatus()
    return resp.payload ?? { ok: false, error: 'no response' }
  }

  async function checkIgnore(filepath: string): Promise<CheckIgnoreResult> {
    const ws = workspacePath()
    if (!ws) return { ok: false, ignored: false, tracked: false, source: '', line: 0, pattern: '', error: 'no workspace' }
    const resp = await send<CheckIgnoreResult>('git.check_ignore', { workspace_path: ws, filepath })
    return resp.payload ?? { ok: false, ignored: false, tracked: false, source: '', line: 0, pattern: '', error: 'no response' }
  }

  async function abortOperation(op: string): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    const resp = await send<{ ok: boolean; error?: string }>('git.abort', {
      workspace_path: ws,
      op,
    })
    if (resp.ok && resp.payload?.ok) {
      await loadStatus()
      await loadLog()
    }
    return resp.payload ?? { ok: false, error: 'no response' }
  }

  async function stashApply(index: number): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    const resp = await send<{ ok: boolean; error?: string }>('git.stash_apply', {
      workspace_path: ws,
      index,
    })
    if (resp.ok && resp.payload?.ok) await loadStatus()
    return resp.payload ?? { ok: false, error: 'no response' }
  }

  async function pullRebase(): Promise<{ ok: boolean; output?: string; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    const resp = await send<{ ok: boolean; output: string; error: string }>('git.pull_rebase', {
      workspace_path: ws,
    })
    if (resp.ok && resp.payload?.ok) {
      await loadStatus()
      await loadLog()
    }
    return resp.payload ?? { ok: false, error: 'no response' }
  }

  async function pushForce(remote = '', branch = ''): Promise<{ ok: boolean; output?: string; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    const resp = await send<{ ok: boolean; output: string; error: string }>('git.push_force', {
      workspace_path: ws, remote, branch,
    })
    if (resp.ok && resp.payload?.ok) await loadStatus()
    return resp.payload ?? { ok: false, error: 'no response' }
  }

  // Refresh when workspace changes
  watch(workspacePath, () => {
    gitStatus.value = emptyStatus()
    gitLog.value = []
    gitBranches.value = []
    gitStashes.value = []
    gitRemotes.value = []
    gitTags.value = []
    gitWorktrees.value = []
    gitConfig.value = {}
    void loadStatus()
    void loadLog()
    void loadBranches()
    void loadStashes()
    void loadRemotes()
    void loadTags()
    void loadWorktrees()
    void loadGitConfig()
  }, { immediate: true })

  // Re-fetch status when the "show ignored files" toggle flips.
  watch(showIgnored, () => { if (workspacePath()) void loadStatus() })

  // No background polling. Like VS Code/Cursor, refresh is purely event-driven:
  // the backend GitWatcher broadcasts git.changed on any disk change. The one
  // gap our cross-process setup has (that an in-editor extension doesn't) is a
  // WebSocket drop — a git.changed emitted while disconnected is lost. So on
  // (re)connect, re-sync once; loadStatus also re-registers this workspace with
  // the backend GitWatcher via git.status.
  const _stopReconnect = watch(
    () => backend.status.value,
    (s) => { if (s === 'connected' && workspacePath()) void loadStatus() },
  )
  onScopeDispose(_stopReconnect)

  // Refresh on backend git.changed broadcast
  on('git.changed', (payload: unknown) => {
    const p = payload as { workspace_path?: string }
    if (!p?.workspace_path || p.workspace_path === workspacePath()) {
      void loadStatus()
      void loadLog()
      void loadBranches()
      void loadStashes()
      void loadRemotes()
      void loadTags()
      void loadWorktrees()
    }
  })

  return {
    // state
    gitStatus, showIgnored, gitLog, gitBranches, gitStashes, gitRemotes, gitTags,
    gitWorktrees, gitConfig,
    logScope, logLimit, canLoadMoreLog,
    isLoadingStatus, isLoadingLog, isInitializing,
    isCommitting, isSyncing, isFetching, isGenerating,
    syncOutput, syncError,
    gitError, clearGitError,
    // loaders
    loadStatus, loadLog, loadMoreLog, setLogScope, loadBranches, loadStashes, loadRemotes, loadTags,
    loadWorktrees, loadGitConfig,
    // init
    initRepo,
    // file operations
    stageFile, unstageFile, stageAll, stageFiles, unstageFiles, discardFiles, discardFile, diffFile,
    fileLog, showFile, resolveConflictOurs, resolveConflictTheirs,
    cleanUntracked, blameFile, diffBlame,
    // remote
    fetchRemote, pullOnly, pushOnly, pushUpstream, sync,
    addRemote, removeRemote,
    // branches
    createBranch, switchBranch, checkoutRemoteBranch, deleteBranch, mergeBranch, mergeInto, rebaseOn,
    compareBranches, restoreFileFromBranch,
    // stash
    stashPush, stashPop, stashDrop,
    // tags
    createTag, deleteTag,
    // worktrees
    addWorktree, removeWorktree,
    // config
    gitConfigAllowedKeys, setGitConfig,
    // commit
    commit, amendCommit, undoLastCommit, revertCommit, cherryPick, generateMessage,
    checkStaged,
    showCommit,
    // vscode-parity additions
    applyPatch, cloneRepo, connectToRemote, addToGitignore, checkIgnore, abortOperation, stashApply,
    pullRebase, pushForce,
  }
}
