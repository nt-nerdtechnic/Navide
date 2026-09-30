import { describe, expect, it, vi } from 'vitest'
import { listAllPlans, needsChunkedWrite, readWholeDocument, SINGLE_WRITE_MAX_JSON_BYTES, writeDocumentChunked } from './planPaging'

describe('readWholeDocument', () => {
  it('returns a single-page reply untouched', async () => {
    const reply = { rel_path: 'a.html', meta: null, html: '<p>x</p>', mtime: 1 }
    const call = vi.fn().mockResolvedValue(reply)
    await expect(readWholeDocument(call, 'plans.read', 'html', { rel_path: 'a.html' })).resolves.toBe(reply)
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('joins pages and drops the paging fields', async () => {
    const pages = [
      { rel_path: 'a.html', meta: { name: 'A' }, html: 'one-', mtime: 5, size: 9, offset: 0, eof: false, next_offset: 4 },
      { rel_path: 'a.html', html: 'two-', mtime: 5, size: 9, offset: 4, eof: false, next_offset: 8 },
      { rel_path: 'a.html', html: 'z', mtime: 5, size: 9, offset: 8, eof: true },
    ]
    const call = vi.fn(async (_name: string, args: Record<string, unknown>) =>
      pages[args.offset === undefined ? 0 : args.offset === 4 ? 1 : 2])
    const whole = await readWholeDocument<Record<string, unknown>>(call, 'plans.read', 'html', { rel_path: 'a.html' })
    expect(whole).toEqual({ rel_path: 'a.html', meta: { name: 'A' }, html: 'one-two-z', mtime: 5 })
    expect(call.mock.calls.map(([, args]) => args.offset)).toEqual([undefined, 4, 8])
  })

  it('joins read_document pages under `content`', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({ ok: true, content: 'ab', mtime: 2, size: 4, offset: 0, eof: false, next_offset: 2 })
      .mockResolvedValueOnce({ ok: true, content: 'cd', mtime: 2, size: 4, offset: 2, eof: true })
    await expect(readWholeDocument(call, 'plans.read_document', 'content', { rel_path: 'a.md' }))
      .resolves.toEqual({ ok: true, content: 'abcd', mtime: 2 })
  })

  it('restarts when the file changes between pages, and gives up after three tries', async () => {
    let version = 0
    const call = vi.fn(async (_name: string, args: Record<string, unknown>) => {
      if (args.offset === undefined) {
        version++
        return { html: `v${version}-`, mtime: version, eof: false, next_offset: 3 }
      }
      return { html: 'end', mtime: version === 1 ? 99 : version, eof: true }
    })
    await expect(readWholeDocument<Record<string, unknown>>(call, 'plans.read', 'html', {}))
      .resolves.toMatchObject({ html: 'v2-end' })

    const churning = vi.fn(async (_name: string, args: Record<string, unknown>) =>
      args.offset === undefined
        ? { html: 'a', mtime: 1, eof: false, next_offset: 1 }
        : { html: 'b', mtime: 2, eof: true })
    await expect(readWholeDocument(churning, 'plans.read', 'html', {})).rejects.toThrow(/changed while it was being read/)
  })

  it('refuses a reply that makes no progress instead of looping forever', async () => {
    const call = vi.fn(async (_name: string, args: Record<string, unknown>) =>
      args.offset === undefined
        ? { html: 'a', mtime: 1, eof: false, next_offset: 5 }
        : { html: 'b', mtime: 1, eof: false, next_offset: 5 })
    await expect(readWholeDocument(call, 'plans.read', 'html', {})).rejects.toThrow(/no progress/)
  })
})

describe('listAllPlans', () => {
  const entry = (n: number) => ({ rel_path: `p${n}.html`, name: `P${n}` })

  it('follows next_offset until every plan has arrived', async () => {
    const call = vi.fn(async (_name: string, args: Record<string, unknown>) => {
      const offset = args.offset as number
      if (offset === 0) return { entries: [entry(0), entry(1)], next_offset: 2, total: 5 }
      if (offset === 2) return { entries: [entry(2), entry(3)], next_offset: 4, total: 5 }
      return { entries: [entry(4)], next_offset: null, total: 5 }
    })
    const all = await listAllPlans(call)
    expect(all.map((plan) => (plan as { name: string }).name)).toEqual(['P0', 'P1', 'P2', 'P3', 'P4'])
  })

  it('falls back to the plain list against a backend that rejects paging', async () => {
    const call = vi.fn(async (_name: string, args: Record<string, unknown>) => {
      if ('offset' in args) throw Object.assign(new Error('bad'), { code: 'INVALID_ARGUMENT' })
      return [entry(0)]
    })
    await expect(listAllPlans(call)).resolves.toEqual([entry(0)])
  })

  it('does not swallow other failures', async () => {
    const call = vi.fn().mockRejectedValue(Object.assign(new Error('down'), { code: 'BACKEND_UNAVAILABLE' }))
    await expect(listAllPlans(call)).rejects.toThrow('down')
  })
})

describe('writeDocumentChunked', () => {
  it('chunks a CJK-heavy document whose UTF-8 frame is over the limit though its code units are not', () => {
    const content = 'a'.repeat(100_000) + '計'.repeat(55_000)
    expect(JSON.stringify(content).length).toBeLessThan(160_000)
    expect(new TextEncoder().encode(JSON.stringify(content)).length).toBeGreaterThan(256 * 1024)
    expect(needsChunkedWrite(content)).toBe(true)
  })

  it('writes a document in one request up to the byte limit and in parts past it', () => {
    const atLimit = 'a'.repeat(SINGLE_WRITE_MAX_JSON_BYTES - 2)
    expect(needsChunkedWrite(atLimit)).toBe(false)
    expect(needsChunkedWrite(`${atLimit}a`)).toBe(true)
  })

  it('sends a small document as one part and a large one as ordered parts, then commits with expected_mtime', async () => {
    const content = 'é✓'.repeat(200_000) // ~1 MB of multi-byte text
    expect(needsChunkedWrite('small')).toBe(false)
    expect(needsChunkedWrite(content)).toBe(true)
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const call = vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args })
      return name === 'plans.write_document_commit' ? { ok: true, mtime: 42 } : { ok: true }
    })
    const result = await writeDocumentChunked(call, '.agent-team/plans/a.html', content, 7)

    expect(result).toEqual({ ok: true, mtime: 42 })
    const parts = calls.filter(({ name }) => name === 'plans.write_document_part')
    const commit = calls.at(-1)!
    expect(commit.name).toBe('plans.write_document_commit')
    const bytes = new TextEncoder().encode(content)
    expect(commit.args).toMatchObject({ rel_path: '.agent-team/plans/a.html', total_size: bytes.length, expected_mtime: 7 })
    expect(new Set(calls.map(({ args }) => args.upload_id)).size).toBe(1)
    expect(String(commit.args.upload_id)).toMatch(/^[0-9a-f]{32}$/)
    // Parts are in order, bounded, and reassemble to exactly the encoded document.
    let expectedOffset = 0
    const joined: Buffer[] = []
    for (const { args } of parts) {
      expect(args.offset).toBe(expectedOffset)
      const raw = Buffer.from(String(args.data_base64), 'base64')
      expect(raw.length).toBeLessThanOrEqual(96 * 1024)
      expectedOffset += raw.length
      joined.push(raw)
    }
    expect(expectedOffset).toBe(bytes.length)
    expect(Buffer.concat(joined).equals(Buffer.from(bytes))).toBe(true)
  })

  it('omits expected_mtime when none is known and aborts the upload when a part fails', async () => {
    const ok = vi.fn(async () => ({ ok: true }))
    await writeDocumentChunked(ok, 'a.html', 'x'.repeat(10))
    expect(ok.mock.calls.at(-1)![1]).not.toHaveProperty('expected_mtime')

    const names: string[] = []
    const failing = vi.fn(async (name: string) => {
      names.push(name)
      if (name === 'plans.write_document_part' && names.filter((n) => n === name).length === 2) throw new Error('boom')
      return { ok: true }
    })
    await expect(writeDocumentChunked(failing, 'a.html', 'x'.repeat(300 * 1024))).rejects.toThrow('boom')
    expect(names).toEqual([
      'plans.write_document_part', 'plans.write_document_part', 'plans.write_document_abort',
    ])
  })
})
