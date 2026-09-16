import type { UpdaterClient } from './updater-service'

/**
 * Release files are published twice: on the GitHub Release (electron-updater's
 * `github` provider, configured at build time) and on dl.navide.dev, a
 * CloudFront mirror of the same bytes written by the release workflow
 * (.github/workflows/mirror.yml). GitHub serves its assets through
 * release-assets.githubusercontent.com, which some networks filter and which
 * hands out one-hour signed URLs a slow line cannot finish a 200 MB installer
 * inside. When that host fails, the app falls back to the mirror.
 *
 * electron-updater holds one provider at a time, but `setFeedURL` swaps it at
 * runtime. This wrapper sits between the service and the real updater:
 *
 * - `checkForUpdates` tries the primary feed; on a network-shaped failure it
 *   switches the feed to the mirror's `generic` provider and checks again.
 * - `downloadUpdate` does the same, then re-checks on the mirror first so the
 *   download uses the mirror's file list rather than GitHub's URLs.
 * - Once switched, the mirror stays the feed for the rest of the session.
 *
 * electron-updater emits `'error'` *before* rejecting, and the service reacts to
 * that event by settling into an error state — which would make the retry's
 * success invisible. So while a primary attempt is in flight its error events
 * are held back; they are replayed only when the failure is one the mirror
 * cannot help with, and dropped when the fallback takes over.
 */

export const MIRROR_FEED_URL = 'https://dl.navide.dev/releases/latest'

/**
 * Failures that mean "could not reach or be served by the primary host". A
 * 404 or a signature/checksum error is left alone: the mirror carries the
 * same files, so it would fail the same way, and hiding that helps nobody.
 */
const NETWORK_FAILURE =
  /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|socket hang up|net::ERR_|timed? ?out|HttpError: (5\d\d|429)|status code (5\d\d|429)/i

export function isNetworkFailure(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return NETWORK_FAILURE.test(message)
}

/** The slice of electron-updater's AppUpdater this wrapper needs. */
export interface MirrorCapableUpdater extends UpdaterClient {
  channel?: string | null
  setFeedURL(options: { provider: 'generic'; url: string; channel?: string }): void
}

type ErrorListener = (error: Error) => void

export interface MirrorFeedOptions {
  url?: string
  log?: (message: string) => void
}

export function withMirrorFeed(updater: MirrorCapableUpdater, options: MirrorFeedOptions = {}): UpdaterClient {
  const url = options.url ?? MIRROR_FEED_URL
  const log = options.log ?? ((message: string) => console.warn('[updater]', message))

  let usingMirror = false
  // While a primary attempt is in flight, its error events land here instead
  // of reaching the service. `null` means "not holding" — pass through.
  let held: Error[] | null = null
  const errorListeners: ErrorListener[] = []

  updater.on('error', (error: Error) => {
    if (held) {
      held.push(error)
      return
    }
    for (const listener of errorListeners) listener(error)
  })

  const replayHeld = (): void => {
    const errors = held ?? []
    held = null
    for (const error of errors) for (const listener of errorListeners) listener(error)
  }

  const switchToMirror = (reason: string): void => {
    usingMirror = true
    log(`primary update feed failed (${reason}); switching to ${url}`)
    updater.setFeedURL({ provider: 'generic', url, channel: updater.channel ?? 'latest' })
  }

  /**
   * Run `attempt` against the primary feed with error events held. Returns
   * the result, or — for a network failure — switches feeds and returns
   * `undefined` so the caller can retry. Any other failure is replayed to the
   * service's listeners and rethrown, exactly as without this wrapper.
   */
  const tryPrimary = async <T>(attempt: () => Promise<T>): Promise<T | undefined> => {
    held = []
    try {
      const result = await attempt()
      replayHeld()
      return result
    } catch (error) {
      if (!isNetworkFailure(error)) {
        replayHeld()
        throw error
      }
      held = null
      switchToMirror(error instanceof Error ? error.message : String(error))
      return undefined
    }
  }

  const client: UpdaterClient = {
    get autoDownload() {
      return updater.autoDownload
    },
    set autoDownload(value: boolean) {
      updater.autoDownload = value
    },
    get autoInstallOnAppQuit() {
      return updater.autoInstallOnAppQuit
    },
    set autoInstallOnAppQuit(value: boolean) {
      updater.autoInstallOnAppQuit = value
    },
    on(event: string, listener: (...args: never[]) => unknown): unknown {
      if (event === 'error') {
        errorListeners.push(listener as ErrorListener)
        return client
      }
      return (updater.on as (event: string, listener: unknown) => unknown)(event, listener)
    },
    async checkForUpdates() {
      if (usingMirror) return updater.checkForUpdates()
      const result = await tryPrimary(() => updater.checkForUpdates())
      if (result !== undefined) return result
      return updater.checkForUpdates()
    },
    async downloadUpdate() {
      if (usingMirror) return updater.downloadUpdate()
      const result = await tryPrimary(() => updater.downloadUpdate())
      if (result !== undefined) return result
      // The pending update info still names GitHub's files; a check on the
      // mirror replaces it with the mirror's before the download starts.
      await updater.checkForUpdates()
      return updater.downloadUpdate()
    },
    quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean) {
      updater.quitAndInstall(isSilent, isForceRunAfter)
    },
  } as UpdaterClient

  return client
}
