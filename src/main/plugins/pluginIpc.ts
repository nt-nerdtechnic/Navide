// IPC surface for the Extensions view: list installed plugins, search the
// marketplace, and drive the verified install / remove flow. The security
// chain lives in `pluginInstaller` (download → digest → signature → scope →
// zip-slip); this module only wires it to `ipcMain` and the loader registry.
//
// Install is two-step so the renderer can interpose a trust confirmation for
// sensitive (fs/aiCli/shell) capabilities or native backend code:
// `plugins:prepareInstall` downloads +
// verifies and returns the trust facts WITHOUT writing to disk; the renderer
// shows the warning, then `plugins:commitInstall` writes the verified package.
// Download bytes never cross to the renderer — the prepared package is held
// main-side, keyed by id, until commit.

import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { dirname, join, resolve } from 'node:path'
import {
  prepareInstall,
  stageInstallCandidate,
  removePlugin,
  type PreparedInstall,
  type InstallerTrustConfig,
} from './pluginInstaller'
import {
  sensitiveCapabilities,
  assertRegistryUrlAllowed,
} from './pluginVerify'
import type { RegistryPackageEnvelope, RegistryTrustMetadata } from './pluginRegistryTrust'
import { verifyRegistryTrustMetadata } from './pluginRegistryTrust'
import {
  loadOfficialRegistryRootKey,
  resolveMarketplaceRegistryRoot,
} from './pluginRegistryRootApproval'
import {
  loadPluginDir,
  type PluginActivationCatalogEntry,
} from './installedPlugins'
import { isValidManifestV2PluginId } from './pluginManifestV2'
import { PluginPublisherTrustStore } from './pluginPublisherTrust'
import {
  readRegistryTrustSnapshot,
  discoverInstalledRegistryPackageIds,
  verifyInstalledRegistryPackage,
  writeRegistryTrustSnapshot,
  type InstalledTrustDecision,
} from './pluginInstalledTrust'
import { currentPluginHostTarget } from './pluginTarget'
import type {
  FrontendPluginManager,
  PluginLaunchDescriptor,
  PluginPackageRestartTransaction,
} from './frontendPluginManager'
import type { ContributionIcon } from './pluginContributionIcon'
import { PluginCapabilityGrantStore } from './pluginCapabilityGrantStore'
import { PluginActivationSelector } from './pluginActivationSelector'
import type {
  ManifestPermissionsSummary,
  PackageVersionGrantSummary,
} from '../../shared/executionPolicy'

/** Development-only endpoint. It is intentionally not the official Registry
 * identity: a local Registry must establish trust through root approval. */
const DEFAULT_MARKETPLACE_URL = 'http://localhost:8787'
/** App-shipped Official Registry identity. A normalized match is always
 * resolved through the independent packaged root pin and cannot be downgraded
 * by approval. */
const OFFICIAL_MARKETPLACE_URL = 'https://registry.navide.dev'

/** Resolve the marketplace registry URL, enforcing the transport policy
 *  (production forbids plaintext http except loopback). Throws before any
 *  fetch when the configured URL is disallowed. */
export function resolveConfiguredMarketplace(
  explicitTrust?: InstallerTrustConfig
): { registryUrl: string; trust: InstallerTrustConfig } {
  if (explicitTrust) {
    const registryUrl = process.env['AGENT_TEAM_MARKETPLACE_URL'] ?? DEFAULT_MARKETPLACE_URL
    assertRegistryUrlAllowed(registryUrl, app.isPackaged)
    return {
      registryUrl,
      trust: {
        ...explicitTrust,
        registryAuthority: explicitTrust.registryAuthority ?? 'self-hosted',
        officialRegistryUrl: explicitTrust.officialRegistryUrl ?? OFFICIAL_MARKETPLACE_URL,
        expectedTarget: explicitTrust.expectedTarget ?? currentPluginHostTarget(),
      },
    }
  }
  const resolved = resolveMarketplaceRegistryRoot({
    registryUrlOverride: process.env['AGENT_TEAM_MARKETPLACE_URL'],
    defaultRegistryUrl: DEFAULT_MARKETPLACE_URL,
    officialRegistryUrl: OFFICIAL_MARKETPLACE_URL,
    officialRootPublicKey: loadOfficialRegistryRootKey(process.resourcesPath),
    approvalFile: process.env['AGENT_TEAM_REGISTRY_ROOT_APPROVAL_FILE'],
  })
  assertRegistryUrlAllowed(resolved.registryUrl, app.isPackaged)
  return {
    registryUrl: resolved.registryUrl,
    trust: {
      pinnedRegistryRootKey: resolved.rootPublicKey,
      registryAuthority: resolved.authority,
      officialRegistryUrl: OFFICIAL_MARKETPLACE_URL,
      expectedTarget: currentPluginHostTarget(),
    },
  }
}

interface InstalledSummary {
  id: string
  requires: string[]
  sensitive: string[]
  packageVersion?: string
  manifestPermissions?: ManifestPermissionsSummary
  packageVersionGrant?: PackageVersionGrantSummary | null
  provenance?: 'official-registry' | 'developer-local-unpacked' | 'factory-bundled'
  warning?: string
  pendingCandidateVersion?: string
}

export interface FactoryPackageSummary {
  id: string
  version: string | null
  active: boolean
  optedOut: boolean
}

export interface PluginTrustRefreshController {
  refreshRegistryTrust(): Promise<{
    decisions: Array<{ pluginId: string; action: 'allow' | 'quarantine'; reason?: string }>
    activationCatalog: ReturnType<FrontendPluginManager['loadInstalledPlugins']>['activationCatalog']
  }>
}

export interface PluginIpcOptions {
  /** Convert a Host-verified icon file into renderer-safe image bytes. */
  resolveContributionIcon?: (iconFile: string) => ContributionIcon | null
  verifyCommittedInstall?: (
    pluginDir: string,
    pluginId: string,
    trust: InstallerTrustConfig
  ) => InstalledTrustDecision
  onActivationChange?: (change: {
    pluginId: string
    activation?: PluginActivationCatalogEntry
  }) => void
  /** Actual uninstall boundary; rollback/quarantine paths deliberately do not call this. */
  cleanupPluginStorage?: (pluginId: string) => Promise<void>
  factoryPackageIds?: readonly string[]
  listFactoryPackages?: () => FactoryPackageSummary[]
  restoreFactoryPackage?: (pluginId: string) => Promise<void> | void
  onFactoryPackageRemoved?: (pluginId: string) => void
  onPackageInstalled?: (pluginId: string) => void
  /** Host-only hidden-window preflight. The candidate must not enter catalog state. */
  preflightCandidateFrontend?: (descriptor: PluginLaunchDescriptor) => Promise<void>
  /** Host-only standalone backend health check with no production bridge route. */
  preflightCandidateBackend?: (activation: PluginActivationCatalogEntry) => Promise<void>
}

function assertPluginRemovalTarget(pluginsRoot: string, value: unknown): string {
  if (!isValidManifestV2PluginId(value)) throw new Error('invalid plugin id')
  const root = resolve(pluginsRoot)
  const target = resolve(root, value)
  if (dirname(target) !== root) throw new Error('invalid plugin id')
  return value
}

function installedPackageVersion(
  manager: FrontendPluginManager,
  pluginsRoot: string,
  pluginId: string,
): string | null {
  const descriptorVersion = manager.getDescriptor(pluginId)?.packageVersion
  if (typeof descriptorVersion === 'string' && descriptorVersion.length > 0) {
    return descriptorVersion
  }
  try {
    const activation = loadPluginDir(join(pluginsRoot, pluginId)).activation
    return activation?.packageVersion ?? null
  } catch {
    return null
  }
}

async function revokeInstalledPackageRuntime(
  manager: FrontendPluginManager,
  pluginsRoot: string,
  pluginId: string,
): Promise<void> {
  const packageVersion = installedPackageVersion(manager, pluginsRoot, pluginId)
  if (packageVersion) {
    await manager.revokePackageVersion(pluginId, packageVersion)
  } else {
    manager.preparePluginRemoval(pluginId)
  }
}

/** Restrict plugin management to the owning WebContents of a live Host window. */
export function isTrustedPluginManagementSender(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  trustedWindows: ReadonlySet<BrowserWindow>
): boolean {
  const window = BrowserWindow.fromWebContents(event.sender)
  return Boolean(
    window &&
      !window.isDestroyed() &&
      trustedWindows.has(window) &&
      window.webContents === event.sender &&
      !event.senderFrame?.parent
  )
}

/** Register every `plugins:*` handler exactly once. `pluginsRoot` is where
 *  verified packages are written (`userData/plugins`). */
export function registerPluginIpc(
  manager: FrontendPluginManager,
  pluginsRoot: string,
  authorizeSender: (event: IpcMainInvokeEvent) => boolean,
  trust?: InstallerTrustConfig,
  publisherTrust = new PluginPublisherTrustStore(
    join(pluginsRoot, '.navide-publisher-trust.json')
  ),
  options: PluginIpcOptions = {}
): PluginTrustRefreshController {
  // Packages verified by prepareInstall, awaiting a commit, keyed by plugin id.
  const prepared = new Map<string, { pkg: PreparedInstall }>()
  const activeTransactions = new Set<string>()
  const capabilityGrants = new PluginCapabilityGrantStore(pluginsRoot)
  const lifecycleSelector = new PluginActivationSelector(pluginsRoot)

  const assertAuthorized = (event: IpcMainInvokeEvent): void => {
    if (!authorizeSender(event)) throw new Error('unauthorized plugin management request')
  }

  ipcMain.handle('plugins:listInstalled', (event): InstalledSummary[] => {
    assertAuthorized(event)
    const summaries = new Map<
      string,
      {
        id: string
        requires: string[]
        packageVersion?: string
        manifestPermissions?: ManifestPermissionsSummary
        provenance?: 'official-registry' | 'developer-local-unpacked' | 'factory-bundled'
        warning?: string
      }
    >()
    for (const descriptor of manager.listDescriptors()) {
      const manifestPermissions = descriptor.capabilityPolicy?.kind === 'manifest-v2'
        ? {
            system: [...descriptor.capabilityPolicy.system],
            ...(descriptor.capabilityPolicy.shell
              ? { shell: descriptor.capabilityPolicy.shell }
              : {}),
          }
        : undefined
      summaries.set(descriptor.id, {
        id: descriptor.id,
        requires: [...descriptor.requires],
        ...(descriptor.packageVersion ? { packageVersion: descriptor.packageVersion } : {}),
        ...(manifestPermissions ? { manifestPermissions } : {}),
      })
    }
    for (const pkg of manager.listInstalledPackages()) summaries.set(pkg.id, pkg)
    // A first install has no selected descriptor yet, so project a staged
    // candidate into the inventory without treating that query result as an
    // activation authority. Restart independently re-verifies its package.
    for (const record of lifecycleSelector.list()) {
      if (!record.candidate || summaries.has(record.pluginId)) continue
      try {
        const staged = loadPluginDir(lifecycleSelector.packageDir(record.pluginId, record.candidate))
        if (staged.packageSummary) summaries.set(record.pluginId, staged.packageSummary)
      } catch {
        // A malformed candidate remains unavailable; its selector is not a grant.
      }
    }
    return [...summaries.values()].map((summary) => {
      const candidate = lifecycleSelector.read(summary.id)?.candidate
      return {
      id: summary.id,
      requires: summary.requires,
      sensitive: sensitiveCapabilities(summary.requires),
      ...(summary.packageVersion ? { packageVersion: summary.packageVersion } : {}),
      ...(summary.manifestPermissions
        ? {
            manifestPermissions: {
              system: [...summary.manifestPermissions.system],
              ...(summary.manifestPermissions.shell
                ? { shell: summary.manifestPermissions.shell }
                : {}),
            },
          }
        : {}),
      ...(summary.packageVersion
        ? {
            packageVersionGrant: (() => {
              const grant = capabilityGrants.get(summary.id, summary.packageVersion)
              return grant
                ? {
                    packageVersion: grant.packageVersion,
                    system: [...grant.system],
                    ...(grant.shell ? { shell: grant.shell } : {}),
                    ...(grant.highRiskShellConfirmed !== undefined
                      ? { highRiskShellConfirmed: grant.highRiskShellConfirmed }
                      : {}),
                    ...(grant.storage !== undefined ? { storage: grant.storage } : {}),
                  }
                : null
            })(),
          }
        : {}),
      ...(summary.provenance ? { provenance: summary.provenance } : {}),
      ...(summary.warning ? { warning: summary.warning } : {}),
      ...(candidate ? { pendingCandidateVersion: candidate.packageVersion } : {}),
    }
    })
  })

  ipcMain.handle('plugins:listContributions', (event) => {
    assertAuthorized(event)
    return manager.listContributionCatalog().map(({ iconFile, ...entry }) => {
      const icon = iconFile ? options.resolveContributionIcon?.(iconFile) ?? null : null
      return {
        ...entry,
        icon: icon?.url ?? null,
        // A silhouette is painted in the current text colour by the renderer,
        // so it follows the theme the way the built-in SVG icons do.
        iconMonochrome: icon?.monochrome ?? false,
      }
    })
  })

  ipcMain.handle('plugins:listFactoryPackages', (event): FactoryPackageSummary[] => {
    assertAuthorized(event)
    return options.listFactoryPackages?.() ?? []
  })

  ipcMain.handle(
    'plugins:restoreFactoryPackage',
    async (event, args: { id?: unknown } | null) => {
      assertAuthorized(event)
      const id = assertPluginRemovalTarget(pluginsRoot, args?.id)
      if (!options.restoreFactoryPackage) throw new Error('factory package restore is unavailable')
      await options.restoreFactoryPackage(id)
      return { ok: true }
    }
  )

  ipcMain.handle('plugins:marketplaceSearch', async (event, query?: string) => {
    assertAuthorized(event)
    const { registryUrl } = resolveConfiguredMarketplace(trust)
    const url = new URL('/api/extensions', registryUrl)
    if (query) url.searchParams.set('q', query)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`marketplace search failed: HTTP ${res.status}`)
    return res.json()
  })

  ipcMain.handle(
    'plugins:prepareInstall',
    async (event, args: { namespace: string; name: string; version?: string }) => {
      assertAuthorized(event)
      const marketplace = resolveConfiguredMarketplace(trust)
      const base = marketplace.registryUrl.replace(/\/+$/, '')
      const detailRes = await fetch(`${base}/api/extensions/${args.namespace}/${args.name}`)
      if (!detailRes.ok) throw new Error(`extension not found: HTTP ${detailRes.status}`)
      const detail = (await detailRes.json()) as {
        latest_version: string | null
        trust_metadata: RegistryTrustMetadata
        trust_metadata_signature: string
        versions: Array<{
          version: string
          package_digest: string
          target: string
          registry_envelope: RegistryPackageEnvelope
          registry_signature: string
          trust_tier: string
          yanked: boolean
        }>
      }
      const wanted = args.version ?? detail.latest_version
      const versionRow = detail.versions.find((v) => v.version === wanted && !v.yanked)
      if (!versionRow) throw new Error(`no installable version ${wanted ?? '(latest)'} found`)

      // The selected Registry envelope and current root-signed trust metadata
      // are verified against the Host-owned root pin before any install write.
      const result = await prepareInstall({
        registryUrl: marketplace.registryUrl,
        namespace: args.namespace,
        name: args.name,
        version: versionRow.version,
        expectedDigest: versionRow.package_digest,
        target: versionRow.target,
        registryEnvelope: versionRow.registry_envelope,
        registrySignature: versionRow.registry_signature,
        trustMetadata: detail.trust_metadata,
        trustMetadataSignature: detail.trust_metadata_signature,
        claimedTrustTier: versionRow.trust_tier,
        provenance: 'official-registry',
      }, undefined, marketplace.trust)
      prepared.set(result.id, { pkg: result })
      return {
        id: result.id,
        version: result.version,
        trustTier: result.trustTier,
        sensitive: result.sensitive,
        containsBackendExecutable: result.containsBackendExecutable,
        requiresConfirmation: result.requiresConfirmation,
        publisherId: result.publisherId,
        requiresPublisherTrust:
          result.registryEvidence !== undefined &&
          !result.official &&
          !publisherTrust.isTrusted(result.publisherId, result.id),
        requiresRiskConfirmation: result.requiresConfirmation,
      }
    }
  )

  ipcMain.handle(
    'plugins:commitInstall',
    async (
      event,
      args: { id: string; publisherConfirmed?: boolean; riskConfirmed?: boolean }
    ) => {
      assertAuthorized(event)
      if (activeTransactions.has(args.id)) {
        throw new Error(`plugin transaction already in progress for ${args.id}`)
      }
      const pending = prepared.get(args.id)
      if (!pending) throw new Error(`no prepared install for ${args.id}; call prepareInstall first`)
      const { pkg } = pending
      // Re-resolve Host-owned trust at commit time. Prepare-time evidence is
      // retained for the transaction, but expiry, root approval, and target
      // policy must not be frozen across the renderer confirmation round trip.
      const commitTrust = resolveConfiguredMarketplace(trust).trust
      const publisherRequiresTrust =
        pkg.registryEvidence !== undefined &&
        !pkg.official &&
        !publisherTrust.isTrusted(pkg.publisherId, pkg.id)
      if (publisherRequiresTrust && args.publisherConfirmed !== true) {
        throw new Error(`publisher trust confirmation is required for ${pkg.publisherId}`)
      }
      if (pkg.requiresConfirmation && args.riskConfirmed !== true) {
        throw new Error(`capability and backend risk confirmation is required for ${args.id}`)
      }
      // Commit deliberately stages only. It never drains the selected package,
      // registers a candidate descriptor, or changes a production grant.
      activeTransactions.add(pkg.id)
      prepared.delete(args.id)
      try {
        const staged = stageInstallCandidate(pkg, pluginsRoot)
        const scanned = loadPluginDir(staged.candidateDir)
        if (scanned.error) throw new Error(`staged candidate is invalid: ${scanned.error}`)
        if (!scanned.activation || !scanned.packageSummary) {
          throw new Error('immutable activation requires a Manifest v2 candidate')
        }
        const verifyCommitted =
          options.verifyCommittedInstall ??
          ((pluginDir: string, pluginId: string, trustConfig: InstallerTrustConfig) =>
            verifyInstalledRegistryPackage(pluginDir, pluginId, {
              pinnedRootKey: trustConfig.pinnedRegistryRootKey,
              snapshot: readRegistryTrustSnapshot(pluginsRoot),
              registryAuthority: trustConfig.registryAuthority,
              officialRegistryUrl: trustConfig.officialRegistryUrl,
              expectedTarget: trustConfig.expectedTarget ?? currentPluginHostTarget(),
              now: trustConfig.now,
            }))
        const decision = verifyCommitted(staged.candidateDir, pkg.id, commitTrust)
        if (decision.action === 'quarantine') {
          throw new Error(`staged candidate quarantined: ${decision.reason}`)
        }
        const activation: PluginActivationCatalogEntry = {
          ...scanned.activation,
          provenance: 'official-registry',
          artifactDigest: decision.artifactDigest,
        }
        if (scanned.descriptor) {
          if (!options.preflightCandidateFrontend) {
            throw new Error('candidate frontend preflight is unavailable')
          }
          await options.preflightCandidateFrontend(scanned.descriptor)
        }
        if (activation.backend) {
          if (!options.preflightCandidateBackend) {
            throw new Error('candidate backend preflight is unavailable')
          }
          await options.preflightCandidateBackend(activation)
        }
        lifecycleSelector.stageCandidate(pkg.id, {
          packageVersion: pkg.version,
          target: staged.target,
          artifactDigest: decision.artifactDigest,
        }, {
          fullShellConfirmed: args.riskConfirmed === true &&
            scanned.descriptor?.capabilityPolicy?.kind === 'manifest-v2' &&
            scanned.descriptor.capabilityPolicy.shell === 'full',
        })
        if (publisherRequiresTrust) {
          publisherTrust.trust(pkg.publisherId, pkg.id)
        }
        return {
          id: pkg.id,
          requires: scanned.packageSummary.requires,
          restartRequired: true,
        }
      } finally {
        activeTransactions.delete(pkg.id)
      }
    }
  )

  ipcMain.handle('plugins:restart', async (event, args: { id?: unknown } | null) => {
    assertAuthorized(event)
    const id = assertPluginRemovalTarget(pluginsRoot, args?.id)
    if (activeTransactions.has(id)) {
      throw new Error(`plugin transaction already in progress for ${id}`)
    }
    const selectedBeforeRestart = lifecycleSelector.read(id)
    if (!selectedBeforeRestart?.candidate) {
      throw new Error(`plugin ${id} has no staged candidate to restart`)
    }
    const candidateDir = lifecycleSelector.packageDir(id, selectedBeforeRestart.candidate)
    const restartTrust = resolveConfiguredMarketplace(trust).trust
    const verifyCommitted =
      options.verifyCommittedInstall ??
      ((pluginDir: string, pluginId: string, trustConfig: InstallerTrustConfig) =>
        verifyInstalledRegistryPackage(pluginDir, pluginId, {
          pinnedRootKey: trustConfig.pinnedRegistryRootKey,
          snapshot: readRegistryTrustSnapshot(pluginsRoot),
          registryAuthority: trustConfig.registryAuthority,
          officialRegistryUrl: trustConfig.officialRegistryUrl,
          expectedTarget: trustConfig.expectedTarget ?? currentPluginHostTarget(),
          now: trustConfig.now,
        }))
    const currentTrust = verifyCommitted(candidateDir, id, restartTrust)
    if (currentTrust.action === 'quarantine') {
      throw new Error(`staged candidate quarantined: ${currentTrust.reason}`)
    }
    if (currentTrust.artifactDigest !== selectedBeforeRestart.candidate.artifactDigest) {
      throw new Error('staged candidate artifact identity changed before restart')
    }
    const scanned = loadPluginDir(candidateDir)
    if (scanned.error || !scanned.activation || !scanned.packageSummary) {
      throw new Error(`staged candidate is invalid${scanned.error ? `: ${scanned.error}` : ''}`)
    }
    const activation: PluginActivationCatalogEntry = {
      ...scanned.activation,
      provenance: 'official-registry',
      artifactDigest: currentTrust.artifactDigest,
    }
    const previousDescriptor = manager.getDescriptor(id)
    const previousVersion = previousDescriptor?.packageVersion
    activeTransactions.add(id)
    let restartTransaction: PluginPackageRestartTransaction | undefined
    try {
      if (previousVersion) {
        restartTransaction = await manager.beginPackageRestart(id, previousVersion)
      }
      const selected = lifecycleSelector.activateCandidate(id)
      const summary = { ...scanned.packageSummary, provenance: 'official-registry' as const }
      if (scanned.descriptor) {
        manager.registerInstalledPackage(summary, scanned.descriptor, { official: true })
        const policy = scanned.descriptor.capabilityPolicy
        if (!policy || policy.kind !== 'manifest-v2') {
          throw new Error('invalid Manifest v2 capability policy')
        }
        capabilityGrants.set(id, {
          packageVersion: selected.active!.packageVersion,
          system: [...policy.system],
        ...(policy.shell ? { shell: policy.shell } : {}),
        ...(policy.shell === 'full' && selectedBeforeRestart.candidateFullShellConfirmed
          ? { highRiskShellConfirmed: true }
          : {}),
          storage: true,
        })
        manager.setPluginStorageSnapshotSelection(id, {
          activeVersion: selected.active!.packageVersion,
          ...(selected.previous ? { previousVersion: selected.previous.packageVersion } : {}),
        })
      }
      options.onActivationChange?.({ pluginId: id, activation })
      if (restartTransaction) {
        const report = await manager.restorePackageRestart(
          restartTransaction,
          selected.active!.packageVersion,
        )
        manager.completePackageRestart(restartTransaction)
        options.onPackageInstalled?.(id)
        return {
          id,
          packageVersion: selected.active!.packageVersion,
          restoredInstances: report.restoredInstances,
          skippedDestroyedHostWindows: report.skippedDestroyedHostWindows,
        }
      }
      options.onPackageInstalled?.(id)
      return { id, packageVersion: selected.active!.packageVersion, restoredInstances: 0, skippedDestroyedHostWindows: 0 }
    } catch (error) {
      if (restartTransaction) manager.cancelPackageRestart(restartTransaction)
      throw error
    } finally {
      activeTransactions.delete(id)
    }
  })

  ipcMain.handle('plugins:remove', async (event, args: { id?: unknown } | null) => {
    assertAuthorized(event)
    const id = assertPluginRemovalTarget(pluginsRoot, args?.id)
    if (activeTransactions.has(id)) {
      throw new Error(`plugin transaction already in progress for ${id}`)
    }
    const cleanupPluginStorage = options.cleanupPluginStorage
    if (!cleanupPluginStorage) {
      throw new Error('plugin storage cleanup is unavailable')
    }
    // Stop live instances before storage cleanup. The storage adapter drains
    // operations already admitted for this plugin; this phase also prevents
    // new renderer calls from being admitted while cleanup is in progress.
    const previousVersion = installedPackageVersion(manager, pluginsRoot, id)
    const previousBackend = previousVersion ? manager.getBackendActivation(id, previousVersion) : undefined
    const pending = prepared.get(id)
    activeTransactions.add(id)
    try {
      await revokeInstalledPackageRuntime(manager, pluginsRoot, id)
      // Storage cleanup is an explicit uninstall operation. On failure retain
      // the package and restore its approved backend tuple for this session.
      try {
        await cleanupPluginStorage(id)
      } catch (error) {
        if (previousBackend) {
          try {
            manager.registerBackendActivation(previousBackend)
          } catch (restoreError) {
            throw new AggregateError([error, restoreError], 'Plugin storage cleanup and runtime restoration failed.')
          }
        }
        throw error
      }
      // Drop the grant before the package files. The grant store lives beside
      // the package directory, not inside it, so it does not need those files;
      // ordering it first keeps a package whose directory removal fails
      // fail-closed instead of leaving a full grant over wiped storage.
      capabilityGrants.remove(id)
      removePlugin(pluginsRoot, id)
      lifecycleSelector.clear(id)
      if (options.factoryPackageIds?.includes(id)) {
        if (!options.onFactoryPackageRemoved) {
          throw new Error('factory package removal is unavailable')
        }
        options.onFactoryPackageRemoved(id)
        manager.removeInstalledPlugin(id, { restoreBuiltin: false })
      } else {
        manager.removeInstalledPlugin(id)
      }
      if (prepared.get(id) === pending) prepared.delete(id)
      options.onActivationChange?.({ pluginId: id })
      return { ok: true }
    } finally {
      activeTransactions.delete(id)
    }
  })

  return {
    async refreshRegistryTrust() {
      const packageIds = discoverInstalledRegistryPackageIds(pluginsRoot)
      const activeRegistryPackages = new Set(
        manager
          .listInstalledPackages()
          .filter((pkg) => pkg.provenance === 'official-registry')
          .map((pkg) => pkg.id)
      )
      const decisions: Array<{
        pluginId: string
        action: 'allow' | 'quarantine'
        reason?: string
      }> = []
      const safePackageIds = new Set(packageIds)
      for (const pluginId of activeRegistryPackages) {
        if (safePackageIds.has(pluginId)) continue
        // A package that disappeared or no longer has a coherent Host-owned
        // manifest is not a refresh candidate. It is nevertheless an active
        // Registry package in memory and must be stopped before this refresh
        // can return, including when there are no network candidates.
        manager.removeInstalledPlugin(pluginId)
        options.onActivationChange?.({ pluginId })
        decisions.push({
          pluginId,
          action: 'quarantine',
          reason:
            'installed Registry package is missing or has a malformed/identity-mismatched manifest',
        })
      }
      if (packageIds.length === 0) return { decisions, activationCatalog: [] }

      const marketplace = resolveConfiguredMarketplace(trust)
      const base = marketplace.registryUrl.replace(/\/+$/, '')
      const fallbackToCachedTrust = () => {
        const snapshot = readRegistryTrustSnapshot(pluginsRoot)
        const refreshed = manager.refreshInstalledPluginTrust(pluginsRoot, {
          pinnedRootKey: marketplace.trust.pinnedRegistryRootKey,
          snapshot,
          registryAuthority: marketplace.trust.registryAuthority,
          officialRegistryUrl: marketplace.trust.officialRegistryUrl,
          expectedTarget: marketplace.trust.expectedTarget ?? currentPluginHostTarget(),
          now: marketplace.trust.now,
        }, new Set([...packageIds, ...activeRegistryPackages]))
        for (const decision of refreshed) {
          if (decision.action === 'quarantine') {
            options.onActivationChange?.({ pluginId: decision.pluginId })
          }
        }
        return refreshed
      }

      let detail: {
        trust_metadata: RegistryTrustMetadata
        trust_metadata_signature: string
      } | null = null
      let lastRefreshError: Error | null = null
      for (const packageId of packageIds) {
        const [namespace, ...nameParts] = packageId.split('.')
        if (!namespace || nameParts.length === 0) continue
        try {
          const response = await fetch(
            `${base}/api/extensions/${namespace}/${nameParts.join('.')}`
          )
          if (!response.ok) {
            lastRefreshError = new Error(
              `trust metadata refresh failed: HTTP ${response.status}`
            )
            continue
          }
          const candidate = (await response.json()) as {
            trust_metadata: RegistryTrustMetadata
            trust_metadata_signature: string
          }
          verifyRegistryTrustMetadata(
            candidate.trust_metadata,
            candidate.trust_metadata_signature,
            marketplace.trust.pinnedRegistryRootKey,
            marketplace.trust.now
          )
          detail = candidate
          break
        } catch (error) {
          lastRefreshError = error instanceof Error ? error : new Error(String(error))
        }
      }
      if (!detail) {
        fallbackToCachedTrust()
        throw lastRefreshError ?? new Error('trust metadata refresh failed')
      }

      try {
        const snapshot = {
          schemaVersion: 1 as const,
          metadata: detail.trust_metadata,
          metadataSignature: detail.trust_metadata_signature,
        }
        writeRegistryTrustSnapshot(pluginsRoot, snapshot)
        const currentTrust = {
          pinnedRootKey: marketplace.trust.pinnedRegistryRootKey,
          snapshot,
          registryAuthority: marketplace.trust.registryAuthority,
          officialRegistryUrl: marketplace.trust.officialRegistryUrl,
          expectedTarget: marketplace.trust.expectedTarget ?? currentPluginHostTarget(),
          now: marketplace.trust.now,
        }
        const activeBeforeRefresh = new Set(
          manager
            .listInstalledPackages()
            .filter((pkg) => pkg.provenance === 'official-registry')
            .map((pkg) => pkg.id)
        )
        const refreshedDecisions = manager.refreshInstalledPluginTrust(
          pluginsRoot,
          currentTrust,
          new Set([...packageIds, ...activeBeforeRefresh])
        )
        for (const decision of refreshedDecisions) {
          if (decision.action === 'quarantine') {
            options.onActivationChange?.({ pluginId: decision.pluginId })
          }
        }
        decisions.push(...refreshedDecisions)
        const restoreIds = new Set(
          refreshedDecisions
            .filter(
              (decision) => decision.action === 'allow' && !activeBeforeRefresh.has(decision.pluginId)
            )
            .map((decision) => decision.pluginId)
        )
        const reloaded =
          restoreIds.size > 0
            ? manager.loadInstalledPlugins(
                pluginsRoot,
                { provenance: 'official-registry', trust: currentTrust },
                restoreIds
              )
            : { activationCatalog: [] }
        return { decisions, activationCatalog: reloaded.activationCatalog }
      } catch (error) {
        fallbackToCachedTrust()
        throw error
      }
    },
  }
}
