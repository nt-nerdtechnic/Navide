import { describe, it, expect, beforeEach } from 'vitest'
import {
  useAgentMessaging,
  _resetMessagingForTest,
  type MessageHold,
  type MessageReason,
  type MessagingDeps,
} from '../useAgentMessaging'

/**
 * A message whose pane has stopped reading its PTY.
 *
 * The injection (App.vue's injectText, driven by lib/ptyInputBlock.ts) waits
 * for the CLI rather than re-sending; while it waits, the row stays
 * `delivering` and carries a `pty-blocked` hold that reaches the backend the
 * same way a queued row's hold does. These tests drive that hold from a fake
 * deliver() and assert what the row, the hold report and a cancel do with it.
 */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

describe('useAgentMessaging — pty-blocked delivering hold', () => {
  let clock: number
  let holds: Array<{ msgKey: string; hold: MessageHold | null }>
  let reports: Array<{ msgKey: string; ok: boolean; reason: MessageReason | null }>
  /** The in-flight injection: resolve it to say how the write ended. */
  let gate: { resolve: (ok: boolean) => void; shouldAbort?: () => boolean } | null
  let deliverCalls: number
  let m: ReturnType<typeof useAgentMessaging>

  const deps: MessagingDeps = {
    now: () => clock,
    deliver: (_paneId, _text, shouldAbort) =>
      new Promise<boolean>((resolve) => {
        deliverCalls++
        gate = { resolve, shouldAbort }
      }),
    isPaneIdle: () => true,
    reportDelivery: (msgKey, ok, reason) => {
      reports.push({ msgKey, ok, reason })
    },
    reportHold: (msgKey, hold) => {
      holds.push({ msgKey, hold })
    },
  }

  /** An MCP cli_send for p2, pumped into its injection. */
  async function acceptAndPump(msgKey = 'mcp:1') {
    m.acceptRemoteMessage({
      msgKey,
      targetPaneId: 'p2',
      fromDisplay: 'an external client',
      content: 'do the thing',
    })
    m.pump()
    await flush()
    const row = m.messages.value.find((x) => x.status === 'delivering')
    expect(row).toBeDefined()
    return row!
  }

  beforeEach(() => {
    _resetMessagingForTest()
    clock = 1_000_000
    holds = []
    reports = []
    gate = null
    deliverCalls = 0
    m = useAgentMessaging()
    m.configureMessaging(deps)
    m.registerPane('p1', 'claude', 'sender')
    m.registerPane('p2', 'codex', 'target')
  })

  it('keeps the row delivering and reports pty-blocked while the PTY is not reading', async () => {
    const row = await acceptAndPump()
    m.setDeliveringHold('p2', { key: 'pty-blocked' })

    expect(row.status).toBe('delivering')
    expect(row.hold).toEqual({ key: 'pty-blocked' })
    expect(holds).toEqual([{ msgKey: 'mcp:1', hold: { key: 'pty-blocked' } }])
    // Still one injection in flight: nothing re-sent, nothing re-queued.
    expect(deliverCalls).toBe(1)
    expect(m.messages.value.filter((x) => x.status === 'queued')).toHaveLength(0)
  })

  it('lands on delivered once the PTY reads and the injection finishes', async () => {
    const row = await acceptAndPump()
    m.setDeliveringHold('p2', { key: 'pty-blocked' })
    m.setDeliveringHold('p2', undefined)
    gate!.resolve(true)
    await flush()

    expect(row.status).toBe('delivered')
    expect(row.hold).toBeUndefined()
    expect(holds.map((h) => h.hold)).toEqual([{ key: 'pty-blocked' }, null])
    expect(reports).toEqual([{ msgKey: 'mcp:1', ok: true, reason: null }])
  })

  it('lets the user withdraw a message the pane has not read, and settles it cancelled', async () => {
    const row = await acceptAndPump()
    m.setDeliveringHold('p2', { key: 'pty-blocked' })

    expect(m.cancelMessage(row.id)).toBe(true)
    // The injection sees the abort, clears what it wrote and reports false.
    expect(gate!.shouldAbort?.()).toBe(true)
    m.setDeliveringHold('p2', undefined)
    gate!.resolve(false)
    await flush()

    expect(row.status).toBe('cancelled')
    expect(row.hold).toBeUndefined()
    expect(reports).toEqual([{ msgKey: 'mcp:1', ok: false, reason: { key: 'cancelled' } }])
  })

  it('honours another window\'s cancel request the same way', async () => {
    const row = await acceptAndPump()
    m.setDeliveringHold('p2', { key: 'pty-blocked' })

    expect(m.cancelRemoteInbound('mcp:1')).toBe(true)
    expect(gate!.shouldAbort?.()).toBe(true)
    gate!.resolve(false)
    await flush()
    expect(row.status).toBe('cancelled')
  })

  it('still refuses to cancel an ordinary in-flight injection', async () => {
    const row = await acceptAndPump()
    expect(m.cancelMessage(row.id)).toBe(false)
    expect(gate!.shouldAbort?.()).toBe(false)
  })

  it('fails once as pane-closed when the pane goes while the PTY holds the text', async () => {
    const row = await acceptAndPump()
    m.setDeliveringHold('p2', { key: 'pty-blocked' })

    m.unregisterPane('p2')
    expect(row.status).toBe('failed')
    expect(row.reason).toEqual({ key: 'pane-closed' })
    // The injection's own false, arriving later, must not re-fail it.
    gate!.resolve(false)
    await flush()

    expect(row.status).toBe('failed')
    expect(row.reason).toEqual({ key: 'pane-closed' })
    expect(reports).toEqual([{ msgKey: 'mcp:1', ok: false, reason: { key: 'pane-closed' } }])
  })

  it('ignores a hold for a pane with nothing in flight', () => {
    m.setDeliveringHold('p2', { key: 'pty-blocked' })
    expect(holds).toEqual([])
  })
})
