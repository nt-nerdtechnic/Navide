import { describe, it, expect } from 'vitest'
import { resolvePaneStatus } from '../paneStatus'

describe('resolvePaneStatus', () => {
  it('shows running while agent_active is the latest signal even if bytes are quiet', () => {
    // The key case: a tool runs for seconds with no output, so the byte
    // heuristic reads idle — but the agent IS working.
    expect(resolvePaneStatus('idle', 1000, 2000)).toBe('running')
    expect(resolvePaneStatus('running', 1000, 2000)).toBe('running')
    expect(resolvePaneStatus('starting', 0, 2000)).toBe('running')
  })

  it('shows idle once turn_complete is the latest signal', () => {
    expect(resolvePaneStatus('running', 1000, 500)).toBe('idle')
    expect(resolvePaneStatus('idle', 1000, 500)).toBe('idle')
  })

  it('treats lastActiveAt == turnCompleteAt as turn ended (idle)', () => {
    expect(resolvePaneStatus('running', 1000, 1000)).toBe('idle')
  })

  it('does not let focus/resize repaints fake running (lifecycle unchanged)', () => {
    // Repaint makes the byte heuristic say running, but the last lifecycle
    // event was turn_complete → the pane is idle.
    expect(resolvePaneStatus('running', 5000, 100)).toBe('idle')
  })

  it('falls back to the byte heuristic when no lifecycle signal exists yet', () => {
    expect(resolvePaneStatus('running', 0, 0)).toBe('running')
    expect(resolvePaneStatus('idle', 0, 0)).toBe('idle')
    expect(resolvePaneStatus('starting', 0, 0)).toBe('starting')
  })

  it('always passes dead states through, ignoring lifecycle', () => {
    expect(resolvePaneStatus('exited', 1000, 2000)).toBe('exited')
    expect(resolvePaneStatus('error', 0, 5000)).toBe('error')
  })
})
