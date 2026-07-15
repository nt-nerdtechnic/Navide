import { describe, expect, it } from 'vitest'
import {
  formatTerminalExit,
  historyEntryLabel,
  isTerminalCrashLoopOpen,
  recordTerminalExit,
  resetTerminalCrashLoop,
  terminalCrashKey,
  updateHistoryCustomName,
  type HistoryTitleEntry,
} from '../spawnHistory'

function entry(overrides: Partial<HistoryTitleEntry> = {}): HistoryTitleEntry {
  return {
    paneId: 'pane-1',
    agentLabel: 'Claude Code',
    ...overrides,
  }
}

describe('spawn history titles', () => {
  it('prefers the CLI custom title and falls back to the vendor label', () => {
    expect(historyEntryLabel(entry({ customName: 'Frontend Lead' }))).toBe('Frontend Lead')
    expect(historyEntryLabel(entry())).toBe('Claude Code')
  })

  it('synchronizes rename and reset operations with the matching history entry', () => {
    const entries = [entry()]

    expect(updateHistoryCustomName(entries, 'pane-1', ' Reviewer ')).toBe(true)
    expect(entries[0].customName).toBe('Reviewer')

    expect(updateHistoryCustomName(entries, 'pane-1', '  ')).toBe(true)
    expect(entries[0].customName).toBeUndefined()
  })

  it('leaves history unchanged when the pane is not present', () => {
    const entries = [entry()]
    expect(updateHistoryCustomName(entries, 'missing', 'Reviewer')).toBe(false)
    expect(entries).toEqual([entry()])
  })

  it('matches a changed Codex pane id through the stable session home', () => {
    const entries = [entry({
      paneId: 'old-pane',
      agentKey: 'codex',
      sessionId: 'session-1',
      sessionHomeId: 'codex-home-1',
    })]

    expect(updateHistoryCustomName(entries, {
      paneId: 'new-pane',
      agentKey: 'codex',
      sessionId: 'session-1',
      sessionHomeId: 'codex-home-1',
    }, 'Restored Codex')).toBe(true)
    expect(entries[0].customName).toBe('Restored Codex')
  })

  it('matches a legacy Codex history pane id to the stable session home', () => {
    const entries = [entry({
      paneId: 'codex-home-1',
      agentKey: 'codex',
      sessionId: 'session-1',
    })]

    expect(updateHistoryCustomName(entries, {
      paneId: 'new-pane',
      agentKey: 'codex',
      sessionId: 'session-1',
      sessionHomeId: 'codex-home-1',
    }, 'Restored legacy Codex')).toBe(true)
    expect(entries[0].customName).toBe('Restored legacy Codex')
  })

  it('matches a changed pane id through the normalized vendor session id', () => {
    const entries = [entry({
      paneId: 'old-pane',
      agentKey: 'claude',
      sessionId: 'session-1',
    })]

    expect(updateHistoryCustomName(entries, {
      paneId: 'new-pane',
      agentKey: 'claude',
      sessionId: ' session-1 ',
    }, 'Restored Claude')).toBe(true)
    expect(entries[0].customName).toBe('Restored Claude')
  })

  it('does not match a changed pane id from a different session', () => {
    const entries = [entry({
      paneId: 'old-pane',
      agentKey: 'claude',
      sessionId: 'session-1',
    })]

    expect(updateHistoryCustomName(entries, {
      paneId: 'new-pane',
      agentKey: 'claude',
      sessionId: 'session-2',
    }, 'Wrong title')).toBe(false)
    expect(entries[0].customName).toBeUndefined()
  })

  it('updates all entries in the same session lineage', () => {
    const entries = [
      entry({ paneId: 'exact-pane', agentKey: 'claude', sessionId: 'session-1' }),
      entry({ paneId: 'older-pane', agentKey: 'claude', sessionId: 'session-1' }),
    ]

    expect(updateHistoryCustomName(entries, {
      paneId: 'exact-pane',
      agentKey: 'claude',
      sessionId: 'session-1',
    }, 'Exact title')).toBe(true)
    expect(entries[0].customName).toBe('Exact title')
    expect(entries[1].customName).toBe('Exact title')
  })
})

describe('terminal crash-loop diagnostics', () => {
  const key = terminalCrashKey({
    agentKey: 'claude',
    cwd: '/workspace',
    resumeKey: 'session-1',
    command: ['zsh', '-lc', 'claude --resume session-1'],
  })

  it('opens after three consecutive exits within one second', () => {
    resetTerminalCrashLoop(key)
    const fastExit = { reason: 'exit', exit_code: -9, signal: 'SIGKILL', uptime_ms: 42 }

    expect(recordTerminalExit(key, fastExit)).toEqual({ count: 1, open: false })
    expect(recordTerminalExit(key, fastExit)).toEqual({ count: 2, open: false })
    expect(recordTerminalExit(key, fastExit)).toEqual({ count: 3, open: true })
    expect(isTerminalCrashLoopOpen(key)).toBe(true)
  })

  it('resets the consecutive count after a non-fast exit', () => {
    resetTerminalCrashLoop(key)
    recordTerminalExit(key, { reason: 'exit', exit_code: -9, uptime_ms: 50 })

    expect(recordTerminalExit(key, { reason: 'exit', exit_code: 0, uptime_ms: 1_500 }))
      .toEqual({ count: 0, open: false })
    expect(isTerminalCrashLoopOpen(key)).toBe(false)
  })

  it('formats the exact signal, lifetime, and resolved binary', () => {
    expect(formatTerminalExit({
      reason: 'exit',
      exit_code: -9,
      signal: 'SIGKILL',
      uptime_ms: 42,
      startup_probe: { binary_path: '/opt/bin/claude' },
    })).toBe('Process was terminated by SIGKILL 42ms after spawn — /opt/bin/claude')
  })
})
