import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import {
  createPluginGitUiPort,
  createPluginTerminalDockPort,
  type PluginCapabilitySdk,
} from '../pluginSurfacePorts'
import {
  runTerminalDockContract,
  type TerminalDockContractHarness,
  type TerminalDockRequestRecord,
} from '../../../src/ports/__tests__/terminalDock.contract'

type PluginSurfaceHarness = TerminalDockContractHarness & { sdk: PluginCapabilitySdk }

function createHarness(): PluginSurfaceHarness {
  const status = { value: 'connected' as const }
  const shell = ref('bash')
  const autoRestart = ref(null)
  const sent: TerminalDockRequestRecord[] = []
  const listeners = new Map<string, Set<(payload: unknown) => void>>()

  const sdk: PluginCapabilitySdk = {
    status,
    shell,
    autoRestart,
    async request<T = unknown>(type: string, payload: Record<string, unknown> = {}, timeoutMs?: number) {
      sent.push({ type, payload, ...(timeoutMs === undefined ? {} : { timeoutMs }) })
      return { ok: true, payload: null as T | null, error: null }
    },
    subscribe(type, callback) {
      const callbacks = listeners.get(type) ?? new Set()
      listeners.set(type, callbacks)
      callbacks.add(callback)
      return () => callbacks.delete(callback)
    },
  }

  return {
    port: createPluginTerminalDockPort(sdk),
    sdk,
    sent,
    emitOutput: (payload) => { listeners.get('terminal.output')?.forEach((callback) => callback(payload)) },
    emitExit: (payload) => { listeners.get('terminal.exit')?.forEach((callback) => callback(payload)) },
  }
}

runTerminalDockContract(createHarness)

describe('plugin terminal dock adapter', () => {
  it('exposes the SDK-bound terminal port without a generic send method', () => {
    expect(createHarness().port).toHaveProperty('create')
    expect(createHarness().port).not.toHaveProperty('send')
  })

  it('does not claim unsupported Host-only terminal operations', () => {
    const port = createHarness().port
    expect(port.getHomeDirectory).toBeUndefined()
    expect(port.openPlan).toBeUndefined()
    expect(port.reportSelection).toBeUndefined()
    expect(port.saveClipboardImage).toBeUndefined()
    expect(port.showContextMenu).toBeUndefined()
    expect(port.reportDragEnd).toBeUndefined()
    expect(port.diagnostic).toBeUndefined()
  })
})

describe('plugin terminal dock adapter — restore record', () => {
  it('reads the panel restore record through terminal.dock_record', async () => {
    const harness = createHarness()
    const requests: Array<{ type: string; payload: Record<string, unknown> }> = []
    const sdk: PluginCapabilitySdk = {
      ...harness.sdk,
      async request<T = unknown>(type: string, payload: Record<string, unknown> = {}) {
        requests.push({ type, payload })
        const record = type === 'terminal.dock_record' ? { agent: 'claude', session_id: 's-9' } : null
        return { ok: true, payload: { record } as T, error: null }
      },
    }
    const port = createPluginTerminalDockPort(sdk)
    expect(await port.readDockRestore!('/w', 'ab12cd34-git-ai-terminal'))
      .toEqual({ agentKey: 'claude', sessionId: 's-9' })
    expect(requests).toEqual([{
      type: 'terminal.dock_record',
      payload: { workspace_path: '/w', pane_id: 'ab12cd34-git-ai-terminal' },
    }])
  })

  it('reads no record from a failed or empty answer', async () => {
    const harness = createHarness()
    const failing = createPluginTerminalDockPort({
      ...harness.sdk,
      async request<T = unknown>() {
        return { ok: false, payload: null as T | null, error: { code: 'X', message: 'x' } }
      },
    })
    expect(await failing.readDockRestore!('/w', 'p')).toBeNull()
    expect(await harness.port.readDockRestore!('/w', 'p')).toBeNull()
  })
})

describe('plugin Git UI adapter', () => {
  it('exposes only UI capabilities available to the plugin window', () => {
    const ui = createPluginGitUiPort(createHarness().sdk)
    expect(ui).toHaveProperty('openInEditor')
    expect(ui).toHaveProperty('openExternal')
    expect(ui).toHaveProperty('revealPath')
    expect(ui).toHaveProperty('pickFolder')
    expect(ui).toHaveProperty('openWorkspace')
    expect(ui).not.toHaveProperty('openPath')
    expect(ui).not.toHaveProperty('openTempFile')
    expect(ui).not.toHaveProperty('pickWorkspace')
    expect(ui).not.toHaveProperty('openMainWindow')
    expect(ui).not.toHaveProperty('openBranchDiffWindow')
    expect(ui).not.toHaveProperty('openGitWindow')
    expect(ui).not.toHaveProperty('openGitHistoryWindow')
  })
})
