import { describe, expect, it, vi } from 'vitest'
import type { WsClient, WsResponse, WsSendOptions } from '../../shared/wsClient'
import {
  EditorAiCapability,
  validateEditorAiEvent,
  validateEditorAiRequest,
} from './editorAiCapability'
import {
  HOST_EVENT_SOURCE_PLUGIN_ID,
  isPublicCapabilityEventAllowed,
  planPublicCapabilityCall,
  type HostCapabilityContext,
} from './pluginCapabilityBroker'
import { manifestV2CapabilityPolicy } from './pluginPermissions'

function makeClient(
  sendImpl?: (
    type: string,
    payload: Record<string, unknown> | undefined,
    timeoutMs: number | undefined,
    options: WsSendOptions | undefined,
  ) => Promise<WsResponse>,
) {
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const send = vi.fn(async (
    type: string,
    payload?: Record<string, unknown>,
    timeoutMs?: number,
    options?: WsSendOptions,
  ) => sendImpl?.(type, payload, timeoutMs, options) ?? {
    id: 'response-id',
    type,
    ok: true,
    payload: null,
    error: null,
    timestamp: new Date(0).toISOString(),
  } as WsResponse)
  const on = vi.fn((type: string, cb: (payload: unknown) => void) => {
    let set = listeners.get(type)
    if (!set) {
      set = new Set()
      listeners.set(type, set)
    }
    set.add(cb)
    return () => set?.delete(cb)
  })
  const client = {
    send,
    on,
    connect: vi.fn(),
    reset: vi.fn(),
    reconnectNow: vi.fn(),
    markErrored: vi.fn(),
    isHealthyFor: vi.fn(() => true),
    currentUrl: vi.fn(() => ''),
    dispose: vi.fn(),
  }
  return {
    ...client,
    asWsClient: () => client as unknown as WsClient,
    emit(type: string, payload: unknown) {
      for (const cb of listeners.get(type) ?? []) cb(payload)
    },
    listenerCount() {
      let count = 0
      for (const set of listeners.values()) count += set.size
      return count
    },
  }
}

const makeContext = (
  instanceId: string,
  workspacePath: string,
  canDispatch: () => boolean = () => true,
) => ({ instanceId, workspacePath, canDispatch })

const rewriteArgs = { code: 'const x = 1', instruction: 'rename x', language: 'ts', model: 'gpt' }
const completeArgs = { prefix: 'const x = ', suffix: '', language: 'ts', model: 'gpt' }
const reviewResult = {
  summary: 'one finding',
  verdict: 'approve_with_comments',
  findings: [{
    id: 'finding-1',
    file: 'src/example.ts',
    title: 'Example finding',
    body: 'Example body',
    line: 3,
    severity: 'suggestion',
  }],
}

describe('editor AI request and event validation', () => {
  it('accepts only the documented strict request shapes', () => {
    expect(validateEditorAiRequest('aiCli.rewrite', rewriteArgs)).toBe(true)
    expect(validateEditorAiRequest('aiCli.complete', completeArgs)).toBe(true)
    expect(validateEditorAiRequest('aiCli.reviewStart', { mode: 'working' })).toBe(true)
    expect(validateEditorAiRequest('aiCli.reviewStart', { mode: 'branch', base: 'main', compare: 'HEAD' })).toBe(true)
    expect(validateEditorAiRequest('aiCli.reviewStop', { reviewId: 'review-1' })).toBe(true)
    expect(validateEditorAiRequest('aiCli.getModelPreferences', {})).toBe(true)
    expect(validateEditorAiRequest('aiCli.setModelPreferences', { provider: 'openai', model: 'gpt' })).toBe(true)
    expect(validateEditorAiRequest('aiCli.listModels', {})).toBe(true)
    expect(validateEditorAiRequest('aiCli.getEditorProfile', {})).toBe(true)
    expect(validateEditorAiRequest('aiCli.setEditorProfile', { profileId: 'codex' })).toBe(true)
  })

  it.each([
    ['aiCli.rewrite', rewriteArgs, 'initiator'],
    ['aiCli.complete', completeArgs, 'instanceId'],
    ['aiCli.reviewStart', { mode: 'working' }, 'workspacePath'],
    ['aiCli.reviewStop', { reviewId: 'review-1' }, 'callerIdentity'],
    ['aiCli.getModelPreferences', {}, 'apiKey'],
    ['aiCli.setModelPreferences', { provider: 'openai', model: 'gpt' }, 'token'],
    ['aiCli.listModels', {}, 'arbitraryMethod'],
  ] as const)('rejects caller identity or extra field %s.%s', (address, args, field) => {
    expect(validateEditorAiRequest(address, { ...args, [field]: 'forged' })).toBe(false)
  })

  it('rejects arbitrary methods and malformed requests', () => {
    expect(validateEditorAiRequest('aiCli.arbitrary', {})).toBe(false)
    expect(validateEditorAiRequest('aiCli.rewrite', { ...rewriteArgs, model: 1 })).toBe(false)
    expect(validateEditorAiRequest('aiCli.reviewStart', { mode: 'detached' })).toBe(false)
    expect(validateEditorAiRequest('aiCli.reviewStart', { mode: 'working', base: 1 })).toBe(false)
    expect(validateEditorAiRequest('aiCli.reviewStop', { reviewId: '' })).toBe(false)
    expect(validateEditorAiEvent('aiCli.reviewEnd', { reviewId: 'r', extra: true })).toBe(false)
    expect(validateEditorAiEvent('aiCli.reviewError', { reviewId: 'r', message: 1 })).toBe(false)
    expect(validateEditorAiEvent('aiCli.reviewResult', { reviewId: 'r', result: { ...reviewResult, verdict: 'unknown' } })).toBe(false)
    expect(validateEditorAiEvent('aiCli.reviewResult', { reviewId: 'r', result: { ...reviewResult, secret: 'leak' } })).toBe(false)
    expect(validateEditorAiEvent('aiCli.reviewResult', {
      reviewId: 'r',
      result: { ...reviewResult, findings: [{ ...reviewResult.findings[0], secret: 'leak' }] },
    })).toBe(false)
    expect(validateEditorAiEvent('aiCli.reviewResult', { reviewId: 'r', result: reviewResult })).toBe(true)
  })
})

describe('EditorAiCapability dispatch boundary', () => {
  it('denies every editor operation before any request or review client call', async () => {
    const request = vi.fn()
    const createReviewClient = vi.fn(() => makeClient().asWsClient())
    const capability = new EditorAiCapability({ request, createReviewClient, publish: vi.fn() })
    const denied = makeContext('denied', '/denied', () => false)

    await expect(capability.execute('aiCli.rewrite', rewriteArgs, denied)).rejects.toThrow('denied')
    await expect(capability.execute('aiCli.complete', completeArgs, denied)).rejects.toThrow('denied')
    await expect(capability.execute('aiCli.getModelPreferences', {}, denied)).rejects.toThrow('denied')
    await expect(capability.execute('aiCli.getEditorProfile', {}, denied)).rejects.toThrow('denied')
    await expect(capability.execute('aiCli.setEditorProfile', { profileId: 'codex' }, denied)).rejects.toThrow('denied')
    await expect(capability.execute('aiCli.setModelPreferences', { provider: 'openai', model: 'gpt' }, denied)).rejects.toThrow('denied')
    await expect(capability.execute('aiCli.listModels', {}, denied)).rejects.toThrow('denied')
    await expect(capability.execute('aiCli.reviewStart', { mode: 'working' }, denied)).rejects.toThrow('denied')

    expect(request).not.toHaveBeenCalled()
    expect(createReviewClient).not.toHaveBeenCalled()
  })

  it('reads and writes only the Host AI profile setting', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ settings: { 'ide-ai-panel-width.agent': 'codex', 'git-ai-panel-width.agent': 'claude' } })
      .mockResolvedValueOnce({ ok: true })
    const capability = new EditorAiCapability({ request, createReviewClient: vi.fn(), publish: vi.fn() })

    await expect(capability.execute('aiCli.getEditorProfile', {}, makeContext('profile', '/workspace')))
      .resolves.toEqual({ profileId: 'codex' })
    await expect(capability.execute('aiCli.setEditorProfile', { profileId: 'claude' }, makeContext('profile', '/workspace')))
      .resolves.toEqual({ ok: true })
    expect(request).toHaveBeenNthCalledWith(1, 'ui.settings.get', {}, expect.any(Function))
    expect(request).toHaveBeenNthCalledWith(2, 'ui.settings.set', {
      updates: { 'ide-ai-panel-width.agent': 'claude' },
    }, expect.any(Function))
    expect(request.mock.calls[1]?.[1]).not.toHaveProperty('updates.git-ai-panel-width.agent')
  })

  it('forwards the original canDispatch guard and honors late revocation', async () => {
    let allowed = true
    const canDispatch = vi.fn(() => allowed)
    const request = vi.fn(async (
      _type: string,
      _payload: Record<string, unknown>,
      beforeDispatch: () => boolean,
    ) => {
      expect(beforeDispatch).toBe(canDispatch)
      allowed = false
      expect(beforeDispatch()).toBe(false)
      throw new Error('revoked before dispatch')
    })
    const capability = new EditorAiCapability({ request, createReviewClient: vi.fn(), publish: vi.fn() })

    await expect(capability.execute('aiCli.rewrite', rewriteArgs, makeContext('late', '/workspace', canDispatch))).rejects.toThrow('revoked')
    // execute() checks admission once; the backend seam receives and rechecks
    // the same original guard immediately before dispatch.
    expect(canDispatch).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenCalledWith('editor.rewrite', rewriteArgs, canDispatch)
  })

  it('projects model preferences without returning provider secrets or extra fields', async () => {
    const request = vi.fn(async () => ({ provider: 'openai', model: 'gpt-5', apiKey: 'secret', token: 'secret' }))
    const capability = new EditorAiCapability({ request, createReviewClient: vi.fn(), publish: vi.fn() })

    await expect(capability.execute('aiCli.getModelPreferences', {}, makeContext('prefs', '/workspace'))).resolves.toEqual({
      provider: 'openai',
      model: 'gpt-5',
    })
    expect(request).toHaveBeenCalledWith('ai.chat.settings.get', {}, expect.any(Function))
  })

  it('projects listModels to named models and drops backend metadata', async () => {
    const request = vi.fn(async () => ({
      models: [
        { name: 'gpt-5', provider: 'openai', size: 4096 },
        { name: 'local-model', default: true, secret: 'leak' },
        { provider: 'missing-name' },
        'malformed',
      ],
      default: 'gpt-5',
      size: 4096,
    }))
    const capability = new EditorAiCapability({ request, createReviewClient: vi.fn(), publish: vi.fn() })

    await expect(capability.execute('aiCli.listModels', {}, makeContext('models', '/workspace'))).resolves.toEqual({
      ok: true,
      models: [{ name: 'gpt-5' }, { name: 'local-model' }],
    })
    expect(request).toHaveBeenCalledWith('analyzer.models', {}, expect.any(Function))
  })
})

describe('EditorAiCapability review ownership and lifecycle', () => {
  it('starts simultaneous reviews with Host-minted IDs, dedicated clients, and bound workspaces', async () => {
    const first = makeClient()
    const second = makeClient()
    const createReviewClient = vi.fn()
      .mockImplementationOnce(() => first.asWsClient())
      .mockImplementationOnce(() => second.asWsClient())
    const capability = new EditorAiCapability({ createReviewClient, request: vi.fn(), publish: vi.fn() })

    const firstStarted = await capability.execute('aiCli.reviewStart', { mode: 'working' }, makeContext('instance-a', '/workspace-a')) as { reviewId: string }
    const secondStarted = await capability.execute('aiCli.reviewStart', { mode: 'branch', base: 'main', compare: 'feature' }, makeContext('instance-b', '/workspace-b')) as { reviewId: string }

    expect(firstStarted.reviewId).toEqual(expect.any(String))
    expect(secondStarted.reviewId).toEqual(expect.any(String))
    expect(firstStarted.reviewId).not.toBe(secondStarted.reviewId)
    expect(first.send).toHaveBeenCalledWith(
      'ai.review.start',
      expect.objectContaining({ review_id: firstStarted.reviewId, workspace_path: '/workspace-a', mode: 'working' }),
      10_000,
      expect.objectContaining({ beforeDispatch: expect.any(Function) }),
    )
    expect(second.send).toHaveBeenCalledWith(
      'ai.review.start',
      expect.objectContaining({ review_id: secondStarted.reviewId, workspace_path: '/workspace-b', mode: 'branch', base: 'main', compare: 'feature' }),
      10_000,
      expect.objectContaining({ beforeDispatch: expect.any(Function) }),
    )
    expect(first.send.mock.calls[0]?.[1]?.review_id).not.toBe(second.send.mock.calls[0]?.[1]?.review_id)
    expect(createReviewClient).toHaveBeenCalledTimes(2)
    expect(first.listenerCount()).toBe(3)
    expect(second.listenerCount()).toBe(3)
  })

  it('rejects cross-instance stop and leaves the other active; owner stop closes only its review', async () => {
    const first = makeClient()
    const second = makeClient()
    const capability = new EditorAiCapability({
      createReviewClient: vi.fn()
        .mockImplementationOnce(() => first.asWsClient())
        .mockImplementationOnce(() => second.asWsClient()),
      request: vi.fn(),
      publish: vi.fn(),
    })
    const firstStarted = await capability.execute('aiCli.reviewStart', { mode: 'working' }, makeContext('instance-a', '/workspace-a')) as { reviewId: string }
    const secondStarted = await capability.execute('aiCli.reviewStart', { mode: 'working' }, makeContext('instance-b', '/workspace-b')) as { reviewId: string }

    await expect(capability.execute('aiCli.reviewStop', { reviewId: firstStarted.reviewId }, makeContext('instance-b', '/workspace-b'))).rejects.toThrow('not owned')
    expect(first.dispose).not.toHaveBeenCalled()
    expect(second.dispose).not.toHaveBeenCalled()

    await capability.execute('aiCli.reviewStop', { reviewId: firstStarted.reviewId }, makeContext('instance-a', '/workspace-a'))
    expect(first.dispose).toHaveBeenCalledTimes(1)
    expect(first.listenerCount()).toBe(0)
    expect(second.dispose).not.toHaveBeenCalled()
    expect(second.listenerCount()).toBe(3)

    await capability.execute('aiCli.reviewStop', { reviewId: secondStarted.reviewId }, makeContext('instance-b', '/workspace-b'))
    expect(second.dispose).toHaveBeenCalledTimes(1)
  })

  it('ignores forged review IDs and routes valid result, end, and error events only to their owner', async () => {
    const first = makeClient()
    const second = makeClient()
    const publish = vi.fn()
    const capability = new EditorAiCapability({
      createReviewClient: vi.fn()
        .mockImplementationOnce(() => first.asWsClient())
        .mockImplementationOnce(() => second.asWsClient()),
      request: vi.fn(),
      publish,
    })
    const firstStarted = await capability.execute('aiCli.reviewStart', { mode: 'working' }, makeContext('instance-a', '/workspace-a')) as { reviewId: string }
    const secondStarted = await capability.execute('aiCli.reviewStart', { mode: 'working' }, makeContext('instance-b', '/workspace-b')) as { reviewId: string }

    const forged = { review_id: 'forged-review-id', result: reviewResult }
    first.emit('ai.review.result', forged)
    second.emit('ai.review.result', { ...forged, review_id: firstStarted.reviewId })
    second.emit('ai.review.error', { review_id: firstStarted.reviewId, message: 'wrong owner' })
    expect(publish).not.toHaveBeenCalled()

    first.emit('ai.review.result', { review_id: firstStarted.reviewId, result: reviewResult })
    second.emit('ai.review.error', { review_id: secondStarted.reviewId, message: 'backend failed' })
    expect(publish).toHaveBeenNthCalledWith(1, 'instance-a', 'aiCli.reviewResult', {
      reviewId: firstStarted.reviewId,
      result: reviewResult,
    })
    expect(publish).toHaveBeenNthCalledWith(2, 'instance-b', 'aiCli.reviewError', {
      reviewId: secondStarted.reviewId,
      message: 'backend failed',
    })
    expect(first.dispose).not.toHaveBeenCalled()
    expect(second.dispose).toHaveBeenCalledTimes(1)

    first.emit('ai.review.end', { review_id: firstStarted.reviewId })
    expect(publish).toHaveBeenNthCalledWith(3, 'instance-a', 'aiCli.reviewEnd', { reviewId: firstStarted.reviewId })
    expect(first.dispose).toHaveBeenCalledTimes(1)
    expect(first.listenerCount()).toBe(0)
    second.emit('ai.review.end', { review_id: secondStarted.reviewId })
    expect(publish).toHaveBeenCalledTimes(3)
  })

  it('closes the client and listeners when disconnect happens after start', async () => {
    const client = makeClient()
    let onDisconnected: (() => void) | undefined
    const publish = vi.fn()
    const capability = new EditorAiCapability({
      createReviewClient: vi.fn((callback: () => void) => {
        onDisconnected = callback
        return client.asWsClient()
      }),
      request: vi.fn(),
      publish,
    })
    const started = await capability.execute('aiCli.reviewStart', { mode: 'working' }, makeContext('instance-a', '/workspace-a')) as { reviewId: string }
    expect(onDisconnected).toEqual(expect.any(Function))
    expect(client.dispose).not.toHaveBeenCalled()
    expect(client.listenerCount()).toBe(3)

    onDisconnected?.()
    expect(client.dispose).toHaveBeenCalledWith('editor review closed')
    expect(client.listenerCount()).toBe(0)
    client.emit('ai.review.result', { review_id: started.reviewId, result: reviewResult })
    expect(publish).not.toHaveBeenCalled()
  })

  it('closeAll closes every active review and removes every listener', async () => {
    const first = makeClient()
    const second = makeClient()
    const capability = new EditorAiCapability({
      createReviewClient: vi.fn()
        .mockImplementationOnce(() => first.asWsClient())
        .mockImplementationOnce(() => second.asWsClient()),
      request: vi.fn(),
      publish: vi.fn(),
    })
    await capability.execute('aiCli.reviewStart', { mode: 'working' }, makeContext('instance-a', '/workspace-a'))
    await capability.execute('aiCli.reviewStart', { mode: 'working' }, makeContext('instance-b', '/workspace-b'))

    capability.closeAll()
    expect(first.dispose).toHaveBeenCalledTimes(1)
    expect(second.dispose).toHaveBeenCalledTimes(1)
    expect(first.listenerCount()).toBe(0)
    expect(second.listenerCount()).toBe(0)
  })

  it('cleans up listeners and client when review start fails', async () => {
    const client = makeClient(async () => { throw new Error('offline') })
    const capability = new EditorAiCapability({
      createReviewClient: vi.fn(() => client.asWsClient()),
      request: vi.fn(),
      publish: vi.fn(),
    })

    await expect(capability.execute('aiCli.reviewStart', { mode: 'branch', base: 'main', compare: 'HEAD' }, makeContext('instance-a', '/workspace-a'))).rejects.toThrow('offline')
    expect(client.send).toHaveBeenCalledTimes(1)
    expect(client.dispose).toHaveBeenCalledWith('editor review closed')
    expect(client.listenerCount()).toBe(0)
  })
})

describe('editor AI broker trust boundary', () => {
  const binding = {
    pluginId: 'acme.editor',
    packageVersion: '1.0.0',
    workspaceId: 'workspace-a',
    instanceId: 'instance-a',
    audience: 'audience-a',
  } as const
  const context = (overrides: Partial<HostCapabilityContext> = {}): HostCapabilityContext => ({
    publisherEligible: true,
    userGrant: { packageVersion: '1.0.0', system: ['aiCli'] },
    runtimeBinding: binding,
    sessionBindings: new Map(),
    ...overrides,
  })

  it('denies an editor AI call before backend planning when policy omits aiCli', () => {
    const decision = planPublicCapabilityCall({
      pluginId: binding.pluginId,
      ns: 'aiCli',
      method: 'rewrite',
      args: rewriteArgs,
      reqId: 'denied-ai',
    }, manifestV2CapabilityPolicy({ system: [] }), context({
      userGrant: { packageVersion: '1.0.0', system: [] },
    }))
    expect(decision).toMatchObject({ kind: 'deny', response: { error: { code: 'CAPABILITY_DENIED' } } })
  })

  it('rejects review events from a different authenticated source binding', () => {
    const validPayload = { reviewId: 'review-1' }
    expect(isPublicCapabilityEventAllowed(
      manifestV2CapabilityPolicy({ system: ['aiCli'] }),
      'aiCli.reviewEnd',
      validPayload,
      context(),
      binding.pluginId,
      { ...binding, instanceId: 'instance-b', audience: 'audience-b' },
    )).toBe(false)
    expect(isPublicCapabilityEventAllowed(
      manifestV2CapabilityPolicy({ system: ['aiCli'] }),
      'aiCli.reviewEnd',
      validPayload,
      context(),
      binding.pluginId,
      binding,
    )).toBe(true)
  })

  it('requires the Host source binding for workspace events across sources', () => {
    const policy = manifestV2CapabilityPolicy({ system: ['fs'] })
    const files = { changes: [{ path: 'README.md', kind: 'changed' }] }
    const hostSource = {
      ...binding,
      pluginId: HOST_EVENT_SOURCE_PLUGIN_ID,
      instanceId: null,
      audience: null,
    }
    expect(isPublicCapabilityEventAllowed(policy, 'workspace.filesChanged', files, context(), binding.pluginId, binding)).toBe(false)
    expect(isPublicCapabilityEventAllowed(policy, 'workspace.filesChanged', files, context({ userGrant: { packageVersion: '1.0.0', system: ['fs'] } }), binding.pluginId, hostSource)).toBe(true)
    expect(isPublicCapabilityEventAllowed(policy, 'workspace.filesChanged', files, context({ userGrant: { packageVersion: '1.0.0', system: ['fs'] } }), binding.pluginId, { ...hostSource, workspaceId: 'workspace-b' })).toBe(false)
  })
})
