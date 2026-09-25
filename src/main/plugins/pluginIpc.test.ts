// End-to-end coverage for the `plugins:prepareInstall` IPC handler, focused on
// the wire → verifier hand-off: the registry detail API speaks snake_case
// (`public_key` at the detail top level, `signature` on each version row) and
// `prepareInstall` takes camelCase (`publicKey`, `signature`). This proves the
// mapping is wired so a validly-signed package actually reaches
// `signed-verified`, a tampered/rotated signature hard-blocks, and missing
// material remains `unsigned` only on the legacy v1 compatibility path.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateKeyPairSync, sign as edSign } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha256Hex } from './pluginVerify'
import { registryRootFingerprint } from './pluginRegistryRootApproval'
import {
  REGISTRY_ARTIFACT_NAME,
  REGISTRY_RECEIPT_NAME,
  REGISTRY_TRUST_SNAPSHOT_NAME,
  readRegistryTrustSnapshot,
  registryReceiptFromEvidence,
  discoverInstalledRegistryPackageIds,
  verifyInstalledRegistryPackage,
  type InstalledTrustDecision,
} from './pluginInstalledTrust'
import { canonicalTrustJson, type RegistryPackageEnvelope, type RegistryTrustMetadata } from './pluginRegistryTrust'
import { defaultInstallerDeps, type InstallerTrustConfig } from './pluginInstaller'
import { backendEntryOnDisk, type PluginActivationCatalogEntry } from './installedPlugins'
import { projectBackendPluginActivationCatalog } from './pluginBackendActivationCatalog'
import { makeZip } from './zipFixture'
import { readZipEntries } from './pluginPackage'
import { PluginCapabilityGrantStore } from './pluginCapabilityGrantStore'
import { immutablePluginPackageDir, PluginActivationSelector } from './pluginActivationSelector'

const { handlers, browserWindowFromWebContents } = vi.hoisted(() => ({
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
  browserWindowFromWebContents: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: { fromWebContents: browserWindowFromWebContents },
  ipcMain: {
    handle: (channel: string, fn: (...a: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    },
  },
}))

import { app as electronApp } from 'electron'
import {
  OFFICIAL_MARKETPLACE_URL,
  isTrustedPluginManagementSender,
  registerPluginIpc,
  resolveConfiguredMarketplace,
} from './pluginIpc'
import { FrontendPluginManager } from './frontendPluginManager'

function buildPkg(
  packageId = 'acme.demo',
  publisherId = 'acme',
  permissions: Record<string, unknown> = {},
  version = '1.0.0'
): { bytes: Uint8Array; digest: string } {
  const manifest = JSON.stringify({
    schemaVersion: 2,
    apiVersion: '^1.0.0',
    id: packageId,
    name: 'Demo',
    version,
    publisher: publisherId,
    permissions,
    marketplace: { description: 'Demo frontend', license: 'MIT' },
    contributes: {
      views: [
        {
          id: 'left',
          kind: 'custom',
          location: 'left',
          title: 'Demo',
          entry: 'frontend/left/index.html',
        },
      ],
    },
  })
  const zip = makeZip([
    { name: 'manifest.json', data: manifest },
    { name: 'frontend/left/index.html', data: '<!doctype html>' },
  ])
  const bytes = new Uint8Array(zip)
  return { bytes, digest: sha256Hex(bytes) }
}

function buildReservedPkg(): { bytes: Uint8Array; digest: string } {
  const manifest = JSON.stringify({
    schemaVersion: 2,
    apiVersion: '^1.0.0',
    id: 'navide.spoof',
    name: 'Spoof',
    version: '1.0.0',
    publisher: 'navide',
    permissions: {},
    marketplace: { description: 'Reserved namespace spoof', license: 'MIT' },
    contributes: {
      views: [
        {
          id: 'left',
          kind: 'custom',
          location: 'left',
          title: 'Spoof',
          entry: 'frontend/left/index.html',
        },
      ],
    },
  })
  const bytes = new Uint8Array(
    makeZip([
      { name: 'manifest.json', data: manifest },
      { name: 'frontend/left/index.html', data: '<!doctype html>' },
    ])
  )
  return { bytes, digest: sha256Hex(bytes) }
}

// The manifest names its backend entry in wire form (`backend/entry`); on
// disk the Host looks for the platform's executable beside it, which on a
// Windows host is `backend/entry.exe`. The fixture ships both so the
// installer's wire check and the on-disk check pass on whichever host runs it.
const BACKEND_ENTRY_ON_DISK = backendEntryOnDisk('backend/entry')

function buildBackendPkg(version = '1.0.0'): { bytes: Uint8Array; digest: string } {
  const manifest = JSON.stringify({
    schemaVersion: 2,
    apiVersion: '^1.0.0',
    id: 'acme.demo',
    name: 'Demo',
    version,
    publisher: 'acme',
    permissions: {},
    marketplace: { description: 'Demo backend', license: 'MIT' },
    backend: { entry: 'backend/entry', protocolVersion: 1, activation: 'startup' },
  })
  const entry = { data: Buffer.from([0x7f, 0x45, 0x4c, 0x46]), unixMode: 0o100755 }
  const zip = makeZip([
    { name: 'manifest.json', data: manifest },
    { name: 'backend/entry', ...entry },
    ...(BACKEND_ENTRY_ON_DISK === 'backend/entry' ? [] : [{ name: BACKEND_ENTRY_ON_DISK, ...entry }]),
  ])
  const bytes = new Uint8Array(zip)
  return { bytes, digest: sha256Hex(bytes) }
}

function buildLegacyPkg(requires: string[] = [], version = '1.0.0'): { bytes: Uint8Array; digest: string } {
  const manifest = JSON.stringify({
    id: 'acme.demo',
    version,
    publisher: 'acme',
    requires,
    entry: 'dist/main.js',
  })
  const bytes = new Uint8Array(
    makeZip([
      { name: 'manifest.json', data: manifest },
      { name: 'dist/main.js', data: 'console.log("demo")' },
    ])
  )
  return { bytes, digest: sha256Hex(bytes) }
}

function keypair(): { pubPem: string; privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'] } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { pubPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey }
}

function signCanonical(value: unknown, privateKey: Parameters<typeof edSign>[2]): string {
  return edSign(null, Buffer.from(canonicalTrustJson(value), 'utf8'), privateKey).toString('base64')
}

const registryRoot = keypair()
const registrySigner = keypair()
const FIXED_NOW = new Date('2026-08-16T12:00:00.000Z')
const TRUST_CONFIG: InstallerTrustConfig = {
  pinnedRegistryRootKey: registryRoot.pubPem,
  now: FIXED_NOW,
}

/** Test-only stand-ins for the Host-owned restricted preflight adapters. */
const TEST_PREFLIGHT_OPTIONS = {
  preflightCandidateFrontend: async () => undefined,
  preflightCandidateBackend: async () => undefined,
}

/** Detail JSON as the central-signing registry serialises it. */
interface WireDetail {
  latest_version: string | null
  trust_metadata: RegistryTrustMetadata
  trust_metadata_signature: string
  versions: Array<{
    version: string
    package_digest: string
    target: string
    registry_envelope: RegistryPackageEnvelope
    registry_signature: string | null
    trust_tier: string
    yanked: boolean
  }>
}

function signedDetail(
  digest: string,
  packageId = 'acme.demo',
  publisherId = 'acme',
  version = '1.0.0'
): WireDetail {
  const registryEnvelope: RegistryPackageEnvelope = {
    schemaVersion: 1,
    artifactDigest: digest,
    packageId,
    version,
    target: 'universal',
    publisherId,
    keyId: 'registry-test-1',
    signedAt: '2026-08-16T11:00:00.000Z',
  }
  const trustMetadata: RegistryTrustMetadata = {
    schemaVersion: 1,
    registryProfile: 'official',
    rootFingerprint: `sha256:${'1'.repeat(64)}`,
    generatedAt: '2026-08-16T10:00:00.000Z',
    expiresAt: '2026-08-17T10:00:00.000Z',
    signers: [
      {
        keyId: 'registry-test-1',
        publicKey: registrySigner.pubPem,
        status: 'active',
        notBefore: '2026-08-01T00:00:00.000Z',
        notAfter: '2026-09-01T00:00:00.000Z',
      },
    ],
    blockedPublishers: [],
    blockedPackages: [],
  }
  return {
    latest_version: version,
    trust_metadata: trustMetadata,
    trust_metadata_signature: signCanonical(trustMetadata, registryRoot.privateKey),
    versions: [
      {
        version,
        package_digest: digest,
        target: 'universal',
        registry_envelope: registryEnvelope,
        registry_signature: signCanonical(registryEnvelope, registrySigner.privateKey),
        trust_tier: 'signed-verified',
        yanked: false,
      },
    ],
  }
}

/** A fetch that serves the detail endpoint and the package download from a
 *  single fixed package + detail body, routing by URL suffix. */
function installFetch(detail: WireDetail, bytes: Uint8Array, digest: string): void {
  global.fetch = vi.fn(async (url: unknown) => {
    const u = String(url)
    if (u.endsWith('/download')) {
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      return {
        ok: true,
        status: 200,
        async arrayBuffer() {
          return ab
        },
        headers: { get: (h: string) => (h.toLowerCase() === 'x-package-digest' ? digest : null) },
      }
    }
    return { ok: true, status: 200, async json() { return detail } }
  }) as unknown as typeof fetch
}

function register(
  pluginsRoot = '/plugins',
  manager = new FrontendPluginManager()
): (...a: unknown[]) => unknown {
  registerPluginIpc(manager, pluginsRoot, () => true, TRUST_CONFIG, undefined, {
    cleanupPluginStorage: async () => undefined,
    ...TEST_PREFLIGHT_OPTIONS,
  })
  const handler = handlers.get('plugins:prepareInstall')
  if (!handler) throw new Error('prepareInstall handler not registered')
  return handler
}

async function installRegistryEvidence(
  root: string,
  bytes: Uint8Array,
  digest: string,
  detail = signedDetail(digest),
  namespace = 'acme',
  name = 'demo'
): Promise<void> {
  installFetch(detail, bytes, digest)
  const manager = new FrontendPluginManager()
  registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
    ...TEST_PREFLIGHT_OPTIONS,
  })
  const prepareHandler = handlers.get('plugins:prepareInstall')
  const commitHandler = handlers.get('plugins:commitInstall')
  const restartHandler = handlers.get('plugins:restart')
  if (!prepareHandler || !commitHandler || !restartHandler) throw new Error('install handlers not registered')
  await prepareHandler(null, { namespace, name })
  await commitHandler(null, { id: `${namespace}.${name}`, publisherConfirmed: true })
  await restartHandler(null, { id: `${namespace}.${name}` })
  expect(discoverInstalledRegistryPackageIds(root)).toContain(`${namespace}.${name}`)
  manager.removeInstalledPlugin(`${namespace}.${name}`)
  handlers.clear()
}

function writeExpiredTrustSnapshot(root: string): void {
  const detail = signedDetail('0'.repeat(64))
  const metadata: RegistryTrustMetadata = {
    ...detail.trust_metadata,
    generatedAt: '2026-08-14T10:00:00.000Z',
    expiresAt: '2026-08-15T10:00:00.000Z',
  }
  writeFileSync(
    join(root, '.navide-registry-trust.json'),
    JSON.stringify({
      schemaVersion: 1,
      metadata,
      metadataSignature: signCanonical(metadata, registryRoot.privateKey),
    })
  )
}

describe('plugin management sender authorization', () => {
  beforeEach(() => {
    handlers.clear()
    browserWindowFromWebContents.mockReset()
  })

  it('accepts only a live trusted Host top-level window', () => {
    const sender = {}
    const trustedWindow = { isDestroyed: () => false, webContents: sender }
    const trustedWindows = new Set([trustedWindow])
    browserWindowFromWebContents.mockReturnValue(trustedWindow)

    expect(
      isTrustedPluginManagementSender(
        { sender, senderFrame: { parent: null } } as never,
        trustedWindows as never
      )
    ).toBe(true)

    expect(
      isTrustedPluginManagementSender(
        { sender, senderFrame: { parent: {} } } as never,
        trustedWindows as never
      )
    ).toBe(false)

    const pluginSender = {}
    browserWindowFromWebContents.mockReturnValue(trustedWindow)
    expect(
      isTrustedPluginManagementSender(
        { sender: pluginSender, senderFrame: { parent: null } } as never,
        trustedWindows as never
      )
    ).toBe(false)

    browserWindowFromWebContents.mockReturnValue({ isDestroyed: () => false, webContents: sender })
    expect(
      isTrustedPluginManagementSender(
        { sender, senderFrame: { parent: null } } as never,
        trustedWindows as never
      )
    ).toBe(false)

    browserWindowFromWebContents.mockReturnValue({ isDestroyed: () => true, webContents: sender })
    expect(
      isTrustedPluginManagementSender(
        { sender, senderFrame: { parent: null } } as never,
        trustedWindows as never
      )
    ).toBe(false)

    browserWindowFromWebContents.mockReturnValue(null)
    expect(
      isTrustedPluginManagementSender(
        { sender, senderFrame: { parent: null } } as never,
        trustedWindows as never
      )
    ).toBe(false)
  })

  it('projects sanitized manifest icons without exposing Host file paths', () => {
    const resolveContributionIcon = vi.fn((iconFile: string) =>
      iconFile.endsWith('primary.png')
        ? { url: 'data:image/png;base64,AAAA', monochrome: true }
        : null
    )
    const manager = {
      listContributionCatalog: () => [
        {
          pluginId: 'acme.tools',
          packageVersion: '1.2.3',
          contributionKey: 'acme.tools.secondary',
          title: 'Secondary',
          iconFile: null,
          kind: 'custom',
          location: 'right',
          manifestOrder: 0,
        },
        {
          pluginId: 'acme.tools',
          packageVersion: '1.2.3',
          contributionKey: 'acme.tools.primary',
          title: 'Primary',
          iconFile: '/plugins/acme.tools/icons/primary.png',
          kind: 'custom',
          location: 'left',
          manifestOrder: 1,
        },
      ],
      listInstalledPackages: () => [],
    } as unknown as FrontendPluginManager
    registerPluginIpc(manager, '/plugins', () => true, undefined, undefined, {
      resolveContributionIcon,
    })

    const handler = handlers.get('plugins:listContributions')
    if (!handler) throw new Error('contribution catalog handler not registered')
    const projected = handler(null) as Array<Record<string, unknown>>
    expect(projected).toEqual([
      {
        pluginId: 'acme.tools',
        packageVersion: '1.2.3',
        contributionKey: 'acme.tools.secondary',
        title: 'Secondary',
        icon: null,
        iconMonochrome: false,
        kind: 'custom',
        location: 'right',
        manifestOrder: 0,
      },
      {
        pluginId: 'acme.tools',
        packageVersion: '1.2.3',
        contributionKey: 'acme.tools.primary',
        title: 'Primary',
        icon: 'data:image/png;base64,AAAA',
        iconMonochrome: true,
        kind: 'custom',
        location: 'left',
        manifestOrder: 1,
      },
    ])
    expect(resolveContributionIcon).toHaveBeenCalledOnce()
    expect(resolveContributionIcon).toHaveBeenCalledWith(
      '/plugins/acme.tools/icons/primary.png'
    )
    expect(projected[1]).not.toHaveProperty('iconFile')
  })

  it('rejects unauthorized senders on every plugins channel before side effects', async () => {
    const manager = {
      listDescriptors: vi.fn(),
      listInstalledPackages: vi.fn(),
      registerDescriptor: vi.fn(),
      registerInstalledPackage: vi.fn(),
      removeInstalledPlugin: vi.fn(),
    } as unknown as FrontendPluginManager
    const authorize = vi.fn(() => false)
    const fetchBefore = global.fetch
    global.fetch = vi.fn() as unknown as typeof fetch
    registerPluginIpc(manager, '/plugins', authorize)

    const calls: Array<[string, unknown]> = [
      ['plugins:listInstalled', undefined],
      ['plugins:listContributions', undefined],
      ['plugins:marketplaceSearch', 'demo'],
      ['plugins:prepareInstall', { namespace: 'acme', name: 'demo' }],
      ['plugins:commitInstall', { id: 'acme.demo', confirmed: true }],
      ['plugins:remove', { id: 'acme.demo' }],
    ]
    try {
      for (const [channel, args] of calls) {
        const handler = handlers.get(channel)
        if (!handler) throw new Error(`${channel} handler not registered`)
        await expect(
          Promise.resolve().then(() => handler({ unauthorized: true }, args))
        ).rejects.toThrow(/unauthorized plugin management request/)
      }
      expect(authorize).toHaveBeenCalledTimes(calls.length)
      expect(global.fetch).not.toHaveBeenCalled()
      expect(manager.listDescriptors).not.toHaveBeenCalled()
      expect(manager.listInstalledPackages).not.toHaveBeenCalled()
      expect(manager.registerDescriptor).not.toHaveBeenCalled()
      expect(manager.registerInstalledPackage).not.toHaveBeenCalled()
      expect(manager.removeInstalledPlugin).not.toHaveBeenCalled()
    } finally {
      global.fetch = fetchBefore
    }
  })
})

describe('plugins:remove boundary validation', () => {
  beforeEach(() => handlers.clear())

  it('rejects malformed ids before deleting or changing activation state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-remove-invalid-'))
    const installedDir = join(root, 'acme.demo')
    mkdirSync(installedDir, { recursive: true })
    writeFileSync(join(installedDir, 'keep.txt'), 'keep')
    const manager = new FrontendPluginManager()
    const removeInstalledPlugin = vi.spyOn(manager, 'removeInstalledPlugin')
    const onActivationChange = vi.fn()
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        onActivationChange,
      })
      const removeHandler = handlers.get('plugins:remove')
      if (!removeHandler) throw new Error('remove handler not registered')

      const invalidIds: unknown[] = [
        '',
        '.',
        '..',
        '/',
        '\\',
        '../acme.demo',
        '..\\acme.demo',
        '/tmp/acme.demo',
        'acme.demo/..',
        'acme.%2e',
        '%2e%2e',
        'Acme.demo',
        'acme',
        'acme..demo',
        'acme.demo.',
        null,
        42,
      ]
      for (const id of invalidIds) {
        await expect(removeHandler(null, { id })).rejects.toThrow(/invalid plugin id/)
      }
      await expect(removeHandler(null, null)).rejects.toThrow(/invalid plugin id/)
      expect(existsSync(installedDir)).toBe(true)
      expect(removeInstalledPlugin).not.toHaveBeenCalled()
      expect(onActivationChange).not.toHaveBeenCalled()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('removes a valid direct-child id and clears its activation state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-remove-valid-'))
    const installedDir = join(root, 'acme.demo')
    mkdirSync(installedDir, { recursive: true })
    const manager = new FrontendPluginManager()
    const order: string[] = []
    vi.spyOn(manager, 'preparePluginRemoval').mockImplementation(() => {
      order.push('stop')
    })
    const removeInstalledPlugin = vi
      .spyOn(manager, 'removeInstalledPlugin')
      .mockImplementation(() => {
        order.push('remove')
      })
    const cleanupPluginStorage = vi.fn(async () => {
      order.push('cleanup')
    })
    const onActivationChange = vi.fn()
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        cleanupPluginStorage,
        onActivationChange,
      })
      const removeHandler = handlers.get('plugins:remove')
      if (!removeHandler) throw new Error('remove handler not registered')

      await expect(removeHandler(null, { id: 'acme.demo' })).resolves.toEqual({ ok: true })
      expect(existsSync(installedDir)).toBe(false)
      expect(removeInstalledPlugin).toHaveBeenCalledWith('acme.demo')
      expect(order).toEqual(['stop', 'cleanup', 'remove'])
      expect(onActivationChange).toHaveBeenCalledWith({ pluginId: 'acme.demo' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('records factory removal without restoring its builtin descriptor', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-remove-factory-'))
    const manager = new FrontendPluginManager()
    const removeInstalledPlugin = vi
      .spyOn(manager, 'removeInstalledPlugin')
      .mockImplementation(() => undefined)
    const onFactoryPackageRemoved = vi.fn()
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        cleanupPluginStorage: vi.fn(async () => undefined),
        factoryPackageIds: ['navide.git'],
        onFactoryPackageRemoved,
      })
      const removeHandler = handlers.get('plugins:remove')
      if (!removeHandler) throw new Error('remove handler not registered')

      await expect(removeHandler(null, { id: 'navide.git' })).resolves.toEqual({ ok: true })
      expect(onFactoryPackageRemoved).toHaveBeenCalledWith('navide.git')
      expect(removeInstalledPlugin).toHaveBeenCalledWith('navide.git', {
        restoreBuiltin: false,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('restores an opted-out factory package through the Host lifecycle callback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-restore-factory-'))
    const manager = new FrontendPluginManager()
    const restoreFactoryPackage = vi.fn(async () => undefined)
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        restoreFactoryPackage,
        listFactoryPackages: () => [
          { id: 'navide.git', version: '0.1.0', active: false, optedOut: true },
        ],
      })
      const listHandler = handlers.get('plugins:listFactoryPackages')
      const restoreHandler = handlers.get('plugins:restoreFactoryPackage')
      if (!listHandler || !restoreHandler) throw new Error('factory handlers not registered')

      expect(listHandler(null)).toEqual([
        { id: 'navide.git', version: '0.1.0', active: false, optedOut: true },
      ])
      await expect(restoreHandler(null, { id: 'navide.git' })).resolves.toEqual({ ok: true })
      expect(restoreFactoryPackage).toHaveBeenCalledWith('navide.git')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses uninstall when storage cleanup is unavailable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-remove-no-storage-cleanup-'))
    const installedDir = join(root, 'acme.demo')
    mkdirSync(installedDir, { recursive: true })
    const manager = new FrontendPluginManager()
    const preparePluginRemoval = vi.spyOn(manager, 'preparePluginRemoval')
    const removeInstalledPlugin = vi.spyOn(manager, 'removeInstalledPlugin')
    const onActivationChange = vi.fn()
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        onActivationChange,
      })
      const removeHandler = handlers.get('plugins:remove')
      if (!removeHandler) throw new Error('remove handler not registered')

      await expect(removeHandler(null, { id: 'acme.demo' })).rejects.toThrow(
        'plugin storage cleanup is unavailable'
      )
      expect(existsSync(installedDir)).toBe(true)
      expect(preparePluginRemoval).not.toHaveBeenCalled()
      expect(removeInstalledPlugin).not.toHaveBeenCalled()
      expect(onActivationChange).not.toHaveBeenCalled()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('restores the approved backend registration after storage cleanup fails', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'navide-remove-backend-')))
    const installedDir = join(root, 'acme.demo')
    mkdirSync(installedDir)
    const manager = new FrontendPluginManager()
    manager.registerDescriptor({
      id: 'acme.demo', packageVersion: '1.0.0', packageDir: installedDir,
      requires: [], devUrl: '', entryFile: join(installedDir, 'index.html'),
    })
    const backend = {
      pluginId: 'acme.demo', packageVersion: '1.0.0', packageDir: installedDir,
      entryFile: join(installedDir, 'backend'), protocolVersion: 1 as const,
      activation: 'startup' as const, approvedMethods: ['fixture.echo'], approvedEvents: [],
    }
    manager.registerBackendActivation(backend)
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        cleanupPluginStorage: async () => { throw new Error('storage unavailable') },
      })
      await expect(handlers.get('plugins:remove')!(null, { id: 'acme.demo' }))
        .rejects.toThrow('storage unavailable')
      expect(manager.getBackendActivation('acme.demo', '1.0.0')).toEqual(backend)
      expect(existsSync(installedDir)).toBe(true)
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('drops the capability grant when package removal fails after storage cleanup', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'navide-remove-grant-')))
    const installedDir = join(root, 'acme.demo')
    mkdirSync(installedDir, { recursive: true })
    const grants = new PluginCapabilityGrantStore(root)
    grants.set('acme.demo', {
      packageVersion: '1.0.0',
      system: ['fs', 'ui', 'aiCli'],
      shell: 'allowlist',
      storage: true,
    })
    const manager = new FrontendPluginManager()
    vi.spyOn(manager, 'removeInstalledPlugin').mockImplementation(() => undefined)
    const rmrf = vi.spyOn(defaultInstallerDeps, 'rmrf').mockImplementation(() => {
      throw new Error('test package removal failure')
    })
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        cleanupPluginStorage: async () => undefined,
      })
      const removeHandler = handlers.get('plugins:remove')
      if (!removeHandler) throw new Error('remove handler not registered')

      // Storage is already wiped here, so a package left behind by a failed
      // directory removal must not keep a usable grant.
      await expect(removeHandler(null, { id: 'acme.demo' })).rejects.toThrow(
        'test package removal failure'
      )
      expect(grants.get('acme.demo', '1.0.0')).toBeNull()
      expect(existsSync(installedDir)).toBe(true)
    } finally {
      rmrf.mockRestore()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps the package installed when storage cleanup fails and permits retry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-remove-storage-failure-'))
    const installedDir = join(root, 'acme.demo')
    mkdirSync(installedDir, { recursive: true })
    const manager = new FrontendPluginManager()
    const preparePluginRemoval = vi.spyOn(manager, 'preparePluginRemoval')
    const removeInstalledPlugin = vi
      .spyOn(manager, 'removeInstalledPlugin')
      .mockImplementation(() => undefined)
    const cleanupPluginStorage = vi
      .fn<(pluginId: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockResolvedValue(undefined)
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        cleanupPluginStorage,
      })
      const removeHandler = handlers.get('plugins:remove')
      if (!removeHandler) throw new Error('remove handler not registered')

      await expect(removeHandler(null, { id: 'acme.demo' })).rejects.toThrow('storage unavailable')
      expect(existsSync(installedDir)).toBe(true)
      expect(preparePluginRemoval).toHaveBeenCalledWith('acme.demo')
      expect(removeInstalledPlugin).not.toHaveBeenCalled()

      await expect(removeHandler(null, { id: 'acme.demo' })).resolves.toEqual({ ok: true })
      expect(existsSync(installedDir)).toBe(false)
      expect(preparePluginRemoval).toHaveBeenCalledTimes(2)
      expect(removeInstalledPlugin).toHaveBeenCalledWith('acme.demo')
      expect(cleanupPluginStorage).toHaveBeenCalledTimes(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('plugins:prepareInstall wire → verifier mapping', () => {
  const savedFetch = global.fetch
  const savedMarketplaceUrl = process.env['AGENT_TEAM_MARKETPLACE_URL']
  const savedRootApprovalFile = process.env['AGENT_TEAM_REGISTRY_ROOT_APPROVAL_FILE']
  beforeEach(() => handlers.clear())
  afterEach(() => {
    global.fetch = savedFetch
    if (savedMarketplaceUrl === undefined) delete process.env['AGENT_TEAM_MARKETPLACE_URL']
    else process.env['AGENT_TEAM_MARKETPLACE_URL'] = savedMarketplaceUrl
    if (savedRootApprovalFile === undefined) {
      delete process.env['AGENT_TEAM_REGISTRY_ROOT_APPROVAL_FILE']
    } else {
      process.env['AGENT_TEAM_REGISTRY_ROOT_APPROVAL_FILE'] = savedRootApprovalFile
    }
    vi.restoreAllMocks()
  })

  it('rejects an unapproved custom Registry before making a network request', async () => {
    process.env['AGENT_TEAM_MARKETPLACE_URL'] = 'https://registry.acme.test'
    delete process.env['AGENT_TEAM_REGISTRY_ROOT_APPROVAL_FILE']
    global.fetch = vi.fn() as unknown as typeof fetch
    registerPluginIpc(new FrontendPluginManager(), '/plugins', () => true)
    const handler = handlers.get('plugins:prepareInstall')
    if (!handler) throw new Error('prepareInstall handler not registered')

    await expect(handler(null, { namespace: 'acme', name: 'demo' })).rejects.toThrow(
      /explicit root approval/
    )
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('uses a separately approved custom Registry root instead of response metadata', async () => {
    const { bytes, digest } = buildPkg()
    const detail = signedDetail(digest)
    installFetch(detail, bytes, digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-custom-registry-'))
    const approvalFile = join(root, 'root-approval.json')
    writeFileSync(
      approvalFile,
      JSON.stringify({
        schemaVersion: 1,
        registryUrl: 'https://registry.acme.test',
        rootPublicKeyPem: registryRoot.pubPem,
        confirmedFingerprint: registryRootFingerprint(registryRoot.pubPem),
      })
    )
    process.env['AGENT_TEAM_MARKETPLACE_URL'] = 'https://registry.acme.test'
    process.env['AGENT_TEAM_REGISTRY_ROOT_APPROVAL_FILE'] = approvalFile
    try {
      registerPluginIpc(new FrontendPluginManager(), '/plugins', () => true, TRUST_CONFIG)
      const handler = handlers.get('plugins:prepareInstall')
      if (!handler) throw new Error('prepareInstall handler not registered')
      await expect(handler(null, { namespace: 'acme', name: 'demo' })).resolves.toMatchObject({
        trustTier: 'signed-verified',
        requiresPublisherTrust: true,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses an approved self-hosted root for the default local Registry profile', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-local-registry-'))
    const approvalFile = join(root, 'root-approval.json')
    writeFileSync(
      approvalFile,
      JSON.stringify({
        schemaVersion: 1,
        registryUrl: 'http://localhost:8787',
        rootPublicKeyPem: registryRoot.pubPem,
        confirmedFingerprint: registryRootFingerprint(registryRoot.pubPem),
      })
    )
    delete process.env['AGENT_TEAM_MARKETPLACE_URL']
    process.env['AGENT_TEAM_REGISTRY_ROOT_APPROVAL_FILE'] = approvalFile

    try {
      expect(resolveConfiguredMarketplace()).toMatchObject({
        registryUrl: 'http://localhost:8787',
        trust: { pinnedRegistryRootKey: registryRoot.pubPem },
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('loads the Official Registry root from packaged resources, not runtime approval', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-packaged-root-'))
    const resources = join(root, 'resources')
    mkdirSync(resources, { recursive: true })
    writeFileSync(join(resources, 'official-registry-root.pem'), registryRoot.pubPem)
    const approvalFile = join(root, 'root-approval.json')
    writeFileSync(
      approvalFile,
      JSON.stringify({
        schemaVersion: 1,
        registryUrl: 'https://server.navide.dev/registry',
        rootPublicKeyPem: registrySigner.pubPem,
        confirmedFingerprint: registryRootFingerprint(registrySigner.pubPem),
      })
    )
    const previousResourcesDescriptor = Object.getOwnPropertyDescriptor(
      process,
      'resourcesPath'
    )
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: root,
    })
    process.env['AGENT_TEAM_MARKETPLACE_URL'] = 'https://server.navide.dev/registry'
    process.env['AGENT_TEAM_REGISTRY_ROOT_APPROVAL_FILE'] = approvalFile
    try {
      expect(resolveConfiguredMarketplace()).toMatchObject({
        registryUrl: 'https://server.navide.dev/registry',
        trust: {
          pinnedRegistryRootKey: registryRoot.pubPem,
          registryAuthority: 'official',
        },
      })
    } finally {
      if (previousResourcesDescriptor) {
        Object.defineProperty(process, 'resourcesPath', previousResourcesDescriptor)
      } else {
        Reflect.deleteProperty(process, 'resourcesPath')
      }
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('defaults a packaged App to the Official Registry and a dev App to localhost', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-packaged-default-'))
    const resources = join(root, 'resources')
    mkdirSync(resources, { recursive: true })
    writeFileSync(join(resources, 'official-registry-root.pem'), registryRoot.pubPem)
    const previousResourcesDescriptor = Object.getOwnPropertyDescriptor(
      process,
      'resourcesPath'
    )
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: root,
    })
    delete process.env['AGENT_TEAM_MARKETPLACE_URL']
    delete process.env['AGENT_TEAM_REGISTRY_ROOT_APPROVAL_FILE']
    const mutableApp = electronApp as { isPackaged: boolean }
    try {
      mutableApp.isPackaged = true
      expect(resolveConfiguredMarketplace()).toMatchObject({
        registryUrl: OFFICIAL_MARKETPLACE_URL,
        trust: {
          pinnedRegistryRootKey: registryRoot.pubPem,
          registryAuthority: 'official',
          officialRegistryUrl: 'https://server.navide.dev/registry',
        },
      })
      mutableApp.isPackaged = false
      // The development default is a self-hosted Registry and never inherits
      // the packaged Official root.
      expect(() => resolveConfiguredMarketplace()).toThrow(/root approval file/)
    } finally {
      mutableApp.isPackaged = false
      if (previousResourcesDescriptor) {
        Object.defineProperty(process, 'resourcesPath', previousResourcesDescriptor)
      } else {
        Reflect.deleteProperty(process, 'resourcesPath')
      }
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps the Registry path prefix when searching the marketplace', async () => {
    process.env['AGENT_TEAM_MARKETPLACE_URL'] = 'https://server.navide.dev/registry/'
    const fetchMock = vi.fn(async (_url: unknown) => ({
      ok: true,
      status: 200,
      async json() {
        return { items: [] }
      },
    }))
    global.fetch = fetchMock as unknown as typeof fetch
    registerPluginIpc(new FrontendPluginManager(), '/plugins', () => true, TRUST_CONFIG)
    const handler = handlers.get('plugins:marketplaceSearch')
    if (!handler) throw new Error('marketplaceSearch handler not registered')
    await handler(null, 'git')
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://server.navide.dev/registry/api/extensions?q=git'
    )
  })

  it('fetches detail and download under the Registry path prefix', async () => {
    const { bytes, digest } = buildPkg()
    installFetch(signedDetail(digest), bytes, digest)
    process.env['AGENT_TEAM_MARKETPLACE_URL'] = 'https://server.navide.dev/registry'
    await register()(null, { namespace: 'acme', name: 'demo' })
    const urls = vi.mocked(global.fetch).mock.calls.map((call) => String(call[0]))
    expect(urls).toEqual([
      'https://server.navide.dev/registry/api/extensions/acme/demo',
      'https://server.navide.dev/registry/api/extensions/acme/demo/1.0.0/download',
    ])
  })

  /** The same version published once per platform: each row signs its target. */
  function perTargetDetail(digest: string, targets: string[]): WireDetail {
    const base = signedDetail(digest)
    const versions = targets.map((target) => {
      const registryEnvelope = { ...base.versions[0].registry_envelope, target }
      return {
        ...base.versions[0],
        target,
        registry_envelope: registryEnvelope,
        registry_signature: signCanonical(registryEnvelope, registrySigner.privateKey),
      }
    })
    return { ...base, versions }
  }

  function registerForHost(expectedTarget: string): (...a: unknown[]) => unknown {
    registerPluginIpc(new FrontendPluginManager(), '/plugins', () => true, {
      ...TRUST_CONFIG,
      expectedTarget,
    })
    const handler = handlers.get('plugins:prepareInstall')
    if (!handler) throw new Error('prepareInstall handler not registered')
    return handler
  }

  it("downloads the Host platform's artifact when a version has several targets", async () => {
    const { bytes, digest } = buildPkg()
    const detail = perTargetDetail(digest, ['darwin-arm64', 'win32-x64'])
    global.fetch = vi.fn(async (url: unknown) => {
      if (String(url).includes('/download')) {
        const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        return { ok: true, status: 200, arrayBuffer: async () => ab, headers: { get: () => digest } }
      }
      return { ok: true, status: 200, json: async () => detail }
    }) as unknown as typeof fetch
    process.env['AGENT_TEAM_MARKETPLACE_URL'] = 'https://server.navide.dev/registry'

    const result = (await registerForHost('win32-x64')(null, { namespace: 'acme', name: 'demo' })) as {
      id: string
    }

    expect(result.id).toBe('acme.demo')
    expect(vi.mocked(global.fetch).mock.calls.map((call) => String(call[0]))).toEqual([
      'https://server.navide.dev/registry/api/extensions/acme/demo',
      'https://server.navide.dev/registry/api/extensions/acme/demo/1.0.0/download?target=win32-x64',
    ])
  })

  it('names the available targets and downloads nothing when none fits the Host', async () => {
    const { digest } = buildPkg()
    const detail = perTargetDetail(digest, ['darwin-arm64', 'linux-x64'])
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => detail })) as unknown as typeof fetch
    process.env['AGENT_TEAM_MARKETPLACE_URL'] = 'https://server.navide.dev/registry'

    await expect(
      registerForHost('win32-x64')(null, { namespace: 'acme', name: 'demo' })
    ).rejects.toThrow(
      "version 1.0.0 has no artifact for host target 'win32-x64' (available: darwin-arm64, linux-x64)"
    )
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('still rejects a row whose signed envelope names another target', async () => {
    const { bytes, digest } = buildPkg()
    const detail = perTargetDetail(digest, ['darwin-arm64'])
    // The row claims the Host target, but the Registry signed darwin-arm64.
    detail.versions[0].target = 'win32-x64'
    global.fetch = vi.fn(async (url: unknown) => {
      if (String(url).includes('/download')) {
        const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        return { ok: true, status: 200, arrayBuffer: async () => ab, headers: { get: () => digest } }
      }
      return { ok: true, status: 200, json: async () => detail }
    }) as unknown as typeof fetch
    process.env['AGENT_TEAM_MARKETPLACE_URL'] = 'https://server.navide.dev/registry'

    await expect(
      registerForHost('win32-x64')(null, { namespace: 'acme', name: 'demo' })
    ).rejects.toThrow(/registry envelope target does not match/)
  })

  it('does not activate a self-hosted reserved package after restart', () => {
    const { bytes, digest } = buildReservedPkg()
    const detail = signedDetail(digest, 'navide.spoof', 'navide')
    const root = mkdtempSync(join(tmpdir(), 'navide-reserved-restart-'))
    const pluginDir = join(root, 'navide.spoof')
    mkdirSync(join(pluginDir, 'frontend', 'left'), { recursive: true })
    writeFileSync(
      join(pluginDir, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 2,
        apiVersion: '^1.0.0',
        id: 'navide.spoof',
        name: 'Spoof',
        version: '1.0.0',
        publisher: 'navide',
        permissions: {},
        marketplace: { description: 'Reserved namespace spoof', license: 'MIT' },
        contributes: {
          views: [
            {
              id: 'left',
              kind: 'custom',
              location: 'left',
              title: 'Spoof',
              entry: 'frontend/left/index.html',
            },
          ],
        },
      })
    )
    writeFileSync(join(pluginDir, 'frontend', 'left', 'index.html'), '<!doctype html>')
    writeFileSync(join(pluginDir, REGISTRY_ARTIFACT_NAME), bytes)
    writeFileSync(
      join(pluginDir, REGISTRY_RECEIPT_NAME),
      JSON.stringify(
        registryReceiptFromEvidence({
          packageId: 'navide.spoof',
          version: '1.0.0',
          publisherId: 'navide',
          target: 'universal',
          artifactDigest: digest,
          envelope: detail.versions[0].registry_envelope,
          envelopeSignature: detail.versions[0].registry_signature ?? '',
          registryAuthority: 'self-hosted',
        })
      )
    )
    writeFileSync(
      join(root, REGISTRY_TRUST_SNAPSHOT_NAME),
      JSON.stringify({
        schemaVersion: 1,
        metadata: detail.trust_metadata,
        metadataSignature: detail.trust_metadata_signature,
      })
    )
    try {
      const manager = new FrontendPluginManager()
      const loaded = manager.loadInstalledPlugins(root, {
        provenance: 'official-registry',
        trust: {
          pinnedRootKey: registryRoot.pubPem,
          snapshot: readRegistryTrustSnapshot(root),
          registryAuthority: 'self-hosted',
          officialRegistryUrl: 'https://server.navide.dev/registry',
          now: FIXED_NOW,
        },
      })
      expect(loaded.loaded).toEqual([])
      expect(loaded.activationCatalog).toEqual([])
      expect(loaded.errors.join(' ')).toMatch(/App-authorized Official Registry/)
      expect(manager.listInstalledPackages()).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('(a) verifies the root-authorized Registry envelope → signed-verified', async () => {
    const { bytes, digest } = buildPkg()
    const detail = signedDetail(digest)
    installFetch(detail, bytes, digest)
    const res = (await register()(null, { namespace: 'acme', name: 'demo' })) as {
      trustTier: string
    }
    expect(res.trustTier).toBe('signed-verified')
  })

  it('(b) a forged Registry signature hard-blocks without downgrade', async () => {
    const { bytes, digest } = buildPkg()
    const detail = signedDetail(digest)
    detail.versions[0].registry_signature = signCanonical(
      { ...detail.versions[0].registry_envelope, artifactDigest: 'deadbeef'.repeat(8) },
      registrySigner.privateKey
    )
    installFetch(detail, bytes, digest)
    await expect(register()(null, { namespace: 'acme', name: 'demo' })).rejects.toThrow(
      /signature/i
    )
  })

  it('(c) missing Registry signing material fails closed for v2', async () => {
    const { bytes, digest } = buildPkg()
    const detail = signedDetail(digest)
    detail.versions[0].registry_signature = null
    installFetch(detail, bytes, digest)
    await expect(register()(null, { namespace: 'acme', name: 'demo' })).rejects.toThrow(
      /missing Registry signatures/i
    )
  })

  it('ignores arbitrary publisher key material when the Registry chain is valid', async () => {
    const { bytes, digest } = buildPkg()
    const detail = Object.assign(signedDetail(digest), { public_key: keypair().pubPem })
    Object.assign(detail.versions[0], { signature: 'attacker-controlled' })
    installFetch(detail, bytes, digest)
    const result = (await register()(null, { namespace: 'acme', name: 'demo' })) as {
      trustTier: string
    }
    expect(result.trustTier).toBe('signed-verified')
  })

  it('requires an explicit commit confirmation for a backend package', async () => {
    const { bytes, digest } = buildBackendPkg()
    const detail = signedDetail(digest)
    installFetch(detail, bytes, digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-ipc-'))
    try {
      const manager = new FrontendPluginManager()
      const prepareHandler = register(root, manager)
      const prepared = (await prepareHandler(null, {
        namespace: 'acme',
        name: 'demo',
      })) as {
        containsBackendExecutable: boolean
        requiresConfirmation: boolean
      }
      expect(prepared.containsBackendExecutable).toBe(true)
      expect(prepared.requiresConfirmation).toBe(true)

      const commitHandler = handlers.get('plugins:commitInstall')
      if (!commitHandler) throw new Error('commitInstall handler not registered')
      await expect(commitHandler(null, { id: 'acme.demo' })).rejects.toThrow(
        /publisher trust confirmation/
      )
      await expect(
        commitHandler(null, { id: 'acme.demo', publisherConfirmed: true })
      ).rejects.toThrow(/capability and backend risk confirmation/)
      expect(
        await commitHandler(null, {
          id: 'acme.demo',
          publisherConfirmed: true,
          riskConfirmed: true,
        })
      ).toEqual({
        id: 'acme.demo',
        requires: [],
        restartRequired: true,
      })
      expect(existsSync(immutablePluginPackageDir(root, 'acme.demo', '1.0.0', 'universal') + '/backend/entry')).toBe(true)

      const restartHandler = handlers.get('plugins:restart')
      if (!restartHandler) throw new Error('restart handler not registered')
      await expect(restartHandler(null, { id: 'acme.demo' })).resolves.toMatchObject({
        id: 'acme.demo',
        packageVersion: '1.0.0',
      })

    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('records full-shell approval only after explicit risk confirmation', async () => {
    const { bytes, digest } = buildPkg('acme.demo', 'acme', { shell: 'full' })
    installFetch(signedDetail(digest), bytes, digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-ipc-full-shell-'))
    try {
      const manager = new FrontendPluginManager()
      const prepareHandler = register(root, manager)
      await prepareHandler(null, { namespace: 'acme', name: 'demo' })
      const commitHandler = handlers.get('plugins:commitInstall')
      if (!commitHandler) throw new Error('commitInstall handler not registered')

      await expect(commitHandler(null, {
        id: 'acme.demo',
        publisherConfirmed: true,
      })).rejects.toThrow(/capability and backend risk confirmation/)

      await commitHandler(null, {
        id: 'acme.demo',
        publisherConfirmed: true,
        riskConfirmed: true,
      })
      expect(new PluginCapabilityGrantStore(root).get('acme.demo', '1.0.0')).toBeNull()
      const restartHandler = handlers.get('plugins:restart')
      if (!restartHandler) throw new Error('restart handler not registered')
      await restartHandler(null, { id: 'acme.demo' })
      expect(new PluginCapabilityGrantStore(root).get('acme.demo', '1.0.0')).toMatchObject({
        shell: 'full',
        highRiskShellConfirmed: true,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps B full-shell consent version-bound across rollback and a fresh selector reload', async () => {
    const first = buildPkg('acme.demo', 'acme', { shell: 'full' }, '1.0.0')
    const second = buildPkg('acme.demo', 'acme', { shell: 'full' }, '1.0.1')
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-ipc-full-shell-rollback-'))
    const manager = new FrontendPluginManager()
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, TEST_PREFLIGHT_OPTIONS)
      const prepare = handlers.get('plugins:prepareInstall')!
      const commit = handlers.get('plugins:commitInstall')!
      const restart = handlers.get('plugins:restart')!
      const rollback = handlers.get('plugins:rollback')!

      installFetch(signedDetail(first.digest, 'acme.demo', 'acme', '1.0.0'), first.bytes, first.digest)
      await prepare(null, { namespace: 'acme', name: 'demo' })
      await commit(null, { id: 'acme.demo', publisherConfirmed: true, riskConfirmed: true })
      await restart(null, { id: 'acme.demo' })

      installFetch(signedDetail(second.digest, 'acme.demo', 'acme', '1.0.1'), second.bytes, second.digest)
      await prepare(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      await commit(null, { id: 'acme.demo', publisherConfirmed: true, riskConfirmed: true })
      await restart(null, { id: 'acme.demo' })
      expect(new PluginCapabilityGrantStore(root).get('acme.demo', '1.0.1')).toMatchObject({
        packageVersion: '1.0.1',
        shell: 'full',
        highRiskShellConfirmed: true,
      })

      await expect(rollback(null, { id: 'acme.demo' })).resolves.toMatchObject({ packageVersion: '1.0.0' })
      expect(new PluginActivationSelector(root).read('acme.demo')).toMatchObject({
        active: { packageVersion: '1.0.0', artifactDigest: first.digest },
        candidate: { packageVersion: '1.0.1', artifactDigest: second.digest },
      })

      const reloaded = new PluginActivationSelector(root)
      expect(reloaded.read('acme.demo')?.candidate).toEqual({
        packageVersion: '1.0.1', target: 'universal', artifactDigest: second.digest,
      })
      await expect(restart(null, { id: 'acme.demo' })).resolves.toMatchObject({ packageVersion: '1.0.1' })
      expect(new PluginCapabilityGrantStore(root).get('acme.demo', '1.0.1')).toMatchObject({
        packageVersion: '1.0.1',
        shell: 'full',
        highRiskShellConfirmed: true,
      })
      expect(new PluginCapabilityGrantStore(root).get('acme.demo', '1.0.2')).toBeNull()
      expect(new PluginActivationSelector(root).read('acme.demo')?.active).not.toEqual({
        ...second,
        packageVersion: '1.0.2',
      })
      expect(new PluginActivationSelector(root).read('acme.demo')?.active).not.toEqual({
        ...second,
        artifactDigest: 'c'.repeat(64),
      })
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('stages an immutable replacement without touching the active runtime until restart', async () => {
    const first = buildPkg('acme.demo', 'acme', {}, '1.0.0')
    installFetch(signedDetail(first.digest, 'acme.demo', 'acme', '1.0.0'), first.bytes, first.digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-ipc-lifecycle-'))
    const manager = new FrontendPluginManager()
    const activationChanges: Array<{ pluginId: string; activation?: PluginActivationCatalogEntry }> = []
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        ...TEST_PREFLIGHT_OPTIONS,
        onActivationChange: (change) => activationChanges.push(change),
      })
      const prepare = handlers.get('plugins:prepareInstall')!
      const commit = handlers.get('plugins:commitInstall')!
      const restart = handlers.get('plugins:restart')!
      const list = handlers.get('plugins:listInstalled')!
      await prepare(null, { namespace: 'acme', name: 'demo' })
      await commit(null, { id: 'acme.demo', publisherConfirmed: true, riskConfirmed: true })
      await restart(null, { id: 'acme.demo' })
      activationChanges.length = 0

      const revoke = vi.spyOn(manager, 'revokePackageVersion')
      const second = buildPkg('acme.demo', 'acme', {}, '1.0.1')
      installFetch(
        signedDetail(second.digest, 'acme.demo', 'acme', '1.0.1'),
        second.bytes,
        second.digest,
      )
      await prepare(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      await expect(commit(null, { id: 'acme.demo', publisherConfirmed: true })).resolves.toEqual({
        id: 'acme.demo',
        requires: [],
        restartRequired: true,
      })

      expect(revoke).not.toHaveBeenCalled()
      expect(manager.getDescriptor('acme.demo')?.packageVersion).toBe('1.0.0')
      expect(activationChanges).toEqual([])
      expect(list(null)).toMatchObject([{
        id: 'acme.demo',
        packageVersion: '1.0.0',
        pendingCandidateVersion: '1.0.1',
      }])
      expect(existsSync(immutablePluginPackageDir(root, 'acme.demo', '1.0.0', 'universal'))).toBe(true)
      expect(existsSync(immutablePluginPackageDir(root, 'acme.demo', '1.0.1', 'universal'))).toBe(true)
      expect(new PluginActivationSelector(root).read('acme.demo')).toMatchObject({
        active: { packageVersion: '1.0.0', artifactDigest: first.digest },
        candidate: { packageVersion: '1.0.1', artifactDigest: second.digest },
      })

      await expect(restart(null, { id: 'acme.demo' })).resolves.toMatchObject({
        id: 'acme.demo',
        packageVersion: '1.0.1',
        restoredInstances: 0,
      })
      expect(revoke).toHaveBeenCalledWith('acme.demo', '1.0.0')
      expect(manager.getDescriptor('acme.demo')?.packageVersion).toBe('1.0.1')
      expect(new PluginActivationSelector(root).read('acme.demo')).toMatchObject({
        active: { packageVersion: '1.0.1', artifactDigest: second.digest },
        previous: { packageVersion: '1.0.0', artifactDigest: first.digest },
      })
      expect(activationChanges).toHaveLength(1)
      expect(activationChanges[0]).toMatchObject({
        pluginId: 'acme.demo',
        activation: { packageVersion: '1.0.1', artifactDigest: second.digest },
      })
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('activates an update over a v0.2.9 mutable v2 install and retains its rollback grant', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-legacy-v2-upgrade-'))
    const manager = new FrontendPluginManager()
    const first = buildPkg('acme.demo', 'acme', {}, '1.0.0')
    const firstDetail = signedDetail(first.digest)
    const legacyDir = join(root, 'acme.demo')
    try {
      for (const entry of readZipEntries(first.bytes)) {
        if (entry.kind !== 'file') continue
        const output = join(legacyDir, entry.path)
        mkdirSync(join(output, '..'), { recursive: true })
        writeFileSync(output, entry.data)
      }
      writeFileSync(join(legacyDir, REGISTRY_ARTIFACT_NAME), first.bytes)
      writeFileSync(join(legacyDir, REGISTRY_RECEIPT_NAME), JSON.stringify(registryReceiptFromEvidence({
        packageId: 'acme.demo', version: '1.0.0', publisherId: 'acme', target: 'universal',
        artifactDigest: first.digest,
        envelope: firstDetail.versions[0]!.registry_envelope,
        envelopeSignature: firstDetail.versions[0]!.registry_signature!,
        registryAuthority: 'self-hosted',
      })))
      writeFileSync(join(root, REGISTRY_TRUST_SNAPSHOT_NAME), JSON.stringify({
        schemaVersion: 1,
        metadata: firstDetail.trust_metadata,
        metadataSignature: firstDetail.trust_metadata_signature,
      }))
      new PluginCapabilityGrantStore(root).set('acme.demo', {
        packageVersion: '1.0.0', system: [], storage: true,
      })
      expect(manager.loadInstalledPlugins(root, {
        provenance: 'official-registry',
        trust: {
          pinnedRootKey: registryRoot.pubPem,
          snapshot: readRegistryTrustSnapshot(root),
          registryAuthority: 'self-hosted',
          now: FIXED_NOW,
        },
      }).loaded).toContain('acme.demo')
      expect(new PluginActivationSelector(root).read('acme.demo')).toBeNull()

      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, TEST_PREFLIGHT_OPTIONS)
      const second = buildPkg('acme.demo', 'acme', {}, '1.0.1')
      installFetch(signedDetail(second.digest, 'acme.demo', 'acme', '1.0.1'), second.bytes, second.digest)
      await handlers.get('plugins:prepareInstall')!(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      await handlers.get('plugins:commitInstall')!(null, { id: 'acme.demo', publisherConfirmed: true })
      expect(manager.getDescriptor('acme.demo')?.packageVersion).toBe('1.0.0')
      expect(new PluginActivationSelector(root).read('acme.demo')).toMatchObject({
        candidate: { packageVersion: '1.0.1' },
      })
      writeFileSync(join(legacyDir, 'frontend', 'left', 'index.html'), '<tampered>')
      await expect(handlers.get('plugins:restart')!(null, { id: 'acme.demo' }))
        .rejects.toThrow(/legacy active package cannot be verified/)
      expect(new PluginActivationSelector(root).read('acme.demo')?.active).toBeUndefined()
      writeFileSync(join(legacyDir, 'frontend', 'left', 'index.html'), '<!doctype html>')

      await expect(handlers.get('plugins:restart')!(null, { id: 'acme.demo' })).resolves.toMatchObject({
        packageVersion: '1.0.1',
      })
      expect(new PluginActivationSelector(root).read('acme.demo')).toMatchObject({
        active: { packageVersion: '1.0.1' },
        previous: { packageVersion: '1.0.0', artifactDigest: first.digest },
        previousGrant: { packageVersion: '1.0.0' },
      })
      await expect(handlers.get('plugins:rollback')!(null, { id: 'acme.demo' })).resolves.toMatchObject({
        packageVersion: '1.0.0',
      })
      expect(manager.getDescriptor('acme.demo')?.packageDir).toBe(legacyDir)
      const reloaded = new FrontendPluginManager()
      expect(reloaded.loadInstalledPlugins(root, {
        provenance: 'official-registry',
        trust: {
          pinnedRootKey: registryRoot.pubPem,
          snapshot: readRegistryTrustSnapshot(root),
          registryAuthority: 'self-hosted',
          now: FIXED_NOW,
        },
      }).loaded).toContain('acme.demo')
      expect(reloaded.getDescriptor('acme.demo')?.packageDir).toBe(legacyDir)
      await reloaded.closeBackendPlugins()
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  /** Lay out a v0.2.9-shaped install: mutable `<root>/<id>`, no selector record. */
  function writeV029Install(root: string, pkg: { bytes: Uint8Array; digest: string }): void {
    const detail = signedDetail(pkg.digest)
    const legacyDir = join(root, 'acme.demo')
    for (const entry of readZipEntries(pkg.bytes)) {
      if (entry.kind !== 'file') continue
      const output = join(legacyDir, entry.path)
      mkdirSync(join(output, '..'), { recursive: true })
      writeFileSync(output, entry.data, entry.executable ? { mode: 0o755 } : undefined)
    }
    writeFileSync(join(legacyDir, REGISTRY_ARTIFACT_NAME), pkg.bytes)
    writeFileSync(join(legacyDir, REGISTRY_RECEIPT_NAME), JSON.stringify(registryReceiptFromEvidence({
      packageId: 'acme.demo', version: '1.0.0', publisherId: 'acme', target: 'universal',
      artifactDigest: pkg.digest,
      envelope: detail.versions[0]!.registry_envelope,
      envelopeSignature: detail.versions[0]!.registry_signature!,
      registryAuthority: 'self-hosted',
    })))
    writeFileSync(join(root, REGISTRY_TRUST_SNAPSHOT_NAME), JSON.stringify({
      schemaVersion: 1,
      metadata: detail.trust_metadata,
      metadataSignature: detail.trust_metadata_signature,
    }))
    new PluginCapabilityGrantStore(root).set('acme.demo', {
      packageVersion: '1.0.0', system: [], storage: true,
    })
  }

  /** The Host's cold-start/activation-change backend registration (index.ts). */
  function registerActivationBackend(manager: FrontendPluginManager, activation?: PluginActivationCatalogEntry): void {
    if (!activation?.backend || manager.hasBackendActivation(activation.pluginId, activation.packageVersion)) return
    manager.registerBackendActivation({
      pluginId: activation.pluginId,
      packageVersion: activation.packageVersion,
      packageDir: activation.packageDir,
      entryFile: activation.backend.entryFile,
      protocolVersion: activation.backend.protocolVersion,
      activation: activation.backend.activation,
      approvedMethods: [],
      approvedEvents: [],
      approvedBridgePorts: [],
    })
  }

  it('activates an update over a v0.2.9 mutable backend-only install and drains its old backend', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'navide-plugin-legacy-backend-upgrade-')))
    const manager = new FrontendPluginManager()
    const first = buildBackendPkg('1.0.0')
    try {
      writeV029Install(root, first)
      const loaded = manager.loadInstalledPlugins(root, {
        provenance: 'official-registry',
        trust: {
          pinnedRootKey: registryRoot.pubPem,
          snapshot: readRegistryTrustSnapshot(root),
          registryAuthority: 'self-hosted',
          now: FIXED_NOW,
        },
      })
      expect(loaded.errors).toEqual([])
      expect(loaded.activationCatalog.map((entry) => entry.pluginId)).toContain('acme.demo')
      for (const activation of loaded.activationCatalog) registerActivationBackend(manager, activation)
      expect(manager.getDescriptor('acme.demo')).toBeUndefined()
      expect(manager.hasBackendActivation('acme.demo', '1.0.0')).toBe(true)

      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        ...TEST_PREFLIGHT_OPTIONS,
        onActivationChange: ({ activation }) => registerActivationBackend(manager, activation),
      })
      const second = buildBackendPkg('1.0.1')
      installFetch(signedDetail(second.digest, 'acme.demo', 'acme', '1.0.1'), second.bytes, second.digest)
      await handlers.get('plugins:prepareInstall')!(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      await handlers.get('plugins:commitInstall')!(null, { id: 'acme.demo', publisherConfirmed: true, riskConfirmed: true })

      await expect(handlers.get('plugins:restart')!(null, { id: 'acme.demo' })).resolves.toMatchObject({
        packageVersion: '1.0.1',
      })
      expect(manager.hasBackendActivation('acme.demo', '1.0.0')).toBe(false)
      expect(manager.hasBackendActivation('acme.demo', '1.0.1')).toBe(true)
      expect(new PluginActivationSelector(root).read('acme.demo')).toMatchObject({
        active: { packageVersion: '1.0.1' },
        previous: { packageVersion: '1.0.0', artifactDigest: first.digest, layout: 'legacy-mutable' },
        previousGrant: { packageVersion: '1.0.0' },
      })
      expect(new PluginActivationSelector(root).read('acme.demo')?.candidate).toBeUndefined()
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('restores the factory-bundled package when a promoted update fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-factory-update-'))
    const factoryDir = mkdtempSync(join(tmpdir(), 'navide-plugin-factory-bundle-'))
    const manager = new FrontendPluginManager()
    const activationChanges: Array<{ pluginId: string; activation?: PluginActivationCatalogEntry }> = []
    try {
      for (const entry of readZipEntries(buildPkg('acme.demo', 'acme', {}, '1.0.0').bytes)) {
        if (entry.kind !== 'file') continue
        const output = join(factoryDir, entry.path)
        mkdirSync(join(output, '..'), { recursive: true })
        writeFileSync(output, entry.data)
      }
      expect(manager.loadFactoryPlugin(factoryDir, 'acme.demo')).toMatchObject({ loaded: true })
      const factoryGrant = { packageVersion: '1.0.0', system: [], storage: true as const }
      new PluginCapabilityGrantStore(root).set('acme.demo', factoryGrant)

      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        ...TEST_PREFLIGHT_OPTIONS,
        onActivationChange: (change) => activationChanges.push(change),
      })
      const second = buildPkg('acme.demo', 'acme', {}, '1.0.1')
      installFetch(signedDetail(second.digest, 'acme.demo', 'acme', '1.0.1'), second.bytes, second.digest)
      await handlers.get('plugins:prepareInstall')!(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      await handlers.get('plugins:commitInstall')!(null, { id: 'acme.demo', publisherConfirmed: true })
      vi.spyOn(manager, 'restorePackageRestart').mockRejectedValueOnce(new Error('injected placement failure'))

      await expect(handlers.get('plugins:restart')!(null, { id: 'acme.demo' }))
        .rejects.toThrow('injected placement failure')
      expect(manager.getDescriptor('acme.demo')).toMatchObject({ packageVersion: '1.0.0', packageDir: factoryDir })
      expect(manager.listInstalledPackages()).toMatchObject([{ id: 'acme.demo', provenance: 'factory-bundled' }])
      expect(new PluginCapabilityGrantStore(root).get('acme.demo', '1.0.0')).toEqual(factoryGrant)
      expect(activationChanges.at(-1)).toMatchObject({
        pluginId: 'acme.demo',
        activation: { packageVersion: '1.0.0', provenance: 'factory-bundled' },
      })
      const selection = new PluginActivationSelector(root).read('acme.demo')
      expect(selection?.active).toBeUndefined()
      expect(selection?.activation).toBeUndefined()
      expect(selection?.candidate).toMatchObject({ packageVersion: '1.0.1' })
      expect((manager as unknown as { restartingPluginIds: Set<string> }).restartingPluginIds.has('acme.demo')).toBe(false)
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
      rmSync(factoryDir, { recursive: true, force: true })
    }
  })

  it('rolls a promoted candidate back to the verified previous package when placement restoration fails', async () => {
    const first = buildPkg('acme.demo', 'acme', {}, '1.0.0')
    const second = buildPkg('acme.demo', 'acme', {}, '1.0.1')
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-restart-rollback-'))
    const manager = new FrontendPluginManager()
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, TEST_PREFLIGHT_OPTIONS)
      const prepare = handlers.get('plugins:prepareInstall')!
      const commit = handlers.get('plugins:commitInstall')!
      const restart = handlers.get('plugins:restart')!

      installFetch(signedDetail(first.digest, 'acme.demo', 'acme', '1.0.0'), first.bytes, first.digest)
      await prepare(null, { namespace: 'acme', name: 'demo' })
      await commit(null, { id: 'acme.demo', publisherConfirmed: true, riskConfirmed: true })
      await restart(null, { id: 'acme.demo' })

      installFetch(signedDetail(second.digest, 'acme.demo', 'acme', '1.0.1'), second.bytes, second.digest)
      await prepare(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      await commit(null, { id: 'acme.demo', publisherConfirmed: true })
      vi.spyOn(manager, 'restorePackageRestart').mockRejectedValueOnce(new Error('injected placement failure'))

      await expect(restart(null, { id: 'acme.demo' })).rejects.toThrow('injected placement failure')
      expect(manager.getDescriptor('acme.demo')?.packageVersion).toBe('1.0.0')
      expect(new PluginActivationSelector(root).read('acme.demo')).toEqual({
        schemaVersion: 1,
        pluginId: 'acme.demo',
        activeGrant: { packageVersion: '1.0.0', system: [], storage: true },
        active: { packageVersion: '1.0.0', target: 'universal', artifactDigest: first.digest },
        candidate: { packageVersion: '1.0.1', target: 'universal', artifactDigest: second.digest },
        candidateGrant: { packageVersion: '1.0.1', system: [], storage: true },
      })
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('re-verifies and restarts only the retained previous package on explicit rollback', async () => {
    const first = buildPkg('acme.demo', 'acme', {}, '1.0.0')
    const second = buildPkg('acme.demo', 'acme', {}, '1.0.1')
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-explicit-rollback-'))
    const manager = new FrontendPluginManager()
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, TEST_PREFLIGHT_OPTIONS)
      const prepare = handlers.get('plugins:prepareInstall')!
      const commit = handlers.get('plugins:commitInstall')!
      const restart = handlers.get('plugins:restart')!
      const rollback = handlers.get('plugins:rollback')
      if (!rollback) throw new Error('rollback handler not registered')

      installFetch(signedDetail(first.digest, 'acme.demo', 'acme', '1.0.0'), first.bytes, first.digest)
      await prepare(null, { namespace: 'acme', name: 'demo' })
      await commit(null, { id: 'acme.demo', publisherConfirmed: true, riskConfirmed: true })
      await restart(null, { id: 'acme.demo' })
      installFetch(signedDetail(second.digest, 'acme.demo', 'acme', '1.0.1'), second.bytes, second.digest)
      await prepare(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      await commit(null, { id: 'acme.demo', publisherConfirmed: true, riskConfirmed: true })
      await restart(null, { id: 'acme.demo' })

      await expect(rollback(null, { id: 'acme.demo' })).resolves.toMatchObject({
        id: 'acme.demo',
        packageVersion: '1.0.0',
      })
      expect(manager.getDescriptor('acme.demo')?.packageVersion).toBe('1.0.0')
      expect(new PluginActivationSelector(root).read('acme.demo')).toEqual({
        schemaVersion: 1,
        pluginId: 'acme.demo',
        activeGrant: { packageVersion: '1.0.0', system: [], storage: true },
        active: { packageVersion: '1.0.0', target: 'universal', artifactDigest: first.digest },
        candidate: { packageVersion: '1.0.1', target: 'universal', artifactDigest: second.digest },
        candidateGrant: { packageVersion: '1.0.1', system: [], storage: true },
      })
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('drains a backend-only active version before promoting an explicit rollback', async () => {
    const first = buildBackendPkg('1.0.0')
    const second = buildBackendPkg('1.0.1')
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'navide-plugin-backend-rollback-drain-')))
    const manager = new FrontendPluginManager()
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        ...TEST_PREFLIGHT_OPTIONS,
        onActivationChange: ({ activation }) => {
          if (!activation?.backend) return
          const packageDirectories = (manager as unknown as {
            installedPackageDirectories: Map<string, string>
          }).installedPackageDirectories
          expect(packageDirectories.get(activation.pluginId)).toBe(activation.packageDir)
          manager.registerBackendActivation({
            pluginId: activation.pluginId,
            packageVersion: activation.packageVersion,
            packageDir: activation.packageDir,
            entryFile: activation.backend.entryFile,
            protocolVersion: activation.backend.protocolVersion,
            activation: activation.backend.activation,
            approvedMethods: [],
            approvedEvents: [],
            approvedBridgePorts: [],
          })
        },
      })
      const prepare = handlers.get('plugins:prepareInstall')!
      const commit = handlers.get('plugins:commitInstall')!
      const restart = handlers.get('plugins:restart')!
      const rollback = handlers.get('plugins:rollback')
      if (!rollback) throw new Error('rollback handler not registered')

      installFetch(signedDetail(first.digest, 'acme.demo', 'acme', '1.0.0'), first.bytes, first.digest)
      await prepare(null, { namespace: 'acme', name: 'demo' })
      await commit(null, { id: 'acme.demo', publisherConfirmed: true, riskConfirmed: true })
      await restart(null, { id: 'acme.demo' })
      expect(manager.hasBackendActivation('acme.demo', '1.0.0')).toBe(true)
      installFetch(signedDetail(second.digest, 'acme.demo', 'acme', '1.0.1'), second.bytes, second.digest)
      await prepare(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      await commit(null, { id: 'acme.demo', publisherConfirmed: true, riskConfirmed: true })
      await restart(null, { id: 'acme.demo' })
      expect(manager.hasBackendActivation('acme.demo', '1.0.1')).toBe(true)

      const revoke = vi.spyOn(manager, 'revokePackageVersion')
      await expect(rollback(null, { id: 'acme.demo' })).resolves.toMatchObject({ packageVersion: '1.0.0' })
      expect(revoke).toHaveBeenCalledWith('acme.demo', '1.0.1')
      expect(manager.hasBackendActivation('acme.demo', '1.0.0')).toBe(true)
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('releases the frontend restart barrier when rolling back to a backend-only package', async () => {
    const first = buildBackendPkg('1.0.0')
    const second = buildPkg('acme.demo', 'acme', {}, '1.0.1')
    const root = mkdtempSync(join(tmpdir(), 'navide-backend-only-rollback-barrier-'))
    const manager = new FrontendPluginManager()
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, TEST_PREFLIGHT_OPTIONS)
      const prepare = handlers.get('plugins:prepareInstall')!
      const commit = handlers.get('plugins:commitInstall')!
      const restart = handlers.get('plugins:restart')!
      const rollback = handlers.get('plugins:rollback')!
      installFetch(signedDetail(first.digest, 'acme.demo', 'acme', '1.0.0'), first.bytes, first.digest)
      await prepare(null, { namespace: 'acme', name: 'demo' })
      await commit(null, { id: 'acme.demo', publisherConfirmed: true, riskConfirmed: true })
      await restart(null, { id: 'acme.demo' })
      installFetch(signedDetail(second.digest, 'acme.demo', 'acme', '1.0.1'), second.bytes, second.digest)
      await prepare(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      await commit(null, { id: 'acme.demo', publisherConfirmed: true })
      await restart(null, { id: 'acme.demo' })
      expect(manager.getDescriptor('acme.demo')?.packageVersion).toBe('1.0.1')

      await expect(rollback(null, { id: 'acme.demo' })).resolves.toMatchObject({ packageVersion: '1.0.0' })
      expect(manager.getDescriptor('acme.demo')).toBeUndefined()
      expect((manager as unknown as { restartingPluginIds: Set<string> }).restartingPluginIds.has('acme.demo')).toBe(false)
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('releases the frontend barrier while retaining a promoted rollback journal after failure', async () => {
    const first = buildPkg('acme.demo', 'acme', {}, '1.0.0')
    const second = buildPkg('acme.demo', 'acme', {}, '1.0.1')
    const root = mkdtempSync(join(tmpdir(), 'navide-rollback-post-promotion-'))
    const manager = new FrontendPluginManager()
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, TEST_PREFLIGHT_OPTIONS)
      const prepare = handlers.get('plugins:prepareInstall')!
      const commit = handlers.get('plugins:commitInstall')!
      const restart = handlers.get('plugins:restart')!
      const rollback = handlers.get('plugins:rollback')!
      installFetch(signedDetail(first.digest, 'acme.demo', 'acme', '1.0.0'), first.bytes, first.digest)
      await prepare(null, { namespace: 'acme', name: 'demo' })
      await commit(null, { id: 'acme.demo', publisherConfirmed: true, riskConfirmed: true })
      await restart(null, { id: 'acme.demo' })
      installFetch(signedDetail(second.digest, 'acme.demo', 'acme', '1.0.1'), second.bytes, second.digest)
      await prepare(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      await commit(null, { id: 'acme.demo', publisherConfirmed: true })
      await restart(null, { id: 'acme.demo' })
      vi.spyOn(manager, 'setPluginStorageSnapshotSelection').mockImplementationOnce(() => {
        throw new Error('injected post-promotion failure')
      })
      await expect(rollback(null, { id: 'acme.demo' })).rejects.toThrow('injected post-promotion failure')
      expect(new PluginActivationSelector(root).read('acme.demo')).toMatchObject({
        active: { packageVersion: '1.0.0' },
        candidate: { packageVersion: '1.0.1' },
        activation: { kind: 'rollback', phase: 'promoted' },
      })
      expect((manager as unknown as { restartingPluginIds: Set<string> }).restartingPluginIds.has('acme.demo')).toBe(false)
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('leaves a promoted rollback journal for cold recovery when placement restoration fails', async () => {
    const first = buildPkg('acme.demo', 'acme', {}, '1.0.0')
    const second = buildPkg('acme.demo', 'acme', {}, '1.0.1')
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-rollback-recovery-'))
    const manager = new FrontendPluginManager()
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, TEST_PREFLIGHT_OPTIONS)
      const prepare = handlers.get('plugins:prepareInstall')!
      const commit = handlers.get('plugins:commitInstall')!
      const restart = handlers.get('plugins:restart')!
      const rollback = handlers.get('plugins:rollback')
      if (!rollback) throw new Error('rollback handler not registered')

      installFetch(signedDetail(first.digest, 'acme.demo', 'acme', '1.0.0'), first.bytes, first.digest)
      await prepare(null, { namespace: 'acme', name: 'demo' })
      await commit(null, { id: 'acme.demo', publisherConfirmed: true })
      await restart(null, { id: 'acme.demo' })
      installFetch(signedDetail(second.digest, 'acme.demo', 'acme', '1.0.1'), second.bytes, second.digest)
      await prepare(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      await commit(null, { id: 'acme.demo', publisherConfirmed: true })
      await restart(null, { id: 'acme.demo' })
      vi.spyOn(manager, 'restorePackageRestart').mockRejectedValueOnce(new Error('injected rollback restore failure'))

      await expect(rollback(null, { id: 'acme.demo' })).rejects.toThrow('injected rollback restore failure')
      const selector = new PluginActivationSelector(root)
      expect(selector.read('acme.demo')).toMatchObject({
        active: { packageVersion: '1.0.0' },
        candidate: { packageVersion: '1.0.1' },
        activation: { kind: 'rollback', phase: 'promoted' },
      })
      expect(new PluginActivationSelector(root).recoverInterruptedActivation('acme.demo')).toMatchObject({
        active: { packageVersion: '1.0.0' },
        candidate: { packageVersion: '1.0.1' },
      })
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('persists the confirmed Manifest v2 grant only after a successful commit and removes it on uninstall', async () => {
    const { bytes, digest } = buildPkg('acme.demo', 'acme', {
      system: ['fs', 'ui'],
      shell: 'allowlist',
    })
    installFetch(signedDetail(digest), bytes, digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-capability-grant-install-'))
    try {
      const manager = new FrontendPluginManager()
      const prepareHandler = register(root, manager)
      await prepareHandler(null, { namespace: 'acme', name: 'demo' })
      const grants = new PluginCapabilityGrantStore(root)
      expect(grants.get('acme.demo', '1.0.0')).toBeNull()

      const commitHandler = handlers.get('plugins:commitInstall')
      const removeHandler = handlers.get('plugins:remove')
      if (!commitHandler || !removeHandler) throw new Error('plugin lifecycle handlers not registered')
      expect(
        await commitHandler(null, {
          id: 'acme.demo',
          publisherConfirmed: true,
          riskConfirmed: true,
        })
      ).toEqual({ id: 'acme.demo', requires: ['fs', 'ui', 'shell'], restartRequired: true })
      expect(grants.get('acme.demo', '1.0.0')).toBeNull()
      const restartHandler = handlers.get('plugins:restart')
      if (!restartHandler) throw new Error('restart handler not registered')
      await restartHandler(null, { id: 'acme.demo' })
      expect(grants.get('acme.demo', '1.0.0')).toEqual({
        packageVersion: '1.0.0',
        system: ['fs', 'ui'],
        shell: 'allowlist',
        storage: true,
      })
      const listHandler = handlers.get('plugins:listInstalled')
      if (!listHandler) throw new Error('installed inventory handler not registered')
      expect(listHandler(null)).toMatchObject([{
        id: 'acme.demo',
        packageVersion: '1.0.0',
        manifestPermissions: { system: ['fs', 'ui'], shell: 'allowlist' },
        packageVersionGrant: {
          packageVersion: '1.0.0',
          system: ['fs', 'ui'],
          shell: 'allowlist',
          storage: true,
        },
      }])

      await removeHandler(null, { id: 'acme.demo' })
      expect(grants.get('acme.demo', '1.0.0')).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('requires publisher consent for a Registry v1 package even with legacy non-sensitive requires', async () => {
    const { bytes, digest } = buildLegacyPkg(['git'])
    installFetch(signedDetail(digest), bytes, digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-v1-publisher-consent-'))
    try {
      const manager = new FrontendPluginManager()
      const prepareHandler = register(root, manager)
      const prepared = (await prepareHandler(null, {
        namespace: 'acme',
        name: 'demo',
      })) as { requiresPublisherTrust: boolean; requiresConfirmation: boolean }
      expect(prepared.requiresPublisherTrust).toBe(true)
      expect(prepared.requiresConfirmation).toBe(false)
      const commitHandler = handlers.get('plugins:commitInstall')
      if (!commitHandler) throw new Error('commitInstall handler not registered')
      await expect(commitHandler(null, { id: 'acme.demo' })).rejects.toThrow(/publisher trust confirmation/)
      await expect(
        commitHandler(null, { id: 'acme.demo', publisherConfirmed: true })
      ).resolves.toEqual({ id: 'acme.demo', requires: ['git'] })
      // Legacy v1 has no activation to stage: the package installs immediately
      // through the mutable path, with no restart step.
      expect(manager.listInstalledPackages()).toEqual([
        expect.objectContaining({ id: 'acme.demo', requires: ['git'] }),
      ])
      expect(manager.listInstalledPackages()[0]?.packageVersion).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('projects only a verified same-session backend activation', async () => {
    const { bytes, digest } = buildBackendPkg()
    installFetch(signedDetail(digest), bytes, digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-same-session-activation-'))
    const active = new Map<string, PluginActivationCatalogEntry>()
    try {
      const manager = new FrontendPluginManager()
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        cleanupPluginStorage: async () => undefined,
        ...TEST_PREFLIGHT_OPTIONS,
        onActivationChange: ({ pluginId, activation }) => {
          active.delete(pluginId)
          if (activation) active.set(pluginId, activation)
        },
      })
      const prepareHandler = handlers.get('plugins:prepareInstall')
      const commitHandler = handlers.get('plugins:commitInstall')
      if (!prepareHandler || !commitHandler) throw new Error('install handlers not registered')

      await prepareHandler(null, { namespace: 'acme', name: 'demo' })
      expect(
        await commitHandler(null, {
          id: 'acme.demo',
          publisherConfirmed: true,
          riskConfirmed: true,
        })
      ).toEqual({ id: 'acme.demo', requires: [], restartRequired: true })
      const restartHandler = handlers.get('plugins:restart')
      if (!restartHandler) throw new Error('restart handler not registered')
      await restartHandler(null, { id: 'acme.demo' })

      expect(
        projectBackendPluginActivationCatalog([...active.values()])
      ).toMatchObject({
        schemaVersion: 1,
        packages: [
          {
            pluginId: 'acme.demo',
            packageVersion: '1.0.0',
            packageDir: immutablePluginPackageDir(root, 'acme.demo', '1.0.0', 'universal'),
            artifactDigest: digest,
            backend: {
              // The active package lives in its immutable target directory, and
              // the entry keeps the platform's on-disk name.
              entryFile: join(immutablePluginPackageDir(root, 'acme.demo', '1.0.0', 'universal'), BACKEND_ENTRY_ON_DISK),
              protocolVersion: 1,
              activation: 'startup',
            },
          },
        ],
      })

      const removeHandler = handlers.get('plugins:remove')
      if (!removeHandler) throw new Error('remove handler not registered')
      await expect(removeHandler(null, { id: 'acme.demo' })).resolves.toEqual({ ok: true })
      expect(projectBackendPluginActivationCatalog([...active.values()])).toEqual({
        schemaVersion: 1,
        packages: [],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('clears the prior activation before adding a replacement backend activation', async () => {
    const { bytes, digest } = buildBackendPkg()
    installFetch(signedDetail(digest), bytes, digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-same-session-replace-'))
    const changes: Array<{ pluginId: string; activation?: PluginActivationCatalogEntry }> = []
    try {
      const manager = new FrontendPluginManager()
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        ...TEST_PREFLIGHT_OPTIONS,
        onActivationChange: (change) => changes.push(change),
      })
      const prepareHandler = handlers.get('plugins:prepareInstall')
      const commitHandler = handlers.get('plugins:commitInstall')
      if (!prepareHandler || !commitHandler) throw new Error('install handlers not registered')

      await prepareHandler(null, { namespace: 'acme', name: 'demo' })
      expect(
        await commitHandler(null, {
          id: 'acme.demo',
          publisherConfirmed: true,
          riskConfirmed: true,
        })
      ).toEqual({ id: 'acme.demo', requires: [], restartRequired: true })
      const restartHandler = handlers.get('plugins:restart')
      if (!restartHandler) throw new Error('restart handler not registered')
      await restartHandler(null, { id: 'acme.demo' })
      changes.length = 0

      const replacement = buildBackendPkg('1.0.1')
      installFetch(
        signedDetail(replacement.digest, 'acme.demo', 'acme', '1.0.1'),
        replacement.bytes,
        replacement.digest,
      )
      await prepareHandler(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      expect(
        await commitHandler(null, {
          id: 'acme.demo',
          publisherConfirmed: true,
          riskConfirmed: true,
        })
      ).toEqual({ id: 'acme.demo', requires: [], restartRequired: true })

      expect(changes).toEqual([])
      await restartHandler(null, { id: 'acme.demo' })
      expect(changes).toHaveLength(1)
      expect(changes[0]).toMatchObject({
        pluginId: 'acme.demo',
        activation: { packageVersion: '1.0.1', artifactDigest: replacement.digest },
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('restores a factory backend when its first Registry replacement fails', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'navide-factory-rollback-')))
    const factoryDir = join(root, 'factory')
    const pluginsDir = join(root, 'installed')
    mkdirSync(factoryDir)
    mkdirSync(pluginsDir)
    writeFileSync(join(factoryDir, 'index.html'), '<!doctype html>')
    writeFileSync(join(factoryDir, 'manifest.json'), JSON.stringify({
      schemaVersion: 2, apiVersion: '^1.0.0', id: 'acme.demo', name: 'Demo', version: '1.0.0',
      publisher: 'acme', permissions: {},
      marketplace: { description: 'Demo frontend', license: 'MIT' },
      contributes: { views: [{ id: 'main', kind: 'custom', location: 'main', title: 'Demo', entry: 'index.html' }] },
    }))
    const manager = new FrontendPluginManager()
    expect(manager.loadFactoryPlugin(factoryDir, 'acme.demo')).toMatchObject({ loaded: true })
    const backend = {
      pluginId: 'acme.demo', packageVersion: '1.0.0', packageDir: factoryDir,
      entryFile: join(factoryDir, 'backend'), protocolVersion: 1 as const,
      activation: 'startup' as const, approvedMethods: ['fixture.echo'], approvedEvents: [],
    }
    manager.registerBackendActivation(backend)
    const { bytes, digest } = buildBackendPkg()
    installFetch(signedDetail(digest), bytes, digest)
    try {
      registerPluginIpc(manager, pluginsDir, () => true, TRUST_CONFIG)
      await handlers.get('plugins:prepareInstall')!(null, { namespace: 'acme', name: 'demo' })
      vi.spyOn(defaultInstallerDeps, 'writeFile').mockImplementation(() => { throw new Error('write failed') })
      await expect(handlers.get('plugins:commitInstall')!(null, {
        id: 'acme.demo', publisherConfirmed: true, riskConfirmed: true,
      })).rejects.toThrow('write failed')
      expect(manager.listInstalledPackages()[0].provenance).toBe('factory-bundled')
      expect(manager.getBackendActivation('acme.demo', '1.0.0')).toEqual(backend)
      expect(manager.getDescriptor('acme.demo')?.packageDir).toBe(factoryDir)
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('restores an approved backend that has no installed-package summary after a failed install', async () => {
    const { bytes, digest } = buildBackendPkg()
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'navide-install-backend-only-')))
    const manager = new FrontendPluginManager()
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        ...TEST_PREFLIGHT_OPTIONS,
      })
      const prepareHandler = handlers.get('plugins:prepareInstall')
      const commitHandler = handlers.get('plugins:commitInstall')
      if (!prepareHandler || !commitHandler) throw new Error('install handlers not registered')

      // A descriptor and an approved backend without an installed-package
      // summary: the shape the developer Plans v2 registration leaves behind.
      const packageDir = join(root, 'acme.demo')
      mkdirSync(packageDir, { recursive: true })
      manager.registerDescriptor({
        id: 'acme.demo', packageVersion: '1.0.0', packageDir,
        requires: [], devUrl: '', entryFile: join(packageDir, 'index.html'),
      })
      const backend = {
        pluginId: 'acme.demo', packageVersion: '1.0.0', packageDir,
        entryFile: join(packageDir, BACKEND_ENTRY_ON_DISK), protocolVersion: 1 as const,
        activation: 'startup' as const, approvedMethods: ['fixture.echo'], approvedEvents: [],
      }
      manager.registerBackendActivation(backend)
      expect(manager.listInstalledPackages()).toEqual([])

      installFetch(signedDetail(digest), bytes, digest)
      await prepareHandler(null, { namespace: 'acme', name: 'demo' })
      vi.spyOn(defaultInstallerDeps, 'writeFile').mockImplementation(() => {
        throw new Error('test package write failure')
      })

      await expect(
        commitHandler(null, {
          id: 'acme.demo',
          publisherConfirmed: true,
          riskConfirmed: true,
        })
      ).rejects.toThrow('test package write failure')
      expect(manager.hasBackendActivation('acme.demo', '1.0.0')).toBe(true)
      expect(manager.getBackendActivation('acme.demo', '1.0.0')).toEqual(backend)
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each(['commit', 'remove'] as const)('rejects concurrent %s while preserving install rollback', async (operation) => {
    const original = buildBackendPkg()
    installFetch(signedDetail(original.digest), original.bytes, original.digest)
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'navide-install-concurrent-')))
    const manager = new FrontendPluginManager()
    const active = new Map<string, PluginActivationCatalogEntry>()
    let failVerification = false
    let release!: () => void
    let hold: Promise<void> | null = null
    let running: Promise<unknown> | undefined
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        ...TEST_PREFLIGHT_OPTIONS,
        cleanupPluginStorage: async () => undefined,
        onActivationChange: ({ pluginId, activation }) => {
          active.delete(pluginId)
          if (activation) active.set(pluginId, activation)
        },
        verifyCommittedInstall: () => ({ action: 'allow', artifactDigest: original.digest }),
        // Holds the commit open inside its transaction so a competing call can
        // be observed; the injected failure then exercises the rollback path.
        preflightCandidateBackend: async () => {
          if (hold) await hold
          if (failVerification) throw new Error('injected verification failure')
        },
      })
      const prepare = handlers.get('plugins:prepareInstall')!
      const commit = handlers.get('plugins:commitInstall')!
      const restart = handlers.get('plugins:restart')!
      const args = { id: 'acme.demo', publisherConfirmed: true, riskConfirmed: true }
      await prepare(null, { namespace: 'acme', name: 'demo' })
      await commit(null, args)
      await restart(null, { id: 'acme.demo' })
      const descriptor = {
        id: 'acme.demo', packageVersion: '1.0.0', packageDir: join(root, 'acme.demo'),
        requires: [], devUrl: '', entryFile: join(root, 'acme.demo', 'index.html'),
      }
      manager.registerDescriptor(descriptor)
      const backend = {
        pluginId: 'acme.demo', packageVersion: '1.0.0', packageDir: descriptor.packageDir,
        entryFile: join(descriptor.packageDir, BACKEND_ENTRY_ON_DISK), protocolVersion: 1 as const,
        activation: 'startup' as const, approvedMethods: ['fixture.echo'], approvedEvents: [],
      }
      manager.registerBackendActivation(backend)
      const grant = new PluginCapabilityGrantStore(root).get('acme.demo', '1.0.0')
      const replacement = buildBackendPkg('1.0.1')
      installFetch(signedDetail(replacement.digest, 'acme.demo', 'acme', '1.0.1'), replacement.bytes, replacement.digest)
      await prepare(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      hold = new Promise<void>((resolve) => { release = resolve })
      failVerification = true
      running = Promise.resolve(commit(null, args)).catch((error: unknown) => error)
      const competing = operation === 'commit'
        ? commit(null, args)
        : handlers.get('plugins:remove')!(null, { id: 'acme.demo' })
      await expect(competing).rejects.toThrow(/transaction already in progress/)
      release()
      expect(await running).toMatchObject({ message: 'injected verification failure' })
      expect(manager.getDescriptor('acme.demo')).toEqual(descriptor)
      expect(manager.getBackendActivation('acme.demo', '1.0.0')).toEqual(backend)
      expect(new PluginCapabilityGrantStore(root).get('acme.demo', '1.0.0')).toEqual(grant)
      expect(active.get('acme.demo')?.artifactDigest).toBe(original.digest)
      await expect(commit(null, args)).rejects.toThrow(/no prepared install/)
      failVerification = false
      await prepare(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      await expect(commit(null, args)).resolves.toMatchObject({ id: 'acme.demo' })
    } finally {
      release?.()
      await running
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('retains a new prepare during a transaction and allows another plugin to install', async () => {
    const pkg = buildPkg()
    installFetch(signedDetail(pkg.digest), pkg.bytes, pkg.digest)
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'navide-install-new-prepare-')))
    const manager = new FrontendPluginManager()
    let release!: () => void
    let hold: Promise<void> | null = null
    let running: Promise<unknown> | undefined
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        ...TEST_PREFLIGHT_OPTIONS,
        preflightCandidateFrontend: async (descriptor) => {
          if (descriptor.id === 'acme.demo' && hold) await hold
        },
      })
      const prepare = handlers.get('plugins:prepareInstall')!
      const commit = handlers.get('plugins:commitInstall')!
      const args = { id: 'acme.demo', publisherConfirmed: true }
      await prepare(null, { namespace: 'acme', name: 'demo' })
      await commit(null, args)
      await handlers.get('plugins:restart')!(null, { id: 'acme.demo' })
      const replacement = buildPkg('acme.demo', 'acme', {}, '1.0.1')
      installFetch(signedDetail(replacement.digest, 'acme.demo', 'acme', '1.0.1'), replacement.bytes, replacement.digest)
      await prepare(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      hold = new Promise<void>((resolve) => { release = resolve })
      running = Promise.resolve(commit(null, args))
      // A prepare arriving while the transaction is open is retained rather
      // than rejected, and another package's commit is not blocked by it.
      await prepare(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      const other = buildPkg('acme.other')
      installFetch(signedDetail(other.digest, 'acme.other'), other.bytes, other.digest)
      await prepare(null, { namespace: 'acme', name: 'other' })
      await expect(commit(null, { id: 'acme.other', publisherConfirmed: true }))
        .resolves.toMatchObject({ id: 'acme.other' })
      release()
      await running
      // The staged candidate is promoted before the next version can stage
      // beside it; the same version cannot be staged twice while referenced.
      await handlers.get('plugins:restart')!(null, { id: 'acme.demo' })
      const final = buildPkg('acme.demo', 'acme', {}, '1.0.2')
      installFetch(signedDetail(final.digest, 'acme.demo', 'acme', '1.0.2'), final.bytes, final.digest)
      await prepare(null, { namespace: 'acme', name: 'demo', version: '1.0.2' })
      await expect(commit(null, args)).resolves.toMatchObject({ id: 'acme.demo' })
    } finally {
      release?.()
      await running
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects install during removal and releases the transaction after cleanup failure', async () => {
    const pkg = buildPkg()
    installFetch(signedDetail(pkg.digest), pkg.bytes, pkg.digest)
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'navide-remove-concurrent-install-')))
    const manager = new FrontendPluginManager()
    let rejectCleanup!: (error: Error) => void
    const cleanup = new Promise<void>((_resolve, reject) => { rejectCleanup = reject })
    let running: Promise<unknown> | undefined
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        ...TEST_PREFLIGHT_OPTIONS,
        cleanupPluginStorage: () => cleanup,
      })
      const prepare = handlers.get('plugins:prepareInstall')!
      const commit = handlers.get('plugins:commitInstall')!
      const args = { id: 'acme.demo', publisherConfirmed: true }
      await prepare(null, { namespace: 'acme', name: 'demo' })
      await commit(null, args)
      await handlers.get('plugins:restart')!(null, { id: 'acme.demo' })
      const replacement = buildPkg('acme.demo', 'acme', {}, '1.0.1')
      installFetch(signedDetail(replacement.digest, 'acme.demo', 'acme', '1.0.1'), replacement.bytes, replacement.digest)
      await prepare(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      running = Promise.resolve(handlers.get('plugins:remove')!(null, { id: 'acme.demo' }))
        .catch((error: unknown) => error)
      await expect(commit(null, args)).rejects.toThrow(/transaction already in progress/)
      rejectCleanup(new Error('cleanup unavailable'))
      expect(await running).toMatchObject({ message: 'cleanup unavailable' })
      await expect(commit(null, args)).resolves.toMatchObject({ id: 'acme.demo' })
    } finally {
      rejectCleanup(new Error('cleanup unavailable'))
      await running
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('restores a factory backend when its first Registry replacement fails', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'navide-factory-rollback-')))
    const factoryDir = join(root, 'factory')
    const pluginsDir = join(root, 'installed')
    mkdirSync(factoryDir)
    mkdirSync(pluginsDir)
    writeFileSync(join(factoryDir, 'index.html'), '<!doctype html>')
    writeFileSync(join(factoryDir, 'manifest.json'), JSON.stringify({
      schemaVersion: 2, apiVersion: '^1.0.0', id: 'acme.demo', name: 'Demo', version: '1.0.0',
      publisher: 'acme', permissions: {},
      marketplace: { description: 'Demo frontend', license: 'MIT' },
      contributes: { views: [{ id: 'main', kind: 'custom', location: 'main', title: 'Demo', entry: 'index.html' }] },
    }))
    const manager = new FrontendPluginManager()
    expect(manager.loadFactoryPlugin(factoryDir, 'acme.demo')).toMatchObject({ loaded: true })
    const backend = {
      pluginId: 'acme.demo', packageVersion: '1.0.0', packageDir: factoryDir,
      entryFile: join(factoryDir, 'backend'), protocolVersion: 1 as const,
      activation: 'startup' as const, approvedMethods: ['fixture.echo'], approvedEvents: [],
    }
    manager.registerBackendActivation(backend)
    const { bytes, digest } = buildBackendPkg()
    installFetch(signedDetail(digest), bytes, digest)
    try {
      registerPluginIpc(manager, pluginsDir, () => true, TRUST_CONFIG)
      await handlers.get('plugins:prepareInstall')!(null, { namespace: 'acme', name: 'demo' })
      vi.spyOn(defaultInstallerDeps, 'writeFile').mockImplementation(() => { throw new Error('write failed') })
      await expect(handlers.get('plugins:commitInstall')!(null, {
        id: 'acme.demo', publisherConfirmed: true, riskConfirmed: true,
      })).rejects.toThrow('write failed')
      expect(manager.listInstalledPackages()[0].provenance).toBe('factory-bundled')
      expect(manager.getBackendActivation('acme.demo', '1.0.0')).toEqual(backend)
      expect(manager.getDescriptor('acme.demo')?.packageDir).toBe(factoryDir)
    } finally {
      await manager.closeBackendPlugins()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('restores the previous install when post-commit verification throws after a replacement starts', async () => {
    const { bytes, digest } = buildBackendPkg()
    installFetch(signedDetail(digest), bytes, digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-post-commit-failure-'))
    const active = new Map<string, PluginActivationCatalogEntry>()
    let failVerification = false
    try {
      const manager = new FrontendPluginManager()
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        ...TEST_PREFLIGHT_OPTIONS,
        onActivationChange: ({ pluginId, activation }) => {
          active.delete(pluginId)
          if (activation) active.set(pluginId, activation)
        },
        verifyCommittedInstall: () => {
          if (failVerification) throw new Error('test post-commit verification failure')
          return { action: 'allow', artifactDigest: digest }
        },
      })
      const prepareHandler = handlers.get('plugins:prepareInstall')
      const commitHandler = handlers.get('plugins:commitInstall')
      const restartHandler = handlers.get('plugins:restart')
      if (!prepareHandler || !commitHandler || !restartHandler) throw new Error('install handlers not registered')

      await prepareHandler(null, { namespace: 'acme', name: 'demo' })
      await expect(commitHandler(null, {
        id: 'acme.demo',
        publisherConfirmed: true,
        riskConfirmed: true,
      })).resolves.toMatchObject({ id: 'acme.demo' })
      await restartHandler(null, { id: 'acme.demo' })
      expect(active.has('acme.demo')).toBe(true)

      const replacement = buildBackendPkg('1.0.1')
      installFetch(signedDetail(replacement.digest, 'acme.demo', 'acme', '1.0.1'), replacement.bytes, replacement.digest)
      await prepareHandler(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      failVerification = true

      await expect(
        commitHandler(null, {
          id: 'acme.demo',
          publisherConfirmed: true,
          riskConfirmed: true,
        })
      ).rejects.toThrow(/test post-commit verification failure/)
      expect(manager.listInstalledPackages()).toEqual([
        {
          id: 'acme.demo',
          requires: [],
          packageVersion: '1.0.0',
          manifestPermissions: { system: [] },
          provenance: 'official-registry',
        },
      ])
      expect(active.has('acme.demo')).toBe(true)
      expect(projectBackendPluginActivationCatalog([...active.values()]).packages).toEqual([
        expect.objectContaining({
          pluginId: 'acme.demo',
          packageDir: immutablePluginPackageDir(root, 'acme.demo', '1.0.0', 'universal'),
          artifactDigest: digest,
        }),
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // The Registry install path is Manifest v2 only: legacy v1 packages carry no
  // activation to stage, so the v2 frontend-only replacement is the case the
  // immutable lifecycle can exercise.
  it('clears a prior backend activation when replaced by a v2 frontend-only package', async () => {
    const backend = buildBackendPkg()
    installFetch(signedDetail(backend.digest), backend.bytes, backend.digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-same-session-downgrade-'))
    const active = new Map<string, PluginActivationCatalogEntry>()
    const changes: Array<{ pluginId: string; activation?: PluginActivationCatalogEntry }> = []
    try {
      const manager = new FrontendPluginManager()
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        ...TEST_PREFLIGHT_OPTIONS,
        onActivationChange: (change) => {
          changes.push(change)
          active.delete(change.pluginId)
          if (change.activation) active.set(change.pluginId, change.activation)
        },
      })
      const prepareHandler = handlers.get('plugins:prepareInstall')
      const commitHandler = handlers.get('plugins:commitInstall')
      const restartHandler = handlers.get('plugins:restart')
      if (!prepareHandler || !commitHandler || !restartHandler) throw new Error('install handlers not registered')

      await prepareHandler(null, { namespace: 'acme', name: 'demo' })
      await commitHandler(null, {
        id: 'acme.demo',
        publisherConfirmed: true,
        riskConfirmed: true,
      })
      await restartHandler(null, { id: 'acme.demo' })
      expect(active.get('acme.demo')?.backend).toBeDefined()
      changes.length = 0

      const replacement = buildPkg('acme.demo', 'acme', {}, '1.0.1')
      installFetch(signedDetail(replacement.digest, 'acme.demo', 'acme', '1.0.1'), replacement.bytes, replacement.digest)
      await prepareHandler(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      await expect(commitHandler(null, { id: 'acme.demo' })).resolves.toMatchObject({ id: 'acme.demo' })
      await restartHandler(null, { id: 'acme.demo' })

      expect(changes).toEqual([expect.objectContaining({ pluginId: 'acme.demo' })])
      expect(active.get('acme.demo')?.backend).toBeUndefined()
      expect(projectBackendPluginActivationCatalog([...active.values()])).toEqual({
        schemaVersion: 1,
        packages: [],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('installs a legacy v1 replacement immediately and clears its staged selection', async () => {
    const backend = buildBackendPkg()
    installFetch(signedDetail(backend.digest), backend.bytes, backend.digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-legacy-downgrade-'))
    const active = new Map<string, PluginActivationCatalogEntry>()
    const changes: Array<{ pluginId: string; activation?: PluginActivationCatalogEntry }> = []
    try {
      const manager = new FrontendPluginManager()
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        ...TEST_PREFLIGHT_OPTIONS,
        onActivationChange: (change) => {
          changes.push(change)
          active.delete(change.pluginId)
          if (change.activation) active.set(change.pluginId, change.activation)
        },
      })
      const prepareHandler = handlers.get('plugins:prepareInstall')
      const commitHandler = handlers.get('plugins:commitInstall')
      const restartHandler = handlers.get('plugins:restart')
      if (!prepareHandler || !commitHandler || !restartHandler) throw new Error('install handlers not registered')

      await prepareHandler(null, { namespace: 'acme', name: 'demo' })
      await commitHandler(null, { id: 'acme.demo', publisherConfirmed: true, riskConfirmed: true })
      await restartHandler(null, { id: 'acme.demo' })
      expect(active.get('acme.demo')?.backend).toBeDefined()
      expect(new PluginActivationSelector(root).read('acme.demo')).not.toBeNull()
      changes.length = 0

      const legacy = buildLegacyPkg()
      installFetch(signedDetail(legacy.digest), legacy.bytes, legacy.digest)
      await prepareHandler(null, { namespace: 'acme', name: 'demo' })

      // Manifest v1 carries no activation to stage, so the commit installs the
      // mutable package and clears the prior backend activation in one step.
      await expect(
        commitHandler(null, { id: 'acme.demo', publisherConfirmed: true })
      ).resolves.toEqual({ id: 'acme.demo', requires: [] })
      expect(changes).toEqual([{ pluginId: 'acme.demo' }])
      expect(active.has('acme.demo')).toBe(false)
      expect(projectBackendPluginActivationCatalog([...active.values()])).toEqual({
        schemaVersion: 1,
        packages: [],
      })
      expect(manager.listInstalledPackages()).toEqual([
        expect.objectContaining({ id: 'acme.demo', requires: [] }),
      ])
      expect(manager.listInstalledPackages()[0]?.packageVersion).toBeUndefined()
      // The v1 write replaced `<root>/acme.demo`, so the record that pointed at
      // the promoted v2 candidate must not survive.
      expect(new PluginActivationSelector(root).read('acme.demo')).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps the active package selected when candidate verification fails', async () => {
    const first = buildPkg('acme.demo', 'acme', {}, '1.0.0')
    const second = buildPkg('acme.demo', 'acme', {}, '1.0.1')
    installFetch(signedDetail(first.digest, 'acme.demo', 'acme', '1.0.0'), first.bytes, first.digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-candidate-verification-failure-'))
    let rejectCandidate = false
    try {
      const manager = new FrontendPluginManager()
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        ...TEST_PREFLIGHT_OPTIONS,
        verifyCommittedInstall: (pluginDir): InstalledTrustDecision => {
          const candidate = pluginDir.includes('1.0.1/')
          if (rejectCandidate && candidate) {
            return { action: 'quarantine', reason: 'candidate verification failure' }
          }
          return {
            action: 'allow',
            artifactDigest: candidate ? second.digest : first.digest,
          }
        },
      })
      const prepare = handlers.get('plugins:prepareInstall')!
      const commit = handlers.get('plugins:commitInstall')!
      const restart = handlers.get('plugins:restart')!
      await prepare(null, { namespace: 'acme', name: 'demo' })
      await commit(null, { id: 'acme.demo', publisherConfirmed: true })
      await restart(null, { id: 'acme.demo' })

      installFetch(signedDetail(second.digest, 'acme.demo', 'acme', '1.0.1'), second.bytes, second.digest)
      await prepare(null, { namespace: 'acme', name: 'demo', version: '1.0.1' })
      rejectCandidate = true
      await expect(commit(null, { id: 'acme.demo', publisherConfirmed: true }))
        .rejects.toThrow(/staged candidate quarantined/)
      expect(manager.getDescriptor('acme.demo')?.packageVersion).toBe('1.0.0')
      expect(new PluginActivationSelector(root).read('acme.demo')).toMatchObject({
        active: { packageVersion: '1.0.0', artifactDigest: first.digest },
      })
      expect(new PluginActivationSelector(root).read('acme.demo')?.candidate).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not project a quarantined same-session backend activation', async () => {
    const { bytes, digest } = buildBackendPkg()
    installFetch(signedDetail(digest), bytes, digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-same-session-quarantine-'))
    const active = new Map<string, PluginActivationCatalogEntry>()
    try {
      const manager = new FrontendPluginManager()
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        ...TEST_PREFLIGHT_OPTIONS,
        onActivationChange: ({ pluginId, activation }) => {
          active.delete(pluginId)
          if (activation) active.set(pluginId, activation)
        },
        verifyCommittedInstall: () => ({
          action: 'quarantine',
          reason: 'test quarantine',
        }),
      })
      const prepareHandler = handlers.get('plugins:prepareInstall')
      const commitHandler = handlers.get('plugins:commitInstall')
      if (!prepareHandler || !commitHandler) throw new Error('install handlers not registered')

      await prepareHandler(null, { namespace: 'acme', name: 'demo' })
      await expect(
        commitHandler(null, {
          id: 'acme.demo',
          publisherConfirmed: true,
          riskConfirmed: true,
        })
      ).rejects.toThrow(/staged candidate quarantined/)
      expect(projectBackendPluginActivationCatalog([...active.values()])).toEqual({
        schemaVersion: 1,
        packages: [],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('carries Official Registry authority through post-commit verification', async () => {
    const { bytes, digest } = buildPkg()
    installFetch(signedDetail(digest), bytes, digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-official-post-commit-'))
    const previousUrl = process.env['AGENT_TEAM_MARKETPLACE_URL']
    process.env['AGENT_TEAM_MARKETPLACE_URL'] = 'https://server.navide.dev/registry'
    try {
      const manager = new FrontendPluginManager()
      registerPluginIpc(manager, root, () => true, {
        ...TRUST_CONFIG,
        registryAuthority: 'official',
        officialRegistryUrl: 'https://server.navide.dev/registry',
      }, undefined, { ...TEST_PREFLIGHT_OPTIONS })
      const prepareHandler = handlers.get('plugins:prepareInstall')
      const commitHandler = handlers.get('plugins:commitInstall')
      if (!prepareHandler || !commitHandler) throw new Error('install handlers not registered')
      const prepared = (await prepareHandler(null, { namespace: 'acme', name: 'demo' })) as {
        requiresPublisherTrust: boolean
      }
      expect(prepared.requiresPublisherTrust).toBe(true)
      expect(
        await commitHandler(null, { id: 'acme.demo', publisherConfirmed: true })
      ).toEqual({ id: 'acme.demo', requires: [], restartRequired: true })
      const restartHandler = handlers.get('plugins:restart')
      if (!restartHandler) throw new Error('restart handler not registered')
      await restartHandler(null, { id: 'acme.demo' })
      expect(manager.listInstalledPackages()).toEqual([
        {
          id: 'acme.demo',
          requires: [],
          packageVersion: '1.0.0',
          manifestPermissions: { system: [] },
          provenance: 'official-registry',
        },
      ])
    } finally {
      if (previousUrl === undefined) delete process.env['AGENT_TEAM_MARKETPLACE_URL']
      else process.env['AGENT_TEAM_MARKETPLACE_URL'] = previousUrl
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not require publisher consent for an authorized first-party identity', async () => {
    const { bytes, digest } = buildReservedPkg()
    const detail = signedDetail(digest, 'navide.spoof', 'navide')
    installFetch(detail, bytes, digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-official-publisher-trust-'))
    const previousUrl = process.env['AGENT_TEAM_MARKETPLACE_URL']
    process.env['AGENT_TEAM_MARKETPLACE_URL'] = 'https://server.navide.dev/registry'
    try {
      const manager = new FrontendPluginManager()
      registerPluginIpc(manager, root, () => true, {
        ...TRUST_CONFIG,
        registryAuthority: 'official',
        officialRegistryUrl: 'https://server.navide.dev/registry',
      })
      const prepareHandler = handlers.get('plugins:prepareInstall')
      if (!prepareHandler) throw new Error('prepareInstall handler not registered')
      const prepared = (await prepareHandler(null, {
        namespace: 'navide',
        name: 'spoof',
      })) as { requiresPublisherTrust: boolean }
      expect(prepared.requiresPublisherTrust).toBe(false)
    } finally {
      if (previousUrl === undefined) delete process.env['AGENT_TEAM_MARKETPLACE_URL']
      else process.env['AGENT_TEAM_MARKETPLACE_URL'] = previousUrl
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('re-verifies committed files before registration and quarantines tampering', async () => {
    const { bytes, digest } = buildBackendPkg()
    installFetch(signedDetail(digest), bytes, digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-post-commit-'))
    try {
      const manager = new FrontendPluginManager()
      registerPluginIpc(
        manager,
        root,
        () => true,
        TRUST_CONFIG,
        undefined,
        {
          ...TEST_PREFLIGHT_OPTIONS,
          verifyCommittedInstall: (pluginDir, pluginId, trust) => {
            writeFileSync(join(pluginDir, 'backend', 'entry'), 'tampered after commit')
            return verifyInstalledRegistryPackage(pluginDir, pluginId, {
              pinnedRootKey: trust.pinnedRegistryRootKey,
              snapshot: readRegistryTrustSnapshot(root),
              now: trust.now,
            })
          },
        }
      )
      const prepareHandler = handlers.get('plugins:prepareInstall')
      const commitHandler = handlers.get('plugins:commitInstall')
      if (!prepareHandler || !commitHandler) throw new Error('install handlers not registered')
      await prepareHandler(null, { namespace: 'acme', name: 'demo' })

      await expect(
        commitHandler(null, {
          id: 'acme.demo',
          publisherConfirmed: true,
          riskConfirmed: true,
        })
      ).rejects.toThrow(/installed package file was modified/)
      expect(manager.listInstalledPackages()).toEqual([])
      expect(existsSync(join(root, 'acme.demo', '.navide-package.zip'))).toBe(false)
      expect(existsSync(join(root, '.navide-quarantine'))).toBe(false)
      expect(existsSync(immutablePluginPackageDir(root, 'acme.demo', '1.0.0', 'universal'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not resurrect a package when trust expires after prepare', async () => {
    const { bytes, digest } = buildPkg()
    installFetch(signedDetail(digest), bytes, digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-expired-after-prepare-'))
    const installTrust: InstallerTrustConfig = { ...TRUST_CONFIG, now: new Date(FIXED_NOW) }
    try {
      const manager = new FrontendPluginManager()
      const controller = registerPluginIpc(manager, root, () => true, installTrust)
      const prepareHandler = handlers.get('plugins:prepareInstall')
      const commitHandler = handlers.get('plugins:commitInstall')
      if (!prepareHandler || !commitHandler) throw new Error('install handlers not registered')
      await prepareHandler(null, { namespace: 'acme', name: 'demo' })
      installTrust.now = new Date('2026-08-18T12:00:00.000Z')
      await expect(
        commitHandler(null, { id: 'acme.demo', publisherConfirmed: true })
      ).rejects.toThrow(/expired/)
      expect(manager.listInstalledPackages()).toEqual([])
      expect(existsSync(immutablePluginPackageDir(root, 'acme.demo', '1.0.0', 'universal'))).toBe(true)
      expect(new PluginActivationSelector(root).read('acme.demo')?.candidate).toBeUndefined()

      await expect(controller.refreshRegistryTrust()).rejects.toThrow(/expired/)
      expect(manager.listInstalledPackages()).toEqual([])
      expect(existsSync(immutablePluginPackageDir(root, 'acme.demo', '1.0.0', 'universal'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps an expired-cache package inactive until online refresh restores it', async () => {
    const { bytes, digest } = buildPkg()
    const root = mkdtempSync(join(tmpdir(), 'navide-trust-refresh-'))
    try {
      await installRegistryEvidence(root, bytes, digest)
      writeExpiredTrustSnapshot(root)
      const manager = new FrontendPluginManager()
      const expiredLoad = manager.loadInstalledPlugins(root, {
        provenance: 'official-registry',
        trust: {
          pinnedRootKey: registryRoot.pubPem,
          snapshot: readRegistryTrustSnapshot(root),
          now: FIXED_NOW,
        },
      })
      expect(expiredLoad.activationCatalog).toEqual([])
      expect(manager.listInstalledPackages()).toEqual([])

      const detail = signedDetail(digest)
      global.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        async json() {
          return detail
        },
      })) as unknown as typeof fetch
      const controller = registerPluginIpc(manager, root, () => true, TRUST_CONFIG)

      const refreshed = await controller.refreshRegistryTrust()
      expect(refreshed.decisions).toEqual([
        { pluginId: 'acme.demo', action: 'allow', artifactDigest: digest },
      ])
      expect(refreshed.activationCatalog).toHaveLength(1)
      expect(manager.listInstalledPackages()).toEqual([
        {
          id: 'acme.demo',
          requires: [],
          packageVersion: '1.0.0',
          manifestPermissions: { system: [] },
          provenance: 'official-registry',
        },
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('leaves an expired-cache package quarantined when trust refresh fails', async () => {
    const { bytes, digest } = buildPkg()
    const root = mkdtempSync(join(tmpdir(), 'navide-trust-refresh-fail-'))
    try {
      await installRegistryEvidence(root, bytes, digest)
      const manager = new FrontendPluginManager()
      manager.loadInstalledPlugins(root, {
        provenance: 'official-registry',
        trust: {
          pinnedRootKey: registryRoot.pubPem,
          snapshot: readRegistryTrustSnapshot(root),
          now: FIXED_NOW,
        },
      })
      expect(manager.listInstalledPackages()).toEqual([
        {
          id: 'acme.demo',
          requires: [],
          packageVersion: '1.0.0',
          manifestPermissions: { system: [] },
          provenance: 'official-registry',
        },
      ])
      writeExpiredTrustSnapshot(root)
      global.fetch = vi.fn(async () => ({ ok: false, status: 503 })) as unknown as typeof fetch
      const controller = registerPluginIpc(manager, root, () => true, TRUST_CONFIG)

      await expect(controller.refreshRegistryTrust()).rejects.toThrow(/HTTP 503/)
      expect(manager.listInstalledPackages()).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps an active package while a still-valid cached snapshot survives refresh failure', async () => {
    const { bytes, digest } = buildPkg()
    const root = mkdtempSync(join(tmpdir(), 'navide-trust-refresh-cache-'))
    try {
      await installRegistryEvidence(root, bytes, digest)
      const manager = new FrontendPluginManager()
      manager.loadInstalledPlugins(root, {
        provenance: 'official-registry',
        trust: {
          pinnedRootKey: registryRoot.pubPem,
          snapshot: readRegistryTrustSnapshot(root),
          now: FIXED_NOW,
        },
      })
      global.fetch = vi.fn(async () => ({ ok: false, status: 503 })) as unknown as typeof fetch
      const controller = registerPluginIpc(manager, root, () => true, TRUST_CONFIG)

      await expect(controller.refreshRegistryTrust()).rejects.toThrow(/HTTP 503/)
      expect(manager.listInstalledPackages()).toEqual([
        {
          id: 'acme.demo',
          requires: [],
          packageVersion: '1.0.0',
          manifestPermissions: { system: [] },
          provenance: 'official-registry',
        },
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('skips an expired HTTP 200 candidate and accepts the next valid candidate', async () => {
    const first = buildPkg()
    const second = buildPkg('beta.other', 'beta')
    const root = mkdtempSync(join(tmpdir(), 'navide-trust-refresh-invalid-candidate-'))
    try {
      await installRegistryEvidence(root, first.bytes, first.digest)
      await installRegistryEvidence(
        root,
        second.bytes,
        second.digest,
        signedDetail(second.digest, 'beta.other', 'beta'),
        'beta',
        'other'
      )
      const manager = new FrontendPluginManager()
      manager.loadInstalledPlugins(root, {
        provenance: 'official-registry',
        trust: {
          pinnedRootKey: registryRoot.pubPem,
          snapshot: readRegistryTrustSnapshot(root),
          now: FIXED_NOW,
        },
      })
      const validFirst = signedDetail(first.digest)
      const expiredMetadata: RegistryTrustMetadata = {
        ...validFirst.trust_metadata,
        generatedAt: '2026-08-14T10:00:00.000Z',
        expiresAt: '2026-08-15T10:00:00.000Z',
      }
      const expiredFirst: WireDetail = {
        ...validFirst,
        trust_metadata: expiredMetadata,
        trust_metadata_signature: signCanonical(expiredMetadata, registryRoot.privateKey),
      }
      const validSecond = signedDetail(second.digest, 'beta.other', 'beta')
      global.fetch = vi.fn(async (url: unknown) => {
        if (String(url).includes('/api/extensions/acme/demo')) {
          return { ok: true, status: 200, async json() { return expiredFirst } }
        }
        return { ok: true, status: 200, async json() { return validSecond } }
      }) as unknown as typeof fetch
      const controller = registerPluginIpc(manager, root, () => true, TRUST_CONFIG)

      const refreshed = await controller.refreshRegistryTrust()
      expect(global.fetch).toHaveBeenCalledTimes(2)
      expect(refreshed.decisions).toEqual([
        { pluginId: 'acme.demo', action: 'allow', artifactDigest: first.digest },
        { pluginId: 'beta.other', action: 'allow', artifactDigest: second.digest },
      ])
      expect(readRegistryTrustSnapshot(root)?.metadata).toEqual(validSecond.trust_metadata)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('continues trust metadata refresh when the first installed package detail is missing', async () => {
    const first = buildPkg()
    const second = buildPkg('beta.other', 'beta')
    const root = mkdtempSync(join(tmpdir(), 'navide-trust-refresh-candidates-'))
    try {
      await installRegistryEvidence(root, first.bytes, first.digest)
      await installRegistryEvidence(
        root,
        second.bytes,
        second.digest,
        signedDetail(second.digest, 'beta.other', 'beta'),
        'beta',
        'other'
      )
      const manager = new FrontendPluginManager()
      manager.loadInstalledPlugins(root, {
        provenance: 'official-registry',
        trust: {
          pinnedRootKey: registryRoot.pubPem,
          snapshot: readRegistryTrustSnapshot(root),
          now: FIXED_NOW,
        },
      })
      const detail = signedDetail(second.digest, 'beta.other', 'beta')
      global.fetch = vi.fn(async (url: unknown) => {
        if (String(url).includes('/api/extensions/acme/demo')) {
          return { ok: false, status: 404 }
        }
        return { ok: true, status: 200, async json() { return detail } }
      }) as unknown as typeof fetch
      const controller = registerPluginIpc(manager, root, () => true, TRUST_CONFIG)

      const refreshed = await controller.refreshRegistryTrust()
      expect(global.fetch).toHaveBeenCalledTimes(2)
      expect(refreshed.decisions).toEqual([
        { pluginId: 'acme.demo', action: 'allow', artifactDigest: first.digest },
        { pluginId: 'beta.other', action: 'allow', artifactDigest: second.digest },
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('quarantines an active Registry package whose directory disappeared without a network candidate', async () => {
    const { bytes, digest } = buildPkg()
    const root = mkdtempSync(join(tmpdir(), 'navide-trust-refresh-missing-dir-'))
    const changes: Array<{ pluginId: string; activation?: PluginActivationCatalogEntry }> = []
    try {
      await installRegistryEvidence(root, bytes, digest)
      const manager = new FrontendPluginManager()
      manager.loadInstalledPlugins(root, {
        provenance: 'official-registry',
        trust: {
          pinnedRootKey: registryRoot.pubPem,
          snapshot: readRegistryTrustSnapshot(root),
          now: FIXED_NOW,
        },
      })
      rmSync(join(root, 'acme.demo'), { recursive: true, force: true })
      global.fetch = vi.fn() as unknown as typeof fetch
      const controller = registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        onActivationChange: (change) => changes.push(change),
      })

      const refreshed = await controller.refreshRegistryTrust()
      expect(refreshed.decisions).toMatchObject([
        {
          pluginId: 'acme.demo',
          action: 'quarantine',
          reason: expect.stringMatching(/missing/),
        },
      ])
      expect(global.fetch).not.toHaveBeenCalled()
      expect(manager.listInstalledPackages()).toEqual([])
      expect(changes).toEqual([{ pluginId: 'acme.demo' }])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('quarantines an active Registry package with a malformed manifest before refresh', async () => {
    const { bytes, digest } = buildPkg()
    const root = mkdtempSync(join(tmpdir(), 'navide-trust-refresh-malformed-manifest-'))
    const changes: Array<{ pluginId: string; activation?: PluginActivationCatalogEntry }> = []
    try {
      await installRegistryEvidence(root, bytes, digest)
      const manager = new FrontendPluginManager()
      manager.loadInstalledPlugins(root, {
        provenance: 'official-registry',
        trust: {
          pinnedRootKey: registryRoot.pubPem,
          snapshot: readRegistryTrustSnapshot(root),
          now: FIXED_NOW,
        },
      })
      writeFileSync(
        join(immutablePluginPackageDir(root, 'acme.demo', '1.0.0', 'universal'), 'manifest.json'),
        '{malformed',
      )
      global.fetch = vi.fn() as unknown as typeof fetch
      const controller = registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        onActivationChange: (change) => changes.push(change),
      })

      const refreshed = await controller.refreshRegistryTrust()
      expect(refreshed.decisions).toMatchObject([
        {
          pluginId: 'acme.demo',
          action: 'quarantine',
          reason: expect.stringMatching(/malformed/),
        },
      ])
      expect(global.fetch).not.toHaveBeenCalled()
      expect(manager.listInstalledPackages()).toEqual([])
      expect(changes).toEqual([{ pluginId: 'acme.demo' }])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reconciles active Registry state even when there are zero safe candidates', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-trust-refresh-zero-candidates-'))
    const changes: Array<{ pluginId: string; activation?: PluginActivationCatalogEntry }> = []
    try {
      const manager = new FrontendPluginManager()
      manager.registerInstalledPackage({
        id: 'acme.orphan',
        requires: [],
        provenance: 'official-registry',
      })
      global.fetch = vi.fn() as unknown as typeof fetch
      const controller = registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        onActivationChange: (change) => changes.push(change),
      })

      const refreshed = await controller.refreshRegistryTrust()
      expect(refreshed).toMatchObject({
        decisions: [
          {
            pluginId: 'acme.orphan',
            action: 'quarantine',
          },
        ],
        activationCatalog: [],
      })
      expect(global.fetch).not.toHaveBeenCalled()
      expect(manager.listInstalledPackages()).toEqual([])
      expect(changes).toEqual([{ pluginId: 'acme.orphan' }])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps a valid active Registry package after trust refresh', async () => {
    const { bytes, digest } = buildPkg()
    const root = mkdtempSync(join(tmpdir(), 'navide-trust-refresh-valid-active-'))
    const changes: Array<{ pluginId: string; activation?: PluginActivationCatalogEntry }> = []
    try {
      await installRegistryEvidence(root, bytes, digest)
      const manager = new FrontendPluginManager()
      manager.loadInstalledPlugins(root, {
        provenance: 'official-registry',
        trust: {
          pinnedRootKey: registryRoot.pubPem,
          snapshot: readRegistryTrustSnapshot(root),
          now: FIXED_NOW,
        },
      })
      const detail = signedDetail(digest)
      global.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        async json() {
          return detail
        },
      })) as unknown as typeof fetch
      const controller = registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        onActivationChange: (change) => changes.push(change),
      })

      const refreshed = await controller.refreshRegistryTrust()
      expect(refreshed.decisions).toEqual([
        { pluginId: 'acme.demo', action: 'allow', artifactDigest: digest },
      ])
      expect(manager.listInstalledPackages()).toEqual([
        {
          id: 'acme.demo',
          requires: [],
          packageVersion: '1.0.0',
          manifestPermissions: { system: [] },
          provenance: 'official-registry',
        },
      ])
      expect(changes).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('plugins:marketplaceDetail / plugins:checkUpdates', () => {
  const savedFetch = global.fetch
  const savedMarketplaceUrl = process.env['AGENT_TEAM_MARKETPLACE_URL']
  beforeEach(() => {
    handlers.clear()
    process.env['AGENT_TEAM_MARKETPLACE_URL'] = 'https://server.navide.dev/registry'
  })
  afterEach(() => {
    global.fetch = savedFetch
    if (savedMarketplaceUrl === undefined) delete process.env['AGENT_TEAM_MARKETPLACE_URL']
    else process.env['AGENT_TEAM_MARKETPLACE_URL'] = savedMarketplaceUrl
    vi.restoreAllMocks()
  })

  function respond(routes: Record<string, { status?: number; body?: unknown } | Error>) {
    const fetchMock = vi.fn(async (url: unknown) => {
      const route = routes[String(url)]
      if (route instanceof Error) throw route
      if (!route) return { ok: false, status: 404, async json() { return {} } }
      const status = route.status ?? 200
      return { ok: status < 400, status, async json() { return route.body } }
    })
    global.fetch = fetchMock as unknown as typeof fetch
    return fetchMock
  }

  const BASE = 'https://server.navide.dev/registry/api/extensions'

  it('returns display fields plus the raw README and never forwards trust material', async () => {
    respond({
      [`${BASE}/acme/demo`]: {
        body: {
          namespace: 'acme',
          name: 'demo',
          identity: 'acme.demo',
          display_name: 'Demo',
          description: 'd',
          categories: ['tools'],
          latest_version: '1.1.0',
          updated_at: '2026-09-01T00:00:00Z',
          download_count: 3,
          rating_average: 4,
          rating_count: 1,
          featured: false,
          publisher: 'acme',
          trust_metadata: { secret: true },
          trust_metadata_signature: 'sig',
          versions: [
            {
              version: '1.1.0',
              published_at: '2026-09-01T00:00:00Z',
              target: 'universal',
              yanked: false,
              trust_tier: 'signed-verified',
              capabilities: ['fs'],
              sensitive_capabilities: ['fs'],
              download_count: 3,
              registry_envelope: { a: 1 },
              registry_signature: 'x',
              package_digest: 'd',
            },
          ],
        },
      },
      [`${BASE}/acme/demo/readme`]: { body: { version: '1.1.0', markdown: '# Demo' } },
    })
    registerPluginIpc(new FrontendPluginManager(), '/plugins', () => true, TRUST_CONFIG)
    const detail = (await handlers.get('plugins:marketplaceDetail')!(null, {
      namespace: 'acme',
      name: 'demo',
    })) as Record<string, unknown> & { versions: Array<Record<string, unknown>> }
    expect(detail.readme).toBe('# Demo')
    expect(detail.publisher).toBe('acme')
    expect(detail).not.toHaveProperty('trust_metadata')
    expect(detail).not.toHaveProperty('trust_metadata_signature')
    expect(detail.versions[0]).not.toHaveProperty('registry_envelope')
    expect(detail.versions[0]).not.toHaveProperty('registry_signature')
    expect(detail.versions[0].capabilities).toEqual(['fs'])
    expect(detail.versions[0].installable).toBe(true)
    expect(detail.latest_installable_version).toBe('1.1.0')
    expect(detail.host_target).toBe(`${process.platform}-${process.arch}`)
  })

  it('tolerates a Registry without the README endpoint and rejects bad identifiers', async () => {
    respond({
      [`${BASE}/acme/demo`]: { body: { namespace: 'acme', name: 'demo', versions: [] } },
    })
    registerPluginIpc(new FrontendPluginManager(), '/plugins', () => true, TRUST_CONFIG)
    const handler = handlers.get('plugins:marketplaceDetail')!
    const detail = (await handler(null, { namespace: 'acme', name: 'demo' })) as { readme: unknown }
    expect(detail.readme).toBeNull()
    await expect(handler(null, { namespace: '', name: 'demo' })).rejects.toThrow(/invalid/)
    await expect(handler(null, { namespace: 'acme', name: 7 })).rejects.toThrow(/invalid/)
  })

  it('reports only strictly newer Registry versions of official-registry packages', async () => {
    const row = (version: string, target = 'universal', yanked = false) => ({ version, target, yanked })
    const host = `${process.platform}-${process.arch}`
    const other = host === 'win32-x64' ? 'linux-x64' : 'win32-x64'
    const fetchMock = respond({
      [`${BASE}/acme/old`]: { body: { versions: [row('1.2.0'), row('1.0.0')] } },
      [`${BASE}/acme/current`]: { body: { versions: [row('1.0.0')] } },
      [`${BASE}/acme/offline`]: new Error('network down'),
      // A newer release published only for another platform is not an update
      // here; the newest release for this Host is.
      [`${BASE}/acme/split`]: {
        body: {
          latest_version: '3.0.0',
          versions: [row('3.0.0', other), row('2.5.0', 'universal', true), row('2.0.0', host), row('1.0.0')],
        },
      },
      [`${BASE}/acme/elsewhere`]: { body: { latest_version: '9.0.0', versions: [row('9.0.0', other)] } },
    })
    const manager = {
      listInstalledPackages: () => [
        { id: 'acme.old', requires: [], packageVersion: '1.0.0', provenance: 'official-registry' },
        { id: 'acme.current', requires: [], packageVersion: '1.0.0', provenance: 'official-registry' },
        { id: 'acme.offline', requires: [], packageVersion: '1.0.0', provenance: 'official-registry' },
        { id: 'acme.split', requires: [], packageVersion: '1.0.0', provenance: 'official-registry' },
        { id: 'acme.elsewhere', requires: [], packageVersion: '1.0.0', provenance: 'official-registry' },
        { id: 'acme.local', requires: [], packageVersion: '0.1.0', provenance: 'developer-local-unpacked' },
      ],
    } as unknown as FrontendPluginManager
    registerPluginIpc(manager, '/plugins', () => true, TRUST_CONFIG)
    const updates = await handlers.get('plugins:checkUpdates')!(null)
    expect(updates).toEqual([
      { id: 'acme.old', namespace: 'acme', name: 'old', installedVersion: '1.0.0', latestVersion: '1.2.0' },
      { id: 'acme.split', namespace: 'acme', name: 'split', installedVersion: '1.0.0', latestVersion: '2.0.0' },
    ])
    // Developer-local packages are never looked up in the Registry.
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).not.toContain(`${BASE}/acme/local`)
  })

  it('exposes the check on the refresh controller and caches it for pendingUpdates', async () => {
    respond({
      [`${BASE}/acme/old`]: { body: { versions: [{ version: '1.2.0', target: 'universal', yanked: false }] } },
    })
    const manager = {
      listInstalledPackages: () => [
        { id: 'acme.old', requires: [], packageVersion: '1.0.0', provenance: 'official-registry' },
      ],
    } as unknown as FrontendPluginManager
    const controller = registerPluginIpc(manager, '/plugins', () => true, TRUST_CONFIG)
    expect(await handlers.get('plugins:pendingUpdates')!(null)).toEqual([])
    const updates = await controller.checkUpdates()
    expect(updates).toHaveLength(1)
    // The cached answer needs no network round trip.
    respond({})
    expect(await handlers.get('plugins:pendingUpdates')!(null)).toEqual(updates)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('rejects unauthorized senders before any network request', async () => {
    const fetchMock = respond({})
    registerPluginIpc(new FrontendPluginManager(), '/plugins', () => false, TRUST_CONFIG)
    for (const channel of ['plugins:marketplaceDetail', 'plugins:checkUpdates', 'plugins:pendingUpdates']) {
      await expect(
        Promise.resolve().then(() => handlers.get(channel)!(null, { namespace: 'a', name: 'b' }))
      ).rejects.toThrow(/unauthorized/)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('forwards only a known sort to the search endpoint', async () => {
    const host = `${process.platform}-${process.arch}`
    const fetchMock = respond({})
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          items: [
            { identity: 'a.universal', latest_targets: ['universal'] },
            { identity: 'a.host', latest_targets: [host] },
            { identity: 'a.other', latest_targets: ['plan9-mips'] },
            { identity: 'a.legacy' },
          ],
        }
      },
    }))
    registerPluginIpc(new FrontendPluginManager(), '/plugins', () => true, TRUST_CONFIG)
    const search = handlers.get('plugins:marketplaceSearch')!
    const result = (await search(null, undefined, 'downloads')) as {
      items: Array<{ identity: string; installable: boolean }>
    }
    // Compatibility is decided main-side with the install rule; a Registry
    // without per-target data stays installable.
    expect(result.items.map((i) => [i.identity, i.installable])).toEqual([
      ['a.universal', true],
      ['a.host', true],
      ['a.other', false],
      ['a.legacy', true],
    ])
    await search(null, undefined, 'evil&x=1')
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([
      `${BASE}?sort=downloads`,
      BASE,
    ])
  })
})
