import type { PluginUpdateInfo } from './pluginIpc'

/**
 * One periodic pass: the installed-plugin trust refresh, then the update
 * reminder. The update check starts only after the trust refresh settled and
 * its failure is contained here, so it can never alter trust state or
 * quarantine decisions. Detection only — nothing is installed.
 */
export async function refreshTrustThenUpdates(deps: {
  refreshTrust: () => Promise<void>
  checkUpdates: () => Promise<PluginUpdateInfo[]>
  publish: (updates: PluginUpdateInfo[]) => void
  warn: (message: string) => void
}): Promise<void> {
  try {
    await deps.refreshTrust()
  } finally {
    try {
      deps.publish(await deps.checkUpdates())
    } catch (error) {
      deps.warn(
        `[main] plugin update check failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
}
