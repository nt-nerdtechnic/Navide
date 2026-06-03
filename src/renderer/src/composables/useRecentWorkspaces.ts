import { onScopeDispose, ref, shallowRef } from 'vue'
import type { useBackend } from './useBackend'

export interface RecentWorkspace {
  path: string
  name: string
  last_opened_at: string
  pinned: boolean
  last_known_state: string
  last_known_task: string
  /** Whether the folder still exists on disk (backend-annotated). */
  exists: boolean
}

/**
 * Per-window recent-workspaces cache. Loads from backend on connect and
 * refreshes whenever the backend broadcasts `workspace.recent_changed`
 * (triggered by any window's touch / pin / unpin). Reconnect-safe.
 * Mirrors the useRoles / useStages pattern.
 */
export function useRecentWorkspaces(backend: ReturnType<typeof useBackend>) {
  const recent = ref<RecentWorkspace[]>([])
  const path = shallowRef<string>('')
  const loaded = ref<boolean>(false)
  const loading = ref<boolean>(false)
  const error = ref<string>('')

  let unsubChanged: (() => void) | null = null
  let unsubBackend: (() => void) | null = null

  async function refresh(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      const resp = await backend.send<{ recent: RecentWorkspace[]; path: string }>(
        'workspace.list_recent',
        {}
      )
      if (!resp.ok || !resp.payload) {
        error.value = resp.error?.message ?? 'failed to load recent workspaces'
        return
      }
      recent.value = resp.payload.recent
      path.value = resp.payload.path
      loaded.value = true
    } catch (err) {
      error.value = String((err as Error).message ?? err)
    } finally {
      loading.value = false
    }
  }

  async function touch(p: string, state = '', task = ''): Promise<boolean> {
    const resp = await backend.send<{ recent: RecentWorkspace[] }>('workspace.touch', {
      path: p,
      state,
      task
    })
    if (!resp.ok || !resp.payload) {
      error.value = resp.error?.message ?? 'touch failed'
      return false
    }
    recent.value = resp.payload.recent
    return true
  }

  async function pin(p: string): Promise<boolean> {
    const resp = await backend.send<{ recent: RecentWorkspace[] }>('workspace.pin', { path: p })
    if (!resp.ok || !resp.payload) {
      error.value = resp.error?.message ?? 'pin failed'
      return false
    }
    recent.value = resp.payload.recent
    return true
  }

  async function unpin(p: string): Promise<boolean> {
    const resp = await backend.send<{ recent: RecentWorkspace[] }>('workspace.unpin', { path: p })
    if (!resp.ok || !resp.payload) {
      error.value = resp.error?.message ?? 'unpin failed'
      return false
    }
    recent.value = resp.payload.recent
    return true
  }

  async function remove(p: string): Promise<boolean> {
    const resp = await backend.send<{ recent: RecentWorkspace[] }>('workspace.remove', { path: p })
    if (!resp.ok || !resp.payload) {
      error.value = resp.error?.message ?? 'remove failed'
      return false
    }
    recent.value = resp.payload.recent
    return true
  }

  // Keep the cache in sync across windows.
  unsubChanged = backend.on('workspace.recent_changed', (raw) => {
    const payload = raw as { recent: RecentWorkspace[] }
    if (payload?.recent) recent.value = payload.recent
  })

  // Initial load once connected; re-fetch on reconnect.
  let lastStatus = backend.status.value
  function maybeLoad(): void {
    if (backend.status.value === 'connected') void refresh()
  }
  maybeLoad()
  unsubBackend = (() => {
    const id = window.setInterval(() => {
      if (backend.status.value !== lastStatus) {
        lastStatus = backend.status.value
        maybeLoad()
      }
    }, 500)
    return () => window.clearInterval(id)
  })()

  onScopeDispose(() => {
    unsubChanged?.()
    unsubBackend?.()
  })

  return { recent, path, loaded, loading, error, refresh, touch, pin, unpin, remove }
}
