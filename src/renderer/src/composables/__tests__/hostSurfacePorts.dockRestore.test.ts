import { describe, expect, it } from 'vitest'
import { createMockBackend } from './mockBackend'

// An embedded AI panel (AiCliDock) whose PTY did not survive an app quit asks
// the host port for its restore record, and resumes the session it names.
describe('Host terminal dock adapter — panel restore record', () => {
  it('asks the backend for the panel record and returns its agent and session', async () => {
    const { terminalPort, sent, setResponse } = createMockBackend()
    setResponse('terminal.dock_record', { record: { agent: 'codex', session_id: 's-1' } })
    await expect(terminalPort.readDockRestore!('/ws', 'pane-1')).resolves.toEqual({ agentKey: 'codex', sessionId: 's-1' })
    expect(sent).toEqual([{ type: 'terminal.dock_record', payload: { workspace_path: '/ws', pane_id: 'pane-1' }, timeoutMs: undefined }])
  })

  it('returns null when there is no record', async () => {
    const { terminalPort, setResponse } = createMockBackend()
    setResponse('terminal.dock_record', { record: null })
    await expect(terminalPort.readDockRestore!('/ws', 'pane-1')).resolves.toBeNull()
  })

  it('returns null when the backend refuses (an older backend has no such handler)', async () => {
    const { terminalPort, setResponse } = createMockBackend()
    setResponse('terminal.dock_record', null, { ok: false, error: { code: 'UNKNOWN_TYPE', message: 'no' } })
    await expect(terminalPort.readDockRestore!('/ws', 'pane-1')).resolves.toBeNull()
  })
})
