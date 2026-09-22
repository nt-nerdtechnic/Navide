import { describe, it, expect, beforeEach } from 'vitest'
import {
  useAgentMessaging,
  _resetMessagingForTest,
  ACK_REASON,
  RATE_LIMIT_MAX,
  type MessageReason,
  type MessagingDeps,
} from '../useAgentMessaging'

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

describe('useAgentMessaging — ack messages', () => {
  let clock: number
  let idlePanes: Set<string>
  let delivered: Array<{ paneId: string; text: string }>
  let reports: Array<{ msgKey: string; ok: boolean; reason: MessageReason | null }>
  let m: ReturnType<typeof useAgentMessaging>

  const deps: MessagingDeps = {
    now: () => clock,
    deliver: async (paneId, text) => {
      delivered.push({ paneId, text })
      return true
    },
    isPaneIdle: (paneId) => idlePanes.has(paneId),
    reportDelivery: (msgKey, ok, reason) => {
      reports.push({ msgKey, ok, reason })
    },
  }

  beforeEach(() => {
    _resetMessagingForTest()
    clock = 1_000_000
    idlePanes = new Set(['p1', 'p2'])
    delivered = []
    reports = []
    m = useAgentMessaging()
    m.configureMessaging(deps)
    m.registerPane('p1', 'claude')
    m.registerPane('p2', 'codex')
  })

  it('logs an ack as delivered without putting it in the target queue', async () => {
    const msg = m.sendMessage('claude-1', 'codex-1', 'got it', { kind: 'ack' })

    expect(msg.status).toBe('delivered')
    expect(msg.route).toBe('ack')
    expect(msg.kind).toBe('ack')
    // The guarantee: nothing for the pump to find, so nothing can ever be
    // typed into the recipient.
    expect(m.queuedCountFor('p2')).toBe(0)
    await m.pump()
    await flush()
    expect(delivered).toEqual([])
  })

  it('spends the pair rate-limit budget like any other send', () => {
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      expect(m.sendMessage('claude-1', 'codex-1', `ack ${i}`, { kind: 'ack' }).status).toBe(
        'delivered',
      )
    }
    const over = m.sendMessage('claude-1', 'codex-1', 'one too many', { kind: 'ack' })
    expect(over.status).toBe('failed')
    expect(over.reason?.key).toBe('rate-limit')
    expect(m.queuedCountFor('p2')).toBe(0)
  })

  it('accepts a remote ack into the log only, and reports it as delivered', async () => {
    const accepted = m.acceptRemoteMessage({
      msgKey: 'pX:mcp:abc',
      targetPaneId: 'p2',
      fromDisplay: 'alpha/planner',
      content: 'done, thanks',
      remoteWorkspace: '/ws/alpha',
      kind: 'ack',
    })

    expect(accepted).toBe(true)
    expect(m.queuedCountFor('p2')).toBe(0)
    await m.pump()
    await flush()
    expect(delivered).toEqual([])

    const row = m.messages.value.find((x) => x.correlationId === 'pX:mcp:abc')
    expect(row?.kind).toBe('ack')
    expect(row?.status).toBe('delivered')
    expect(row?.route).toBe('ack')
    // Without a positive report the sender's cli_check_message never settles.
    expect(reports).toEqual([{ msgKey: 'pX:mcp:abc', ok: true, reason: ACK_REASON }])
  })

  it('leaves an ordinary message on the queue exactly as before', () => {
    idlePanes.clear()
    const local = m.sendMessage('claude-1', 'codex-1', 'run the tests')
    expect(local.status).toBe('queued')
    expect(local.kind).toBeUndefined()
    expect(local.route).toBeUndefined()
    expect(m.queuedCountFor('p2')).toBe(1)

    m.acceptRemoteMessage({
      msgKey: 'pX:mcp:def',
      targetPaneId: 'p2',
      fromDisplay: 'alpha/planner',
      content: 'and then deploy',
    })
    expect(m.queuedCountFor('p2')).toBe(2)
    expect(reports).toEqual([])
  })
})
