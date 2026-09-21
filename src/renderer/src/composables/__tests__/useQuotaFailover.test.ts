// @vitest-environment happy-dom
// useQuotaFailover — the renderer's side of the quota_failover.* contract,
// driven through a fake backend: prepare answered per pane and re-answered
// when a busy pane frees up, commit acted on exactly once per pane with no
// prompt sent, reconnect alignment, announcement buttons carrying the epoch
// the backend checks, and the manual switch-back surviving a closed incident.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'

const store = vi.hoisted(() => new Map<string, unknown>())
vi.mock('@navide/plugin-ui/shared', () => ({
  settingsGet: (key: string, fallback: unknown) => (store.has(key) ? store.get(key) : fallback),
  settingsSet: (key: string, value: unknown) => {
    store.set(key, value)
  },
}))

import {
  ackPayload,
  noticeFromIncident,
  PREPARE_RECHECK_MS,
  useQuotaFailover,
  type CommitEvent,
  type FailoverCandidate,
  type FailoverIncident,
  type FailoverState,
  type FailoverTransaction,
  type PaneReadiness,
  type PrepareEvent,
  type QuotaFailoverHooks,
} from '../useQuotaFailover'
import { __resetQuotaAnnouncementsForTest, useAnnouncements } from '../useAnnouncements'

type Handler = (raw: unknown) => void

const T0 = '2026-09-21T10:00:00.000Z'
const T1 = '2026-09-21T10:01:00.000Z'

function incident(patch: Partial<FailoverIncident> = {}): FailoverIncident {
  return {
    id: 'inc-1',
    agentKey: 'claude',
    authScope: 'claude',
    outgoingSlotId: 'slot-a',
    epoch: 7,
    state: 'detected',
    reason: null,
    trusted: true,
    attribution: 'pane-history',
    autoAllowed: true,
    tried: [],
    panes: [
      { paneId: 'p1', workspacePath: '/ws/a' },
      { paneId: 'p2', workspacePath: '/ws/a' },
      { paneId: 'p3', workspacePath: '/ws/b' },
    ],
    transactionIds: [],
    detectedAt: T0,
    resetsAt: '2026-09-21T15:00:00.000Z',
    windowKind: 'session',
    closedAt: null,
    updatedAt: T0,
    ...patch,
  }
}

function transaction(patch: Partial<FailoverTransaction> = {}): FailoverTransaction {
  return {
    id: 'tx-1',
    incidentId: 'inc-1',
    agentKey: 'claude',
    authScope: 'claude',
    fromSlotId: 'slot-a',
    toSlotId: 'slot-b',
    automatic: false,
    idempotencyKey: 'k1',
    switchMode: 'restart',
    restartStrategy: 'resume',
    confirmation: 'none',
    state: 'preparing',
    reason: null,
    error: null,
    swapped: false,
    epochBefore: 7,
    epochAfter: null,
    panes: [
      { paneId: 'p1', termId: 't1', agentKey: 'claude', workspacePath: '/ws/a', ack: null, ackReason: null, settle: null, settleReason: null },
      { paneId: 'p2', termId: 't2', agentKey: 'claude', workspacePath: '/ws/a', ack: null, ackReason: null, settle: null, settleReason: null },
    ],
    createdAt: T0,
    committedAt: null,
    closedAt: null,
    ...patch,
  }
}

function state(patch: Partial<FailoverState> = {}): FailoverState {
  return {
    policy: { mode: 'notify', updatedAt: null },
    capabilities: {
      claude: { agentKey: 'claude', supported: true, switchMode: 'hot', authScope: 'claude', evidence: 'source', resume: 'native', scopes: [], hasSlots: true, todo: '' },
    },
    budget: {},
    epochs: { claude: 7 },
    incidents: [],
    transactions: [],
    ...patch,
  }
}

const labels = {
  agentLabel: (k: string) => (k === 'claude' ? 'Claude Code' : k),
  slotLabel: (_k: string, slot: string) => (slot === '__default__' ? 'Default' : `${slot}@example.com`),
}

describe('noticeFromIncident (pure)', () => {
  const cands: FailoverCandidate[] = [
    { slotId: 'slot-b', tier: 'fresh-headroom', loginState: 'ok', excluded: null, headroom: 78.4, fetchedAt: T0 },
    { slotId: '__default__', tier: 'unknown', loginState: 'ok', excluded: null, headroom: null, fetchedAt: null },
    { slotId: 'slot-a', tier: 'unknown', loginState: 'ok', excluded: 'current', headroom: null, fetchedAt: null },
    { slotId: 'slot-c', tier: 'unknown', loginState: 'signed-out', excluded: 'signed-out', headroom: null, fetchedAt: null },
    { slotId: 'slot-d', tier: 'reset-expected', loginState: 'ok', excluded: 'exhausted', headroom: null, fetchedAt: null },
  ]

  it('lists candidates (default slot included) and the excluded with reasons, current omitted', () => {
    const n = noticeFromIncident(incident(), [], cands, labels)
    expect(n).toMatchObject({
      status: 'detected',
      epoch: 7,
      untrusted: false,
      sourceLabel: 'slot-a@example.com',
      affected: { workspaces: 2, panes: 3 },
      resetExpectedAt: Date.parse('2026-09-21T15:00:00.000Z'),
    })
    expect(n.candidates).toEqual([
      { slotId: 'slot-b', label: 'slot-b@example.com', tier: 'fresh-headroom', detail: '78%' },
      { slotId: '__default__', label: 'Default', tier: 'unknown', detail: undefined },
    ])
    expect(n.excluded).toEqual([
      { label: 'slot-c@example.com', reason: 'signed-out' },
      { label: 'slot-d@example.com', reason: 'exhausted' },
    ])
    expect(n.switchBack).toBeUndefined()
  })

  it('an untrusted incident offers nothing and carries the backend reason', () => {
    const n = noticeFromIncident(incident({ trusted: false, reason: 'usage-window-disagrees' }), [], cands, labels)
    expect(n.untrusted).toBe(true)
    expect(n.candidates).toEqual([])
    expect(n.reason).toBe('usage-window-disagrees')
  })

  it('shows awaiting-confirmation from the transaction, and partial from a partial one', () => {
    const awaiting = noticeFromIncident(incident(), [transaction({ state: 'awaiting-confirmation', confirmation: 'required', restartStrategy: 'new-conversation' })], cands, labels)
    expect(awaiting.status).toBe('awaiting-confirmation')
    expect(awaiting.targetLabel).toBe('slot-b@example.com')
    expect(awaiting.candidates).toEqual([])

    const partial = noticeFromIncident(
      incident({ state: 'notify-stopped', reason: 'resume-failed' }),
      [transaction({ state: 'partial', swapped: true, epochAfter: 8, committedAt: T1, panes: [
        { paneId: 'p1', termId: 't1', agentKey: 'claude', workspacePath: '/ws/a', ack: 'ready', ackReason: null, settle: 'resumed', settleReason: null },
        { paneId: 'p2', termId: 't2', agentKey: 'claude', workspacePath: '/ws/a', ack: 'ready', ackReason: null, settle: 'failed', settleReason: 'missing-session' },
      ] })],
      cands,
      labels,
    )
    expect(partial.status).toBe('partial')
    expect(partial.retryResume).toBe(true)
    expect(partial.epoch).toBe(8)
    expect(partial.switchBack).toEqual({ slotId: 'slot-a', label: 'slot-a@example.com' })
  })

  it('after a commit the buttons carry the post-switch epoch and a switch-back, never more candidates', () => {
    const n = noticeFromIncident(
      incident({ state: 'ready', reason: 'quota-confirmed', closedAt: T1, updatedAt: T1 }),
      [transaction({ state: 'committed', swapped: true, epochAfter: 8, committedAt: T1, closedAt: T1 })],
      cands,
      labels,
    )
    expect(n.status).toBe('ready')
    expect(n.epoch).toBe(8)
    expect(n.candidates).toEqual([])
    expect(n.switchBack).toEqual({ slotId: 'slot-a', label: 'slot-a@example.com' })
    expect(n.retryResume).toBe(false)
  })
})

describe('ackPayload (pure)', () => {
  it('a ready pane claims a turn boundary and names its session', () => {
    expect(ackPayload('tx-1', 'p1', { ready: true, sessionId: 's1', resumable: true })).toEqual({
      transaction_id: 'tx-1', pane_id: 'p1', ready: true, idle: 'turn-boundary', resume: { session_id: 's1', resumable: true },
    })
    expect(ackPayload('tx-1', 'p1', { ready: false, reason: 'busy' })).toEqual({ transaction_id: 'tx-1', pane_id: 'p1', ready: false, reason: 'busy' })
  })
})

describe('useQuotaFailover (fake backend)', () => {
  const handlers = new Map<string, Handler>()
  const sent: { type: string; payload: Record<string, unknown> }[] = []
  let responder: (type: string, payload: Record<string, unknown>) => unknown
  const status = ref<'connected' | 'disconnected'>('disconnected')
  const backend = {
    status,
    send: vi.fn(async (type: string, payload: Record<string, unknown>) => {
      sent.push({ type, payload })
      const answer = responder(type, payload)
      if (answer && typeof answer === 'object' && 'error' in (answer as object)) {
        const e = (answer as { error: { code: string; message: string; details?: Record<string, unknown> } }).error
        return { ok: false, payload: null, error: e }
      }
      return { ok: true, payload: answer, error: null }
    }),
    on: vi.fn((type: string, cb: Handler) => {
      handlers.set(type, cb)
      return () => handlers.delete(type)
    }),
  }
  const readiness = new Map<string, PaneReadiness>()
  const owned = new Set(['p1', 'p2'])
  const termIds = new Map<string, string>([['p1', 't1'], ['p2', 't2']])
  const sessionIds = new Map<string, string>([['p1', 's-p1'], ['p2', 's-p2']])
  let hooks: QuotaFailoverHooks & { restartPane: ReturnType<typeof vi.fn>; openNewConversation: ReturnType<typeof vi.fn>; onSwitchCommitted: ReturnType<typeof vi.fn>; onSwitchRefused: ReturnType<typeof vi.fn>; confirmNewConversation: ReturnType<typeof vi.fn>; confirmLiveIsCurrent: ReturnType<typeof vi.fn>; onIncidentReady: ReturnType<typeof vi.fn> }
  let api: ReturnType<typeof useQuotaFailover>

  function emit(type: string, payload: unknown): void {
    handlers.get(type)?.(payload)
  }
  function sentOf(type: string) {
    return sent.filter((s) => s.type === type).map((s) => s.payload)
  }
  async function flush(): Promise<void> {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  }
  async function reconnect(): Promise<void> {
    status.value = 'disconnected'
    await nextTick()
    status.value = 'connected'
    await nextTick()
    await flush()
  }

  beforeEach(async () => {
    vi.useFakeTimers()
    store.clear()
    store.set('agentTeam.announcements.readIds', [])
    handlers.clear()
    sent.length = 0
    readiness.clear()
    responder = (type) => {
      if (type === 'quota_failover.get_state') return state()
      if (type === 'quota_failover.candidates') return { candidates: [] }
      if (type === 'quota_failover.ack' || type === 'quota_failover.settle' || type === 'quota_failover.cancel' || type === 'quota_failover.confirm' || type === 'quota_failover.switch') return { transaction: transaction() }
      if (type === 'quota_failover.set_policy') return state({ policy: { mode: 'auto', updatedAt: T0 } })
      return {}
    }
    hooks = {
      ownsPane: (id) => owned.has(id),
      paneReadiness: (id) => readiness.get(id) ?? { ready: true, sessionId: `s-${id}`, resumable: true },
      restartPane: vi.fn(async (pane) => ({ outcome: 'resumed' as const, paneId: `${pane.paneId}-new`, termId: `${pane.termId}-new`, sessionId: `s-${pane.paneId}` })),
      openNewConversation: vi.fn(async (pane) => ({ outcome: 'new-conversation' as const, paneId: `${pane.paneId}-fresh`, termId: `${pane.termId}-fresh` })),
      confirmNewConversation: vi.fn(async () => true),
      confirmLiveIsCurrent: vi.fn(async () => true),
      paneTermId: (id) => termIds.get(id) ?? null,
      paneSessionId: (id) => sessionIds.get(id) ?? null,
      agentLabel: labels.agentLabel,
      slotLabel: labels.slotLabel,
      onSwitchCommitted: vi.fn(),
      onIncidentReady: vi.fn(),
      onSwitchRefused: vi.fn(),
    }
    __resetQuotaAnnouncementsForTest()
    api = useQuotaFailover()
    api.__resetQuotaFailoverForTest()
    api.initQuotaFailover(backend as never, hooks)
    status.value = 'connected'
    await nextTick()
    await flush()
  })

  afterEach(() => {
    api.__resetQuotaFailoverForTest()
    status.value = 'disconnected'
    vi.useRealTimers()
  })

  it('loads state on connect and mirrors a trusted incident into the feed with the backend candidates', async () => {
    expect(sentOf('quota_failover.get_state')).toHaveLength(1)
    responder = (type) => {
      if (type === 'quota_failover.candidates') {
        return { candidates: [{ slotId: 'slot-b', tier: 'fresh-headroom', loginState: 'ok', excluded: null, headroom: 60, fetchedAt: T0 }] }
      }
      return {}
    }
    emit('quota_failover.changed', state({ incidents: [incident()] }))
    await flush()
    expect(sentOf('quota_failover.candidates')).toEqual([{ agent_key: 'claude' }])
    const row = useAnnouncements().items.value.find((i) => i.id === 'quota:inc-1')
    expect(row?.actions).toEqual([
      { kind: 'quota-switch', incidentId: 'inc-1', agentKey: 'claude', epoch: 7, slotId: 'slot-b', label: 'slot-b@example.com', tier: 'fresh-headroom' },
    ])
    // The same incident re-broadcast unchanged is not re-fetched.
    emit('quota_failover.changed', state({ incidents: [incident()] }))
    await flush()
    expect(sentOf('quota_failover.candidates')).toHaveLength(1)
  })

  it('answers prepare per owned pane, parks on a busy one and re-acks when it frees up', async () => {
    readiness.set('p2', { ready: false, reason: 'busy' })
    const ev: PrepareEvent = {
      transactionId: 'tx-1', incidentId: 'inc-1', agentKey: 'claude', authScope: 'claude', fromSlotId: 'slot-a', toSlotId: 'slot-b',
      restartStrategy: 'resume', automatic: true, deadlineAt: T1,
      panes: [
        { paneId: 'p1', termId: 't1', agentKey: 'claude', workspacePath: '/ws/a' },
        { paneId: 'p2', termId: 't2', agentKey: 'claude', workspacePath: '/ws/a' },
        { paneId: 'p9', termId: 't9', agentKey: 'claude', workspacePath: '/ws/z' },
      ],
    }
    emit('quota_failover.prepare', ev)
    await flush()
    expect(sentOf('quota_failover.ack')).toEqual([
      { transaction_id: 'tx-1', pane_id: 'p1', ready: true, idle: 'turn-boundary', resume: { session_id: 's-p1', resumable: true } },
      { transaction_id: 'tx-1', pane_id: 'p2', ready: false, reason: 'busy' },
    ])
    // Still busy at the first recheck: nothing new, keep waiting.
    await vi.advanceTimersByTimeAsync(PREPARE_RECHECK_MS)
    expect(sentOf('quota_failover.ack')).toHaveLength(3)
    expect(sentOf('quota_failover.ack')[2]).toMatchObject({ pane_id: 'p2', ready: false, reason: 'busy' })
    // Turn boundary reached: the ready ack goes out and the polling stops.
    readiness.set('p2', { ready: true, sessionId: 's-p2', resumable: true })
    await vi.advanceTimersByTimeAsync(PREPARE_RECHECK_MS)
    expect(sentOf('quota_failover.ack')[3]).toMatchObject({ pane_id: 'p2', ready: true, resume: { session_id: 's-p2', resumable: true } })
    await vi.advanceTimersByTimeAsync(PREPARE_RECHECK_MS * 3)
    expect(sentOf('quota_failover.ack')).toHaveLength(4)
    // Nothing was restarted or typed by a prepare.
    expect(hooks.restartPane).not.toHaveBeenCalled()
  })

  it('a pane waiting on a permission prompt or holding unsent input refuses once, without polling', async () => {
    readiness.set('p1', { ready: false, reason: 'permission-pending' })
    emit('quota_failover.prepare', {
      transactionId: 'tx-1', incidentId: 'inc-1', agentKey: 'claude', authScope: 'claude', fromSlotId: 'slot-a', toSlotId: 'slot-b',
      restartStrategy: 'resume', automatic: true, deadlineAt: T1,
      panes: [{ paneId: 'p1', termId: 't1', agentKey: 'claude', workspacePath: '/ws/a' }],
    } satisfies PrepareEvent)
    await flush()
    expect(sentOf('quota_failover.ack')).toEqual([{ transaction_id: 'tx-1', pane_id: 'p1', ready: false, reason: 'permission-pending' }])
    await vi.advanceTimersByTimeAsync(PREPARE_RECHECK_MS * 3)
    expect(sentOf('quota_failover.ack')).toHaveLength(1)
  })

  it('commit with resume restarts each owned pane exactly once, settles with the new PTY, and sends no prompt', async () => {
    const ev: CommitEvent = {
      transactionId: 'tx-1', incidentId: 'inc-1', agentKey: 'claude', authScope: 'claude', fromSlotId: 'slot-a', toSlotId: 'slot-b',
      epoch: 8, switchMode: 'restart', restartStrategy: 'resume', state: 'committed', needsLogin: false, needsLoginReason: null,
      panes: [
        { paneId: 'p1', termId: 't1', agentKey: 'claude', workspacePath: '/ws/a' },
        { paneId: 'p9', termId: 't9', agentKey: 'claude', workspacePath: '/ws/z' },
      ],
    }
    emit('quota_failover.commit', ev)
    await flush()
    expect(hooks.onSwitchCommitted).toHaveBeenCalledWith(ev)
    expect(hooks.restartPane).toHaveBeenCalledTimes(1)
    expect(hooks.restartPane.mock.calls[0][0]).toMatchObject({ paneId: 'p1' })
    expect(sentOf('quota_failover.settle')).toEqual([
      { transaction_id: 'tx-1', pane_id: 'p1', outcome: 'resumed', term_id: 't1-new', session_id: 's-p1' },
    ])
    // The same commit replayed (a second window relays it, a reconnect
    // re-reads it): no second restart, no second settle.
    emit('quota_failover.commit', ev)
    await flush()
    expect(hooks.restartPane).toHaveBeenCalledTimes(1)
    expect(sentOf('quota_failover.settle')).toHaveLength(1)
    // Nothing else was sent into the pane by the switch itself.
    expect(sent.every((s) => s.type.startsWith('quota_failover.'))).toBe(true)
  })

  it('a hot commit restarts nothing; a failed restart settles as failed', async () => {
    emit('quota_failover.commit', {
      transactionId: 'tx-h', incidentId: 'inc-1', agentKey: 'claude', authScope: 'claude', fromSlotId: 'slot-a', toSlotId: 'slot-b',
      epoch: 8, switchMode: 'hot', restartStrategy: 'none', state: 'committed', needsLogin: false, needsLoginReason: null,
      panes: [{ paneId: 'p1', termId: 't1', agentKey: 'claude', workspacePath: '/ws/a' }],
    } satisfies CommitEvent)
    await flush()
    expect(hooks.restartPane).not.toHaveBeenCalled()
    expect(sentOf('quota_failover.settle')).toEqual([])

    hooks.restartPane.mockResolvedValueOnce({ outcome: 'failed', reason: 'missing-session' })
    emit('quota_failover.commit', {
      transactionId: 'tx-r', incidentId: 'inc-1', agentKey: 'claude', authScope: 'claude', fromSlotId: 'slot-a', toSlotId: 'slot-b',
      epoch: 8, switchMode: 'restart', restartStrategy: 'resume', state: 'committed', needsLogin: false, needsLoginReason: null,
      panes: [{ paneId: 'p2', termId: 't2', agentKey: 'claude', workspacePath: '/ws/a' }],
    } satisfies CommitEvent)
    await flush()
    expect(sentOf('quota_failover.settle')).toEqual([{ transaction_id: 'tx-r', pane_id: 'p2', outcome: 'failed', reason: 'missing-session' }])
  })

  it('new-conversation keeps the old pane and opens a fresh one, settled as such', async () => {
    emit('quota_failover.commit', {
      transactionId: 'tx-n', incidentId: 'inc-1', agentKey: 'aider', authScope: 'aider', fromSlotId: 'slot-a', toSlotId: 'slot-b',
      epoch: 8, switchMode: 'manual', restartStrategy: 'new-conversation', state: 'committed', needsLogin: false, needsLoginReason: null,
      panes: [{ paneId: 'p1', termId: 't1', agentKey: 'aider', workspacePath: '/ws/a' }],
    } satisfies CommitEvent)
    await flush()
    expect(hooks.restartPane).not.toHaveBeenCalled()
    expect(hooks.openNewConversation).toHaveBeenCalledTimes(1)
    expect(sentOf('quota_failover.settle')).toEqual([{ transaction_id: 'tx-n', pane_id: 'p1', outcome: 'new-conversation', term_id: 't1-fresh', session_id: '' }])
  })

  it('a turn completed by the restarted pane settles as turn-complete under the listed pane id', async () => {
    emit('quota_failover.commit', {
      transactionId: 'tx-1', incidentId: 'inc-1', agentKey: 'claude', authScope: 'claude', fromSlotId: 'slot-a', toSlotId: 'slot-b',
      epoch: 8, switchMode: 'restart', restartStrategy: 'resume', state: 'committed', needsLogin: false, needsLoginReason: null,
      panes: [{ paneId: 'p1', termId: 't1', agentKey: 'claude', workspacePath: '/ws/a' }],
    } satisfies CommitEvent)
    await flush()
    emit('quota_failover.changed', state({ transactions: [transaction({ id: 'tx-1', state: 'committed', swapped: true, epochAfter: 8, committedAt: T1 })] }))
    sent.length = 0
    const startedAt = Date.parse(T1) + 5000
    api.noteTurnComplete('p1-new', 't1-new', startedAt)
    expect(sentOf('quota_failover.settle')).toEqual([
      { transaction_id: 'tx-1', pane_id: 'p1', outcome: 'turn-complete', term_id: 't1-new', turn_started_at: new Date(startedAt).toISOString() },
    ])
    // A pane no transaction lists says nothing.
    sent.length = 0
    api.noteTurnComplete('p7', 't7', startedAt)
    expect(sentOf('quota_failover.settle')).toEqual([])
  })

  it('a hot-switched pane reports its turn with the turn start, and only while the transaction is unsettled', async () => {
    emit('quota_failover.changed', state({ transactions: [transaction({ id: 'tx-h', switchMode: 'hot', restartStrategy: 'none', state: 'committed', swapped: true, epochAfter: 8, committedAt: T1 })] }))
    sent.length = 0
    api.noteTurnComplete('p1', 't1', Date.parse(T1) + 1000)
    expect(sentOf('quota_failover.settle')).toEqual([
      { transaction_id: 'tx-h', pane_id: 'p1', outcome: 'turn-complete', term_id: 't1', turn_started_at: new Date(Date.parse(T1) + 1000).toISOString() },
    ])
    emit('quota_failover.changed', state({ recentTransactions: [transaction({ id: 'tx-h', switchMode: 'hot', restartStrategy: 'none', state: 'committed', swapped: true, epochAfter: 8, committedAt: T1, closedAt: T1 })] }))
    sent.length = 0
    api.noteTurnComplete('p1', 't1', Date.parse(T1) + 2000)
    expect(sentOf('quota_failover.settle')).toEqual([])
  })

  it('on reconnect, a committed transaction whose pane already runs a new PTY is settled, not restarted again', async () => {
    termIds.set('p1', 't1-after')
    responder = (type) => {
      if (type === 'quota_failover.get_state') {
        return state({ transactions: [transaction({ state: 'committed', swapped: true, epochAfter: 8, committedAt: T1, panes: [
          { paneId: 'p1', termId: 't1', agentKey: 'claude', workspacePath: '/ws/a', ack: 'ready', ackReason: null, settle: null, settleReason: null, sessionId: 's-p1' },
        ] })] })
      }
      return { transaction: transaction() }
    }
    await reconnect()
    expect(hooks.restartPane).not.toHaveBeenCalled()
    expect(sentOf('quota_failover.settle')).toEqual([{ transaction_id: 'tx-1', pane_id: 'p1', outcome: 'resumed', term_id: 't1-after', session_id: 's-p1' }])
    termIds.set('p1', 't1')
  })

  it('on reconnect, a pane on a new PTY but a different session was not resumed — it is a new conversation', async () => {
    termIds.set('p1', 't1-after')
    sessionIds.set('p1', 's-other')
    responder = (type) => {
      if (type === 'quota_failover.get_state') {
        return state({ transactions: [transaction({ state: 'committed', swapped: true, epochAfter: 8, committedAt: T1, panes: [
          { paneId: 'p1', termId: 't1', agentKey: 'claude', workspacePath: '/ws/a', ack: 'ready', ackReason: null, settle: null, settleReason: null, sessionId: 's-p1' },
        ] })] })
      }
      return { transaction: transaction() }
    }
    await reconnect()
    expect(hooks.restartPane).not.toHaveBeenCalled()
    expect(sentOf('quota_failover.settle')).toEqual([{ transaction_id: 'tx-1', pane_id: 'p1', outcome: 'new-conversation', term_id: 't1-after', session_id: '' }])
    termIds.set('p1', 't1')
    sessionIds.set('p1', 's-p1')
  })

  it('on reconnect, a transaction still preparing gets our panes re-acked', async () => {
    responder = (type) => {
      if (type === 'quota_failover.get_state') return state({ transactions: [transaction({ state: 'waiting-safe' })] })
      return { transaction: transaction() }
    }
    await reconnect()
    expect(sentOf('quota_failover.ack').map((a) => a.pane_id)).toEqual(['p1', 'p2'])
  })

  it('a switch button sends the backend the ids and epoch it carries, automatic:false', async () => {
    emit('quota_failover.changed', state({ incidents: [incident()] }))
    await flush()
    await api.actOn({ kind: 'quota-switch', incidentId: 'inc-1', agentKey: 'claude', epoch: 7, slotId: 'slot-b', label: 'b', tier: 'fresh-headroom' })
    const [sw] = sentOf('quota_failover.switch')
    expect(sw).toMatchObject({ agent_key: 'claude', to_slot_id: 'slot-b', incident_id: 'inc-1', expected_current_slot_id: 'slot-a', expected_epoch: 7, automatic: false })
    expect(typeof sw.idempotency_key).toBe('string')
    expect(sw.force).toBeUndefined()
  })

  it('a stale click withdraws the row buttons and reports the refusal; other refusals only report', async () => {
    emit('quota_failover.changed', state({ incidents: [incident()] }))
    await flush()
    responder = () => ({ error: { code: 'STALE_EPOCH', message: 'epoch moved', details: { epoch: 8 } } })
    await api.actOn({ kind: 'quota-switch', incidentId: 'inc-1', agentKey: 'claude', epoch: 7, slotId: 'slot-b', label: 'b', tier: 'fresh-headroom' })
    expect(hooks.onSwitchRefused).toHaveBeenCalledWith('STALE_EPOCH', 'epoch moved', { epoch: 8 })
    expect(useAnnouncements().items.value.find((i) => i.id === 'quota:inc-1')?.actions).toBeUndefined()

    responder = () => ({ error: { code: 'AUTO_BUDGET_EXHAUSTED', message: 'budget', details: { retryAfter: 600 } } })
    await api.actOn({ kind: 'quota-switch', incidentId: 'inc-1', agentKey: 'claude', epoch: 7, slotId: 'slot-b', label: 'b', tier: 'fresh-headroom' })
    expect(hooks.onSwitchRefused).toHaveBeenLastCalledWith('AUTO_BUDGET_EXHAUSTED', 'budget', { retryAfter: 600 })
  })

  it('a switch that needs a new conversation asks the user first, then confirms or cancels', async () => {
    const awaiting = transaction({ id: 'tx-c', state: 'awaiting-confirmation', confirmation: 'required', switchMode: 'manual', restartStrategy: 'new-conversation' })
    responder = (type) => (type === 'quota_failover.switch' ? { transaction: awaiting } : { transaction: { ...awaiting, confirmation: 'confirmed', state: 'preparing' } })
    await api.actOn({ kind: 'quota-switch', incidentId: 'inc-1', agentKey: 'claude', epoch: 7, slotId: 'slot-b', label: 'b', tier: 'unknown' })
    expect(hooks.confirmNewConversation).toHaveBeenCalledTimes(1)
    expect(sentOf('quota_failover.confirm')).toEqual([{ transaction_id: 'tx-c' }])

    hooks.confirmNewConversation.mockResolvedValueOnce(false)
    await api.actOn({ kind: 'quota-switch', incidentId: 'inc-1', agentKey: 'claude', epoch: 7, slotId: 'slot-b', label: 'b', tier: 'unknown' })
    expect(sentOf('quota_failover.cancel')).toEqual([{ transaction_id: 'tx-c' }])
  })

  it('an accepted confirmation the backend then refuses is reported, not swallowed', async () => {
    const awaiting = transaction({ id: 'tx-c', state: 'awaiting-confirmation', confirmation: 'required', switchMode: 'manual', restartStrategy: 'new-conversation' })
    responder = (type) =>
      type === 'quota_failover.switch'
        ? { transaction: awaiting }
        : { error: { code: 'STALE_STATE', message: 'account moved', details: { currentSlotId: 'slot-c' } } }
    await api.actOn({ kind: 'quota-switch', incidentId: 'inc-1', agentKey: 'claude', epoch: 7, slotId: 'slot-b', label: 'b', tier: 'unknown' })
    expect(hooks.confirmNewConversation).toHaveBeenCalledTimes(1)
    expect(sentOf('quota_failover.confirm')).toEqual([{ transaction_id: 'tx-c' }])
    expect(hooks.onSwitchRefused).toHaveBeenCalledWith('STALE_STATE', 'account moved', { currentSlotId: 'slot-c' })
  })

  describe('unverifiable live drift on a manual switch', () => {
    const drift = (reason: 'live-drift' | 'live-drift-unverified', liveFingerprint: string | null = 'fp-1') =>
      transaction({ id: 'tx-d', state: 'cancelled', reason, swapped: false, liveIdentity: { email: null, signedIn: true }, liveFingerprint })
    const click = () => api.actOn({ kind: 'quota-switch', incidentId: 'inc-1', agentKey: 'claude', epoch: 7, slotId: 'slot-b', label: 'b', tier: 'fresh-headroom' })

    beforeEach(async () => {
      emit('quota_failover.changed', state({ incidents: [incident()] }))
      await flush()
    })

    it('asks the user, then resends the same switch with the assumption under a NEW request id', async () => {
      let calls = 0
      responder = (type) => {
        if (type !== 'quota_failover.switch') return {}
        calls += 1
        return calls === 1 ? { transaction: drift('live-drift-unverified') } : { transaction: transaction({ id: 'tx-ok', state: 'preparing' }) }
      }
      await click()
      const sent2 = sentOf('quota_failover.switch')
      expect(sent2).toHaveLength(2)
      expect(hooks.confirmLiveIsCurrent).toHaveBeenCalledWith('claude', 'slot-a', 'slot-b')
      // Same target / incident / expected state; only the assumption is added,
      // automatic stays false, and the key is fresh.
      expect(sent2[0].assume_live_is_current).toBeUndefined()
      expect(sent2[1]).toMatchObject({ agent_key: 'claude', to_slot_id: 'slot-b', incident_id: 'inc-1', expected_current_slot_id: 'slot-a', expected_epoch: 7, automatic: false, assume_live_is_current: true, live_fingerprint: 'fp-1' })
      expect(sent2[1].idempotency_key).not.toBe(sent2[0].idempotency_key)
      expect(hooks.onSwitchRefused).not.toHaveBeenCalled()
    })

    it('a decline sends nothing more', async () => {
      responder = (type) => (type === 'quota_failover.switch' ? { transaction: drift('live-drift-unverified') } : {})
      hooks.confirmLiveIsCurrent.mockResolvedValueOnce(false)
      await click()
      expect(sentOf('quota_failover.switch')).toHaveLength(1)
      // The cancelled transaction is on record for the row to explain itself.
      expect(useAnnouncements().items.value.find((i) => i.id === 'quota:inc-1')?.quota?.reason).toBe('live-drift-unverified')
    })

    it('a cancelled drift without a fingerprint is not resent — no proof to hand back, the user is not asked', async () => {
      responder = (type) => (type === 'quota_failover.switch' ? { transaction: drift('live-drift-unverified', null) } : {})
      await click()
      expect(hooks.confirmLiveIsCurrent).not.toHaveBeenCalled()
      expect(sentOf('quota_failover.switch')).toHaveLength(1)
    })

    it('the fingerprint sent back is the one the refusal reported, not one read after the dialog', async () => {
      let calls = 0
      responder = (type) => {
        if (type !== 'quota_failover.switch') return {}
        calls += 1
        return calls === 1 ? { transaction: drift('live-drift-unverified', 'fp-first') } : { transaction: transaction({ id: 'tx-ok', state: 'preparing' }) }
      }
      // A newer state arrives while the dialog is open; it must not change
      // what the resend vouches for.
      hooks.confirmLiveIsCurrent.mockImplementationOnce(async () => {
        emit('quota_failover.changed', state({ epochs: { claude: 7 }, incidents: [incident()], recentTransactions: [drift('live-drift-unverified', 'fp-later')] }))
        return true
      })
      await click()
      expect(sentOf('quota_failover.switch')[1]).toMatchObject({ live_fingerprint: 'fp-first', expected_current_slot_id: 'slot-a', expected_epoch: 7 })
    })

    it('a verified drift (the live credential IS another account) is never assumed away', async () => {
      responder = (type) => (type === 'quota_failover.switch' ? { transaction: drift('live-drift') } : {})
      await click()
      expect(hooks.confirmLiveIsCurrent).not.toHaveBeenCalled()
      expect(sentOf('quota_failover.switch')).toHaveLength(1)
    })

    it('a stale state after the confirmation is refused by the backend and reported, not forced', async () => {
      let calls = 0
      responder = (type) => {
        if (type !== 'quota_failover.switch') return {}
        calls += 1
        return calls === 1
          ? { transaction: drift('live-drift-unverified') }
          : { error: { code: 'STALE_EPOCH', message: 'epoch moved', details: { epoch: 8 } } }
      }
      await click()
      expect(sentOf('quota_failover.switch')).toHaveLength(2)
      expect(hooks.onSwitchRefused).toHaveBeenCalledWith('STALE_EPOCH', 'epoch moved', { epoch: 8 })
      expect(useAnnouncements().items.value.find((i) => i.id === 'quota:inc-1')?.actions).toBeUndefined()
      expect(sent.some((s) => 'force' in s.payload)).toBe(false)
    })
  })

  it('a ready incident the backend closed stays in the feed with a valid switch-back', async () => {
    const closed = incident({ state: 'ready', reason: 'quota-confirmed', closedAt: T1, updatedAt: T1 })
    const done = transaction({ state: 'committed', swapped: true, epochAfter: 8, committedAt: T1, closedAt: T1 })
    emit('quota_failover.changed', state({ incidents: [incident()], transactions: [transaction()] }))
    await flush()
    emit('quota_failover.changed', state({ recentIncidents: [closed], recentTransactions: [done] }))
    await flush()
    const row = useAnnouncements().items.value.find((i) => i.id === 'quota:inc-1')
    expect(row?.quota?.status).toBe('ready')
    expect(row?.actions).toEqual([
      { kind: 'quota-switch-back', incidentId: 'inc-1', agentKey: 'claude', epoch: 8, slotId: 'slot-a', label: 'slot-a@example.com' },
    ])
    expect(hooks.onIncidentReady).toHaveBeenCalledTimes(1)
    // A later state that no longer lists it does not remove the row.
    emit('quota_failover.changed', state())
    await flush()
    expect(useAnnouncements().items.value.some((i) => i.id === 'quota:inc-1')).toBe(true)
    expect(hooks.onIncidentReady).toHaveBeenCalledTimes(1)

    sent.length = 0
    await api.actOn(row!.actions![0] as never)
    expect(sentOf('quota_failover.switch')[0]).toMatchObject({ to_slot_id: 'slot-a', expected_current_slot_id: 'slot-b', expected_epoch: 8, incident_id: 'inc-1', automatic: false })
  })

  it('an old retry button restarts nothing once the epoch moved on (manual switch since)', async () => {
    const partial = transaction({ state: 'partial', swapped: true, epochAfter: 8, committedAt: T1, panes: [
      { paneId: 'p2', termId: 't2', agentKey: 'claude', workspacePath: '/ws/a', ack: 'ready', ackReason: null, settle: 'failed', settleReason: 'missing-session' },
    ] })
    emit('quota_failover.changed', state({ epochs: { claude: 9 }, incidents: [incident({ state: 'notify-stopped', reason: 'resume-failed' })], transactions: [partial] }))
    await flush()
    await api.actOn({ kind: 'quota-retry-resume', incidentId: 'inc-1', agentKey: 'claude', epoch: 8 })
    expect(hooks.restartPane).not.toHaveBeenCalled()
    expect(sentOf('quota_failover.settle')).toEqual([])
    expect(hooks.onSwitchRefused).toHaveBeenCalledWith('STALE_EPOCH', expect.any(String), { epoch: 9 })
    expect(useAnnouncements().items.value.find((i) => i.id === 'quota:inc-1')?.actions).toBeUndefined()
    // A transaction the backend has closed is not retried either.
    emit('quota_failover.changed', state({ epochs: { claude: 8 }, recentIncidents: [incident({ state: 'notify-stopped', reason: 'resume-failed', closedAt: T1 })], recentTransactions: [{ ...partial, closedAt: T1 }] }))
    await flush()
    await api.actOn({ kind: 'quota-retry-resume', incidentId: 'inc-1', agentKey: 'claude', epoch: 8 })
    expect(hooks.restartPane).not.toHaveBeenCalled()
  })

  it('retry-resume re-runs the restart only for the panes that failed', async () => {
    const partial = transaction({ state: 'partial', swapped: true, epochAfter: 8, committedAt: T1, panes: [
      { paneId: 'p1', termId: 't1', agentKey: 'claude', workspacePath: '/ws/a', ack: 'ready', ackReason: null, settle: 'resumed', settleReason: null },
      { paneId: 'p2', termId: 't2', agentKey: 'claude', workspacePath: '/ws/a', ack: 'ready', ackReason: null, settle: 'failed', settleReason: 'missing-session' },
    ] })
    emit('quota_failover.changed', state({ epochs: { claude: 8 }, incidents: [incident({ state: 'notify-stopped', reason: 'resume-failed' })], transactions: [partial] }))
    await flush()
    await api.actOn({ kind: 'quota-retry-resume', incidentId: 'inc-1', agentKey: 'claude', epoch: 8 })
    expect(hooks.restartPane).toHaveBeenCalledTimes(1)
    expect(hooks.restartPane.mock.calls[0][0]).toMatchObject({ paneId: 'p2' })
    expect(sentOf('quota_failover.settle')).toEqual([{ transaction_id: 'tx-1', pane_id: 'p2', outcome: 'resumed', term_id: 't2-new', session_id: 's-p2' }])
    expect(hooks.onSwitchCommitted).not.toHaveBeenCalled()
  })

  it('report sends the contract payload and applies the incident it comes back with', async () => {
    responder = () => ({ incident: incident({ trusted: false, reason: 'text-did-not-match' }), created: true })
    const res = await api.report({
      agentKey: 'claude', paneId: 'p1', workspacePath: '/ws/a', at: Date.parse(T0), resetsAt: Date.parse('2026-09-21T15:00:00.000Z'),
      windowKind: 'session', source: 'cli-text', text: "You've hit your limit · resets 3pm", idempotencyKey: 'idem-1',
    })
    expect(sentOf('quota_failover.report')).toEqual([{
      agent_key: 'claude', pane_id: 'p1', workspace_path: '/ws/a', at: T0, resets_at: '2026-09-21T15:00:00.000Z', window_kind: 'session',
      signal: 'quota-exhausted', source: 'cli-text', text: "You've hit your limit · resets 3pm", idempotency_key: 'idem-1',
    }])
    expect(res?.incident.trusted).toBe(false)
    const row = useAnnouncements().items.value.find((i) => i.id === 'quota:inc-1')
    expect(row?.quota?.untrusted).toBe(true)
    expect(row?.actions).toBeUndefined()

    responder = () => ({ error: { code: 'BAD_SIGNAL', message: 'no' } })
    expect(await api.report({ agentKey: 'claude', paneId: 'p1', workspacePath: '/ws/a', at: 0, resetsAt: null, windowKind: null, source: 'cli-text', idempotencyKey: 'idem-2' })).toBeNull()
  })

  it('setPolicy applies the state the backend answers with', async () => {
    expect(await api.setPolicy('auto')).toBe(true)
    expect(sentOf('quota_failover.set_policy')).toEqual([{ mode: 'auto' }])
    expect(api.state.value?.policy.mode).toBe('auto')
    expect(api.agentHasActiveTransaction('claude')).toBe(false)
    emit('quota_failover.changed', state({ transactions: [transaction({ state: 'waiting-safe' })] }))
    expect(api.agentHasActiveTransaction('claude')).toBe(true)
    expect(api.agentHasActiveTransaction('codex')).toBe(false)
  })
})
