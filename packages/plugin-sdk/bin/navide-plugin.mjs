#!/usr/bin/env node

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signDigest,
  verify as verifyDigest,
} from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { TextDecoder } from 'node:util'
import {
  canonicalArchivePath,
  comparePortableArchivePaths,
  manifestReferencedFiles,
  parseManifestJson,
  parseManifestV2,
  validatePortableArchiveEntries,
} from '@navide/plugin-contracts'
import { readRegularFileNoFollow } from './package-files.mjs'

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function fail(message) {
  throw new Error(message)
}

function decodeUtf8(bytes, label) {
  try {
    return UTF8_DECODER.decode(bytes)
  } catch (error) {
    fail(`${label} is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assertSafePath(path, label) {
  if (canonicalArchivePath(path, 'regular') === null) {
    fail(`${label} is not a safe package-relative path`)
  }
}

function readManifest(directory) {
  const path = join(directory, 'manifest.json')
  const stat = lstatSync(path, { bigint: true })
  if (!stat.isFile()) fail('manifest.json must be a regular file')
  const raw = parseManifestJson(decodeUtf8(readRegularFileNoFollow(path), 'manifest.json'))
  return parseManifestV2(raw)
}

function assertInsideRoot(root, candidate) {
  const relativePath = relative(root, realpathSync(candidate))
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    fail(`package entry '${candidate}' resolves outside the package root`)
  }
}

function assertNoSymlinkPath(root, path) {
  let candidate = root
  const segments = path.split('/')
  for (const [index, segment] of segments.entries()) {
    candidate = join(candidate, segment)
    let stat
    try {
      stat = lstatSync(candidate, { bigint: true })
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        fail(`package entry '${path}' does not exist`)
      }
      throw error
    }
    if (stat.isSymbolicLink()) fail(`package entry '${path}' contains a symlink`)
    if (index < segments.length - 1 && !stat.isDirectory()) {
      fail(`package entry '${path}' has a non-directory ancestor`)
    }
  }
}

const CANONICAL_FILE_LIST = 'artifact-files.json'
const SOURCE_ONLY_SEGMENTS = new Set(['node_modules', '.venv', 'venv', '__pycache__', 'tests'])
const SOURCE_ONLY_FILE = /(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|uv\.lock|pyproject\.toml|vite\.config\.[cm]?[jt]s)$/
const SOURCE_ONLY_EXTENSION = /\.(?:py|pyc|pyo|ts|tsx|vue|map)$/
const SECRET_FILE = /(?:^|\/)(?:\.env(?:\..*)?|[^/]+\.(?:key|pem|p12|pfx))$/i

function artifactTarget(manifest, target) {
  if (manifest.backend) {
    const expected = `${process.platform}-${process.arch}`
    if (target !== expected) {
      fail(`backend package target '${target}' must match the build host target '${expected}'`)
    }
    return target
  }
  if (target !== 'universal') {
    fail(`frontend-only package target must be 'universal', received '${target}'`)
  }
  return target
}

function backendMatchesTarget(bytes, target) {
  const [platform, architecture] = target.split('-', 2)
  if (platform === 'linux') {
    if (bytes.length < 20 || !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return false
    const machine = bytes[5] === 1 ? bytes.readUInt16LE(18) : bytes[5] === 2 ? bytes.readUInt16BE(18) : -1
    return bytes[4] === 2 && ((architecture === 'x64' && machine === 62) || (architecture === 'arm64' && machine === 183))
  }
  if (platform === 'win32') {
    if (bytes.length < 0x40 || bytes.subarray(0, 2).toString('ascii') !== 'MZ') return false
    const offset = bytes.readUInt32LE(0x3c)
    if (offset + 6 > bytes.length || bytes.subarray(offset, offset + 4).toString('ascii') !== 'PE\0\0') return false
    const machine = bytes.readUInt16LE(offset + 4)
    return (architecture === 'x64' && machine === 0x8664) || (architecture === 'arm64' && machine === 0xaa64)
  }
  if (bytes.length < 8 || bytes.readUInt32LE(0) !== 0xfeedfacf) return false
  const cpuType = bytes.readUInt32LE(4)
  return (architecture === 'x64' && cpuType === 0x01000007) || (architecture === 'arm64' && cpuType === 0x0100000c)
}

function parseFileList(directory) {
  const listPath = join(directory, CANONICAL_FILE_LIST)
  let parsed
  try {
    parsed = parseManifestJson(decodeUtf8(readRegularFileNoFollow(listPath), CANONICAL_FILE_LIST))
  } catch (error) {
    fail(`${CANONICAL_FILE_LIST} must be a JSON object with a files array: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length !== 1 || !Array.isArray(parsed.files)) {
    fail(`${CANONICAL_FILE_LIST} must contain only a files array`)
  }
  const paths = parsed.files
  if (paths.length === 0 || paths.some((path) => typeof path !== 'string')) {
    fail(`${CANONICAL_FILE_LIST}.files must be a nonempty string array`)
  }
  return paths
}

function assertPublishableFile(path) {
  const segments = path.split('/')
  if (segments.some((segment) => SOURCE_ONLY_SEGMENTS.has(segment))) {
    fail(`package entry '${path}' is source-only build input`)
  }
  if (SOURCE_ONLY_FILE.test(path) || SOURCE_ONLY_EXTENSION.test(path) || SECRET_FILE.test(path)) {
    fail(`package entry '${path}' is source-only or secret material`)
  }
}

function collectFiles(directory, paths, root = realpathSync(directory)) {
  const files = []
  let totalSize = 0
  for (const path of paths) {
    assertSafePath(path, `package entry '${path}'`)
    assertPublishableFile(path)
    const fullPath = join(directory, path)
    assertNoSymlinkPath(root, path)
    let stat
    try {
      stat = lstatSync(fullPath, { bigint: true })
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        fail(`package entry '${path}' does not exist`)
      }
      throw error
    }
    if (!stat.isFile()) fail(`package entry '${path}' must be a regular file`)
    assertInsideRoot(root, fullPath)
    if (stat.size > 50n * 1024n * 1024n) fail(`package entry '${path}' exceeds the 50 MiB size limit`)
    totalSize += Number(stat.size)
    if (totalSize > 200 * 1024 * 1024) fail('package entries exceed the 200 MiB size limit')
    files.push({ path, bytes: readRegularFileNoFollow(fullPath) })
  }
  return files
}

function validateFiles(manifest, files, target, root) {
  const paths = new Set(files.map((file) => file.path))
  if (!paths.has('manifest.json')) fail('package must contain manifest.json at its root')
  // A view's declared detail target schema is an explicit manifest reference and
  // may live outside the frontend/assets/backend roots; everything else keeps
  // the original package boundary.
  const declaredTargetSchemas = new Set(
    (manifest.contributes?.views ?? [])
      .map((view) => view.targetSchema)
      .filter((path) => typeof path === 'string' && path.length > 0),
  )
  for (const path of paths) {
    if (path === 'manifest.json' || path === 'README.md') continue
    if (path.startsWith('frontend/') || path.startsWith('assets/') || path.startsWith('backend/')) continue
    if (declaredTargetSchemas.has(path)) continue
    fail(`package entry '${path}' is outside the frontend/assets/backend package boundary`)
  }
  for (const path of manifestReferencedFiles(manifest)) {
    if (!paths.has(path)) fail(`manifest references '${path}', but that file does not exist`)
  }
  const backendEntries = [...paths].filter((path) => path.startsWith('backend/'))
  const frontendEntries = [...paths].filter((path) => path.startsWith('frontend/'))
  if (manifest.backend) {
    if (backendEntries.length !== 1 || backendEntries[0] !== manifest.backend.entry) {
      fail('backend package must contain exactly its declared self-contained backend executable')
    }
    const backend = files.find((file) => file.path === manifest.backend.entry)
    const backendStat = lstatSync(join(root, manifest.backend.entry), { bigint: true })
    if (!backendStat.isFile() || (process.platform !== 'win32' && (backendStat.mode & 0o111n) === 0n)) {
      fail(`backend entry '${manifest.backend.entry}' must be marked executable`)
    }
    if (!backend || backend.bytes.subarray(0, 2).equals(Buffer.from('#!')) || !backendMatchesTarget(backend.bytes, target)) {
      fail(`backend entry '${manifest.backend.entry}' does not match declared target ${target}`)
    }
  } else if (backendEntries.length !== 0) {
    fail('frontend-only package must not contain backend entries')
  }
  if (!manifest.contributes && frontendEntries.length !== 0) {
    fail('backend-only package must not contain frontend entries')
  }
}

function validateDirectory(directory, target = 'universal') {
  const root = resolve(directory)
  if (!lstatSync(root, { bigint: true }).isDirectory()) {
    fail(`package directory '${directory}' is not a directory`)
  }
  const rootRealPath = realpathSync(root)
  const manifest = readManifest(root)
  artifactTarget(manifest, target)
  const files = collectFiles(root, parseFileList(root), rootRealPath).sort((left, right) =>
    comparePortableArchivePaths(left.path, right.path)
  )
  const issue = validatePortableArchiveEntries(
    files.map((file) => ({ path: file.path, type: 'regular' }))
  )
  if (issue) {
    if (issue.kind === 'unsafe-path') {
      fail(`package entry '${issue.path}' is not a safe package-relative path`)
    }
    if (issue.kind === 'duplicate') {
      fail(`portable archive collision: '${issue.path}' duplicates another entry`)
    }
    fail(`portable archive collision: '${issue.path}' is a regular-file ancestor`)
  }
  validateFiles(manifest, files, target, root)
  return { root, manifest, files, target }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(bytes) {
  let value = 0xffffffff
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function u16(value) {
  const buffer = Buffer.alloc(2)
  buffer.writeUInt16LE(value, 0)
  return buffer
}

function u32(value) {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value >>> 0, 0)
  return buffer
}

function makeZip(files) {
  const local = []
  const central = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.path, 'utf8')
    const checksum = crc32(file.bytes)
    const header = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0x0800),
      u16(0),
      u16(0x21),
      u16(0),
      u32(checksum),
      u32(file.bytes.length),
      u32(file.bytes.length),
      u16(name.length),
      u16(0),
      name,
      file.bytes,
    ])
    local.push(header)
    central.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(0x0314),
        u16(20),
        u16(0x0800),
        u16(0),
        u16(0x21),
        u16(0),
        u32(checksum),
        u32(file.bytes.length),
        u32(file.bytes.length),
        u16(name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32((file.executable ? 0o100755 : 0o100644) << 16),
        u32(offset),
        name,
      ])
    )
    offset += header.length
  }
  const centralBytes = Buffer.concat(central)
  const localBytes = Buffer.concat(local)
  return Buffer.concat([
    localBytes,
    centralBytes,
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralBytes.length),
    u32(localBytes.length),
    u16(0),
  ])
}

function packageDirectory(directory, output, target) {
  const result = validateDirectory(directory, target)
  const outputPath = resolve(output ?? `${result.manifest.id}-${result.manifest.version}-${result.target}.vsix`)
  mkdirSync(dirname(outputPath), { recursive: true })
  const files = result.files.map((file) => ({
    ...file,
    executable: result.manifest.backend?.entry === file.path,
  }))
  writeFileSync(outputPath, makeZip(files))
  return { outputPath, manifest: result.manifest, target: result.target }
}

function packageDigest(path) {
  return createHash('sha256').update(readRegularFileNoFollow(path)).digest('hex')
}

function readKey(path, label, requireOwnerOnly) {
  const stat = lstatSync(path, { bigint: true })
  if (!stat.isFile()) fail(`${label} must be a regular file`)
  if (requireOwnerOnly && (stat.mode & 0o077n) !== 0n) {
    fail(`${label} must have owner-only permissions`)
  }
  return readRegularFileNoFollow(path)
}

function signPackage(packagePath, privateKeyPath, output) {
  const digest = packageDigest(packagePath)
  const signature = signDigest(null, Buffer.from(digest, 'ascii'), createPrivateKey(readKey(privateKeyPath, 'private key', true))).toString('base64')
  const outputPath = resolve(output ?? `${packagePath}.sig`)
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${signature}\n`, { mode: 0o600 })
  return { outputPath, digest }
}

function verifyPackage(packagePath, publicKeyPath, signaturePath) {
  const digest = packageDigest(packagePath)
  const signature = readRegularFileNoFollow(signaturePath).toString('utf8').trim()
  if (!signature || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) fail('signature must be base64')
  if (!verifyDigest(null, Buffer.from(digest, 'ascii'), createPublicKey(readKey(publicKeyPath, 'public key', false)), Buffer.from(signature, 'base64'))) {
    fail('signature does not verify the complete archive digest')
  }
  return digest
}

function usage() {
  return [
    'Usage:',
    '  navide-plugin validate <directory> [--target <target>]',
    '  navide-plugin package <directory> [--target <target>] [--out <file>]',
    '  navide-plugin sign <package> --key <private-key> [--out <signature>]',
    '  navide-plugin verify <package> --key <public-key> --signature <signature>',
  ].join('\n')
}

function main(argv) {
  const [command, directory, ...rest] = argv
  if (!command || !directory || !['validate', 'package', 'sign', 'verify'].includes(command)) fail(usage())
  const options = new Map()
  for (let index = 0; index < rest.length; index += 2) {
    if (!rest[index]?.startsWith('--') || rest[index + 1] === undefined || options.has(rest[index])) fail(usage())
    options.set(rest[index], rest[index + 1])
  }
  if (command === 'validate') {
    if ([...options.keys()].some((key) => key !== '--target')) fail(usage())
    const result = validateDirectory(directory, options.get('--target') ?? 'universal')
    console.log(`Validated ${result.manifest.id}@${result.manifest.version} for ${result.target}`)
    return
  }
  if (command === 'package') {
    if ([...options.keys()].some((key) => key !== '--target' && key !== '--out')) fail(usage())
    const result = packageDirectory(directory, options.get('--out'), options.get('--target') ?? 'universal')
    console.log(`Packaged ${result.manifest.id}@${result.manifest.version} for ${result.target} to ${result.outputPath}`)
    return
  }
  if (command === 'sign') {
    if ([...options.keys()].some((key) => key !== '--key' && key !== '--out') || !options.get('--key')) fail(usage())
    const result = signPackage(directory, options.get('--key'), options.get('--out'))
    console.log(`Signed complete archive digest ${result.digest} to ${result.outputPath}`)
    return
  }
  if ([...options.keys()].some((key) => key !== '--key' && key !== '--signature') || !options.get('--key') || !options.get('--signature')) fail(usage())
  const digest = verifyPackage(directory, options.get('--key'), options.get('--signature'))
  console.log(`Verified complete archive digest ${digest}`)
}

try {
  main(process.argv.slice(2))
} catch (error) {
  console.error(`navide-plugin: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
