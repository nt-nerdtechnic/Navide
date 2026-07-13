import { computed, onUnmounted, ref } from 'vue'

export type PermissionKey = 'automation' | 'notifications' | 'folders' | 'fullDisk'
export type PermissionStatus = 'granted' | 'denied' | 'unknown' | 'not-applicable'

export const PERMISSION_KEYS: PermissionKey[] = ['automation', 'notifications', 'folders', 'fullDisk']

// Full Disk Access cannot be requested from inside the app — the user flips it
// in System Settings — so it never gates the wizard.
export const OPTIONAL_PERMISSIONS: PermissionKey[] = ['fullDisk']

const UNKNOWN: Record<PermissionKey, PermissionStatus> = {
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
  const statuses = ref<Record<PermissionKey, PermissionStatus>>({ ...UNKNOWN })
  const requesting = ref<PermissionKey | ''>('')

  const bridge = (): NonNullable<Window['agentTeam']>['permissions'] | undefined =>
    window.agentTeam?.permissions

  async function refresh(): Promise<void> {
    const api = bridge()
    if (!api) return
    try {
      statuses.value = { ...statuses.value, ...(await api.status()) }
    } catch {
      /* keep the last known statuses — a failed poll must not reset the UI */
    }
  }

  async function request(key: PermissionKey, payload?: { title: string; body: string }): Promise<void> {
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

  async function openSettings(key: PermissionKey): Promise<void> {
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

  onUnmounted(stopPolling)

  // ── Derived ────────────────────────────────────────────────────────────────
  const supported = computed(() => PERMISSION_KEYS.some((k) => statuses.value[k] !== 'not-applicable'))

  function isSettled(key: PermissionKey): boolean {
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
