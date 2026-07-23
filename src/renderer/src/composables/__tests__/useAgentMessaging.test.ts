import { describe, it, expect, beforeEach } from 'vitest'
import {
  useAgentMessaging,
  _resetMessagingForTest,
  RATE_LIMIT_MAX,
  QUEUE_CAP,
  USER_SENDER,
  type MessagingDeps,
} from '../useAgentMessaging'
import { MSG_ENVELOPE_PREFIX } from '../../lib/agentMessaging'

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

describe('useAgentMessaging', () => {
  let clock: number
  let idlePanes: Set<string>
  let delivered: Array<{ paneId: string; text: string }>
  let deliverResult: boolean
  let m: ReturnType<typeof useAgentMessaging>

  const deps: MessagingDeps = {
    now: () => clock,
    deliver: async (paneId, text) => {
      delivered.push({ paneId, text })
      return deliverResult
    },
    isPaneIdle: (paneId) => idlePanes.has(paneId),
  }

  beforeEach(() => {
    _resetMessagingForTest()
    clock = 1_000_000
    idlePanes = new Set(['p1', 'p2'])
    delivered = []
    deliverResult = true
    m = useAgentMessaging()
    m.configureMessaging(deps)
  })

  describe('name registry', () => {
    it('auto-assigns unique names per agentKey', () => {
      expect(m.registerPane('p1', 'claude')).toBe('claude-1')
      expect(m.registerPane('p2', 'claude')).toBe('claude-2')
      expect(m.registerPane('p3', 'codex')).toBe('codex-1')
    })

    it('is idempotent per pane and honors a free preferred name', () => {
      expect(m.registerPane('p1', 'claude', 'Backend A')).toBe('Backend A')
      expect(m.registerPane('p1', 'claude')).toBe('Backend A')
      expect(m.registerPane('p2', 'claude', 'Backend A')).toBe('claude-1')
    })

    it('rename enforces validity and uniqueness', () => {
      m.registerPane('p1', 'claude')
      m.registerPane('p2', 'codex')
      expect(m.renamePane('p1', '前端組')).toBe(true)
      expect(m.nameOf('p1')).toBe('前端組')
      expect(m.paneIdOf('前端組')).toBe('p1')
      expect(m.paneIdOf('claude-1')).toBeNull()
      expect(m.renamePane('p2', '前端組')).toBe(false)
      expect(m.renamePane('p2', '   ')).toBe(false)
    })
  })

  describe('sendMessage validation', () => {
    beforeEach(() => {
      m.registerPane('p1', 'claude') // claude-1
      m.registerPane('p2', 'codex') // codex-1
    })

    it('fails on unknown target', () => {
      const msg = m.sendMessage('claude-1', 'ghost', 'hi')
      expect(msg.status).toBe('failed')
      expect(msg.reason).toContain('unknown target')
    })

    it('fails on self-send', () => {
      const msg = m.sendMessage('claude-1', 'claude-1', 'hi')
      expect(msg.status).toBe('failed')
      expect(msg.reason).toContain('same pane')
    })

    it('rate-limits a sender→target pair, but never the user', () => {
      idlePanes.clear() // keep everything queued
      for (let i = 0; i < RATE_LIMIT_MAX; i++) {
        expect(m.sendMessage('claude-1', 'codex-1', `n${i}`).status).toBe('queued')
      }
      expect(m.sendMessage('claude-1', 'codex-1', 'over').status).toBe('failed')
      // other pair unaffected; user sender bypasses the pair rate limit
      expect(m.sendMessage('codex-1', 'claude-1', 'x').status).toBe('queued')
      for (let i = 0; i < RATE_LIMIT_MAX + 2; i++) {
        expect(m.sendMessage(USER_SENDER, 'claude-1', `u${i}`).status).toBe('queued')
      }
    })

    it('rate limit window slides with time', () => {
      idlePanes.clear()
      for (let i = 0; i < RATE_LIMIT_MAX; i++) m.sendMessage('claude-1', 'codex-1', `n${i}`)
      clock += 61_000
      expect(m.sendMessage('claude-1', 'codex-1', 'later').status).toBe('queued')
    })

    it('caps the per-target queue', () => {
      idlePanes.clear()
      for (let i = 0; i < QUEUE_CAP; i++) {
        expect(m.sendMessage(USER_SENDER, 'codex-1', `n${i}`).status).toBe('queued')
      }
      const over = m.sendMessage(USER_SENDER, 'codex-1', 'over')
      expect(over.status).toBe('failed')
      expect(over.reason).toContain('queue full')
    })
  })

  describe('delivery', () => {
    beforeEach(() => {
      m.registerPane('p1', 'claude')
      m.registerPane('p2', 'codex')
    })

    it('delivers the envelope to the target pane when idle', async () => {
      const msg = m.sendMessage('claude-1', 'codex-1', 'hello codex')
      m.pump()
      await flush()
      expect(msg.status).toBe('delivered')
      expect(delivered).toHaveLength(1)
      expect(delivered[0].paneId).toBe('p2')
      expect(delivered[0].text).toContain(`${MSG_ENVELOPE_PREFIX} claude-1`)
      expect(delivered[0].text).toContain('hello codex')
    })

    it('waits for the target to become idle', async () => {
      idlePanes.delete('p2')
      const msg = m.sendMessage('claude-1', 'codex-1', 'hi')
      m.pump()
      await flush()
      expect(msg.status).toBe('queued')
      expect(delivered).toHaveLength(0)
      idlePanes.add('p2')
      m.pump()
      await flush()
      expect(msg.status).toBe('delivered')
    })

    it('marks failed when injection does not verify', async () => {
      deliverResult = false
      const msg = m.sendMessage('claude-1', 'codex-1', 'hi')
      m.pump()
      await flush()
      expect(msg.status).toBe('failed')
      expect(msg.reason).toContain('injection failed')
    })

    it('delivers FIFO per target, one at a time', async () => {
      const a = m.sendMessage('claude-1', 'codex-1', 'first')
      const b = m.sendMessage('claude-1', 'codex-1', 'second')
      m.pump()
      await flush()
      m.pump()
      await flush()
      expect(a.status).toBe('delivered')
      expect(b.status).toBe('delivered')
      expect(delivered.map((d) => d.text.includes('first'))).toEqual([true, false])
    })

    it('pause holds the queue; resume flushes it', async () => {
      m.pauseMessaging()
      const msg = m.sendMessage('claude-1', 'codex-1', 'hi')
      m.pump()
      await flush()
      expect(msg.status).toBe('queued')
      m.resumeMessaging()
      await flush()
      expect(msg.status).toBe('delivered')
    })

    it('unregisterPane fails its queued messages', () => {
      idlePanes.clear()
      const msg = m.sendMessage('claude-1', 'codex-1', 'hi')
      m.unregisterPane('p2')
      expect(msg.status).toBe('failed')
      expect(msg.reason).toContain('closed')
      expect(m.paneIdOf('codex-1')).toBeNull()
    })
  })
})
