import { describe, it, expect } from 'vitest'
import { generateKeyPairSync, sign as edSign } from 'node:crypto'
import {
  prepareInstall,
  commitInstall,
  removePlugin,
  isUpdateAvailable,
  type InstallerDeps,
} from './pluginInstaller'
import { sha256Hex } from './pluginVerify'
import { makeZip, type ZipFile } from './zipFixture'

const REQ_BASE = {
  registryUrl: 'http://localhost:8787',
  namespace: 'acme',
  name: 'demo',
  version: '1.0.0',
}

function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'acme.demo',
    name: 'Demo',
    version: '1.0.0',
    publisher: 'acme',
    engines: { navide: '^0.1.0' },
    entry: 'dist/main.js',
    requires: ['git'],
    ...overrides,
  })
}

function pkg(files?: ZipFile[]): { bytes: Uint8Array; digest: string } {
  const zip = makeZip(
    files ?? [
      { name: 'manifest.json', data: manifest() },
      { name: 'dist/main.js', data: 'console.log("demo")' },
    ]
  )
  return { bytes: new Uint8Array(zip), digest: sha256Hex(new Uint8Array(zip)) }
}

/** Deps that serve a fixed package and capture filesystem writes in a map. */
function fakeDeps(bytes: Uint8Array, digestHeader: string | null = 'from-header') {
  const writes = new Map<string, Uint8Array>()
  const removed: string[] = []
  const deps: InstallerDeps = {
    async download() {
      return { bytes, digestHeader }
    },
    mkdirp() {},
    writeFile(path, data) {
      writes.set(path, data)
    },
    rmrf(dir) {
      removed.push(dir)
    },
  }
  return { deps, writes, removed }
}

describe('prepareInstall', () => {
  it('verifies and returns manifest + entries for a good package', async () => {
    const { bytes, digest } = pkg()
    const { deps } = fakeDeps(bytes, digest)
    const prepared = await prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    expect(prepared.id).toBe('acme.demo')
    expect(prepared.trustTier).toBe('unsigned')
    expect(prepared.requiresConfirmation).toBe(false)
  })

  it('flags sensitive capabilities for confirmation', async () => {
    const { bytes, digest } = pkg([
      { name: 'manifest.json', data: manifest({ requires: ['fs', 'terminal'] }) },
      { name: 'dist/main.js', data: 'x' },
    ])
    const { deps } = fakeDeps(bytes, digest)
    const prepared = await prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    expect(prepared.sensitive).toEqual(['fs', 'terminal'])
    expect(prepared.requiresConfirmation).toBe(true)
  })

  it('rejects a forged digest (bytes do not match expected)', async () => {
    const { bytes } = pkg()
    const { deps } = fakeDeps(bytes, null)
    await expect(
      prepareInstall({ ...REQ_BASE, expectedDigest: 'f'.repeat(64) }, deps)
    ).rejects.toThrow(/digest/)
  })

  it('rejects when the download header disagrees with expected digest', async () => {
    const { bytes, digest } = pkg()
    const { deps } = fakeDeps(bytes, 'a'.repeat(64))
    await expect(
      prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    ).rejects.toThrow(/header/)
  })

  it('rejects an identity mismatch (manifest id != requested)', async () => {
    const { bytes, digest } = pkg()
    const { deps } = fakeDeps(bytes, digest)
    await expect(
      prepareInstall({ ...REQ_BASE, name: 'other', expectedDigest: digest }, deps)
    ).rejects.toThrow(/identity/)
  })

  it('verifies a valid Ed25519 signature → signed-verified', async () => {
    const { bytes, digest } = pkg()
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const signature = edSign(null, Buffer.from(digest, 'ascii'), privateKey).toString('base64')
    const { deps } = fakeDeps(bytes, digest)
    const prepared = await prepareInstall(
      { ...REQ_BASE, expectedDigest: digest, signature, publicKey: pubPem },
      deps
    )
    expect(prepared.trustTier).toBe('signed-verified')
  })

  it('blocks a signed package whose signature does not verify', async () => {
    const { bytes, digest } = pkg()
    const { publicKey } = generateKeyPairSync('ed25519') // key A
    const other = generateKeyPairSync('ed25519') // sign with key B
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const badSig = edSign(null, Buffer.from(digest, 'ascii'), other.privateKey).toString('base64')
    const { deps } = fakeDeps(bytes, digest)
    await expect(
      prepareInstall(
        { ...REQ_BASE, expectedDigest: digest, signature: badSig, publicKey: pubPem },
        deps
      )
    ).rejects.toThrow(/signature/i)
  })

  it('rejects an unknown capability in the package manifest', async () => {
    const { bytes, digest } = pkg([
      { name: 'manifest.json', data: manifest({ requires: ['fs', 'network'] }) },
      { name: 'dist/main.js', data: 'x' },
    ])
    const { deps } = fakeDeps(bytes, digest)
    await expect(
      prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    ).rejects.toThrow(/network/)
  })
})

describe('commitInstall', () => {
  it('writes verified entries under <root>/<id> and returns a descriptor', async () => {
    const { bytes, digest } = pkg()
    const { deps, writes, removed } = fakeDeps(bytes, digest)
    const prepared = await prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    const desc = commitInstall(prepared, '/plugins', deps)
    expect(removed).toContain('/plugins/acme.demo')
    expect([...writes.keys()].sort()).toEqual([
      '/plugins/acme.demo/dist/main.js',
      '/plugins/acme.demo/manifest.json',
    ])
    expect(desc.entryFile).toBe('/plugins/acme.demo/dist/main.js')
  })

  it('refuses a zip-slip entry before writing outside the root', async () => {
    const { bytes, digest } = pkg([
      { name: 'manifest.json', data: manifest() },
      { name: '../evil.js', data: 'pwned' },
    ])
    const { deps } = fakeDeps(bytes, digest)
    const prepared = await prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    expect(() => commitInstall(prepared, '/plugins', deps)).toThrow(/unsafe archive entry/)
  })
})

describe('removePlugin', () => {
  it('removes the plugin directory', () => {
    const { deps, removed } = fakeDeps(new Uint8Array())
    removePlugin('/plugins', 'acme.demo', deps)
    expect(removed).toContain('/plugins/acme.demo')
  })
})

describe('isUpdateAvailable', () => {
  it('detects a strictly-newer latest version', () => {
    expect(isUpdateAvailable('1.0.0', '1.0.1')).toBe(true)
    expect(isUpdateAvailable('1.0.0', '2.0.0')).toBe(true)
    expect(isUpdateAvailable('1.2.0', '1.10.0')).toBe(true)
  })

  it('is false for same or older or missing versions', () => {
    expect(isUpdateAvailable('1.0.0', '1.0.0')).toBe(false)
    expect(isUpdateAvailable('2.0.0', '1.9.9')).toBe(false)
    expect(isUpdateAvailable('1.0.0', null)).toBe(false)
    expect(isUpdateAvailable('1.0.0', 'not-semver')).toBe(false)
  })
})
