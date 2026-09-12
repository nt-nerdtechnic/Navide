import { generateKeyPairSync } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readZipEntries } from '../../../src/main/plugins/pluginPackage'

const roots: string[] = []
const cli = join(process.cwd(), 'packages/plugin-sdk/bin/navide-plugin.mjs')
const target = `${process.platform}-${process.arch}`

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), 'navide-plugin-sdk-cli-'))
  roots.push(directory)
  return directory
}

function run(args: string[], cwd: string) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' })
}

function frontendManifest() {
  return {
    schemaVersion: 2,
    apiVersion: '^1.0.0',
    id: 'acme.frontend',
    name: 'Frontend',
    version: '1.0.0',
    publisher: 'acme',
    permissions: {},
    marketplace: { description: 'A frontend fixture.', license: 'MIT' },
    contributes: { views: [{ id: 'main', kind: 'custom', location: 'main', title: 'Frontend', entry: 'frontend/main/index.html' }] },
  }
}

function backendManifest() {
  return {
    schemaVersion: 2,
    apiVersion: '^1.0.0',
    id: 'acme.backend',
    name: 'Backend',
    version: '1.0.0',
    publisher: 'acme',
    permissions: {},
    marketplace: { description: 'A backend fixture.', license: 'MIT' },
    backend: { entry: 'backend/acme-backend', protocolVersion: 1, activation: 'startup' },
  }
}

function targetBinary(): Buffer {
  if (process.platform === 'linux') {
    const binary = Buffer.alloc(20)
    binary.set([0x7f, 0x45, 0x4c, 0x46, 2, 1])
    binary.writeUInt16LE(process.arch === 'x64' ? 62 : 183, 18)
    return binary
  }
  if (process.platform === 'win32') {
    const binary = Buffer.alloc(0x86)
    binary.write('MZ')
    binary.writeUInt32LE(0x80, 0x3c)
    binary.write('PE\0\0', 0x80)
    binary.writeUInt16LE(process.arch === 'x64' ? 0x8664 : 0xaa64, 0x84)
    return binary
  }
  const binary = Buffer.alloc(8)
  binary.writeUInt32LE(0xfeedfacf, 0)
  binary.writeUInt32LE(process.arch === 'x64' ? 0x01000007 : 0x0100000c, 4)
  return binary
}

function packageDirectory(directory: string, manifest: object, files: Record<string, Buffer | string>): void {
  writeFileSync(join(directory, 'manifest.json'), `${JSON.stringify(manifest)}\n`)
  for (const [path, contents] of Object.entries(files)) {
    const fullPath = join(directory, path)
    const parent = fullPath.slice(0, fullPath.lastIndexOf('/'))
    if (parent) mkdirSync(parent, { recursive: true })
    writeFileSync(fullPath, contents)
  }
  writeFileSync(
    join(directory, 'artifact-files.json'),
    `${JSON.stringify({ files: ['manifest.json', ...Object.keys(files)] })}\n`,
  )
}

afterEach(() => {
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('navide-plugin canonical artifacts', () => {
  it('packages a deterministic frontend-only archive from its explicit file list', () => {
    const directory = root()
    packageDirectory(directory, frontendManifest(), {
      'frontend/main/index.html': '<!doctype html>',
      'frontend/main/app.js': 'console.log(1)',
    })
    const first = join(directory, 'first.vsix')
    const second = join(directory, 'second.vsix')
    expect(run(['package', directory, '--out', first], directory).status).toBe(0)
    expect(run(['package', directory, '--out', second], directory).status).toBe(0)
    expect(readFileSync(first)).toEqual(readFileSync(second))
    expect(readZipEntries(readFileSync(first)).map((entry) => entry.path)).toEqual([
      'frontend/main/app.js', 'frontend/main/index.html', 'manifest.json',
    ])
  })

  it('requires one native backend executable and its exact build-host target', () => {
    const directory = root()
    packageDirectory(directory, backendManifest(), { 'backend/acme-backend': targetBinary() })
    chmodSync(join(directory, 'backend/acme-backend'), 0o755)
    expect(run(['package', directory, '--target', 'universal'], directory).status).not.toBe(0)
    const archive = join(directory, 'backend.vsix')
    const packaged = run(['package', directory, '--target', target, '--out', archive], directory)
    expect(packaged.status, packaged.stderr).toBe(0)
    const backend = readZipEntries(readFileSync(archive)).find((entry) => entry.path === 'backend/acme-backend')
    expect(backend?.executable).toBe(true)
  })

  it('signs and verifies the complete archive digest with an ephemeral key', () => {
    const directory = root()
    packageDirectory(directory, frontendManifest(), { 'frontend/main/index.html': '<!doctype html>' })
    const archive = join(directory, 'frontend.vsix')
    expect(run(['package', directory, '--out', archive], directory).status).toBe(0)
    const keys = generateKeyPairSync('ed25519')
    const privateKey = join(directory, 'private.pem')
    const publicKey = join(directory, 'public.pem')
    writeFileSync(privateKey, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }))
    chmodSync(privateKey, 0o600)
    writeFileSync(publicKey, keys.publicKey.export({ type: 'spki', format: 'pem' }))
    const signature = join(directory, 'frontend.sig')
    expect(run(['sign', archive, '--key', privateKey, '--out', signature], directory).status).toBe(0)
    expect(run(['verify', archive, '--key', publicKey, '--signature', signature], directory).status).toBe(0)
    writeFileSync(archive, Buffer.concat([readFileSync(archive), Buffer.from('tampered')]))
    expect(run(['verify', archive, '--key', publicKey, '--signature', signature], directory).status).not.toBe(0)
  })

  it('rejects source-only files and duplicate file-list keys', () => {
    const directory = root()
    packageDirectory(directory, frontendManifest(), {
      'frontend/main/index.html': '<!doctype html>',
      'frontend/main/source.ts': 'export {}',
    })
    expect(run(['validate', directory], directory).status).not.toBe(0)
    writeFileSync(join(directory, 'artifact-files.json'), '{"files":["manifest.json"],"files":["manifest.json"]}\n')
    expect(run(['validate', directory], directory).status).not.toBe(0)
  })
})
