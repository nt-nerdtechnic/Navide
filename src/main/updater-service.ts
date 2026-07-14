import type { UpdateActionResult, UpdateState } from '../shared/updater'

interface UpdateInfoLike {
  version: string
}

interface CheckResultLike {
  isUpdateAvailable?: boolean
  updateInfo?: UpdateInfoLike
}

export interface UpdaterClient {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  on(event: 'checking-for-update', listener: () => void): unknown
  on(event: 'update-available' | 'update-not-available' | 'update-downloaded', listener: (info: UpdateInfoLike) => void): unknown
  on(event: 'download-progress', listener: (progress: { percent: number }) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  checkForUpdates(): Promise<CheckResultLike | null>
  downloadUpdate(): Promise<string[]>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export interface UpdaterService {
  getState(): UpdateState
  check(): Promise<UpdateActionResult>
  download(): Promise<UpdateActionResult>
  install(): UpdateActionResult
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createUpdaterService(
  client: UpdaterClient,
  currentVersion: string,
  supported: boolean,
  onStateChanged: (state: UpdateState) => void,
): UpdaterService {
  let state: UpdateState = supported
    ? { status: 'idle', currentVersion }
    : {
        status: 'unsupported',
        currentVersion,
        message: 'Updates are available in packaged builds only.',
      }
  let checkPromise: Promise<UpdateActionResult> | null = null
  let downloadPromise: Promise<UpdateActionResult> | null = null

  const snapshot = (): UpdateState => ({ ...state })
  const setState = (next: UpdateState): void => {
    state = next
    onStateChanged(snapshot())
  }
  const success = (): UpdateActionResult => ({ ok: true, state: snapshot() })
  const failure = (message: string): UpdateActionResult => ({ ok: false, state: snapshot(), error: message })

  client.autoDownload = false
  client.autoInstallOnAppQuit = false

  if (supported) {
    client.on('checking-for-update', () => {
      setState({ status: 'checking', currentVersion, availableVersion: state.availableVersion })
    })
    client.on('update-available', (info) => {
      setState({
        status: 'available',
        currentVersion,
        availableVersion: info.version,
        checkedAt: new Date().toISOString(),
      })
    })
    client.on('update-not-available', () => {
      setState({ status: 'not-available', currentVersion, checkedAt: new Date().toISOString() })
    })
    client.on('download-progress', (progress) => {
      setState({
        status: 'downloading',
        currentVersion,
        availableVersion: state.availableVersion,
        percent: Math.max(0, Math.min(100, Math.round(progress.percent))),
      })
    })
    client.on('update-downloaded', (info) => {
      setState({
        status: 'downloaded',
        currentVersion,
        availableVersion: info.version,
        percent: 100,
      })
    })
    client.on('error', (error) => {
      setState({
        status: 'error',
        currentVersion,
        availableVersion: state.availableVersion,
        message: errorMessage(error),
      })
    })
  }

  async function check(): Promise<UpdateActionResult> {
    if (!supported) return failure(state.message ?? 'Updates are not supported in this build.')
    if (checkPromise) return checkPromise
    if (downloadPromise || state.status === 'downloaded' || state.status === 'installing') return success()

    checkPromise = (async () => {
      setState({ status: 'checking', currentVersion, availableVersion: state.availableVersion })
      try {
        const result = await client.checkForUpdates()
        // electron-updater normally emits an event before resolving. Keep a
        // deterministic fallback for providers/mocks that only return a result.
        if (state.status === 'checking') {
          const version = result?.updateInfo?.version
          if (result?.isUpdateAvailable && version) {
            setState({
              status: 'available',
              currentVersion,
              availableVersion: version,
              checkedAt: new Date().toISOString(),
            })
          } else {
            setState({ status: 'not-available', currentVersion, checkedAt: new Date().toISOString() })
          }
        }
        return success()
      } catch (error) {
        const message = errorMessage(error)
        if (state.status !== 'error' || state.message !== message) {
          setState({ status: 'error', currentVersion, message })
        }
        return failure(message)
      } finally {
        checkPromise = null
      }
    })()
    return checkPromise
  }

  async function download(): Promise<UpdateActionResult> {
    if (!supported) return failure(state.message ?? 'Updates are not supported in this build.')
    if (downloadPromise) return downloadPromise
    if (state.status === 'downloaded') return success()
    if (state.status !== 'available' && state.status !== 'error') {
      return failure('No update is ready to download.')
    }
    const availableVersion = state.availableVersion
    if (!availableVersion) return failure('No update is ready to download.')

    downloadPromise = (async () => {
      setState({ status: 'downloading', currentVersion, availableVersion, percent: 0 })
      try {
        await client.downloadUpdate()
        return success()
      } catch (error) {
        const message = errorMessage(error)
        if (state.status !== 'error' || state.message !== message) {
          setState({ status: 'error', currentVersion, availableVersion, message })
        }
        return failure(message)
      } finally {
        downloadPromise = null
      }
    })()
    return downloadPromise
  }

  function install(): UpdateActionResult {
    if (state.status !== 'downloaded') return failure('No downloaded update is ready to install.')
    setState({
      status: 'installing',
      currentVersion,
      availableVersion: state.availableVersion,
      percent: 100,
    })
    try {
      client.quitAndInstall(false, true)
      return success()
    } catch (error) {
      const message = errorMessage(error)
      setState({
        status: 'error',
        currentVersion,
        availableVersion: state.availableVersion,
        message,
      })
      return failure(message)
    }
  }

  return { getState: snapshot, check, download, install }
}
