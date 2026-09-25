import { describe, it, expect, beforeEach } from 'vitest'
import {
  useAgentMessaging,
  _resetMessagingForTest,
  NOTICE_SENDER,
  TERMINAL_AGENT_KEY,
  STALE_HOLD_MS,
  type MessageReason,
  type MessagingDeps,
} from '../useAgentMessaging'

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

/** A plain terminal pane runs whatever is typed into it, so every path that
 *  can reach one must type the message body and nothing else. */
describe('useAgentMessaging — plain terminal targets', () => {
  let idlePanes: Set<string>
  let delivered: Array<{ paneId: string; text: string }>
  let reports: Array<{ msgKey: string; ok: boolean; reason: MessageReason | null }>
  let m: ReturnType<typeof useAgentMessaging>

  const deps: MessagingDeps = {
    now: () => 1_000_000,
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
    idlePanes = new Set(['agent', 'shell', 'other'])
    delivered = []
    reports = []
    m = useAgentMessaging()
    m.configureMessaging(deps)
    m.registerPane('agent', 'claude', 'boss')
    m.registerPane('shell', TERMINAL_AGENT_KEY, 'sh')
  })

  it('types the bare body into a terminal — no envelope, reply hint or sender line', async () => {
    m.sendMessage('boss', 'sh', 'ls -la\necho done')
    m.pump()
    await flush()
    expect(delivered).toEqual([{ paneId: 'shell', text: 'ls -la\necho done' }])
  })

  it('does not neutralize marker tokens — the shell gets the text verbatim', async () => {
    m.sendMessage('boss', 'sh', "grep -- '---MSG-START---' log.txt")
    m.pump()
    await flush()
    expect(delivered[0].text).toBe("grep -- '---MSG-START---' log.txt")
  })

  it('never types a Navide notice or fallback report into a terminal', async () => {
    const notice = m.sendMessage(NOTICE_SENDER, 'sh', 'delivery failed', { kind: 'notice' })
    const fallback = m.sendMessage('boss', 'sh', 'my result', { kind: 'fallback' })
    m.pump()
    await flush()
    // The bounced fallback's sender (an agent) may hear about it; the shell never does.
    expect(delivered.filter((d) => d.paneId === 'shell')).toEqual([])
    expect(notice.status).toBe('failed')
    expect(fallback.status).toBe('failed')
  })

  it('leaves terminals out of an `all` broadcast', async () => {
    m.registerPane('other', 'codex', 'peer')
    const sent = m.sendBroadcast('boss', 'status?')
    m.pump()
    await flush()
    expect(sent.map((msg) => msg.to)).toEqual(['peer'])
    expect(delivered.map((d) => d.paneId)).toEqual(['other'])
  })

  it('types an inbound cli_send body into a terminal bare', async () => {
    m.acceptRemoteMessage({ msgKey: 'k1', targetPaneId: 'shell', fromDisplay: 'boss', content: 'pwd' })
    await flush()
    expect(delivered).toEqual([{ paneId: 'shell', text: 'pwd' }])
    expect(reports).toEqual([{ msgKey: 'k1', ok: true, reason: null }])
  })

  it('refuses external content (chat channel, remote device) for a terminal', async () => {
    m.acceptRemoteMessage({
      msgKey: 'k2', targetPaneId: 'shell', fromDisplay: 'telegram:alice', content: 'rm -rf ~', external: true,
    })
    await flush()
    expect(delivered).toEqual([])
    expect(reports).toHaveLength(1)
    expect(reports[0].ok).toBe(false)
  })
})

describe('useAgentMessaging — a command held for a terminal expires', () => {
  it('fails a message queued for a busy terminal past STALE_HOLD_MS instead of typing it late', async () => {
    _resetMessagingForTest()
    let now = 1_000_000
    let idle = false
    const delivered: string[] = []
    const m = useAgentMessaging()
    m.configureMessaging({
      now: () => now,
      deliver: async (p, text) => { if (p === 'shell') delivered.push(text); return true },
      isPaneIdle: () => idle,
    })
    m.registerPane('agent', 'claude', 'boss')
    m.registerPane('shell', TERMINAL_AGENT_KEY, 'sh')
    const msg = m.sendMessage('boss', 'sh', 'make deploy')
    m.pump()
    await flush()
    expect(msg.status).toBe('queued')
    now += STALE_HOLD_MS + 1
    idle = true
    m.pump()
    await flush()
    expect(delivered).toEqual([])
    expect(msg.status).toBe('failed')
  })
})

describe('useAgentMessaging — refuseDelivery', () => {
  it('fails a message the pane refuses, with the refusal as the reason, and types nothing', async () => {
    _resetMessagingForTest()
    const delivered: string[] = []
    const reports: Array<{ ok: boolean; reason: MessageReason | null }> = []
    const m = useAgentMessaging()
    m.configureMessaging({
      now: () => 1_000_000,
      deliver: async (p, text) => { if (p === 'shell') delivered.push(text); return true },
      isPaneIdle: () => true,
      refuseDelivery: (paneId, envelope) =>
        paneId === 'shell' && envelope.includes('\n') ? { key: 'raw', params: { text: 'one line at a time' } } : null,
      reportDelivery: (_k, ok, reason) => { reports.push({ ok, reason }) },
    })
    m.registerPane('agent', 'claude', 'boss')
    m.registerPane('shell', TERMINAL_AGENT_KEY, 'sh')
    const accepted = m.acceptRemoteMessage({
      msgKey: 'k1', targetPaneId: 'shell', fromDisplay: 'mcp', content: 'a\nb',
    } as Parameters<typeof m.acceptRemoteMessage>[0])
    expect(accepted).toBe(true)
    m.pump()
    await flush()
    expect(delivered).toEqual([])
    expect(reports).toEqual([{ ok: false, reason: { key: 'raw', params: { text: 'one line at a time' } } }])
    const single = m.sendMessage('boss', 'sh', 'ls')
    m.pump()
    await flush()
    expect(delivered).toEqual(['ls'])
    expect(single.status).toBe('delivered')
  })
})

describe('useAgentMessaging — a delivery refused for good', () => {
  it('fails the message with the refusal the deliver dep returned, and tells the sender', async () => {
    _resetMessagingForTest()
    const reports: Array<{ ok: boolean; reason: MessageReason | null }> = []
    const refusal: MessageReason = { key: 'raw', params: { text: 'refused to type into a terminal: `sudo ls`' } }
    const m = useAgentMessaging()
    m.configureMessaging({
      now: () => 1_000_000,
      deliver: async () => ({ failed: refusal }),
      isPaneIdle: () => true,
      reportDelivery: (_k, ok, reason) => { reports.push({ ok, reason }) },
    })
    m.registerPane('shell', TERMINAL_AGENT_KEY, 'sh')
    m.acceptRemoteMessage({
      msgKey: 'k1', targetPaneId: 'shell', fromDisplay: 'mcp', content: 'sudo ls',
    } as Parameters<typeof m.acceptRemoteMessage>[0])
    m.pump()
    await flush()
    expect(reports).toEqual([{ ok: false, reason: refusal }])
    expect(m.messages.value.find((x) => x.content === 'sudo ls')?.status).toBe('failed')
  })
})
