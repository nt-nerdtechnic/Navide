// Minimal, dependency-free reader for the `.vsix`-style plugin package (a ZIP
// archive with a root `manifest.json` + assets — see marketplace FORMAT.md).
// PURE logic: only `node:zlib` (a runtime builtin) is imported, so it is
// unit-testable and electron-free. Supports the two compression methods a
// packer emits — stored (0) and deflate (8) — which is all `registry/package.py`
// produces.
//
// The reader is intentionally small: it walks the End-Of-Central-Directory
// record → central directory → each local file header, and hands back decoded
// entries. Zip-slip defence is NOT applied here (paths are returned verbatim);
// the caller runs `assertSafeEntryPath` from `pluginVerify` before writing, so
// path policy lives in one place.

import { inflateRawSync } from 'node:zlib'

export interface ZipEntry {
  /** Archive-relative path exactly as stored (unvalidated). */
  path: string
  /** Decompressed file bytes. */
  data: Buffer
}

export class PluginPackageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PluginPackageError'
  }
}

const SIG_EOCD = 0x06054b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50

/** Locate the End-Of-Central-Directory record by scanning back from the end
 *  (the trailing 22-byte record may be followed by a variable comment). */
function findEocd(buf: Buffer): number {
  const min = 22
  if (buf.length < min) throw new PluginPackageError('not a zip archive (too short)')
  const start = Math.max(0, buf.length - min - 0xffff)
  for (let i = buf.length - min; i >= start; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i
  }
  throw new PluginPackageError('not a zip archive (no end-of-central-directory record)')
}

/** Decode every entry in a ZIP buffer. Throws {@link PluginPackageError} on a
 *  malformed archive or an unsupported compression method. */
export function readZipEntries(bytes: Uint8Array): ZipEntry[] {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocd = findEocd(buf)
  const entryCount = buf.readUInt16LE(eocd + 10)
  let ptr = buf.readUInt32LE(eocd + 16) // central directory offset

  const entries: ZipEntry[] = []
  for (let i = 0; i < entryCount; i++) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== SIG_CENTRAL) {
      throw new PluginPackageError('corrupt central directory')
    }
    const method = buf.readUInt16LE(ptr + 10)
    const compSize = buf.readUInt32LE(ptr + 20)
    const nameLen = buf.readUInt16LE(ptr + 28)
    const extraLen = buf.readUInt16LE(ptr + 30)
    const commentLen = buf.readUInt16LE(ptr + 32)
    const localOffset = buf.readUInt32LE(ptr + 42)
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen)
    ptr += 46 + nameLen + extraLen + commentLen

    if (name.endsWith('/')) continue // directory entry — no data

    if (buf.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new PluginPackageError(`corrupt local header for ${name}`)
    }
    const lNameLen = buf.readUInt16LE(localOffset + 26)
    const lExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + lNameLen + lExtraLen
    const raw = buf.subarray(dataStart, dataStart + compSize)

    let data: Buffer
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) data = inflateRawSync(raw)
    else throw new PluginPackageError(`unsupported compression method ${method} for ${name}`)

    entries.push({ path: name, data })
  }
  return entries
}

/** Read and JSON-parse the root `manifest.json` from a package's entries.
 *  Throws {@link PluginPackageError} if absent or not valid JSON. */
export function readManifestFromEntries(entries: ZipEntry[]): Record<string, unknown> {
  const entry = entries.find((e) => e.path === 'manifest.json')
  if (!entry) throw new PluginPackageError('package has no manifest.json at its root')
  try {
    const parsed = JSON.parse(entry.data.toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new PluginPackageError('manifest.json is not a JSON object')
    }
    return parsed as Record<string, unknown>
  } catch (err) {
    if (err instanceof PluginPackageError) throw err
    throw new PluginPackageError(`manifest.json is not valid JSON: ${(err as Error).message}`)
  }
}
