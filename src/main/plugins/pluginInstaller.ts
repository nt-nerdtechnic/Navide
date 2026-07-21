// Plugin install / update / remove orchestration for the main process.
//
// The security-critical chain (download → digest → signature → capability
// scope → zip-slip-guarded unpack) is delegated to the pure, unit-tested
// `pluginVerify` + `pluginPackage` + `installedPlugins` modules; this file is
// the thin I/O shell that wires them to the network and the filesystem. Every
// side-effecting dependency (network download, fs writes) is injectable so the
// whole flow can be driven in tests without a real registry or disk.
//
// Install is split into prepare → commit so the UI can interpose a trust
// confirmation (sensitive `fs`/`terminal` capabilities) AFTER verification but
// BEFORE anything is written to disk.

import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  verifyPackage,
  assertSafeEntryPath,
  type TrustTier,
} from './pluginVerify'
import { readZipEntries, readManifestFromEntries, type ZipEntry } from './pluginPackage'
import {
  parseInstalledManifest,
  manifestToDescriptor,
  type InstalledManifest,
} from './installedPlugins'
import type { PluginLaunchDescriptor } from './frontendPluginManager'

/** What a caller must supply to install a specific marketplace version. The
 *  trusted `expectedDigest` and (optional) signature material come from the
 *  registry's extension-detail API, fetched by the caller before installing. */
export interface InstallRequest {
  registryUrl: string
  namespace: string
  name: string
  version: string
  /** sha256 hex from the version's `package_digest` (trusted metadata). */
  expectedDigest: string
  /** Detached base64 Ed25519 signature, when available (else omitted). */
  signature?: string | null
  /** Publisher PEM public key, when available (else omitted). */
  publicKey?: string | null
  /** Trust tier the registry recorded (`signed-verified`/`unsigned`). */
  claimedTrustTier?: string | null
}

/** A downloaded, verified package ready to commit to disk. */
export interface PreparedInstall {
  id: string
  version: string
  manifest: InstalledManifest
  entries: ZipEntry[]
  trustTier: TrustTier
  sensitive: string[]
  /** True when the plugin declares a sensitive capability and the UI must
   *  obtain a second confirmation before {@link commitInstall}. */
  requiresConfirmation: boolean
}

export class InstallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InstallError'
  }
}

/** Injectable side-effects (network + filesystem) so the flow is testable. */
export interface InstallerDeps {
  /** Fetch a package blob + the registry's `X-Package-Digest` header. */
  download(url: string): Promise<{ bytes: Uint8Array; digestHeader: string | null }>
  mkdirp(dir: string): void
  writeFile(path: string, data: Uint8Array): void
  rmrf(dir: string): void
}

/** Default deps: global `fetch` (Electron main / Node 18+) + `node:fs`. */
export const defaultInstallerDeps: InstallerDeps = {
  async download(url) {
    const res = await fetch(url)
    if (!res.ok) throw new InstallError(`download failed: HTTP ${res.status}`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    return { bytes, digestHeader: res.headers.get('x-package-digest') }
  },
  mkdirp(dir) {
    mkdirSync(dir, { recursive: true })
  },
  writeFile(path, data) {
    writeFileSync(path, data)
  },
  rmrf(dir) {
    rmSync(dir, { recursive: true, force: true })
  },
}

function downloadUrl(req: InstallRequest): string {
  const base = req.registryUrl.replace(/\/+$/, '')
  return `${base}/api/extensions/${req.namespace}/${req.name}/${req.version}/download`
}

/**
 * Download + fully verify a package WITHOUT writing anything. Runs the digest,
 * signature, and capability-scope checks, cross-checks the identity, and reads
 * the manifest. Throws on any verification failure. On success returns the
 * decoded entries and the trust facts the UI gates on.
 */
export async function prepareInstall(
  req: InstallRequest,
  deps: InstallerDeps = defaultInstallerDeps
): Promise<PreparedInstall> {
  const { bytes, digestHeader } = await deps.download(downloadUrl(req))

  // The download's advertised digest, when present, must match the trusted
  // metadata digest — a mismatch means the blob was swapped mid-flight.
  if (digestHeader && digestHeader !== req.expectedDigest) {
    throw new InstallError(
      `download digest header ${digestHeader} does not match expected ${req.expectedDigest}`
    )
  }

  // Read the manifest first so capability scope feeds the verification chain.
  const entries = readZipEntries(bytes)
  const rawManifest = readManifestFromEntries(entries)
  const manifest = parseInstalledManifest(rawManifest)

  const expectedId = `${req.namespace}.${req.name}`
  if (manifest.id !== expectedId) {
    throw new InstallError(
      `package identity ${manifest.id} does not match requested ${expectedId}`
    )
  }
  if (manifest.version !== req.version) {
    throw new InstallError(
      `package version ${manifest.version} does not match requested ${req.version}`
    )
  }

  const { trustTier, sensitive } = verifyPackage({
    bytes,
    expectedDigest: req.expectedDigest,
    signature: req.signature,
    publicKey: req.publicKey,
    claimedTrustTier: req.claimedTrustTier,
    requires: manifest.requires,
  })

  return {
    id: manifest.id,
    version: manifest.version,
    manifest,
    entries,
    trustTier,
    sensitive,
    requiresConfirmation: sensitive.length > 0,
  }
}

/**
 * Write a prepared, verified package into `<pluginsRoot>/<id>/`, replacing any
 * previous install of the same id (so update reuses this path). Every entry
 * path is re-checked against zip-slip before it is written. Returns the launch
 * descriptor the loader registers.
 */
export function commitInstall(
  prepared: PreparedInstall,
  pluginsRoot: string,
  deps: InstallerDeps = defaultInstallerDeps
): PluginLaunchDescriptor {
  const dir = join(pluginsRoot, prepared.id)
  deps.rmrf(dir) // idempotent replace (fresh install or update)
  for (const entry of prepared.entries) {
    assertSafeEntryPath(entry.path)
    const target = join(dir, entry.path)
    deps.mkdirp(dirname(target))
    deps.writeFile(target, entry.data)
  }
  return manifestToDescriptor(prepared.manifest, dir)
}

/** Remove an installed plugin's directory. Idempotent. */
export function removePlugin(
  pluginsRoot: string,
  id: string,
  deps: InstallerDeps = defaultInstallerDeps
): void {
  deps.rmrf(join(pluginsRoot, id))
}

/**
 * Whether `latestVersion` is a strictly-newer semver than `installedVersion`.
 * Used to surface an update in the Extensions view. Non-semver inputs return
 * false (no false-positive update prompts).
 */
export function isUpdateAvailable(installedVersion: string, latestVersion: string | null): boolean {
  if (!latestVersion) return false
  const a = parseSemver(installedVersion)
  const b = parseSemver(latestVersion)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) {
    if (b[i] > a[i]) return true
    if (b[i] < a[i]) return false
  }
  return false
}

function parseSemver(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}
