import { beforeEach, describe, expect, it, vi } from 'vitest'

const { calls, call } = vi.hoisted(() => {
  const recorded: Array<{ name: string; args: Record<string, unknown> }> = []
  return {
    calls: recorded,
    call: async (name: string, args: Record<string, unknown>) => {
      recorded.push({ name, args })
      if (name === 'plans.write_document_commit') return { ok: true, mtime: 5 }
      if (name === 'plans.read_document' && args.offset === undefined) {
        return { ok: true, content: 'ab', mtime: 1, size: 4, offset: 0, eof: false, next_offset: 2 }
      }
      if (name === 'plans.read_document') return { ok: true, content: 'cd', mtime: 1, size: 4, offset: 2, eof: true }
      return { ok: true }
    },
  }
})

vi.mock('../backend', () => ({ plansBackend: { call, subscribe: () => undefined } }))

import { plansTransport } from './transport'

describe('plansTransport large documents', () => {
  beforeEach(() => { calls.length = 0 })

  it('writes a small document with one plans.write_document call', async () => {
    await plansTransport.send('fs.write_file', { workspace_path: '/w', rel_path: 'a.html', content: 'hi', expected_mtime: 3 })
    expect(calls).toEqual([{ name: 'plans.write_document', args: { rel_path: 'a.html', content: 'hi', expected_mtime: 3 } }])
  })

  it('writes a document too big for one request in parts and commits with the mtime check', async () => {
    const content = 'x'.repeat(400_000)
    const { payload } = await plansTransport.send<{ ok: boolean; mtime: number }>('fs.write_file', {
      workspace_path: '/w', rel_path: '.agent-team/plans/a.html', content, expected_mtime: 3,
    })
    expect(payload).toEqual({ ok: true, mtime: 5 })
    expect(calls.map(({ name }) => name)).toEqual([
      ...Array(5).fill('plans.write_document_part'), 'plans.write_document_commit',
    ])
    expect(calls.at(-1)!.args).toMatchObject({ total_size: 400_000, expected_mtime: 3 })
    expect(calls.some(({ args }) => 'workspace_path' in args)).toBe(false)
  })

  it('joins a document the backend returns page by page', async () => {
    const { payload } = await plansTransport.send<{ content: string }>('fs.read_file', { workspace_path: '/w', rel_path: 'a.html' })
    expect(payload).toMatchObject({ ok: true, content: 'abcd', mtime: 1 })
  })
})
