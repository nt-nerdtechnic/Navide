import { describe, expect, it, vi } from 'vitest'
import { createUpdaterService, type UpdaterClient } from './updater-service'
import type { UpdateState } from '../shared/updater'

type Listener = (...args: never[]) => void

function fakeClient() {
  const listeners = new Map<string, Listener[]>()
  const client = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    on: vi.fn((event: string, listener: Listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    }),
    checkForUpdates: vi.fn().mockResolvedValue({ isUpdateAvailable: false, updateInfo: { version: '1.0.0' } }),
    downloadUpdate: vi.fn().mockResolvedValue([]),
    quitAndInstall: vi.fn(),
  }
  const emit = (event: string, value?: unknown): void => {
    for (const listener of listeners.get(event) ?? []) listener(value as never)
  }
  return { client: client as unknown as UpdaterClient, raw: client, emit }
}

describe('createUpdaterService', () => {
  it('reports dev builds as unsupported without contacting a provider', async () => {
    const { client, raw } = fakeClient()
    const service = createUpdaterService(client, '1.0.0', false, vi.fn())

    expect(service.getState().status).toBe('unsupported')
    expect((await service.check()).ok).toBe(false)
    expect(raw.checkForUpdates).not.toHaveBeenCalled()
  })

  it('checks and falls back to a deterministic not-available state', async () => {
    const { client } = fakeClient()
    const states: UpdateState[] = []
    const service = createUpdaterService(client, '1.0.0', true, (state) => states.push(state))

    expect((await service.check()).ok).toBe(true)
    expect(service.getState().status).toBe('not-available')
    expect(states.map((state) => state.status)).toEqual(['checking', 'not-available'])
  })

  it('serializes checks and preserves the available version through download', async () => {
    const { client, raw, emit } = fakeClient()
    let resolveCheck!: (value: { isUpdateAvailable: boolean; updateInfo: { version: string } }) => void
    let resolveDownload!: (value: string[]) => void
    raw.checkForUpdates.mockReturnValue(new Promise((resolve) => { resolveCheck = resolve }))
    raw.downloadUpdate.mockReturnValue(new Promise((resolve) => { resolveDownload = resolve }))
    const service = createUpdaterService(client, '1.0.0', true, vi.fn())

    const first = service.check()
    const second = service.check()
    expect(raw.checkForUpdates).toHaveBeenCalledTimes(1)
    emit('update-available', { version: '1.1.0' })
    resolveCheck({ isUpdateAvailable: true, updateInfo: { version: '1.1.0' } })
    await Promise.all([first, second])

    const download = service.download()
    expect(raw.downloadUpdate).toHaveBeenCalledOnce()
    emit('download-progress', { percent: 42.4 })
    expect(service.getState()).toMatchObject({
      status: 'downloading', availableVersion: '1.1.0', percent: 42,
    })
    emit('update-downloaded', { version: '1.1.0' })
    resolveDownload([])
    expect((await download).ok).toBe(true)
    expect(service.getState().status).toBe('downloaded')
  })

  it('only installs a downloaded update', () => {
    const { client, raw, emit } = fakeClient()
    const service = createUpdaterService(client, '1.0.0', true, vi.fn())

    expect(service.install().ok).toBe(false)
    emit('update-downloaded', { version: '1.1.0' })
    expect(service.install().ok).toBe(true)
    expect(raw.quitAndInstall).toHaveBeenCalledWith(false, true)
    expect(service.getState().status).toBe('installing')
  })

  it('turns provider failures into a retryable error state', async () => {
    const { client, raw } = fakeClient()
    raw.checkForUpdates.mockRejectedValue(new Error('feed unavailable'))
    const service = createUpdaterService(client, '1.0.0', true, vi.fn())

    const result = await service.check()
    expect(result).toMatchObject({ ok: false, error: 'feed unavailable' })
    expect(service.getState()).toMatchObject({ status: 'error', message: 'feed unavailable' })
  })

  it('returns failure when the provider emits an error but resolves the operation', async () => {
    const { client, emit } = fakeClient()
    const service = createUpdaterService(client, '1.0.0', true, vi.fn())

    const check = service.check()
    emit('error', new Error('bad metadata'))
    await expect(check).resolves.toMatchObject({ ok: false, error: 'bad metadata' })
  })

  it('finishes downloading when a provider resolves without a downloaded event', async () => {
    const { client, emit } = fakeClient()
    const service = createUpdaterService(client, '1.0.0', true, vi.fn())
    emit('update-available', { version: '1.1.0' })

    await expect(service.download()).resolves.toMatchObject({ ok: true })
    expect(service.getState()).toMatchObject({
      status: 'downloaded', availableVersion: '1.1.0', percent: 100,
    })
  })
})
