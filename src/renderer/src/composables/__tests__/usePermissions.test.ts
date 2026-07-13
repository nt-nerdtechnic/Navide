// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { usePermissions } from '../usePermissions'

const ALL_UNKNOWN: Record<TccPermissionKey, TccPermissionStatus> = {
  automation: 'unknown',
  notifications: 'unknown',
  folders: 'unknown',
  fullDisk: 'unknown',
}

function mockBridge(overrides: Partial<Record<TccPermissionKey, TccPermissionStatus>> = {}) {
  const status = vi.fn().mockResolvedValue({ ...ALL_UNKNOWN, ...overrides })
  const request = vi.fn().mockResolvedValue('granted')
  const openSettings = vi.fn().mockResolvedValue({ ok: true })
  ;(window as unknown as { agentTeam: unknown }).agentTeam = { permissions: { status, request, openSettings } }
  return { status, request, openSettings }
}

describe('usePermissions', () => {
  beforeEach(() => {
    delete (window as unknown as { agentTeam?: unknown }).agentTeam
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads statuses from the bridge', async () => {
    mockBridge({ automation: 'granted', fullDisk: 'denied' })
    const p = usePermissions()
    await p.refresh()

    expect(p.statuses.value.automation).toBe('granted')
    expect(p.statuses.value.fullDisk).toBe('denied')
    expect(p.supported.value).toBe(true)
  })

  it('marks every permission not-applicable when the bridge is absent', async () => {
    const p = usePermissions()
    await p.refresh()

    expect(p.statuses.value.automation).toBe('not-applicable')
    expect(p.supported.value).toBe(false)
    expect(p.allGranted.value).toBe(true)
  })

  it('keeps the last known statuses when a poll fails', async () => {
    const { status } = mockBridge({ automation: 'granted' })
    const p = usePermissions()
    await p.refresh()
    status.mockRejectedValueOnce(new Error('ipc down'))
    await p.refresh()

    expect(p.statuses.value.automation).toBe('granted')
  })

  it('request() stores the returned status and passes the payload through', async () => {
    const { request } = mockBridge()
    const p = usePermissions()
    const payload = { title: 'Navide', body: 'hi' }
    await p.request('notifications', payload)

    expect(request).toHaveBeenCalledWith('notifications', payload)
    expect(p.statuses.value.notifications).toBe('granted')
    expect(p.requesting.value).toBe('')
  })

  it('request() reports denial and never throws', async () => {
    const { request } = mockBridge()
    request.mockResolvedValueOnce('denied')
    const p = usePermissions()
    await p.request('automation')

    expect(p.statuses.value.automation).toBe('denied')
    expect(p.isSettled('automation')).toBe(false)
  })

  it('ignores a second request while one is in flight', async () => {
    const { request } = mockBridge()
    let release: (v: TccPermissionStatus) => void = () => {}
    request.mockReturnValueOnce(new Promise<TccPermissionStatus>((r) => (release = r)))
    const p = usePermissions()

    const first = p.request('automation')
    await p.request('folders')
    expect(request).toHaveBeenCalledTimes(1)

    release('granted')
    await first
    expect(p.requesting.value).toBe('')
  })

  it('allGranted ignores the optional full-disk permission', async () => {
    mockBridge({ automation: 'granted', notifications: 'granted', folders: 'granted', fullDisk: 'denied' })
    const p = usePermissions()
    await p.refresh()

    expect(p.allGranted.value).toBe(true)
    expect(p.grantedCount.value).toBe(3)
  })

  it('polls while started and stops on demand', async () => {
    vi.useFakeTimers()
    const { status } = mockBridge()
    const p = usePermissions()

    p.startPolling(1000)
    p.startPolling(1000) // a second start must not stack a timer
    vi.advanceTimersByTime(3000)
    expect(status).toHaveBeenCalledTimes(3)

    p.stopPolling()
    vi.advanceTimersByTime(3000)
    expect(status).toHaveBeenCalledTimes(3)
  })

  it('openSettings forwards the key to the bridge', async () => {
    const { openSettings } = mockBridge()
    const p = usePermissions()
    await p.openSettings('fullDisk')

    expect(openSettings).toHaveBeenCalledWith('fullDisk')
  })
})
