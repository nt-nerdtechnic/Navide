import { describe, expect, it, vi } from 'vitest'
import type { PluginContext } from '@navide/plugin-sdk'
import {
  createAiCliSessionController,
  createAiCliTerminalResources,
  createAiCliTerminalView,
  type AiCliTerminalResources,
} from './index'

describe('public Vue plugin UI controllers', () => {
  it('routes AI CLI output only for its PluginContext-owned session', async () => {
    const eventListeners = new Map<string, (payload: never) => void>()
    const invoke = vi.fn().mockResolvedValueOnce({ sessionId: 'session-1' }).mockResolvedValue({})
    const context = {
      capabilities: { invoke },
      events: {
        subscribe: (event: string, listener: (payload: never) => void) => {
          eventListeners.set(event, listener)
          return { dispose: vi.fn() }
        },
      },
    } as unknown as PluginContext
    const controller = createAiCliSessionController(context)
    const output = vi.fn()
    controller.onOutput(output)

    await expect(controller.start('codex', 100, 30)).resolves.toBe('session-1')
    eventListeners.get('aiCli.output')?.({ sessionId: 'foreign', data: 'secret' } as never)
    eventListeners.get('aiCli.output')?.({ sessionId: 'session-1', data: 'owned' } as never)

    expect(output).toHaveBeenCalledOnce()
    expect(output).toHaveBeenCalledWith('owned')
  })

  it('replays output emitted before start acknowledgement exactly once', async () => {
    const listeners = new Map<string, (payload: never) => void>()
    let resolveStart!: (value: { sessionId: string }) => void
    const invoke = vi.fn(() => new Promise<{ sessionId: string }>(resolve => { resolveStart = resolve }))
    const context = {
      capabilities: { invoke },
      events: { subscribe: (event: string, listener: (payload: never) => void) => { listeners.set(event, listener); return { dispose: vi.fn() } } },
    } as unknown as PluginContext
    const controller = createAiCliSessionController(context)
    const output = vi.fn()
    controller.onOutput(output)
    const pending = controller.start('codex', 80, 24)
    listeners.get('aiCli.output')?.({ sessionId: 'session-1', data: 'early' } as never)
    resolveStart({ sessionId: 'session-1' })
    await expect(pending).resolves.toBe('session-1')
    expect(output).toHaveBeenCalledOnce()
    expect(output).toHaveBeenCalledWith('early')
  })

  it('delivers early output then early exit and clears the session', async () => {
    const listeners = new Map<string, (payload: never) => void>()
    let resolveResume!: (value: { sessionId: string; profileId: string }) => void
    const invoke = vi.fn(() => new Promise<{ sessionId: string; profileId: string }>(resolve => { resolveResume = resolve }))
    const context = {
      capabilities: { invoke },
      events: { subscribe: (event: string, listener: (payload: never) => void) => { listeners.set(event, listener); return { dispose: vi.fn() } } },
    } as unknown as PluginContext
    const controller = createAiCliSessionController(context)
    const output = vi.fn()
    const exited = vi.fn()
    controller.onOutput(output)
    controller.onExit(exited)
    const pending = controller.resume(80, 24)
    listeners.get('aiCli.output')?.({ sessionId: 'session-resumed', data: 'before-exit' } as never)
    listeners.get('aiCli.exited')?.({ sessionId: 'session-resumed' } as never)
    resolveResume({ sessionId: 'session-resumed', profileId: 'codex' })
    await expect(pending).resolves.toEqual({ sessionId: 'session-resumed', profileId: 'codex' })
    expect(output).toHaveBeenCalledOnce()
    expect(output).toHaveBeenCalledWith('before-exit')
    expect(exited).toHaveBeenCalledOnce()
    expect(controller.sessionId).toBeNull()
  })

  it('can start again after stop and disposes subscriptions only at teardown', async () => {
    const disposeOutput = vi.fn()
    const disposeExit = vi.fn()
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ sessionId: 'session-1' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ sessionId: 'session-2' })
    const context = {
      capabilities: { invoke },
      events: {
        subscribe: (event: string) => ({
          dispose: event === 'aiCli.output' ? disposeOutput : disposeExit,
        }),
      },
    } as unknown as PluginContext
    const controller = createAiCliSessionController(context)

    await controller.start('codex', 100, 30)
    await controller.stop()
    expect(invoke).toHaveBeenNthCalledWith(2, 'aiCli.stopSession', {
      sessionId: 'session-1',
      force: true,
    })
    expect(disposeOutput).not.toHaveBeenCalled()
    expect(disposeExit).not.toHaveBeenCalled()

    await expect(controller.start('codex', 100, 30)).resolves.toBe('session-2')
    controller.dispose()
    expect(disposeOutput).toHaveBeenCalledOnce()
    expect(disposeExit).toHaveBeenCalledOnce()
  })

  it('reports an owned session exit without exposing foreign sessions', async () => {
    const eventListeners = new Map<string, (payload: never) => void>()
    const context = {
      capabilities: { invoke: vi.fn().mockResolvedValue({ sessionId: 'session-1' }) },
      events: {
        subscribe: (event: string, listener: (payload: never) => void) => {
          eventListeners.set(event, listener)
          return { dispose: vi.fn() }
        },
      },
    } as unknown as PluginContext
    const controller = createAiCliSessionController(context)
    const exited = vi.fn()
    controller.onExit(exited)
    await controller.start('codex', 80, 24)

    eventListeners.get('aiCli.exited')?.({ sessionId: 'foreign' } as never)
    eventListeners.get('aiCli.exited')?.({ sessionId: 'session-1', exitCode: 0 } as never)

    expect(exited).toHaveBeenCalledOnce()
    expect(controller.sessionId).toBeNull()
  })

  it('lists Host profiles and resumes only the tuple-owned detached session', async () => {
    const invoke = vi.fn(async (address: string) => {
      if (address === 'aiCli.listProfiles') {
        return { profiles: [{ id: 'claude', label: 'Claude Code' }] }
      }
      if (address === 'aiCli.resumeSession') {
        return { sessionId: 'session-resumed', profileId: 'claude' }
      }
      return null
    })
    const context = {
      capabilities: { invoke },
      events: { subscribe: () => ({ dispose: vi.fn() }) },
    } as unknown as PluginContext
    const controller = createAiCliSessionController(context)

    await expect(controller.listProfiles()).resolves.toEqual([
      { id: 'claude', label: 'Claude Code' },
    ])
    await expect(controller.resume(100, 30)).resolves.toEqual({
      sessionId: 'session-resumed',
      profileId: 'claude',
    })
    expect(controller.sessionId).toBe('session-resumed')
    expect(invoke).toHaveBeenCalledWith('aiCli.resumeSession', { cols: 100, rows: 30 })
  })

  it('coalesces concurrent starts and forwards unattended mode once', async () => {
    let resolveStart!: (value: { sessionId: string }) => void
    const started = new Promise<{ sessionId: string }>((resolve) => { resolveStart = resolve })
    const invoke = vi.fn((address: string, _args?: Record<string, unknown>) => {
      if (address === 'aiCli.startSession') return started
      return Promise.resolve({})
    })
    const context = {
      capabilities: { invoke },
      events: { subscribe: () => ({ dispose: vi.fn() }) },
    } as unknown as PluginContext
    const controller = createAiCliSessionController(context)

    const first = controller.start('claude', 100, 30, { yolo: true })
    const second = controller.start('claude', 100, 30, { yolo: true })
    expect(invoke).toHaveBeenCalledTimes(1)
    const startCalls = invoke.mock.calls.filter(([address]) => address === 'aiCli.startSession')
    expect(startCalls).toHaveLength(1)
    const startCall = startCalls[0]
    if (!startCall) throw new Error('missing start call')
    expect(startCall[1]).toEqual({
      profileId: 'claude',
      cols: 100,
      rows: 30,
      yolo: true,
      requestId: expect.any(String),
    })
    const requestId = String((startCall[1] as Record<string, unknown>).requestId)
    expect(requestId).toHaveLength(36)

    await controller.cancelStart?.()
    expect(invoke).toHaveBeenCalledWith('aiCli.cancelStart', { requestId })

    resolveStart({ sessionId: 'session-1' })
    await expect(Promise.all([first, second])).resolves.toEqual(['session-1', 'session-1'])
  })

  it('forwards opt-in terminal persistence and uses fixed terminal view methods', async () => {
    const invoke = vi.fn(async (address: string) => {
      if (address === 'aiCli.startSession') return { sessionId: 'session-1' }
      if (address === 'aiCli.readTerminalView') return { fontSize: 12, lastSize: null, snapshot: null }
      return {}
    })
    const context = { capabilities: { invoke }, events: { subscribe: () => ({ dispose: vi.fn() }) } } as unknown as PluginContext
    const controller = createAiCliSessionController(context, { persistView: true })
    await controller.start('codex', 100, 30)
    await controller.redraw?.(100, 30)
    expect(invoke).toHaveBeenCalledWith('aiCli.startSession', expect.objectContaining({ persistView: true }))
    expect(invoke).toHaveBeenCalledWith('aiCli.redrawSession', { sessionId: 'session-1', cols: 100, rows: 30 })
    const view = createAiCliTerminalView(context, controller)
    await view.read()
    await view.setFontSize(14)
    await view.save(['snapshot'])
    expect(invoke).toHaveBeenCalledWith('aiCli.readTerminalView', {})
    expect(invoke).toHaveBeenCalledWith('aiCli.setTerminalFontSize', { fontSize: 14 })
    expect(invoke).toHaveBeenCalledWith('aiCli.saveTerminalView', { sessionId: 'session-1', snapshots: ['snapshot'] })
  })

  it('routes terminal resources with the controller-owned session', async () => {
    const invoke = vi.fn(async (address: string) => {
      if (address === 'aiCli.startSession') return { sessionId: 'session-1' }
      if (address === 'aiCli.listMentionTargets') return { targets: [{ address: 'file:README.md' }] }
      if (address === 'aiCli.saveClipboardImage') return { path: '/tmp/clip.png' }
      return {}
    })
    const context = { capabilities: { invoke }, events: { subscribe: () => ({ dispose: vi.fn() }) } } as unknown as PluginContext
    const controller = createAiCliSessionController(context)
    await controller.start('codex', 80, 24)
    const resources = createAiCliTerminalResources(context, controller)
    await expect(resources.listMentionTargets()).resolves.toEqual([{ address: 'file:README.md' }])
    await expect(resources.saveClipboardImage(new File(['x'], 'x.png', { type: 'image/png' }))).resolves.toBe('/tmp/clip.png')
    await resources.showContextMenu('selected')
    await resources.reportSelection('selected')
    expect(invoke).toHaveBeenCalledWith('aiCli.showTerminalContextMenu', { sessionId: 'session-1', selection: 'selected' })
    expect(invoke).toHaveBeenCalledWith('aiCli.reportTerminalSelection', { sessionId: 'session-1', selection: 'selected' })
  })

  it('binds public file-picker requests to the controller session and dispatches URL and Plans actions', async () => {
    const invoke = vi.fn(async (address: string) => {
      if (address === 'aiCli.startSession') return { sessionId: 'session-owned' }
      return {}
    })
    const context = { capabilities: { invoke }, events: { subscribe: () => ({ dispose: vi.fn() }) } } as unknown as PluginContext
    const controller = createAiCliSessionController(context)
    await controller.start('codex', 80, 24)
    const resources = createAiCliTerminalResources(context, controller)

    const forgedRequest = {
      query: 'README.md',
      candidates: ['README.md:12'],
      line: 12,
      sessionId: 'session-forged',
    } as unknown as Parameters<NonNullable<AiCliTerminalResources['openFilePicker']>>[0]
    await resources.openFilePicker!(forgedRequest)
    await resources.openExternal!('https://example.test/docs')
    await resources.openPlan!('.agent-team/plans/example.html')

    expect(invoke).toHaveBeenCalledWith('ui.openFilePicker', {
      query: 'README.md',
      candidates: ['README.md:12'],
      line: 12,
      sessionId: 'session-owned',
    })
    expect(invoke).not.toHaveBeenCalledWith('ui.openFilePicker', expect.objectContaining({ sessionId: 'session-forged' }))
    expect(invoke).toHaveBeenCalledWith('ui.openExternal', { url: 'https://example.test/docs' })
    expect(invoke).toHaveBeenCalledWith('ui.openPlansWindow', { path: '.agent-team/plans/example.html' })
  })
})
