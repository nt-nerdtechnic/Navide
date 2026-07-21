// IPC surface for the Extensions view: list installed plugins, search the
// marketplace, and drive the verified install / remove flow. The security
// chain lives in `pluginInstaller` (download → digest → signature → scope →
// zip-slip); this module only wires it to `ipcMain` and the loader registry.
//
// Install is two-step so the renderer can interpose a trust confirmation for
// sensitive (fs/terminal) capabilities: `plugins:prepareInstall` downloads +
// verifies and returns the trust facts WITHOUT writing to disk; the renderer
// shows the warning, then `plugins:commitInstall` writes the verified package.
// Download bytes never cross to the renderer — the prepared package is held
// main-side, keyed by id, until commit.

import { ipcMain } from 'electron'
import {
  prepareInstall,
  commitInstall,
  removePlugin,
  type PreparedInstall,
} from './pluginInstaller'
import { sensitiveCapabilities } from './pluginVerify'
import type { FrontendPluginManager } from './frontendPluginManager'

const DEFAULT_MARKETPLACE_URL = 'http://localhost:8787'

function marketplaceUrl(): string {
  return process.env['AGENT_TEAM_MARKETPLACE_URL'] ?? DEFAULT_MARKETPLACE_URL
}

interface InstalledSummary {
  id: string
  requires: string[]
  sensitive: string[]
}

/** Register every `plugins:*` handler exactly once. `pluginsRoot` is where
 *  verified packages are written (`userData/plugins`). */
export function registerPluginIpc(
  manager: FrontendPluginManager,
  pluginsRoot: string
): void {
  // Packages verified by prepareInstall, awaiting a commit, keyed by plugin id.
  const prepared = new Map<string, PreparedInstall>()

  ipcMain.handle('plugins:listInstalled', (): InstalledSummary[] => {
    return manager.listDescriptors().map((d) => ({
      id: d.id,
      requires: d.requires,
      sensitive: sensitiveCapabilities(d.requires),
    }))
  })

  ipcMain.handle('plugins:marketplaceSearch', async (_e, query?: string) => {
    const url = new URL('/api/extensions', marketplaceUrl())
    if (query) url.searchParams.set('q', query)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`marketplace search failed: HTTP ${res.status}`)
    return res.json()
  })

  ipcMain.handle(
    'plugins:prepareInstall',
    async (_e, args: { namespace: string; name: string; version?: string }) => {
      const base = marketplaceUrl().replace(/\/+$/, '')
      const detailRes = await fetch(`${base}/api/extensions/${args.namespace}/${args.name}`)
      if (!detailRes.ok) throw new Error(`extension not found: HTTP ${detailRes.status}`)
      const detail = (await detailRes.json()) as {
        latest_version: string | null
        versions: Array<{
          version: string
          package_digest: string
          trust_tier: string
          yanked: boolean
        }>
      }
      const wanted = args.version ?? detail.latest_version
      const versionRow = detail.versions.find((v) => v.version === wanted && !v.yanked)
      if (!versionRow) throw new Error(`no installable version ${wanted ?? '(latest)'} found`)

      // The registry API does not currently expose the detached signature bytes
      // or the publisher public key, so client-side re-verification is not
      // possible here; the registry-recorded trust tier is consumed instead.
      // The mandatory digest check still runs against the trusted metadata.
      const result = await prepareInstall({
        registryUrl: marketplaceUrl(),
        namespace: args.namespace,
        name: args.name,
        version: versionRow.version,
        expectedDigest: versionRow.package_digest,
        claimedTrustTier: versionRow.trust_tier,
      })
      prepared.set(result.id, result)
      return {
        id: result.id,
        version: result.version,
        trustTier: result.trustTier,
        sensitive: result.sensitive,
        requiresConfirmation: result.requiresConfirmation,
      }
    }
  )

  ipcMain.handle('plugins:commitInstall', (_e, args: { id: string }) => {
    const pkg = prepared.get(args.id)
    if (!pkg) throw new Error(`no prepared install for ${args.id}; call prepareInstall first`)
    const descriptor = commitInstall(pkg, pluginsRoot)
    manager.registerDescriptor(descriptor)
    prepared.delete(args.id)
    return { id: descriptor.id, requires: descriptor.requires }
  })

  ipcMain.handle('plugins:remove', (_e, args: { id: string }) => {
    prepared.delete(args.id)
    removePlugin(pluginsRoot, args.id)
    manager.removeInstalledPlugin(args.id)
    return { ok: true }
  })
}
