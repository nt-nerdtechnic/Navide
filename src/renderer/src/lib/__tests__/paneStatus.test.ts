import { describe, it, expect } from 'vitest'
import { resolvePaneStatus } from '../paneStatus'

describe('resolvePaneStatus', () => {
  it('confirms running only when agent_active is the latest lifecycle signal', () => {
    expect(resolvePaneStatus('running', 1000, 2000)).toBe('running')
  })

  it('downgrades a stuck running pane when turn_complete is the latest signal', () => {
    expect(resolvePaneStatus('running', 1000, 500)).toBe('idle')
  })

  it('treats lastActiveAt == turnCompleteAt as turn ended (idle)', () => {
    expect(resolvePaneStatus('running', 1000, 1000)).toBe('idle')
  })

  it('resolves a repaint-faked running to idle when no lifecycle signal exists yet', () => {
    // Focus / resize refit repaints and idle resumed sessions right after app
    // start have no lifecycle event — the byte heuristic must not assert running.
    expect(resolvePaneStatus('running', 0, 0)).toBe('idle')
  })

  it('lets the byte heuristic veto to idle even while agent_active is latest', () => {
    // rawStatus is the veto: once output goes quiet the pane is idle regardless.
    expect(resolvePaneStatus('idle', 1000, 2000)).toBe('idle')
  })

  it('passes every non-running status through unchanged', () => {
    expect(resolvePaneStatus('idle', 1000, 500)).toBe('idle')
    expect(resolvePaneStatus('starting', 0, 0)).toBe('starting')
    expect(resolvePaneStatus('exited', 1000, 500)).toBe('exited')
  })
})
