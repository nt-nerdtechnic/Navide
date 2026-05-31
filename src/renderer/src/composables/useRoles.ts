import { onScopeDispose, ref, shallowRef } from 'vue'
import type { useBackend } from './useBackend'

export interface Role {
  key: string
  label: string
  one_line: string
  system_prompt: string
  is_default?: boolean
  created_at?: string
  updated_at?: string
}

/**
 * Per-window roles cache. Loads from backend on mount and refreshes whenever
 * the backend broadcasts a `roles.changed` event (triggered by any window's
 * upsert / delete / reset). Reconnect-safe.
 */
export function useRoles(backend: ReturnType<typeof useBackend>) {
  const roles = ref<Role[]>([])
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
      const resp = await backend.send<{ roles: Role[]; path: string }>('roles.list', {})
      if (!resp.ok || !resp.payload) {
        error.value = resp.error?.message ?? 'failed to load roles'
        return
      }
      roles.value = resp.payload.roles
      path.value = resp.payload.path
      loaded.value = true
    } catch (err) {
      error.value = String((err as Error).message ?? err)
    } finally {
      loading.value = false
    }
  }

  async function upsert(input: {
    key: string
    label: string
    one_line: string
    system_prompt: string
  }): Promise<Role | null> {
    const resp = await backend.send<{ role: Role; roles: Role[] }>('roles.upsert', {
      key: input.key,
      label: input.label,
      one_line: input.one_line,
      system_prompt: input.system_prompt
    })
    if (!resp.ok || !resp.payload) {
      error.value = resp.error?.message ?? 'upsert failed'
      return null
    }
    roles.value = resp.payload.roles
    return resp.payload.role
  }

  async function remove(key: string): Promise<boolean> {
    const resp = await backend.send<{ roles: Role[] }>('roles.delete', { key })
    if (!resp.ok || !resp.payload) {
      error.value = resp.error?.message ?? 'delete failed'
      return false
    }
    roles.value = resp.payload.roles
    return true
  }

  async function reset(): Promise<boolean> {
    const resp = await backend.send<{ roles: Role[] }>('roles.reset', {})
    if (!resp.ok || !resp.payload) {
      error.value = resp.error?.message ?? 'reset failed'
      return false
    }
    roles.value = resp.payload.roles
    return true
  }

  function find(key: string): Role | undefined {
    return roles.value.find((r) => r.key === key)
  }

  // Subscribe to backend broadcasts so the cache stays in sync across windows.
  unsubChanged = backend.on('roles.changed', (raw) => {
    const payload = raw as { roles: Role[] }
    if (payload?.roles) roles.value = payload.roles
  })

  // Initial load — wait until backend is connected then fetch. Also re-fetch
  // on reconnect.
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

  return { roles, path, loaded, loading, error, refresh, upsert, remove, reset, find }
}
