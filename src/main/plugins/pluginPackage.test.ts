import { describe, it, expect } from 'vitest'
import { deflateRawSync } from 'node:zlib'
import { readZipEntries, readManifestFromEntries, PluginPackageError } from './pluginPackage'
import { makeZip } from './zipFixture'

const u16 = (n: number): Buffer => {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n, 0)
  return b
}
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n, 0)
  return b
}

describe('readZipEntries', () => {
  it('decodes stored entries and skips directory entries', () => {
    const zip = makeZip([
      { name: 'manifest.json', data: '{"id":"acme.demo"}' },
      { name: 'dist/', data: '' },
      { name: 'dist/main.js', data: 'console.log(1)' },
    ])
    const entries = readZipEntries(zip)
    const paths = entries.map((e) => e.path).sort()
    expect(paths).toEqual(['dist/main.js', 'manifest.json'])
    expect(entries.find((e) => e.path === 'dist/main.js')?.data.toString()).toBe('console.log(1)')
  })

  it('decodes deflate (method 8) entries', () => {
    // Hand-build a single deflated entry to exercise the inflate path.
    const payload = Buffer.from('x'.repeat(500))
    const comp = deflateRawSync(payload)
    const name = Buffer.from('big.txt')
    const u16 = (n: number) => {
      const b = Buffer.alloc(2)
      b.writeUInt16LE(n, 0)
      return b
    }
    const u32 = (n: number) => {
      const b = Buffer.alloc(4)
      b.writeUInt32LE(n, 0)
      return b
    }
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(8), u16(0), u16(0), u32(0),
      u32(comp.length), u32(payload.length), u16(name.length), u16(0), name, comp,
    ])
    const central = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(8), u16(0), u16(0), u32(0),
      u32(comp.length), u32(payload.length), u16(name.length), u16(0), u16(0), u16(0),
      u16(0), u32(0), u32(0), name,
    ])
    const eocd = Buffer.concat([
      u32(0x06054b50), u16(0), u16(0), u16(1), u16(1), u32(central.length), u32(local.length), u16(0),
    ])
    const zip = Buffer.concat([local, central, eocd])
    const entries = readZipEntries(zip)
    expect(entries[0].data.toString()).toBe(payload.toString())
  })

  it('throws on a non-zip buffer', () => {
    expect(() => readZipEntries(new Uint8Array([1, 2, 3]))).toThrow(PluginPackageError)
  })

  it('rejects a zip bomb (deflate inflating past the per-entry limit)', () => {
    // 60 MB of zeros compresses to a few KB but exceeds the 50 MB entry cap;
    // inflating it must raise a PluginPackageError, not exhaust memory.
    const payload = Buffer.alloc(60 * 1024 * 1024)
    const comp = deflateRawSync(payload)
    const name = Buffer.from('bomb.bin')
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(8), u16(0), u16(0), u32(0),
      u32(comp.length), u32(payload.length), u16(name.length), u16(0), name, comp,
    ])
    const central = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(8), u16(0), u16(0), u32(0),
      u32(comp.length), u32(payload.length), u16(name.length), u16(0), u16(0), u16(0),
      u16(0), u32(0), u32(0), name,
    ])
    const eocd = Buffer.concat([
      u32(0x06054b50), u16(0), u16(0), u16(1), u16(1), u32(central.length), u32(local.length), u16(0),
    ])
    const zip = Buffer.concat([local, central, eocd])
    expect(() => readZipEntries(zip)).toThrow(PluginPackageError)
  })

  it('throws PluginPackageError (not RangeError) on an out-of-bounds local offset', () => {
    // Central directory entry whose localOffset points past the buffer end.
    const name = Buffer.from('x.js')
    const central = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(4), u32(4), u16(name.length), u16(0), u16(0), u16(0),
      u16(0), u32(0), u32(0xffffffff), name, // localOffset = huge → out of bounds
    ])
    const eocd = Buffer.concat([
      u32(0x06054b50), u16(0), u16(0), u16(1), u16(1), u32(central.length), u32(0), u16(0),
    ])
    const zip = Buffer.concat([central, eocd])
    expect(() => readZipEntries(zip)).toThrow(PluginPackageError)
  })
})

describe('readManifestFromEntries', () => {
  it('reads and parses the root manifest.json', () => {
    const zip = makeZip([{ name: 'manifest.json', data: '{"id":"acme.demo","version":"1.0.0"}' }])
    const manifest = readManifestFromEntries(readZipEntries(zip))
    expect(manifest.id).toBe('acme.demo')
  })

  it('throws when manifest.json is absent', () => {
    const zip = makeZip([{ name: 'readme.md', data: '# hi' }])
    expect(() => readManifestFromEntries(readZipEntries(zip))).toThrow(/no manifest\.json/)
  })

  it('throws on invalid manifest JSON', () => {
    const zip = makeZip([{ name: 'manifest.json', data: '{ not json' }])
    expect(() => readManifestFromEntries(readZipEntries(zip))).toThrow(/not valid JSON/)
  })
})
