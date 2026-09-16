import { describe, expect, it, vi } from 'vitest'
import { isNetworkFailure, MIRROR_FEED_URL, withMirrorFeed, type MirrorCapableUpdater } from './updater-mirror-feed'
import { createUpdaterService } from './updater-service'
import type { UpdateState } from '../shared/updater'

type Listener = (...args: never[]) => void

/**
 * Mimics electron-updater's contract: a failing call emits 'error' first and
 * rejects afterwards, which is exactly the ordering the wrapper has to absorb.
 */
function fakeUpdater() {
  const listeners = new Map<string, Listener[]>()
  const emit = (event: string, value?: unknown): void => {
    for (const listener of listeners.get(event) ?? []) listener(value as never)
  }
  const failing = (error: Error) => async () => {
    emit('error', error)
    throw error
  }
  const updater = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    channel: 'latest' as string | null,
    on: vi.fn((event: string, listener: Listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    }),
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn().mockResolvedValue({ isUpdateAvailable: true, updateInfo: { version: '2.0.0' } }),
    downloadUpdate: vi.fn().mockResolvedValue([]),
    quitAndInstall: vi.fn(),
  }
  return { updater: updater as unknown as MirrorCapableUpdater, raw: updater, emit, failing }
}

const dns = new Error('getaddrinfo ENOTFOUND release-assets.githubusercontent.com')
const notFound = new Error('HttpError: 404 Not Found')

describe('isNetworkFailure', () => {
  it('recognises the shapes a mirror can route around', () => {
    expect(isNetworkFailure(dns)).toBe(true)
    expect(isNetworkFailure(new Error('read ECONNRESET'))).toBe(true)
    expect(isNetworkFailure(new Error('net::ERR_CONNECTION_TIMED_OUT'))).toBe(true)
    expect(isNetworkFailure(new Error('HttpError: 502 Bad Gateway'))).toBe(true)
  })

  it('leaves failures the mirror would repeat alone', () => {
    expect(isNetworkFailure(notFound)).toBe(false)
    expect(isNetworkFailure(new Error('sha512 checksum mismatch'))).toBe(false)
  })
})

describe('withMirrorFeed', () => {
  it('passes a healthy primary check straight through without touching the feed', async () => {
    const { updater, raw } = fakeUpdater()
    const client = withMirrorFeed(updater, { log: vi.fn() })

    const result = await client.checkForUpdates()

    expect(result?.updateInfo?.version).toBe('2.0.0')
    expect(raw.setFeedURL).not.toHaveBeenCalled()
    expect(raw.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('switches to the mirror feed when the primary check fails on the network', async () => {
    const { updater, raw, failing } = fakeUpdater()
    raw.checkForUpdates
      .mockImplementationOnce(failing(dns))
      .mockResolvedValueOnce({ isUpdateAvailable: true, updateInfo: { version: '2.0.0' } })
    const log = vi.fn()
    const errors: Error[] = []
    const client = withMirrorFeed(updater, { log })
    client.on('error', (error) => errors.push(error))

    const result = await client.checkForUpdates()

    expect(result?.updateInfo?.version).toBe('2.0.0')
    expect(raw.setFeedURL).toHaveBeenCalledWith({ provider: 'generic', url: MIRROR_FEED_URL, channel: 'latest' })
    expect(raw.checkForUpdates).toHaveBeenCalledTimes(2)
    // The primary's error event never reached the service.
    expect(errors).toEqual([])
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('stays on the mirror for the rest of the session', async () => {
    const { updater, raw, failing } = fakeUpdater()
    raw.checkForUpdates.mockImplementationOnce(failing(dns))
    const client = withMirrorFeed(updater, { log: vi.fn() })

    await client.checkForUpdates()
    await client.checkForUpdates()

    expect(raw.setFeedURL).toHaveBeenCalledTimes(1)
    expect(raw.checkForUpdates).toHaveBeenCalledTimes(3)
  })

  it('replays a non-network failure to the service and rethrows it unchanged', async () => {
    const { updater, raw, failing } = fakeUpdater()
    raw.checkForUpdates.mockImplementationOnce(failing(notFound))
    const errors: Error[] = []
    const client = withMirrorFeed(updater, { log: vi.fn() })
    client.on('error', (error) => errors.push(error))

    await expect(client.checkForUpdates()).rejects.toBe(notFound)

    expect(errors).toEqual([notFound])
    expect(raw.setFeedURL).not.toHaveBeenCalled()
  })

  it('lets a failure on the mirror itself reach the service', async () => {
    const { updater, raw, failing } = fakeUpdater()
    const mirrorDown = new Error('getaddrinfo ENOTFOUND dl.navide.dev')
    raw.checkForUpdates.mockImplementationOnce(failing(dns)).mockImplementationOnce(failing(mirrorDown))
    const errors: Error[] = []
    const client = withMirrorFeed(updater, { log: vi.fn() })
    client.on('error', (error) => errors.push(error))

    await expect(client.checkForUpdates()).rejects.toBe(mirrorDown)

    expect(errors).toEqual([mirrorDown])
  })

  it('re-checks on the mirror before retrying a download that failed on the network', async () => {
    const { updater, raw, failing } = fakeUpdater()
    raw.downloadUpdate.mockImplementationOnce(failing(new Error('read ETIMEDOUT'))).mockResolvedValueOnce(['/tmp/x'])
    const client = withMirrorFeed(updater, { log: vi.fn() })

    const files = await client.downloadUpdate()

    expect(files).toEqual(['/tmp/x'])
    expect(raw.setFeedURL).toHaveBeenCalledTimes(1)
    // check (on the mirror) happens between the two download attempts
    const order = [
      ...raw.downloadUpdate.mock.invocationCallOrder.map((n) => [n, 'download'] as const),
      ...raw.checkForUpdates.mock.invocationCallOrder.map((n) => [n, 'check'] as const),
    ]
      .sort((a, b) => a[0] - b[0])
      .map(([, name]) => name)
    expect(order).toEqual(['download', 'check', 'download'])
  })

  it('forwards every other event and property to the real updater', () => {
    const { updater, raw } = fakeUpdater()
    const client = withMirrorFeed(updater, { log: vi.fn() })
    const progress = vi.fn()

    client.on('download-progress', progress)
    client.autoDownload = true
    client.quitAndInstall(true, false)

    expect(raw.on).toHaveBeenCalledWith('download-progress', progress)
    expect(raw.autoDownload).toBe(true)
    expect(raw.quitAndInstall).toHaveBeenCalledWith(true, false)
  })

  it('lets the updater service complete a check that only the mirror could answer', async () => {
    const { updater, raw, failing } = fakeUpdater()
    raw.checkForUpdates
      .mockImplementationOnce(failing(dns))
      .mockResolvedValueOnce({ isUpdateAvailable: true, updateInfo: { version: '2.0.0' } })
    const states: UpdateState[] = []
    const service = createUpdaterService(withMirrorFeed(updater, { log: vi.fn() }), '1.0.0', true, (s) => states.push(s))

    expect((await service.check()).ok).toBe(true)
    expect(service.getState().status).toBe('available')
    expect(service.getState().availableVersion).toBe('2.0.0')
    expect(states.map((s) => s.status)).not.toContain('error')
  })
})
