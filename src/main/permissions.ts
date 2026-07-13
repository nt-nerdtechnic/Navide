import { app, Notification, shell } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, rename, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const execFileAsync = promisify(execFile)

export type PermissionKey = 'automation' | 'notifications' | 'folders' | 'fullDisk'
export type PermissionStatus = 'granted' | 'denied' | 'unknown' | 'not-applicable'

const SETTINGS_PANES: Record<PermissionKey, string> = {
  automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
  notifications: 'x-apple.systempreferences:com.apple.preference.notifications',
  folders: 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders',
  fullDisk: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
}

const isMac = (): boolean => process.platform === 'darwin'

// macOS exposes no non-prompting TCC check to Electron for automation /
// notifications / folders — probing them IS the prompt — so the last known
// result is cached on disk and used as the reported status until the user
// explicitly requests the permission again. (Full Disk Access never prompts:
// a protected read just fails with EPERM, so it is detected live instead.)
type PermissionCache = Partial<Record<PermissionKey, PermissionStatus>>

function cachePath(): string {
  return join(app.getPath('userData'), 'permissions.json')
}

async function readCache(): Promise<PermissionCache> {
  try {
    const parsed = JSON.parse(await readFile(cachePath(), 'utf-8')) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as PermissionCache) : {}
  } catch {
    return {}
  }
}

async function writeCache(key: PermissionKey, status: PermissionStatus): Promise<void> {
  try {
    const cache = await readCache()
    cache[key] = status
    const file = cachePath()
    const tmp = `${file}.tmp`
    await writeFile(tmp, JSON.stringify(cache), 'utf-8')
    await rename(tmp, file)
  } catch {
    // Cache is a convenience only — a failed write just means the next status
    // call reports 'unknown'.
  }
}

function isDeniedError(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | null)?.code
  return code === 'EPERM' || code === 'EACCES'
}

/**
 * Readable => granted, EPERM/EACCES => denied, missing folder => ignored.
 * The first read triggers the TCC prompt, so this only runs on an explicit
 * user-initiated request — never from getPermissionStatuses().
 */
async function probeFolders(): Promise<PermissionStatus> {
  const folders = ['Desktop', 'Documents', 'Downloads'].map((name) => join(homedir(), name))
  let status: PermissionStatus = 'granted'
  for (const folder of folders) {
    try {
      await readdir(folder)
    } catch (e) {
      if (isDeniedError(e)) {
        status = 'denied'
        break
      }
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue
      status = 'unknown'
      break
    }
  }
  await writeCache('folders', status)
  return status
}

/** Full Disk Access cannot be requested — only detected via a protected path. */
async function detectFullDisk(): Promise<PermissionStatus> {
  const candidates = [
    join(homedir(), 'Library', 'Safari'),
    join(homedir(), 'Library', 'Application Support', 'com.apple.TCC'),
  ]
  let last: PermissionStatus = 'unknown'
  for (const dir of candidates) {
    try {
      await readdir(dir)
      return 'granted'
    } catch (e) {
      if (isDeniedError(e)) return 'denied'
      last = 'unknown'
    }
  }
  return last
}

/**
 * Drives Terminal.app via AppleScript — the same TCC entry `shell:openTerminal`
 * needs. The first run raises the macOS authorization prompt, which blocks the
 * osascript process until the user answers, hence the long timeout.
 */
async function requestAutomation(): Promise<PermissionStatus> {
  try {
    await execFileAsync('osascript', ['-e', 'tell application "Terminal" to count windows'], {
      timeout: 20_000,
    })
    await writeCache('automation', 'granted')
    return 'granted'
  } catch (e) {
    const stderr = String((e as { stderr?: string })?.stderr ?? '')
    const status: PermissionStatus =
      stderr.includes('-1743') || stderr.includes('Not authorized to send Apple events')
        ? 'denied'
        : 'unknown'
    await writeCache('automation', status)
    return status
  }
}

/**
 * Showing the first notification raises the macOS authorization prompt. Electron
 * main has no readable notification auth status, so a notification that is shown
 * without throwing is optimistically cached as 'granted'; the UI offers
 * openSettings('notifications') as the fallback when the user actually denied.
 */
async function requestNotifications(payload?: { title?: string; body?: string }): Promise<PermissionStatus> {
  if (!Notification.isSupported()) return 'not-applicable'
  try {
    new Notification({
      title: payload?.title ?? 'Notifications enabled',
      body: payload?.body ?? 'Agent-Team will notify you when an agent needs your attention.',
    }).show()
    await writeCache('notifications', 'granted')
    return 'granted'
  } catch {
    await writeCache('notifications', 'unknown')
    return 'unknown'
  }
}

export async function getPermissionStatuses(): Promise<Record<PermissionKey, PermissionStatus>> {
  if (!isMac()) {
    return {
      automation: 'not-applicable',
      notifications: 'not-applicable',
      folders: 'not-applicable',
      fullDisk: 'not-applicable',
    }
  }
  // Status must never prompt: automation / notifications / folders report the
  // cached last result; only fullDisk is probed live (it fails silently).
  const [cache, fullDisk] = await Promise.all([readCache(), detectFullDisk()])
  return {
    automation: cache.automation ?? 'unknown',
    notifications: Notification.isSupported() ? cache.notifications ?? 'unknown' : 'not-applicable',
    folders: cache.folders ?? 'unknown',
    fullDisk,
  }
}

export async function requestPermission(
  key: PermissionKey,
  payload?: { title?: string; body?: string }
): Promise<PermissionStatus> {
  if (!isMac()) return 'not-applicable'
  switch (key) {
    case 'automation':
      return await requestAutomation()
    case 'notifications':
      return await requestNotifications(payload)
    // The fs probe IS the request: the first read triggers the TCC prompt.
    case 'folders':
      return await probeFolders()
    // Not requestable — the UI sends the user to System Settings instead.
    case 'fullDisk':
      return await detectFullDisk()
  }
}

export async function openPermissionSettings(key: PermissionKey): Promise<void> {
  if (!isMac()) return
  await shell.openExternal(SETTINGS_PANES[key])
}
