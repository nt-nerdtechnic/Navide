// Storage usage + cleanup state, shared by the Resource Manager's Disk card
// and its Storage section. Asks the backend to scan the app data dir, the
// Electron caches, the per-agent CLI homes and the known workspaces, then
// lets the user delete the reclaimable parts.
//
// Nothing here runs on its own: the scan walks several large trees, so it is
// always a button — the caller decides when to ask.
//
// Two deletion paths exist and must not be mixed: items reported with
// `handledBy: 'backend'` go back over the WebSocket to `storage.cleanup`,
// while `handledBy: 'electron'` items can only be cleared by the main process
// (the Chromium cache is owned by the session, not the filesystem), so they
// are routed through the `window.agentTeam.storage` preload bridge.
import { computed, ref, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { useBackend } from './useBackend'

export type StorageRisk = 'safe' | 'caution' | 'danger'
export type StorageGroupId = 'appData' | 'electron' | 'cliHomes' | 'workspaces'

export interface StorageItem {
  id: string
  bytes: number
  fileCount: number
  paths: string[]
  risk: StorageRisk
  cleanable: boolean
  handledBy: 'backend' | 'electron'
  note: string | null
}
export interface StorageGroup {
  id: StorageGroupId
  rootPath: string
  totalBytes: number
  items: StorageItem[]
}
export interface StorageReport {
  generatedAt: string
  staleDays: number
  totalBytes: number
  disk: { totalBytes: number; freeBytes: number }
  groups: StorageGroup[]
  errors: Array<{ path: string; message: string }>
}
export interface CleanupResult {
  itemId: string
  ok: boolean
  freedBytes: number
  removedCount: number
  error: string | null
}

// A full disk walk is far slower than the 10s default request timeout.
const SCAN_TIMEOUT_MS = 120_000
export const STALE_DAY_OPTIONS = [7, 30, 90]

// The preload bridge takes booleans, not item ids, so the two Electron-owned
// items are recognised by their id.
const CHROMIUM_ID_RE = /chromium|chrome/i
const UPDATER_ID_RE = /updater/i

function isReport(v: unknown): v is StorageReport {
  const r = v as Partial<StorageReport> | null
  return (
    !!r &&
    Array.isArray(r.groups) &&
    !!r.disk &&
    typeof r.disk.totalBytes === 'number' &&
    typeof r.disk.freeBytes === 'number'
  )
}

export function useStorageUsage(opts: {
  backend: ReturnType<typeof useBackend>
  /** Workspaces the app knows about — scanned for build artifacts / stale logs. */
  workspacePaths: Ref<string[] | undefined> | (() => string[] | undefined)
}) {
  const { t } = useI18n()
  const workspacePaths = (): string[] =>
    (typeof opts.workspacePaths === 'function' ? opts.workspacePaths() : opts.workspacePaths.value) ?? []

  const report = ref<StorageReport | null>(null)
  const scanning = ref(false)
  const scanError = ref('')
  const staleDays = ref(30)
  const selected = ref<string[]>([])
  const expanded = ref<string[]>([])
  const cleaning = ref(false)
  const cleanupError = ref('')
  // Non-fatal problem from the Electron pass (e.g. the updater cache was skipped
  // because an update is downloading) — bytes may still have been freed.
  const cleanupWarning = ref('')
  const cleanupFreed = ref<number | null>(null)
  const cleanupFailures = ref<CleanupResult[]>([])
  const pendingConfirm = ref<StorageItem[] | null>(null)
  const homeDir = ref('')
  /** Scan and cleanup both need the backend; the buttons read this. */
  const connected = computed(() => opts.backend.status.value === 'connected')

  const allItems = computed<StorageItem[]>(() => (report.value?.groups ?? []).flatMap((g) => g.items))

  const safeCleanableItems = computed(() =>
    allItems.value.filter((i) => i.cleanable && i.risk === 'safe')
  )
  const safeCleanableBytes = computed(() =>
    safeCleanableItems.value.reduce((sum, i) => sum + i.bytes, 0)
  )
  const selectedItems = computed(() => allItems.value.filter((i) => selected.value.includes(i.id)))
  // "Clean selected" is the deliberate path for anything beyond the safe set —
  // it only lights up once a non-safe item is checked.
  const canCleanSelected = computed(() => selectedItems.value.some((i) => i.risk !== 'safe'))

  const confirmBytes = computed(() =>
    (pendingConfirm.value ?? []).reduce((sum, i) => sum + i.bytes, 0)
  )
  const confirmHasDanger = computed(() =>
    (pendingConfirm.value ?? []).some((i) => i.risk === 'danger')
  )

  function collapseHome(p: string): string {
    const h = homeDir.value.replace(/\/+$/, '')
    if (!h) return p
    return p === h || p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p
  }

  function isExpanded(id: string): boolean {
    return expanded.value.includes(id)
  }
  function toggleExpanded(id: string): void {
    expanded.value = isExpanded(id)
      ? expanded.value.filter((x) => x !== id)
      : [...expanded.value, id]
  }

  function isSelected(id: string): boolean {
    return selected.value.includes(id)
  }
  function toggleSelected(id: string): void {
    selected.value = isSelected(id) ? selected.value.filter((x) => x !== id) : [...selected.value, id]
  }

  let homeDirLoaded = false
  async function loadHomeDir(): Promise<void> {
    if (homeDirLoaded) return
    homeDirLoaded = true
    try {
      homeDir.value = (await window.agentTeam?.getHomeDir?.()) || ''
    } catch {
      /* '~' collapsing is cosmetic — fall back to absolute paths */
    }
  }

  async function scan(): Promise<void> {
    if (scanning.value) return
    // Not queued for a backend that is away: the request would sit in the
    // client's queue reading "Scanning…" until the 120s timeout said otherwise.
    if (!connected.value) {
      scanError.value = t('resource.storage.not-connected')
      return
    }
    scanning.value = true
    scanError.value = ''
    try {
      await loadHomeDir()
      const resp = await opts.backend.send<StorageReport>(
        'storage.usage',
        { workspacePaths: workspacePaths(), staleDays: staleDays.value },
        SCAN_TIMEOUT_MS
      )
      if (!resp.ok || !isReport(resp.payload)) {
        scanError.value = resp.error?.message ?? 'storage scan failed'
        return
      }
      report.value = resp.payload
      // Drop selections for items the rescan no longer reports.
      const live = new Set(resp.payload.groups.flatMap((g) => g.items.map((i) => i.id)))
      selected.value = selected.value.filter((id) => live.has(id))
    } catch (err) {
      scanError.value = err instanceof Error ? err.message : String(err)
    } finally {
      scanning.value = false
    }
  }

  function setStaleDays(raw: string | number): void {
    const n = Number(raw)
    if (!Number.isFinite(n)) return
    staleDays.value = n
    void scan()
  }

  function requestCleanSafe(): void {
    if (!safeCleanableItems.value.length) return
    pendingConfirm.value = safeCleanableItems.value
  }
  function requestCleanSelected(): void {
    if (!canCleanSelected.value) return
    pendingConfirm.value = selectedItems.value.filter((i) => i.cleanable)
  }
  function cancelConfirm(): void {
    pendingConfirm.value = null
  }

  /** Electron-side clearing is partial-success capable: a non-ok result still
   *  reports the bytes the passes that did run freed, so `freed` and `error` are
   *  independent. The bridge itself may be absent on an older main process. */
  async function clearElectronCaches(items: StorageItem[]): Promise<{
    freed: number
    error: string
  }> {
    const bridge = window.agentTeam?.storage?.clearElectronCaches
    if (typeof bridge !== 'function') return { freed: 0, error: t('resource.storage.bridge-missing') }
    const chromium = items.some((i) => CHROMIUM_ID_RE.test(i.id))
    const updater = items.some((i) => UPDATER_ID_RE.test(i.id))
    try {
      const res = await bridge({ chromium, updater })
      return { freed: res?.freedBytes ?? 0, error: res?.ok ? '' : (res?.error ?? '') }
    } catch (err) {
      return { freed: 0, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async function confirmCleanup(): Promise<void> {
    const items = pendingConfirm.value ?? []
    pendingConfirm.value = null
    if (!items.length) return
    cleaning.value = true
    cleanupError.value = ''
    cleanupWarning.value = ''
    cleanupFreed.value = null
    cleanupFailures.value = []
    let freed = 0
    const failures: CleanupResult[] = []
    try {
      const backendIds = items.filter((i) => i.handledBy === 'backend').map((i) => i.id)
      if (backendIds.length) {
        // Scoped try: backend.send REJECTS on timeout, and a dead backend must
        // not cancel the Electron pass — the two are independent.
        try {
          const resp = await opts.backend.send<{
            totalFreedBytes: number
            results: CleanupResult[]
          }>(
            'storage.cleanup',
            {
              itemIds: backendIds,
              workspacePaths: workspacePaths(),
              staleDays: staleDays.value,
            },
            SCAN_TIMEOUT_MS
          )
          if (!resp.ok || !resp.payload) {
            cleanupError.value = t('resource.storage.backend-failed', {
              message: resp.error?.message ?? 'storage cleanup failed',
            })
          } else {
            freed += resp.payload.totalFreedBytes
            failures.push(...resp.payload.results.filter((r) => !r.ok))
          }
        } catch (err) {
          cleanupError.value = t('resource.storage.backend-failed', {
            message: err instanceof Error ? err.message : String(err),
          })
        }
      }
      const electronItems = items.filter((i) => i.handledBy === 'electron')
      if (electronItems.length) {
        const res = await clearElectronCaches(electronItems)
        // Always counted: a non-ok result can still have freed real bytes.
        freed += res.freed
        if (res.error) cleanupWarning.value = res.error
      }
      cleanupFreed.value = freed
      cleanupFailures.value = failures
      selected.value = []
    } catch (err) {
      cleanupError.value = err instanceof Error ? err.message : String(err)
    } finally {
      cleaning.value = false
      await scan()
    }
  }

  return {
    connected,
    report,
    scanning,
    scanError,
    staleDays,
    selected,
    cleaning,
    cleanupError,
    cleanupWarning,
    cleanupFreed,
    cleanupFailures,
    pendingConfirm,
    allItems,
    safeCleanableItems,
    safeCleanableBytes,
    selectedItems,
    canCleanSelected,
    confirmBytes,
    confirmHasDanger,
    collapseHome,
    isExpanded,
    toggleExpanded,
    isSelected,
    toggleSelected,
    scan,
    setStaleDays,
    requestCleanSafe,
    requestCleanSelected,
    cancelConfirm,
    confirmCleanup,
  }
}
