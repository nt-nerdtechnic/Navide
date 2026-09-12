import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// permissions.ts caches the last prompt result on disk because macOS exposes no
// non-prompting TCC read to Electron. These tests pin the contract the Settings
// "Notification permission" row relies on: status never prompts, a request
// shows a real notification and records the result, and every path degrades to
// a status string instead of throwing.

const USER_DATA = join('/tmp', 'navide-permissions-test')
const files = new Map<string, string>()
const notifications: Array<{ title: string; body: string }> = []
let notificationsSupported = true
let showThrows = false
const openExternal = vi.fn(() => Promise.resolve())

vi.mock('electron', () => ({
  app: { getPath: () => USER_DATA },
  Notification: class {
    static isSupported(): boolean { return notificationsSupported }
    constructor(private readonly opts: { title: string; body: string }) {}
    show(): void {
      if (showThrows) throw new Error('display failed')
      notifications.push(this.opts)
    }
  },
  shell: { openExternal },
}))

vi.mock('node:fs/promises', () => ({
  readFile: async (path: string) => {
    const v = files.get(path)
    if (v === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return v
  },
  writeFile: async (path: string, data: string) => { files.set(path, data) },
  rename: async (from: string, to: string) => {
    files.set(to, files.get(from) ?? '')
    files.delete(from)
  },
  // Full Disk Access is detected by reading a protected folder; report it
  // denied so the live probe has a deterministic answer.
  readdir: async () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }) },
}))

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))

// join(), not a literal: the module builds the path the same way, and on
// Windows that is a backslash — a literal would key the fake filesystem
// differently from the code under test and every cached read would miss.
const CACHE = join(USER_DATA, 'permissions.json')

function setPlatform(p: string): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

describe('permissions (main)', () => {
  const realPlatform = process.platform

  beforeEach(() => {
    files.clear()
    notifications.length = 0
    notificationsSupported = true
    showThrows = false
    openExternal.mockClear()
    setPlatform('darwin')
  })
  afterEach(() => {
    setPlatform(realPlatform)
  })

  it('reports every permission not-applicable off macOS without touching disk', async () => {
    setPlatform('linux')
    const { getPermissionStatuses, requestPermission } = await import('./permissions')
    expect(await getPermissionStatuses()).toEqual({
      automation: 'not-applicable',
      notifications: 'not-applicable',
      folders: 'not-applicable',
      fullDisk: 'not-applicable',
    })
    expect(await requestPermission('notifications')).toBe('not-applicable')
    expect(notifications).toEqual([])
  })

  it('status reads the cache and never shows a notification', async () => {
    files.set(CACHE, JSON.stringify({ notifications: 'denied' }))
    const { getPermissionStatuses } = await import('./permissions')
    const s = await getPermissionStatuses()
    expect(s.notifications).toBe('denied')
    expect(s.automation).toBe('unknown')
    expect(s.fullDisk).toBe('denied')
    expect(notifications).toEqual([])
  })

  it('status tolerates a corrupt cache file', async () => {
    files.set(CACHE, '{not json')
    const { getPermissionStatuses } = await import('./permissions')
    expect((await getPermissionStatuses()).notifications).toBe('unknown')
  })

  it('requesting notifications shows the payload and caches granted', async () => {
    const { requestPermission, getPermissionStatuses } = await import('./permissions')
    const status = await requestPermission('notifications', { title: 'Navide', body: 'test' })
    expect(status).toBe('granted')
    expect(notifications).toEqual([{ title: 'Navide', body: 'test' }])
    expect(JSON.parse(files.get(CACHE) ?? '{}')).toEqual({ notifications: 'granted' })
    expect((await getPermissionStatuses()).notifications).toBe('granted')
  })

  it('a request that fails to display caches unknown instead of throwing', async () => {
    showThrows = true
    const { requestPermission } = await import('./permissions')
    expect(await requestPermission('notifications')).toBe('unknown')
    expect(JSON.parse(files.get(CACHE) ?? '{}')).toEqual({ notifications: 'unknown' })
  })

  it('notifications are not-applicable when Electron reports no support', async () => {
    notificationsSupported = false
    const { requestPermission, getPermissionStatuses } = await import('./permissions')
    expect(await requestPermission('notifications')).toBe('not-applicable')
    expect((await getPermissionStatuses()).notifications).toBe('not-applicable')
  })

  it('writing the cache preserves other keys', async () => {
    files.set(CACHE, JSON.stringify({ automation: 'granted' }))
    const { requestPermission } = await import('./permissions')
    await requestPermission('notifications')
    expect(JSON.parse(files.get(CACHE) ?? '{}')).toEqual({ automation: 'granted', notifications: 'granted' })
  })

  it('openPermissionSettings deep-links to the Notifications pane', async () => {
    const { openPermissionSettings } = await import('./permissions')
    await openPermissionSettings('notifications')
    expect(openExternal).toHaveBeenCalledWith('x-apple.systempreferences:com.apple.preference.notifications')
  })

  it('openPermissionSettings is a no-op off macOS', async () => {
    setPlatform('win32')
    const { openPermissionSettings } = await import('./permissions')
    await openPermissionSettings('notifications')
    expect(openExternal).not.toHaveBeenCalled()
  })
})
