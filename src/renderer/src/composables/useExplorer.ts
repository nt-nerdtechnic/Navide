import { ref, watch, onScopeDispose, type Ref } from 'vue'
import type { useBackend } from './useBackend'
import type { GitStatus } from './useGit'

export interface FsEntry {
  name: string
  rel_path: string
  is_dir: boolean
  is_hidden: boolean
  is_noise: boolean
}

interface ListDirResult {
  ok: boolean
  entries?: FsEntry[]
  error?: string
}

const SHOW_HIDDEN_KEY = 'agentTeam.explorerShowHidden'

/**
 * useExplorer — lazy directory tree backed by the `fs.*` WebSocket API.
 *
 * State is per-instance (keyed off the given workspace). Children are loaded on
 * demand and cached; toggling `showHidden` or a `git.changed` event invalidates
 * the cache and reloads whatever is currently expanded. Git status is NOT
 * fetched here — the host merges it as an overlay via {@link statusFor}.
 */
export function useExplorer(backend: ReturnType<typeof useBackend>, workspacePath: Ref<string>) {
  const childrenCache = ref<Map<string, FsEntry[]>>(new Map())
  const expanded = ref<Set<string>>(new Set())
  const loadingDirs = ref<Set<string>>(new Set())
  const error = ref('')

  const showHidden = ref<boolean>(
    (() => {
      try {
        return sessionStorage.getItem(SHOW_HIDDEN_KEY) === '1'
      } catch {
        return false
      }
    })()
  )

  function ws(): string {
    return workspacePath.value || ''
  }

  async function fetchDir(rel: string): Promise<FsEntry[]> {
    const resp = await backend.send<ListDirResult>('fs.list_dir', {
      workspace_path: ws(),
      rel_path: rel,
      show_hidden: showHidden.value,
    })
    const payload = resp.payload
    if (!payload?.ok) {
      error.value = payload?.error || resp.error?.message || 'failed to list directory'
      return []
    }
    error.value = ''
    return payload.entries ?? []
  }

  /** Load (and cache) the children of `rel`. Returns the cached list. */
  async function loadDir(rel: string): Promise<FsEntry[]> {
    if (!ws()) return []
    loadingDirs.value = new Set(loadingDirs.value).add(rel)
    try {
      const entries = await fetchDir(rel)
      const next = new Map(childrenCache.value)
      next.set(rel, entries)
      childrenCache.value = next
      return entries
    } finally {
      const s = new Set(loadingDirs.value)
      s.delete(rel)
      loadingDirs.value = s
    }
  }

  function isExpanded(rel: string): boolean {
    return expanded.value.has(rel)
  }

  function isLoading(rel: string): boolean {
    return loadingDirs.value.has(rel)
  }

  /** Expand/collapse a directory, lazy-loading children on first expand. */
  async function toggleDir(rel: string): Promise<void> {
    const next = new Set(expanded.value)
    if (next.has(rel)) {
      next.delete(rel)
      expanded.value = next
      return
    }
    next.add(rel)
    expanded.value = next
    if (!childrenCache.value.has(rel)) await loadDir(rel)
  }

  /** Drop all caches and reload the root + every currently expanded dir. */
  async function reloadAll(): Promise<void> {
    childrenCache.value = new Map()
    const dirs = ['', ...expanded.value]
    await Promise.all(dirs.map((d) => loadDir(d)))
  }

  /** Refresh the root and visible expanded dirs without collapsing anything. */
  async function refreshVisible(): Promise<void> {
    const dirs = ['', ...expanded.value]
    await Promise.all(dirs.map((d) => loadDir(d)))
  }

  function setShowHidden(value: boolean): void {
    showHidden.value = value
    try {
      sessionStorage.setItem(SHOW_HIDDEN_KEY, value ? '1' : '0')
    } catch {
      /* ignore */
    }
    void reloadAll()
  }

  // ── Git status overlay ────────────────────────────────────────────────────
  /**
   * Build a relPath → status-letter map from a GitStatus. staged paths win
   * (so the Explorer can pass the right `staged` flag when opening a diff).
   */
  function buildStatusMap(status: GitStatus | null): Map<string, { letter: string; staged: boolean }> {
    const map = new Map<string, { letter: string; staged: boolean }>()
    if (!status) return map
    for (const e of status.unstaged ?? []) map.set(e.path, { letter: e.status.trim() || 'M', staged: false })
    for (const e of status.untracked ?? []) map.set(e.path, { letter: 'U', staged: false })
    for (const e of status.staged ?? []) map.set(e.path, { letter: e.status.trim() || 'M', staged: true })
    return map
  }

  // ── git.changed → invalidate ──────────────────────────────────────────────
  const off = backend.on('git.changed', () => {
    if (ws()) void refreshVisible()
  })
  onScopeDispose(() => off())

  // Reset when the workspace changes.
  watch(workspacePath, () => {
    childrenCache.value = new Map()
    expanded.value = new Set()
    error.value = ''
  })

  return {
    childrenCache,
    expanded,
    showHidden,
    error,
    isExpanded,
    isLoading,
    loadDir,
    toggleDir,
    reloadAll,
    refreshVisible,
    setShowHidden,
    buildStatusMap,
  }
}
