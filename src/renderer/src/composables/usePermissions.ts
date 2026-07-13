import { computed, getCurrentInstance, onUnmounted, ref } from 'vue'

// TccPermissionKey / TccPermissionStatus are ambient globals declared in env.d.ts,
// alongside the `agentTeam.permissions` bridge signature they belong to.
export const PERMISSION_KEYS: TccPermissionKey[] = ['automation', 'notifications', 'folders', 'fullDisk']

// Full Disk Access cannot be requested from inside the app — the user flips it
// in System Settings — so it never gates the wizard.
export const OPTIONAL_PERMISSIONS: TccPermissionKey[] = ['fullDisk']

const UNKNOWN: Record<TccPermissionKey, TccPermissionStatus> = {
  automation: 'unknown',
  notifications: 'unknown',
  folders: 'unknown',
  fullDisk: 'unknown',
}

/**
 * usePermissions — drives the macOS permission step of the onboarding wizard.
 * All TCC state lives in the Electron main process; this composable is a thin
 * client over the `agentTeam.permissions` IPC bridge.
 *
 * Requests are only ever fired from an explicit user click: a TCC prompt is
 * one-shot per app signature, so `refresh()` must stay side-effect free.
 */
export function usePermissions() {
  const statuses = ref<Record<TccPermissionKey, TccPermissionStatus>>({ ...UNKNOWN })
  const requesting = ref<TccPermissionKey | ''>('')

  const bridge = () => window.agentTeam?.permissions

  async function refresh(): Promise<void> {
    const api = bridge()
    if (!api) {
      // No bridge (non-Electron host / older preload) — nothing to grant here.
      statuses.value = {
        automation: 'not-applicable',
        notifications: 'not-applicable',
        folders: 'not-applicable',
        fullDisk: 'not-applicable',
      }
      return
    }
    try {
      statuses.value = { ...statuses.value, ...(await api.status()) }
    } catch {
      /* keep the last known statuses — a failed poll must not reset the UI */
    }
  }

  async function request(key: TccPermissionKey, payload?: { title?: string; body?: string }): Promise<void> {
    const api = bridge()
    if (!api || requesting.value) return
    requesting.value = key
    try {
      statuses.value = { ...statuses.value, [key]: await api.request(key, payload) }
    } catch {
      statuses.value = { ...statuses.value, [key]: 'unknown' }
    } finally {
      requesting.value = ''
    }
  }

  async function openSettings(key: TccPermissionKey): Promise<void> {
    await bridge()?.openSettings(key)
  }

  // Full Disk Access is granted outside the app, so poll while the step is
  // visible to reflect the toggle without asking the user to click Re-detect.
  let pollTimer: ReturnType<typeof setInterval> | null = null

  function startPolling(intervalMs = 3000): void {
    if (pollTimer) return
    pollTimer = setInterval(() => void refresh(), intervalMs)
  }

  function stopPolling(): void {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
  }

  if (getCurrentInstance()) onUnmounted(stopPolling)

  // ── Derived ────────────────────────────────────────────────────────────────
  const supported = computed(() => PERMISSION_KEYS.some((k) => statuses.value[k] !== 'not-applicable'))

  function isSettled(key: TccPermissionKey): boolean {
    const s = statuses.value[key]
    return s === 'granted' || s === 'not-applicable'
  }

  const requiredKeys = computed(() =>
    PERMISSION_KEYS.filter((k) => !OPTIONAL_PERMISSIONS.includes(k) && statuses.value[k] !== 'not-applicable'),
  )
  const allGranted = computed(() => requiredKeys.value.every((k) => statuses.value[k] === 'granted'))
  const grantedCount = computed(() => PERMISSION_KEYS.filter((k) => statuses.value[k] === 'granted').length)

  return {
    statuses,
    requesting,
    refresh,
    request,
    openSettings,
    startPolling,
    stopPolling,
    supported,
    isSettled,
    requiredKeys,
    allGranted,
    grantedCount,
  }
}
