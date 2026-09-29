import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  createHostPlansFilesystemPort,
  createInMemoryPlansCorePorts,
  createInMemoryPlansBridgeDispatcher,
  createTestPlansFilesystemPort,
  createProductionPlansCorePorts,
  createProductionPlansBridgeDispatcher,
  type BackendBridgeDispatcher,
  type PlansBridgeContext,
  type PlansBridgeRequest,
  type PlansFilesystemService,
} from './plansBridge'
import type { BackendRuntimeContext, JsonValue } from './pluginBackendSupervisor'
import {
  MAX_BACKEND_BRIDGE_RESULT_BYTES,
  MAX_BACKEND_BRIDGE_CHUNK_BYTES,
  MAX_BACKEND_BRIDGE_RANGE_BYTES,
} from './pluginBackendLimits'

const runtime = {
  pluginId: 'navide.plans',
  packageVersion: '0.1.93',
  workspaceId: 'workspace-1',
  instanceId: 'view-1',
  contributionKey: 'navide.plans.window',
  hostWindowId: 'window-1',
  initiator: { kind: 'user', id: 'user-1' },
} as const

function context(
  signal: AbortSignal,
  events: Array<{ event: string; payload: unknown }> = [],
  workspacePath?: string,
  runtimeValue: BackendRuntimeContext = runtime,
  authorizedPlanRoot = workspacePath,
): PlansBridgeContext {
  return {
    runtime: runtimeValue,
    ...(workspacePath === undefined ? {} : { workspacePath }),
    ...(authorizedPlanRoot === undefined ? {} : { authorizedPlanRoot }),
    requestId: 'bridge:test',
    signal,
    emit: (event, payload) => events.push({ event, payload }),
  }
}

function request(
  port: PlansBridgeRequest['port'],
  operation: string,
  arguments_: PlansBridgeRequest['arguments'],
): PlansBridgeRequest {
  return {
    id: 'bridge:test',
    origin: { kind: 'call', requestId: 'call-1' },
    port,
    operation,
    arguments: arguments_,
  }
}

async function runCoreCorpus(create: () => ReturnType<typeof createInMemoryPlansBridgeDispatcher>) {
  const dispatcher = create()
  const controller = new AbortController()
  const workspace = resolve('/workspace')
  const bridgeContext = context(controller.signal, [], workspace)

  await expect(dispatcher.dispatch(
    request('filesystem', 'resolve_root', {}),
    bridgeContext,
  )).resolves.toEqual({ root: workspace })

  await expect(dispatcher.dispatch(
    request('filesystem', 'rename', {
      from: 'old-plan.md',
      to: 'new-plan.md',
    }),
    bridgeContext,
  )).resolves.toEqual({ ok: true })

  await expect(dispatcher.dispatch(
    request('workspace-storage', 'set', { scope: 'workspace', key: 'draft', value: { version: 1 } }),
    bridgeContext,
  )).resolves.toBeNull()
  await expect(dispatcher.dispatch(
    request('workspace-storage', 'get', { scope: 'workspace', key: 'draft' }),
    bridgeContext,
  )).resolves.toEqual({ found: true, value: { version: 1 } })

  await expect(dispatcher.dispatch(
    request('streams', 'open', null),
    bridgeContext,
  )).resolves.toMatchObject({ credit_bytes: expect.any(Number) })
  await expect(dispatcher.dispatch(
    request('spawn', 'transform', { command: 'python', args: ['-c', 'pass'] }),
    bridgeContext,
  )).resolves.toEqual({ command: 'python', args: ['-c', 'pass'] })
  await expect(dispatcher.dispatch(
    request('filesystem', 'unknown', null),
    bridgeContext,
  )).rejects.toMatchObject({ code: 'METHOD_NOT_FOUND' })

  const watcher = dispatcher.dispatch(
    request('filesystem', 'watch', { rel_path: '' }),
    bridgeContext,
  )
  controller.abort()
  await expect(watcher).resolves.toBeNull()
}

function createProductionCorpusDispatcher(): BackendBridgeDispatcher {
  const injectedCore = createInMemoryPlansCorePorts({ root: process.cwd() })
  return createProductionPlansBridgeDispatcher({
    filesystem: createTestPlansFilesystemPort(),
    workspaceStorage: injectedCore.workspaceStorage,
    terminal: injectedCore.terminal,
    agentMessaging: injectedCore.agentMessaging,
    routes: injectedCore.routes,
    streams: injectedCore.streams,
    spawn: injectedCore.spawn,
  })
}

function createLocalFilesystemDispatcher(): BackendBridgeDispatcher {
  return createProductionPlansBridgeDispatcher({
    filesystem: createTestPlansFilesystemPort(),
  })
}

async function runAdapterCorpus(
  create: () => BackendBridgeDispatcher,
): Promise<void> {
  const dispatcher = create()
  const workspacePath = process.cwd()
  const controller = new AbortController()
  const bridgeContext = context(controller.signal, [], workspacePath)

  await expect(dispatcher.dispatch(
    request('filesystem', 'resolve_root', {}),
    bridgeContext,
  )).resolves.toEqual({ root: workspacePath })

  await expect(dispatcher.dispatch(
    request('filesystem', 'delete', { rel_path: '' }),
    bridgeContext,
  )).rejects.toMatchObject({ code: 'WORKSPACE_SCOPE_VIOLATION' })
  await expect(dispatcher.dispatch(
    request('filesystem', 'write_file', { rel_path: '', content: 'root' }),
    bridgeContext,
  )).rejects.toMatchObject({ code: 'WORKSPACE_SCOPE_VIOLATION' })
  await expect(dispatcher.dispatch(
    request('filesystem', 'list_dir', { rel_path: '', workspace_path: workspacePath }),
    bridgeContext,
  )).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })

  await expect(dispatcher.dispatch(
    request('workspace-storage', 'set', { scope: 'workspace', key: 'filters', value: { open: true } }),
    bridgeContext,
  )).resolves.toBeNull()
  await expect(dispatcher.dispatch(
    request('workspace-storage', 'get', { scope: 'workspace', key: 'filters' }),
    bridgeContext,
  )).resolves.toEqual({ found: true, value: { open: true } })

  const opened = await dispatcher.dispatch(request('streams', 'open', null), bridgeContext)
  if (
    opened === null ||
    typeof opened !== 'object' ||
    Array.isArray(opened) ||
    typeof opened.stream_id !== 'string'
  ) throw new Error('Stream adapter returned an invalid stream id.')
  const streamId = opened.stream_id
  const fullChunk = Buffer.alloc(MAX_BACKEND_BRIDGE_CHUNK_BYTES).toString('base64')
  for (let index = 0; index < 4; index += 1) {
    await expect(dispatcher.dispatch(
      request('streams', 'write', { stream_id: streamId, chunk_base64: fullChunk }),
      bridgeContext,
    )).resolves.toEqual({
      accepted_bytes: MAX_BACKEND_BRIDGE_CHUNK_BYTES,
      credit_bytes: (3 - index) * MAX_BACKEND_BRIDGE_CHUNK_BYTES,
    })
  }
  await expect(dispatcher.dispatch(
    request('streams', 'write', { stream_id: streamId, chunk_base64: 'eA==' }),
    bridgeContext,
  )).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
  await expect(dispatcher.dispatch(
    request('streams', 'write', {
      stream_id: streamId,
      chunk_base64: Buffer.alloc(MAX_BACKEND_BRIDGE_CHUNK_BYTES + 1).toString('base64'),
    }),
    bridgeContext,
  )).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
  await expect(dispatcher.dispatch(
    request('streams', 'end', { stream_id: streamId }),
    bridgeContext,
  )).resolves.toEqual({ ok: true })

  await expect(dispatcher.dispatch(
    request('filesystem', 'read_file', { rel_path: '../other-workspace' }),
    bridgeContext,
  )).rejects.toMatchObject({ code: 'WORKSPACE_SCOPE_VIOLATION' })

  const watcher = dispatcher.dispatch(
    request('filesystem', 'watch', { rel_path: '' }),
    bridgeContext,
  )
  controller.abort()
  await expect(watcher).resolves.toBeNull()
}

describe('Plans Host Bridge ports', () => {
  it('keeps the in-memory adapter behind the explicit port contract', async () => {
    await runCoreCorpus(() => createInMemoryPlansBridgeDispatcher())
  })

  it('does not start an adapter operation after its context is cancelled', async () => {
    const dispatcher = createInMemoryPlansBridgeDispatcher()
    const controller = new AbortController()
    controller.abort()

    await expect(dispatcher.dispatch(
      request('terminal', 'create', null),
      context(controller.signal, [], '/workspace'),
    )).rejects.toMatchObject({ code: 'USER_CANCELLED' })
  })

  it('keeps in-memory terminal and stream resources bound to their runtime', async () => {
    const dispatcher = createInMemoryPlansBridgeDispatcher()
    const ownerController = new AbortController()
    const ownerContext = context(ownerController.signal)
    const otherContext = context(
      new AbortController().signal,
      [],
      undefined,
      { ...runtime, instanceId: 'view-2' },
    )
    const session = await dispatcher.dispatch(
      request('terminal', 'create', null),
      ownerContext,
    )
    const sessionId = (session as { terminal_session_id: string }).terminal_session_id
    await expect(dispatcher.dispatch(
      request('terminal', 'kill', { terminal_session_id: sessionId }),
      otherContext,
    )).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })

    const stream = await dispatcher.dispatch(request('streams', 'open', null), ownerContext)
    const streamId = (stream as { stream_id: string }).stream_id
    await expect(dispatcher.dispatch(
      request('streams', 'end', { stream_id: streamId }),
      otherContext,
    )).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
  })

  it('renames the requested source path in the in-memory filesystem adapter', async () => {
    const workspace = resolve('/workspace')
    const dispatcher = createInMemoryPlansBridgeDispatcher({
      root: workspace,
      files: { [join(workspace, 'old-plan.md')]: 'draft' },
    })
    const controller = new AbortController()
    const bridgeContext = context(controller.signal, [], workspace)

    await expect(dispatcher.dispatch(
      request('filesystem', 'rename', {
        from: 'old-plan.md',
        to: 'new-plan.md',
      }),
      bridgeContext,
    )).resolves.toEqual({ ok: true })
    await expect(dispatcher.dispatch(
      request('filesystem', 'read_file', { rel_path: 'new-plan.md' }),
      bridgeContext,
    )).resolves.toEqual({ content: 'draft' })
    await expect(dispatcher.dispatch(
      request('filesystem', 'read_file', { rel_path: 'old-plan.md' }),
      bridgeContext,
    )).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' })
  })

  it('forwards watcher events for plan documents only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plans-bridge-watch-'))
    const canonicalRoot = realpathSync(root)
    mkdirSync(join(root, '.agent-team/plans'), { recursive: true })
    const dispatcher = createLocalFilesystemDispatcher()
    const controller = new AbortController()
    const events: Array<{ event: string; payload: unknown }> = []
    const bridgeContext = context(controller.signal, events, canonicalRoot, runtime, canonicalRoot)
    const settle = (): Promise<void> => new Promise((resolvePromise) => setTimeout(resolvePromise, 300))
    // FSEvents can replay the directory creation above into a watch that
    // starts right after it; let it drain before the watch begins.
    await settle()
    const watcher = dispatcher.dispatch(request('filesystem', 'watch', { rel_path: '' }), bridgeContext)
    try {
      await settle()
      // The storm that took the child down: backend state files and logs next
      // to the plans directory, plus ordinary source edits.
      writeFileSync(join(root, '.agent-team/navide.db'), 'db', 'utf8')
      writeFileSync(join(root, '.agent-team/pipeline.log'), 'log', 'utf8')
      writeFileSync(join(root, 'notes.txt'), 'text', 'utf8')
      await settle()
      expect(events).toEqual([])

      writeFileSync(join(root, '.agent-team/plans/doc.html'), '<html></html>', 'utf8')
      await settle()
      expect(events.length).toBeGreaterThan(0)
      for (const { event, payload } of events) {
        expect(event).toBe('filesystem.changed')
        expect(payload).toMatchObject({ workspace_path: canonicalRoot, path: '.agent-team/plans/doc.html' })
        // Vacuous on POSIX and the whole point on Windows, where fs.watch
        // reports the host separator: this wire is posix, and the child
        // rejects a workspace-relative path containing a backslash.
        expect(String((payload as { path: string }).path)).not.toContain('\\')
      }

      // Moving a whole plan directory away sends one event naming the
      // directory and none for the documents inside it.
      events.length = 0
      renameSync(join(root, '.agent-team/plans'), join(root, '.agent-team/stash'))
      await settle()
      expect(events.map(({ payload }) => (payload as { path?: string }).path)).toContain('.agent-team/plans')
    } finally {
      controller.abort()
      await expect(watcher).resolves.toBeNull()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not overwrite an existing production rename destination', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plans-bridge-rename-'))
    const dispatcher = createLocalFilesystemDispatcher()
    const controller = new AbortController()
    const bridgeContext = context(controller.signal, [], root, runtime, realpathSync(root))
    writeFileSync(join(root, 'source.html'), 'source', 'utf8')
    writeFileSync(join(root, 'destination.html'), 'destination', 'utf8')
    try {
      await expect(dispatcher.dispatch(
        request('filesystem', 'rename', {
          from: 'source.html',
          to: 'destination.html',
        }),
        bridgeContext,
      )).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
      expect(readFileSync(join(root, 'source.html'), 'utf8')).toBe('source')
      expect(readFileSync(join(root, 'destination.html'), 'utf8')).toBe('destination')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('protects Git metadata and symlink escapes on production mutations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plans-bridge-root-'))
    const outside = mkdtempSync(join(tmpdir(), 'navide-plans-bridge-outside-'))
    const dispatcher = createLocalFilesystemDispatcher()
    const controller = new AbortController()
    const bridgeContext = context(controller.signal, [], root, runtime, realpathSync(root))
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true })
    writeFileSync(join(root, '.git', 'config'), 'safe', 'utf8')
    symlinkSync(outside, join(root, 'linked'))
    symlinkSync(join(root, 'missing-target'), join(root, 'dangling'))
    symlinkSync(root, join(root, 'root-link'))
    try {
      await expect(dispatcher.dispatch(
        request('filesystem', 'write_file', { rel_path: '.git/hooks/pre-commit', content: 'bad' }),
        bridgeContext,
      )).rejects.toMatchObject({ code: 'WORKSPACE_SCOPE_VIOLATION' })
      await expect(dispatcher.dispatch(
        request('filesystem', 'delete', { rel_path: '.git/config' }),
        bridgeContext,
      )).rejects.toMatchObject({ code: 'WORKSPACE_SCOPE_VIOLATION' })
      await expect(dispatcher.dispatch(
        request('filesystem', 'rename', { from: 'notes.md', to: '.git/notes.md' }),
        bridgeContext,
      )).rejects.toMatchObject({ code: 'WORKSPACE_SCOPE_VIOLATION' })
      await expect(dispatcher.dispatch(
        request('filesystem', 'write_file', { rel_path: 'linked/new.txt', content: 'escape' }),
        bridgeContext,
      )).rejects.toMatchObject({ code: 'WORKSPACE_SCOPE_VIOLATION' })
      await expect(dispatcher.dispatch(
        request('filesystem', 'write_file', { rel_path: 'dangling/new.txt', content: 'escape' }),
        bridgeContext,
      )).rejects.toMatchObject({ code: 'WORKSPACE_SCOPE_VIOLATION' })
      await expect(dispatcher.dispatch(
        request('filesystem', 'delete', { rel_path: 'root-link' }),
        bridgeContext,
      )).rejects.toMatchObject({ code: 'WORKSPACE_SCOPE_VIOLATION' })
      await expect(dispatcher.dispatch(
        request('filesystem', 'rename', { from: 'root-link', to: 'notes.md' }),
        bridgeContext,
      )).rejects.toMatchObject({ code: 'WORKSPACE_SCOPE_VIOLATION' })
      expect(readFileSync(join(root, '.git', 'config'), 'utf8')).toBe('safe')
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('rejects a filesystem read before it can exceed the bridge result bound', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plans-bridge-large-'))
    const dispatcher = createLocalFilesystemDispatcher()
    const controller = new AbortController()
    const bridgeContext = context(controller.signal, [], root, runtime, realpathSync(root))
    writeFileSync(
      join(root, 'large.md'),
      Buffer.alloc(MAX_BACKEND_BRIDGE_RESULT_BYTES + 1, 0x61),
    )
    try {
      await expect(dispatcher.dispatch(
        request('filesystem', 'read_file', { rel_path: 'large.md' }),
        bridgeContext,
      )).rejects.toMatchObject({ code: 'RESULT_TOO_LARGE' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reads a file larger than 5 MB in full by paging ranges that each fit the bridge result bound', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plans-bridge-range-'))
    const dispatcher = createLocalFilesystemDispatcher()
    const controller = new AbortController()
    const bridgeContext = context(controller.signal, [], root, runtime, realpathSync(root))
    const payload = Buffer.alloc(6 * 1024 * 1024 + 123)
    for (let index = 0; index < payload.length; index++) payload[index] = (index * 31 + 7) & 0xff
    writeFileSync(join(root, 'huge.html'), payload)
    try {
      // A whole-file read refuses it (the shared result bound is unchanged) ...
      await expect(dispatcher.dispatch(
        request('filesystem', 'read_file', { rel_path: 'huge.html' }),
        bridgeContext,
      )).rejects.toMatchObject({ code: 'RESULT_TOO_LARGE' })
      // ... and ranged reads assemble it, each result inside that bound.
      const parts: Buffer[] = []
      let offset = 0
      for (;;) {
        const page = await dispatcher.dispatch(
          request('filesystem', 'read_range', {
            rel_path: 'huge.html', offset, length: MAX_BACKEND_BRIDGE_RANGE_BYTES,
          }),
          bridgeContext,
        ) as { data_base64: string; size: number; mtime: number; eof: boolean }
        expect(JSON.stringify(page).length).toBeLessThan(MAX_BACKEND_BRIDGE_RESULT_BYTES)
        expect(page.size).toBe(payload.length)
        const bytes = Buffer.from(page.data_base64, 'base64')
        parts.push(bytes)
        offset += bytes.length
        if (page.eof) break
      }
      const assembled = Buffer.concat(parts)
      expect(assembled.length).toBe(payload.length)
      expect(createHash('sha256').update(assembled).digest('hex'))
        .toBe(createHash('sha256').update(payload).digest('hex'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects malformed, oversized and escaping range reads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plans-bridge-range-bad-'))
    const dispatcher = createLocalFilesystemDispatcher()
    const controller = new AbortController()
    const bridgeContext = context(controller.signal, [], root, runtime, realpathSync(root))
    writeFileSync(join(root, 'a.md'), 'hello')
    try {
      const bad: Array<Record<string, JsonValue>> = [
        { rel_path: 'a.md', offset: -1, length: 1 },
        { rel_path: 'a.md', offset: 0, length: 0 },
        { rel_path: 'a.md', offset: 0, length: MAX_BACKEND_BRIDGE_RANGE_BYTES + 1 },
        { rel_path: 'a.md', offset: 1.5, length: 1 },
        { rel_path: 'a.md', offset: 0 },
        { rel_path: 'a.md', offset: 0, length: 1, extra: true },
      ]
      for (const args of bad) {
        await expect(dispatcher.dispatch(request('filesystem', 'read_range', args), bridgeContext))
          .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
      }
      await expect(dispatcher.dispatch(
        request('filesystem', 'read_range', { rel_path: '../outside', offset: 0, length: 1 }),
        bridgeContext,
      )).rejects.toMatchObject({ code: 'WORKSPACE_SCOPE_VIOLATION' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('delegates production range reads to the Host filesystem service', async () => {
    const root = realpathSync(process.cwd())
    const calls: Array<{ operation: string; payload: Record<string, unknown> }> = []
    const service: PlansFilesystemService = {
      async call(operation, payload): Promise<JsonValue> {
        calls.push({ operation, payload })
        return { ok: true, data_base64: 'aGk=', size: 2, mtime: 5, eof: true, offset: 0 }
      },
    }
    const port = createHostPlansFilesystemPort(service)
    const bridgeContext = context(new AbortController().signal, [], '/workspace', runtime, root)

    await expect(port.readRange({ rel_path: 'plan.html', offset: 0, length: 1024 }, bridgeContext))
      .resolves.toEqual({ data_base64: 'aGk=', size: 2, mtime: 5, eof: true })
    expect(calls).toEqual([
      {
        operation: 'fs.read_range',
        payload: { rel_path: 'plan.html', offset: 0, length: 1024, workspace_path: root },
      },
    ])
    await expect(port.readRange({ rel_path: 'plan.html', offset: 0, length: MAX_BACKEND_BRIDGE_RANGE_BYTES + 1 }, bridgeContext))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('writes a multi-megabyte file in parts and swaps it in atomically with the mtime conflict check', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plans-bridge-chunked-'))
    const dispatcher = createLocalFilesystemDispatcher()
    const controller = new AbortController()
    const bridgeContext = context(controller.signal, [], root, runtime, realpathSync(root))
    const uploadId = 'a'.repeat(32)
    const payload = Buffer.alloc(3 * 1024 * 1024 + 17)
    for (let index = 0; index < payload.length; index++) payload[index] = (index * 13 + 5) & 0xff
    writeFileSync(join(root, 'plan.html'), 'old')
    try {
      let offset = 0
      while (offset < payload.length) {
        const part = payload.subarray(offset, offset + MAX_BACKEND_BRIDGE_RANGE_BYTES)
        await expect(dispatcher.dispatch(
          request('filesystem', 'write_part', {
            rel_path: 'plan.html', upload_id: uploadId, offset, data_base64: part.toString('base64'),
          }),
          bridgeContext,
        )).resolves.toEqual({ ok: true, size: offset + part.length })
        offset += part.length
      }
      expect(readFileSync(join(root, 'plan.html'), 'utf8')).toBe('old') // not visible before commit

      // A stale expected_mtime is refused and the staged bytes are discarded.
      await expect(dispatcher.dispatch(
        request('filesystem', 'write_commit', {
          rel_path: 'plan.html', upload_id: uploadId, total_size: payload.length, expected_mtime: 1,
        }),
        bridgeContext,
      )).resolves.toMatchObject({ ok: false, conflict: true })
      expect(readFileSync(join(root, 'plan.html'), 'utf8')).toBe('old')
      expect(readdirSync(root)).toEqual(['plan.html'])

      // Stage again and commit with the real mtime.
      offset = 0
      while (offset < payload.length) {
        const part = payload.subarray(offset, offset + MAX_BACKEND_BRIDGE_RANGE_BYTES)
        await dispatcher.dispatch(
          request('filesystem', 'write_part', {
            rel_path: 'plan.html', upload_id: uploadId, offset, data_base64: part.toString('base64'),
          }),
          bridgeContext,
        )
        offset += part.length
      }
      const mtime = statSync(join(root, 'plan.html')).mtimeMs
      await expect(dispatcher.dispatch(
        request('filesystem', 'write_commit', {
          rel_path: 'plan.html', upload_id: uploadId, total_size: payload.length, expected_mtime: mtime,
        }),
        bridgeContext,
      )).resolves.toMatchObject({ ok: true, mtime: expect.any(Number) })
      const written = readFileSync(join(root, 'plan.html'))
      expect(createHash('sha256').update(written).digest('hex'))
        .toBe(createHash('sha256').update(payload).digest('hex'))
      expect(readdirSync(root)).toEqual(['plan.html'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects malformed, out-of-order and protected chunked writes, and aborts idempotently', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plans-bridge-chunked-bad-'))
    const dispatcher = createLocalFilesystemDispatcher()
    const controller = new AbortController()
    const bridgeContext = context(controller.signal, [], root, runtime, realpathSync(root))
    const id = 'b'.repeat(32)
    const data = Buffer.from('abc').toString('base64')
    try {
      const bad: Array<[string, Record<string, JsonValue>]> = [
        ['write_part', { rel_path: 'a.md', upload_id: 'short', offset: 0, data_base64: data }],
        ['write_part', { rel_path: 'a.md', upload_id: id, offset: -1, data_base64: data }],
        ['write_part', { rel_path: 'a.md', upload_id: id, offset: 0 }],
        ['write_part', { rel_path: 'a.md', upload_id: id, offset: 0, data_base64: 'A'.repeat(140_000) }],
        ['write_part', { rel_path: 'a.md', upload_id: id, offset: 0, data_base64: data, extra: 1 }],
        ['write_commit', { rel_path: 'a.md', upload_id: id }],
        ['write_commit', { rel_path: 'a.md', upload_id: id, total_size: 1, expected_mtime: 'x' }],
        ['write_abort', { rel_path: 'a.md' }],
      ]
      for (const [operation, args] of bad) {
        await expect(dispatcher.dispatch(request('filesystem', operation, args), bridgeContext))
          .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
      }
      await expect(dispatcher.dispatch(
        request('filesystem', 'write_part', { rel_path: '.git/config', upload_id: id, offset: 0, data_base64: data }),
        bridgeContext,
      )).rejects.toMatchObject({ code: 'WORKSPACE_SCOPE_VIOLATION' })
      await expect(dispatcher.dispatch(
        request('filesystem', 'write_part', { rel_path: 'a.md', upload_id: id, offset: 3, data_base64: data }),
        bridgeContext,
      )).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' })
      await dispatcher.dispatch(
        request('filesystem', 'write_part', { rel_path: 'a.md', upload_id: id, offset: 0, data_base64: data }),
        bridgeContext,
      )
      await expect(dispatcher.dispatch(
        request('filesystem', 'write_commit', { rel_path: 'a.md', upload_id: id, total_size: 99 }),
        bridgeContext,
      )).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' })
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(dispatcher.dispatch(
          request('filesystem', 'write_abort', { rel_path: 'a.md', upload_id: id }),
          bridgeContext,
        )).resolves.toEqual({ ok: true })
      }
      expect(readdirSync(root)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('delegates production chunked writes to the Host filesystem service', async () => {
    const root = realpathSync(process.cwd())
    const calls: Array<{ operation: string; payload: Record<string, unknown> }> = []
    const service: PlansFilesystemService = {
      async call(operation, payload): Promise<JsonValue> {
        calls.push({ operation, payload })
        if (operation === 'fs.write_commit') return { ok: false, conflict: true, mtime: 9 }
        return { ok: true, size: 3 }
      },
    }
    const port = createHostPlansFilesystemPort(service)
    const bridgeContext = context(new AbortController().signal, [], '/workspace', runtime, root)
    const id = 'c'.repeat(32)

    await expect(port.writePart({ rel_path: 'p.html', upload_id: id, offset: 0, data_base64: 'YWJj' }, bridgeContext))
      .resolves.toEqual({ ok: true, size: 3 })
    await expect(port.writeCommit({ rel_path: 'p.html', upload_id: id, total_size: 3, expected_mtime: 4 }, bridgeContext))
      .resolves.toEqual({ ok: false, conflict: true, mtime: 9 })
    await expect(port.writeAbort({ rel_path: 'p.html', upload_id: id }, bridgeContext)).resolves.toEqual({ ok: true })
    expect(calls).toEqual([
      { operation: 'fs.write_part', payload: { rel_path: 'p.html', upload_id: id, offset: 0, data_base64: 'YWJj', workspace_path: root } },
      { operation: 'fs.write_commit', payload: { rel_path: 'p.html', upload_id: id, total_size: 3, expected_mtime: 4, workspace_path: root } },
      { operation: 'fs.write_abort', payload: { rel_path: 'p.html', upload_id: id, workspace_path: root } },
    ])
  })

  it.each([
    ['production composition', createProductionCorpusDispatcher],
    ['in-memory composition', () => createInMemoryPlansBridgeDispatcher({ root: process.cwd() })],
  ] as const)('passes the shared authorization, cancellation, stream, and backpressure corpus in the %s', async (_label, create) => {
    await runAdapterCorpus(create)
  })

  it('uses the same production dispatcher seam for the real filesystem root', async () => {
    const dispatcher = createLocalFilesystemDispatcher()
    const controller = new AbortController()
    await expect(dispatcher.dispatch(
      request('filesystem', 'resolve_root', {}),
      context(controller.signal, [], process.cwd()),
    )).resolves.toEqual({ root: process.cwd() })
    await expect(dispatcher.dispatch(
      request('workspace-storage', 'get', { scope: 'workspace', key: 'draft' }),
      context(controller.signal, [], process.cwd()),
    )).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' })
  })

  it('supports Host-owned optimistic mtime checks without changing the basic file shape', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plans-bridge-mtime-'))
    const dispatcher = createLocalFilesystemDispatcher()
    const controller = new AbortController()
    const bridgeContext = context(controller.signal, [], root, runtime, realpathSync(root))
    writeFileSync(join(root, 'plan.html'), 'before', 'utf8')
    try {
      await expect(dispatcher.dispatch(
        request('filesystem', 'read_file', { rel_path: 'plan.html' }),
        bridgeContext,
      )).resolves.toEqual({ content: 'before' })
      const snapshot = await dispatcher.dispatch(
        request('filesystem', 'read_file', { rel_path: 'plan.html', include_mtime: true }),
        bridgeContext,
      ) as { content: string; mtime: number }
      expect(snapshot).toMatchObject({ content: 'before', mtime: expect.any(Number) })

      await expect(dispatcher.dispatch(
        request('filesystem', 'write_file', {
          rel_path: 'plan.html',
          content: 'after',
          expected_mtime: snapshot.mtime + 1,
        }),
        bridgeContext,
      )).resolves.toMatchObject({ ok: false, conflict: true })
      await expect(dispatcher.dispatch(
        request('filesystem', 'write_file', {
          rel_path: 'plan.html',
          content: 'after',
          expected_mtime: snapshot.mtime,
        }),
        bridgeContext,
      )).resolves.toMatchObject({ ok: true, mtime: expect.any(Number) })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('delegates production filesystem reads and mutations to the Host service root', async () => {
    const root = realpathSync(process.cwd())
    const calls: Array<{ operation: string; payload: Record<string, unknown> }> = []
    const service: PlansFilesystemService = {
      async call(operation, payload): Promise<JsonValue> {
        calls.push({ operation, payload })
        if (operation === 'fs.read_file') {
          return { ok: true, content: 'draft', mtime: 10 }
        }
        if (operation === 'fs.list_dir') {
          return {
            ok: true,
            entries: [
              { name: 'plan.md', is_dir: false },
              { name: 'nested', is_dir: true },
            ],
          }
        }
        if (operation === 'fs.stat_workspace_path') {
          return { ok: true, exists: true, is_directory: true, size: 4 }
        }
        if (operation === 'fs.write_file') {
          return { ok: false, conflict: true, mtime: 11 }
        }
        if (operation === 'fs.delete' || operation === 'fs.rename') {
          return { ok: true }
        }
        throw new Error(`unexpected operation: ${operation}`)
      },
    }
    const port = createHostPlansFilesystemPort(service)
    const bridgeContext = context(new AbortController().signal, [], '/workspace', runtime, root)

    await expect(port.readFile({ rel_path: 'plan.md', include_mtime: true }, bridgeContext))
      .resolves.toEqual({ content: 'draft', mtime: 10 })
    await expect(port.listDir({ rel_path: '.agent-team/plans' }, bridgeContext))
      .resolves.toEqual({ entries: ['plan.md', 'nested'] })
    await expect(port.statPath({ rel_path: '.agent-team/plans' }, bridgeContext))
      .resolves.toEqual({ exists: true, isDirectory: true, size: 4 })
    await expect(port.writeFile(
      { rel_path: 'plan.md', content: 'updated', expected_mtime: 10 },
      bridgeContext,
    )).resolves.toEqual({ ok: false, conflict: true, mtime: 11 })
    await expect(port.delete({ rel_path: 'plan.md' }, bridgeContext)).resolves.toEqual({ ok: true })
    await expect(port.rename({ from: 'plan.md', to: 'renamed.md' }, bridgeContext))
      .resolves.toEqual({ ok: true })

    expect(calls).toEqual([
      { operation: 'fs.read_file', payload: { rel_path: 'plan.md', workspace_path: root } },
      { operation: 'fs.list_dir', payload: { rel_path: '.agent-team/plans', workspace_path: root } },
      { operation: 'fs.stat_workspace_path', payload: { rel_path: '.agent-team/plans', workspace_path: root } },
      {
        operation: 'fs.write_file',
        payload: { rel_path: 'plan.md', content: 'updated', expected_mtime: 10, workspace_path: root },
      },
      { operation: 'fs.delete', payload: { rel_path: 'plan.md', workspace_path: root } },
      {
        operation: 'fs.rename',
        payload: { src_path: 'plan.md', dst_path: 'renamed.md', workspace_path: root },
      },
    ])
  })

  it('does not let a workspace storage payload choose its partition identity', async () => {
    const dispatcher = createInMemoryPlansBridgeDispatcher()
    const controller = new AbortController()
    await expect(dispatcher.dispatch(
      request('workspace-storage', 'set', {
        scope: 'workspace',
        key: 'draft',
        value: { pluginId: 'forged.plugin', workspaceId: 'forged-workspace' },
      }),
      context(controller.signal),
    )).resolves.toBeNull()
    await expect(dispatcher.dispatch(
      request('workspace-storage', 'get', { scope: 'workspace', key: 'draft' }),
      context(controller.signal),
    )).resolves.toEqual({
      found: true,
      value: { pluginId: 'forged.plugin', workspaceId: 'forged-workspace' },
    })
    await expect(dispatcher.dispatch(
      request('workspace-storage', 'get', {
        scope: 'workspace',
        key: 'draft',
        workspaceId: 'forged-workspace',
      }),
      context(controller.signal),
    )).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it.each([
    ['production', createLocalFilesystemDispatcher],
    ['in-memory', () => createInMemoryPlansBridgeDispatcher()],
  ] as const)('rejects a workspace path outside the Host binding in the %s adapter', async (_label, create) => {
    const dispatcher = create()
    const controller = new AbortController()
    await expect(dispatcher.dispatch(
      request('filesystem', 'read_file', { rel_path: '../other-workspace' }),
      context(controller.signal, [], '/workspace'),
    )).rejects.toMatchObject({ code: 'WORKSPACE_SCOPE_VIOLATION' })
  })

  it('forwards discovery mode and truncated flag through Host Plans filesystem port', async () => {
    const root = realpathSync(process.cwd())
    const calls: Array<{ operation: string; payload: Record<string, unknown> }> = []
    const service: PlansFilesystemService = {
      async call(operation, payload) {
        calls.push({ operation, payload })
        if (operation === 'fs.list_dir') {
          return {
            ok: true,
            entries: [{ name: 'repo-1', is_dir: true }],
            truncated: true,
          }
        }
        throw new Error(`unexpected operation: ${operation}`)
      },
    }
    const port = createHostPlansFilesystemPort(service)
    const bridgeContext = context(new AbortController().signal, [], '/workspace', runtime, root)

    // Mode discovery + truncated forwarding
    await expect(port.listDir({ rel_path: '', mode: 'discovery' }, bridgeContext))
      .resolves.toEqual({ entries: ['repo-1'], truncated: true })
    expect(calls).toEqual([
      { operation: 'fs.list_dir', payload: { rel_path: '', mode: 'discovery', workspace_path: root } },
    ])

    // Invalid mode rejection
    await expect(port.listDir({ rel_path: '', mode: 'invalid' }, bridgeContext))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })
})
