import { describe, it, expect } from 'vitest'
import { resolvePaneStatus } from '../paneStatus'

describe('resolvePaneStatus', () => {
  it('downgrades a stuck running pane when turn_complete is the latest signal', () => {
    expect(resolvePaneStatus('running', 1000, 500)).toBe('idle')
  })

  it('keeps running when agent_active is newer than turn_complete', () => {
    expect(resolvePaneStatus('running', 1000, 2000)).toBe('running')
  })

  it('treats lastActiveAt == turnCompleteAt as turn ended', () => {
    expect(resolvePaneStatus('running', 1000, 1000)).toBe('idle')
  })

  it('does not override when there is no lifecycle signal', () => {
    expect(resolvePaneStatus('running', 0, 0)).toBe('running')
  })

  it('only downgrades running; other statuses pass through unchanged', () => {
    expect(resolvePaneStatus('idle', 1000, 500)).toBe('idle')
    expect(resolvePaneStatus('starting', 1000, 500)).toBe('starting')
    expect(resolvePaneStatus('exited', 1000, 500)).toBe('exited')
  })
})
