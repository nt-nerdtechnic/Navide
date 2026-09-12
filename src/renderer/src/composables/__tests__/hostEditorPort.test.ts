// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { createHostEditorPort } from '../hostEditorPort'
import { createPreflightEditorPort } from '@navide/plugin-ui/editor'
import { diagnosticsKey, diagnosticsStore, setDiagnostics } from '../../editor/diagnostics'
vi.mock('../../../../../packages/plugin-ui/src/editor/view/EditorViewMonaco.vue', () => ({ default: {} }))

describe('editor composition ports', () => {
  it('preserves file coordinates, AI requests, connection state and subscription cleanup', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, payload: { ok: true, content: 'text' } })
    const dispose = vi.fn()
    let changed: (payload: unknown) => void = () => {}
    const status = ref<'connected' | 'disconnected'>('connected')
    const backend = {
      status, lastError: ref(''), send,
      on: vi.fn((_event, listener) => { changed = listener; return dispose }), restart: vi.fn(),
    }
    const port = createHostEditorPort(backend as never)
    await port.readFile({ workspacePath: '/external', relPath: 'a.txt', encoding: 'big5' })
    expect(send).toHaveBeenLastCalledWith('fs.read_file', {
      workspace_path: '/external', rel_path: 'a.txt', encoding_override: 'big5',
    })
    const rewrite = { code: 'x', instruction: 'change', language: 'text', model: 'local' }
    await port.rewrite(rewrite)
    expect(send).toHaveBeenLastCalledWith('editor.rewrite', rewrite)
    const complete = { prefix: 'x', suffix: '', language: 'text', model: 'local' }
    await port.complete(complete)
    expect(send).toHaveBeenLastCalledWith('editor.complete', complete)
    status.value = 'disconnected'
    expect(port.status.value).toBe('disconnected')
    const listener = vi.fn()
    const unsubscribe = port.onFilesChanged(listener)
    changed({ workspace_path: '/external' })
    changed({ workspace_path: 42 })
    changed(null)
    expect(listener).toHaveBeenCalledExactlyOnceWith('/external')
    unsubscribe()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('leaves diagnostics in the Host store and looks them up by file workspace', () => {
    const port = createHostEditorPort({ status: ref('connected'), lastError: ref('') } as never)
    const diagnostic = { wsPath: '/external', relPath: 'a.txt', line: 1, col: 0, severity: 'error' as const, message: 'Invalid' }
    try {
      setDiagnostics(diagnosticsKey('/external', 'a.txt'), [diagnostic])
      expect(port.diagnostics({ workspacePath: '/external', relPath: 'a.txt' })).toEqual([diagnostic])
      expect(port.diagnostics({ workspacePath: '/workspace', relPath: 'a.txt' })).toEqual([])
    } finally { diagnosticsStore.value = new Map() }
  })
  it('preserves encoding and optimistic save conflicts through the Host adapter', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, payload: { ok: false, conflict: true, mtime: 42 } })
    const port = createHostEditorPort({
      status: ref('connected'), lastError: ref(''), send,
      on: vi.fn(() => () => {}), restart: vi.fn(),
    } as never)
    expect(await port.writeFile({
      workspacePath: '/workspace', relPath: 'a.txt', content: 'edited',
      encoding: 'cp1252', expectedMtime: 41,
    })).toEqual({ ok: false, conflict: true, mtime: 42 })
    expect(send).toHaveBeenCalledWith('fs.write_file', {
      workspace_path: '/workspace', rel_path: 'a.txt', content: 'edited',
      encoding: 'cp1252', expected_mtime: 41,
    })
  })

  it('keeps failed transport envelopes from becoming successful editor reads', async () => {
    const port = createHostEditorPort({
      status: ref('connected'), lastError: ref(''),
      send: vi.fn().mockResolvedValue({ ok: false, error: { message: 'Denied' } }),
      on: vi.fn(() => () => {}), restart: vi.fn(),
    } as never)
    expect(await port.readFile({ workspacePath: '/workspace', relPath: 'a.txt' }))
      .toEqual({ ok: false, error: 'Denied' })
  })

  it('restricts preflight without constructing or invoking a production transport', async () => {
    const port = createPreflightEditorPort()
    expect(port.status.value).toBe('connected')
    expect(await port.readFile({ workspacePath: '/workspace', relPath: 'a.txt' }))
      .toMatchObject({ ok: false, error: expect.stringContaining('preflight') })
    expect(await port.writeFile({ workspacePath: '/workspace', relPath: 'a.txt', content: 'x' }))
      .toMatchObject({ ok: false })
    expect(await port.rewrite({ code: 'x', instruction: 'change', language: 'text', model: 'local' }))
      .toMatchObject({ ok: false })
    expect(await port.complete({ prefix: 'x', suffix: '', language: 'text', model: 'local' }))
      .toMatchObject({ ok: false })
    expect(await port.readImage({ workspacePath: '/workspace', relPath: 'a.png' })).toBe('')
    expect(port.onFilesChanged(vi.fn())).toBeTypeOf('function')
    await port.restart()
  })
})
