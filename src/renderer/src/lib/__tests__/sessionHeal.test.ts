import { describe, expect, it, vi } from 'vitest'
import {
  claimFreshSessionId,
  classifyAttributedSession,
  classifySessionExistsResponse,
  confirmGhostAdoption,
  createGhostHealGate,
  createUiStateSeqGuard,
  isRetriableUiStateTimeout,
  mapOrphanSession,
  pinFreshClaudeSession,
  reconnectCandidateSessionIds,
  resolveDeterministicReconnect,
  sendWithUiStateRetry,
  shouldAttemptResume,
  uiStateWriteKey,
} from '../sessionHeal'

// ── Bug A: self-heal gate for attributed session ids ─────────────────────────

describe('classifyAttributedSession', () => {
  it('adopts when the pane has no pinned id', () => {
    expect(classifyAttributedSession(undefined, 'real-id')).toBe('adopt')
    expect(classifyAttributedSession('', 'real-id')).toBe('adopt')
  })

  it('adopts when the attributed id matches the pinned id', () => {
    expect(classifyAttributedSession('same-id', 'same-id')).toBe('adopt')
  })

  it('requires ghost verification when the attributed id diverges (pre-fix: unconditional refusal)', () => {
    expect(classifyAttributedSession('pinned-id', 'real-id')).toBe('verify')
  })
})

describe('createGhostHealGate', () => {
  it('confirms adoption when the pinned id has no transcript (ghost)', async () => {
    const gate = createGhostHealGate(async () => false)
    await expect(gate.shouldAdopt('pane-1', 'ghost-id')).resolves.toBe(true)
  })

  it('refuses adoption when the pinned id is healthy (transcript exists)', async () => {
    const probe = vi.fn().mockResolvedValue(true)
    const gate = createGhostHealGate(probe)
    await expect(gate.shouldAdopt('pane-1', 'healthy-id')).resolves.toBe(false)
    expect(probe).toHaveBeenCalledWith('pane-1', 'healthy-id')
  })

  it('first confirmed adoption wins — later divergent attributions are refused', async () => {
    const probe = vi.fn().mockResolvedValue(false)
    const gate = createGhostHealGate(probe)
    await expect(gate.shouldAdopt('pane-1', 'ghost-id')).resolves.toBe(true)
    await expect(gate.shouldAdopt('pane-1', 'another-id')).resolves.toBe(false)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('serializes concurrent events per pane — only the in-flight check can win', async () => {
    let resolveProbe!: (exists: boolean) => void
    const gate = createGhostHealGate(
      () => new Promise<boolean>((resolve) => { resolveProbe = resolve })
    )
    const first = gate.shouldAdopt('pane-1', 'ghost-id')
    // Second event races in while the probe is pending: refused immediately.
    await expect(gate.shouldAdopt('pane-1', 'ghost-id')).resolves.toBe(false)
    resolveProbe(false)
    await expect(first).resolves.toBe(true)
  })

  it('keeps panes independent', async () => {
    const gate = createGhostHealGate(async () => false)
    await expect(gate.shouldAdopt('pane-1', 'ghost-a')).resolves.toBe(true)
    await expect(gate.shouldAdopt('pane-2', 'ghost-b')).resolves.toBe(true)
  })

  // F2: a FAILED probe (null) is unknown, not proof of a ghost — never adopt.
  it('refuses adoption when the probe fails (null) — pre-fix: null was falsy and adopted', async () => {
    const gate = createGhostHealGate(async () => null)
    await expect(gate.shouldAdopt('pane-1', 'maybe-ghost')).resolves.toBe(false)
  })

  it('a failed probe does not mark the pane healed — a later definitive ghost probe can adopt', async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(false)
    const gate = createGhostHealGate(probe)
    await expect(gate.shouldAdopt('pane-1', 'ghost-id')).resolves.toBe(false)
    await expect(gate.shouldAdopt('pane-1', 'ghost-id')).resolves.toBe(true)
  })
})

// ── F2: tri-state resumability probe + restore routing ───────────────────────

describe('classifySessionExistsResponse', () => {
  it('maps a definitive backend answer to true/false', () => {
    expect(classifySessionExistsResponse({ exists: true })).toBe(true)
    expect(classifySessionExistsResponse({ exists: false })).toBe(false)
  })

  it('maps a failed probe or malformed payload to null (unknown, NOT absent)', () => {
    expect(classifySessionExistsResponse(null)).toBe(null)
    expect(classifySessionExistsResponse(undefined)).toBe(null)
    expect(classifySessionExistsResponse({})).toBe(null)
    expect(classifySessionExistsResponse({ exists: 'yes' })).toBe(null)
  })
})

describe('shouldAttemptResume (restore fallback routing)', () => {
  it('resumes on true, and on null still ATTEMPTS resume with the saved id', () => {
    expect(shouldAttemptResume(true)).toBe(true)
    // Pre-fix: null collapsed to false → fresh spawn despite a possibly-alive
    // transcript. Unknown must route to --resume (worst case: one errored
    // boot, but the id mapping survives).
    expect(shouldAttemptResume(null)).toBe(true)
  })

  it('fresh-spawns only on a DEFINITIVE false', () => {
    expect(shouldAttemptResume(false)).toBe(false)
  })
})

// ── F3: duplicate saved ids may be reused only once per restore batch ────────

describe('claimFreshSessionId', () => {
  it('first claim reuses the saved id; a duplicate mints a new uuid instead', () => {
    const used = new Set<string>()
    expect(claimFreshSessionId(used, 'dup-id')).toBe('dup-id')
    // Pre-fix: the second record also received 'dup-id' → --session-id clash.
    expect(claimFreshSessionId(used, 'dup-id')).toBe('')
    const second = pinFreshClaudeSession(
      'claude', false, 'claude', claimFreshSessionId(used, 'dup-id'), () => 'fresh-uuid'
    )
    expect(second.explicitSessionId).toBe('fresh-uuid')
  })

  it('blank ids claim nothing and stay generatable', () => {
    const used = new Set<string>()
    expect(claimFreshSessionId(used, '')).toBe('')
    expect(claimFreshSessionId(used, '   ')).toBe('')
    expect(used.size).toBe(0)
  })

  it('distinct ids are independent', () => {
    const used = new Set<string>()
    expect(claimFreshSessionId(used, 'id-a')).toBe('id-a')
    expect(claimFreshSessionId(used, 'id-b')).toBe('id-b')
  })
})

// ── F4: post-probe adoption requires the pane to still be mounted ────────────

describe('confirmGhostAdoption', () => {
  const base = {
    gateWon: true,
    paneStillMounted: true,
    currentPinnedId: 'ghost-id',
    verifiedPinnedId: 'ghost-id',
    attributedId: 'real-id',
  }

  it('adopts when the gate won, the pane is mounted, and the pin is unchanged', () => {
    expect(confirmGhostAdoption(base)).toBe(true)
  })

  it('refuses when the pane was removed between probe and adoption — pre-fix: only the pinned id was re-checked', () => {
    expect(confirmGhostAdoption({ ...base, paneStillMounted: false })).toBe(false)
  })

  it('refuses on a lost gate, a re-pinned id, or a non-divergent attribution', () => {
    expect(confirmGhostAdoption({ ...base, gateWon: false })).toBe(false)
    expect(confirmGhostAdoption({ ...base, currentPinnedId: 'other-id' })).toBe(false)
    expect(confirmGhostAdoption({ ...base, currentPinnedId: undefined })).toBe(false)
    expect(confirmGhostAdoption({
      ...base, attributedId: 'ghost-id',
    })).toBe(false)
  })
})

// ── Bug B: not-resumable rebuild reuses the SAME session id ──────────────────

describe('pinFreshClaudeSession', () => {
  const generate = (): string => 'generated-uuid'

  it('reuses the requested (saved, not-resumable) id — no new uuid rotation', () => {
    const gen = vi.fn(generate)
    const res = pinFreshClaudeSession('claude', false, 'claude', 'saved-id', gen)
    expect(res.explicitSessionId).toBe('saved-id')
    expect(res.command).toBe('claude --session-id saved-id')
    expect(gen).not.toHaveBeenCalled()
  })

  it('generates a fresh id when none is requested', () => {
    for (const requested of [undefined, '', '   ']) {
      const res = pinFreshClaudeSession('claude', false, 'claude', requested, generate)
      expect(res.explicitSessionId).toBe('generated-uuid')
      expect(res.command).toBe('claude --session-id generated-uuid')
    }
  })

  it('never pins for resumes or other agents', () => {
    expect(pinFreshClaudeSession('claude', true, 'claude --resume x', 'saved-id', generate))
      .toEqual({ command: 'claude --resume x', explicitSessionId: '' })
    expect(pinFreshClaudeSession('codex', false, 'codex', 'saved-id', generate))
      .toEqual({ command: 'codex', explicitSessionId: '' })
  })

  const handwrittenId = '11111111-2222-3333-4444-555555555555'

  it('a hand-written --session-id is surfaced as the explicit pin, command untouched', () => {
    // Pre-fix: explicitSessionId was '' → pane.pinnedSessionId stayed
    // undefined → classifyAttributedSession returned unconditional 'adopt' →
    // a mis-routed sibling session could silently replace this pane's real
    // (persisted) session. The parsed pin closes that hole end-to-end: the
    // backend gets a deterministic session→pane claim and the frontend gate
    // treats any divergent attribution as verify-first.
    for (const cmd of [
      `claude --session-id ${handwrittenId}`,
      `claude --session-id=${handwrittenId}`,
      `claude --session-id ${handwrittenId} --model opus`,
    ]) {
      expect(pinFreshClaudeSession('claude', false, cmd, undefined, generate))
        .toEqual({ command: cmd, explicitSessionId: handwrittenId })
    }
  })

  it('an unparseable hand-written --session-id keeps the old no-pin behavior', () => {
    for (const cmd of ['claude --session-id abc', 'claude --session-id "$SID"']) {
      expect(pinFreshClaudeSession('claude', false, cmd, 'saved-id', generate))
        .toEqual({ command: cmd, explicitSessionId: '' })
    }
  })

  it('hand-written pin + divergent attribution routes through ghost verification, never blind adopt', () => {
    const { explicitSessionId } = pinFreshClaudeSession(
      'claude', false, `claude --session-id ${handwrittenId}`, undefined, generate
    )
    // spawnPane assigns pinnedSessionId = explicitSessionId || undefined.
    const pinnedSessionId = explicitSessionId || undefined
    expect(classifyAttributedSession(pinnedSessionId, 'attributed-sibling-id')).toBe('verify')
    expect(classifyAttributedSession(pinnedSessionId, handwrittenId)).toBe('adopt')
  })
})

// ── Bug C: project.set_ui_state timeout gets exactly one retry ───────────────

describe('sendWithUiStateRetry', () => {
  const timeoutErr = new Error('request project.set_ui_state timeout')

  it('classifies only set_ui_state timeouts as retriable', () => {
    expect(isRetriableUiStateTimeout('project.set_ui_state', timeoutErr.message)).toBe(true)
    expect(isRetriableUiStateTimeout('project.set_ui_state', 'ws not open')).toBe(false)
    expect(isRetriableUiStateTimeout('project.peek', 'request project.peek timeout')).toBe(false)
  })

  it('retries exactly once on a set_ui_state timeout and returns the retry result', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(timeoutErr)
      .mockResolvedValueOnce({ ok: true })
    await expect(
      sendWithUiStateRetry(send, 'project.set_ui_state', { a: 1 }, 0)
    ).resolves.toEqual({ ok: true })
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenNthCalledWith(2, 'project.set_ui_state', { a: 1 })
  })

  it('propagates a second timeout without a third attempt', async () => {
    const send = vi.fn().mockRejectedValue(timeoutErr)
    await expect(
      sendWithUiStateRetry(send, 'project.set_ui_state', {}, 0)
    ).rejects.toThrow('timeout')
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('does not retry non-timeout failures or other request types', async () => {
    const closed = vi.fn().mockRejectedValue(new Error('WebSocket closed'))
    await expect(
      sendWithUiStateRetry(closed, 'project.set_ui_state', {}, 0)
    ).rejects.toThrow('WebSocket closed')
    expect(closed).toHaveBeenCalledTimes(1)

    const other = vi.fn().mockRejectedValue(new Error('request project.peek timeout'))
    await expect(sendWithUiStateRetry(other, 'project.peek', {}, 0)).rejects.toThrow('timeout')
    expect(other).toHaveBeenCalledTimes(1)
  })
})

// ── F1: a stale retry must not overwrite a newer set_ui_state snapshot ───────

describe('uiStateWriteKey', () => {
  it('keys by workspace + state field(s), ignoring field values', () => {
    const a = uiStateWriteKey('project.set_ui_state', { workspace_path: '/w', spawn_history: [1] })
    const b = uiStateWriteKey('project.set_ui_state', { workspace_path: '/w', spawn_history: [2] })
    expect(a).toBe(b)
  })

  it('separates different workspaces and different state fields', () => {
    const hist = uiStateWriteKey('project.set_ui_state', { workspace_path: '/w', spawn_history: [] })
    const groups = uiStateWriteKey('project.set_ui_state', { workspace_path: '/w', run_groups: [] })
    const otherWs = uiStateWriteKey('project.set_ui_state', { workspace_path: '/x', spawn_history: [] })
    expect(hist).not.toBe(groups)
    expect(hist).not.toBe(otherWs)
  })
})

describe('sendWithUiStateRetry + seq guard (stale-retry drop)', () => {
  const timeoutErr = new Error('request project.set_ui_state timeout')

  it('drops the retry when a newer send for the same key was issued meanwhile', async () => {
    const guard = createUiStateSeqGuard()
    const staleSend = vi.fn().mockRejectedValue(timeoutErr)
    const stale = sendWithUiStateRetry(
      staleSend, 'project.set_ui_state',
      { workspace_path: '/w', spawn_history: ['old'] }, 0, guard
    ).then(() => 'resolved', (e: unknown) => e)
    // A newer snapshot of the SAME state field goes out while the stale
    // retry is waiting — pre-fix, the stale retry re-sent 'old' afterwards
    // and overwrote it (last-writer-wins).
    const freshSend = vi.fn().mockResolvedValue({ ok: true })
    await sendWithUiStateRetry(
      freshSend, 'project.set_ui_state',
      { workspace_path: '/w', spawn_history: ['new'] }, 0, guard
    )
    await expect(stale).resolves.toBe(timeoutErr) // original timeout propagates
    expect(staleSend).toHaveBeenCalledTimes(1) // pre-fix: 2 (stale re-send)
  })

  it('still retries when it is the newest write for its key', async () => {
    const guard = createUiStateSeqGuard()
    const send = vi.fn()
      .mockRejectedValueOnce(timeoutErr)
      .mockResolvedValueOnce({ ok: true })
    await expect(sendWithUiStateRetry(
      send, 'project.set_ui_state', { workspace_path: '/w', spawn_history: [] }, 0, guard
    )).resolves.toEqual({ ok: true })
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('a send for a different field or workspace does not suppress the retry', async () => {
    const guard = createUiStateSeqGuard()
    const staleSend = vi.fn()
      .mockRejectedValueOnce(timeoutErr)
      .mockResolvedValueOnce({ ok: true })
    const stale = sendWithUiStateRetry(
      staleSend, 'project.set_ui_state',
      { workspace_path: '/w', spawn_history: ['keep-me'] }, 0, guard
    )
    await sendWithUiStateRetry(
      vi.fn().mockResolvedValue({ ok: true }), 'project.set_ui_state',
      { workspace_path: '/w', active_tab: 'tab' }, 0, guard
    )
    await sendWithUiStateRetry(
      vi.fn().mockResolvedValue({ ok: true }), 'project.set_ui_state',
      { workspace_path: '/other', spawn_history: [] }, 0, guard
    )
    await expect(stale).resolves.toEqual({ ok: true })
    expect(staleSend).toHaveBeenCalledTimes(2)
  })
})

// ── Deterministic reconnect resolver ─────────────────────────────────────────

describe('resolveDeterministicReconnect', () => {
  const ghost = { paneId: 'pane-1', customName: 'Backend', sessionId: 'ghost-id' }
  const exists = (ids: string[]) => (id: string) => ids.includes(id)

  it('returns the id when exactly one provenance candidate has a transcript', () => {
    const history = [{ paneId: 'pane-1', sessionId: 'real-a' }]
    expect(
      resolveDeterministicReconnect(ghost, history, exists(['real-a']), [])
    ).toBe('real-a')
  })

  it('returns null when no provenance candidate has a transcript', () => {
    const history = [{ paneId: 'pane-1', sessionId: 'gone-a' }]
    expect(
      resolveDeterministicReconnect(ghost, history, exists([]), [])
    ).toBeNull()
  })

  it('returns null when multiple candidates have transcripts (ambiguous)', () => {
    const history = [
      { paneId: 'pane-1', sessionId: 'real-a' },
      { paneId: 'pane-1', sessionId: 'real-b' },
    ]
    expect(
      resolveDeterministicReconnect(ghost, history, exists(['real-a', 'real-b']), [])
    ).toBeNull()
  })

  it('excludes a candidate whose transcript is missing, leaving a unique survivor', () => {
    const history = [
      { paneId: 'pane-1', sessionId: 'real-a' },
      { paneId: 'pane-1', sessionId: 'gone-b' },
    ]
    expect(
      resolveDeterministicReconnect(ghost, history, exists(['real-a']), [])
    ).toBe('real-a')
  })

  it('excludes a candidate that is another live pane\'s current session id', () => {
    const history = [{ paneId: 'pane-1', sessionId: 'real-a' }]
    expect(
      resolveDeterministicReconnect(ghost, history, exists(['real-a']), [
        { paneId: 'pane-2', sessionId: 'real-a' },
      ])
    ).toBeNull()
  })

  it('falls back to customName provenance when no paneId record exists', () => {
    const history = [{ paneId: 'other-pane', customName: 'Backend', sessionId: 'real-a' }]
    expect(
      resolveDeterministicReconnect(ghost, history, exists(['real-a']), [])
    ).toBe('real-a')
  })

  it('never targets a healthy pane whose own saved id has a transcript', () => {
    const history = [{ paneId: 'pane-1', sessionId: 'real-a' }]
    const healthy = { paneId: 'pane-1', customName: 'Backend', sessionId: 'ghost-id' }
    expect(
      resolveDeterministicReconnect(
        healthy,
        history,
        exists(['ghost-id', 'real-a']),
        []
      )
    ).toBeNull()
  })

  // F1 fork guard: the exclusion set App.vue feeds the resolver is the UNION of
  // in-window live panes AND every saved pane record's session id. A
  // customName-provenance candidate already claimed by ANOTHER pane's saved
  // record — a session live in a detached/other window, or a sibling not yet
  // spawned in this concurrent restore batch, so never seen "live" here — must
  // be excluded, else two panes --resume the same conversation (fork).
  it('excludes a customName candidate claimed by another (saved, not-live) pane — cross-window/not-yet-spawned fork guard', () => {
    const history = [{ paneId: 'sibling-pane', customName: 'Backend', sessionId: 'shared-id' }]
    // 'shared-id' has a transcript and would otherwise resolve — but the
    // sibling pane's SAVED record already claims it (that pane's own session).
    // Pre-fix App.vue passed only panes.value, which omits an unspawned/other-
    // window sibling, so this id would have been stolen.
    expect(
      resolveDeterministicReconnect(ghost, history, exists(['shared-id']), [
        { paneId: 'sibling-pane', sessionId: 'shared-id' },
      ])
    ).toBeNull()
  })

  it('paneId-provenance unique candidate still resolves — its id is not claimed under any other pane record', () => {
    const history = [{ paneId: 'pane-1', sessionId: 'real-a' }]
    // Other saved records are in the exclusion set but none claim real-a, so
    // tightening the exclusion to all saved panes leaves this case unchanged.
    expect(
      resolveDeterministicReconnect(ghost, history, exists(['real-a']), [
        { paneId: 'pane-2', sessionId: 'other-b' },
        { paneId: 'pane-3', sessionId: '' },
      ])
    ).toBe('real-a')
  })
})

// ── F2: backend orphan row (custom_name) → picker OrphanSession (name) ────────

describe('mapOrphanSession', () => {
  it('maps backend custom_name onto the picker\'s name field', () => {
    // Pre-fix: the response was cast straight to OrphanSession, leaving `.name`
    // undefined (backend sends `custom_name`), so every row rendered "(unnamed)".
    expect(mapOrphanSession({
      session_id: 's1', custom_name: 'Backend',
      preview: ['hi'], size_bytes: 10, mtime: 5, resumable: true,
    })).toEqual({
      session_id: 's1', name: 'Backend',
      preview: ['hi'], size_bytes: 10, mtime: 5, resumable: true,
    })
  })

  it('defaults missing fields — absent name is empty string, not undefined', () => {
    expect(mapOrphanSession({ session_id: 's2' })).toEqual({
      session_id: 's2', name: '', preview: [], size_bytes: 0, mtime: 0, resumable: false,
    })
  })
})

describe('reconnectCandidateSessionIds', () => {
  it('matches by paneId and dedupes, dropping blanks', () => {
    const history = [
      { paneId: 'p1', sessionId: 'a' },
      { paneId: 'p1', sessionId: 'a' },
      { paneId: 'p1', sessionId: '' },
      { paneId: 'p2', sessionId: 'b' },
    ]
    expect(reconnectCandidateSessionIds({ paneId: 'p1', customName: '' }, history)).toEqual(['a'])
  })

  it('falls back to customName only when no paneId record exists', () => {
    const history = [{ paneId: 'other', customName: 'Web', sessionId: 'c' }]
    expect(reconnectCandidateSessionIds({ paneId: 'p1', customName: 'Web' }, history)).toEqual(['c'])
    expect(reconnectCandidateSessionIds({ paneId: 'p1', customName: '' }, history)).toEqual([])
  })
})
