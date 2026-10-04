// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useBackend } from '../capabilityBackend'
import { createHostTerminalDockPort } from '../../../src/composables/hostSurfacePorts'

// The legacy Mini-IDE plugin mounts EditorWindowApp unchanged, so its AI panel
// gets the HOST terminal port built over the capability shim. This composes the
// two exactly as the plugin bundle does and checks every dock call reaches the
// broker instead of answering UNMAPPED_CAPABILITY.
describe('Mini-IDE plugin — embedded AI panel port over the capability shim', () => {
  const callCapability = vi.fn()
  beforeEach(() => {
    callCapability.mockReset()
    ;(window as unknown as { nav: unknown }).nav = {
      callCapability,
      on: vi.fn(() => () => {}),
      ready: vi.fn(),
    }
  })

  it('registers and unregisters the panel through the terminal namespace', async () => {
    callCapability.mockResolvedValue({ reqId: 'r', ok: true, result: { ok: true } })
    const port = createHostTerminalDockPort(useBackend())
    const pane = {
      pane_id: 'ab12cd34-editor-ai-terminal',
      name: 'editor-claude',
      workspace_path: '/w',
      agent_key: 'claude',
      surface: 'editor',
      window_kind: 'editor',
    }
    expect((await port.registerAgentPane!(pane)).ok).toBe(true)
    expect(callCapability).toHaveBeenLastCalledWith('terminal', 'agent_msg_register_dock', pane)
    expect((await port.unregisterAgentPane!(pane.pane_id)).ok).toBe(true)
    expect(callCapability).toHaveBeenLastCalledWith('terminal', 'agent_msg_unregister_dock', {
      pane_id: pane.pane_id,
    })
  })

  it('reads the panel restore record through the terminal namespace', async () => {
    callCapability.mockResolvedValue({
      reqId: 'r',
      ok: true,
      result: { record: { agent: 'codex', session_id: 's-1' } },
    })
    const port = createHostTerminalDockPort(useBackend())
    expect(await port.readDockRestore!('/w', 'ab12cd34-editor-ai-terminal'))
      .toEqual({ agentKey: 'codex', sessionId: 's-1' })
    expect(callCapability).toHaveBeenCalledWith('terminal', 'dock_record', {
      workspace_path: '/w',
      pane_id: 'ab12cd34-editor-ai-terminal',
    })
  })

  it('offers no delivery, so the panel registers as not deliverable', () => {
    // The broker never forwards agent_msg.deliver to a plugin view: a panel
    // that claimed to be deliverable would be accepted as a target and then
    // never hear its messages.
    const port = createHostTerminalDockPort(useBackend())
    expect(port.onAgentMessage).toBeUndefined()
    expect(port.reportAgentDelivery).toBeUndefined()
  })
})
