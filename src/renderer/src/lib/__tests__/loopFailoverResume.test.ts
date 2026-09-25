import { describe, it, expect } from 'vitest'
import {
  LOOP_FAILOVER_RESUME_TIMEOUT_MS,
  loopFailoverResumeStep,
  shouldResumeLoopAfterFailover,
} from '../loopFailoverResume'

type Input = Parameters<typeof shouldResumeLoopAfterFailover>[0]

const base: Input = {
  enabled: true,
  policyMode: 'auto',
  loopActive: true,
  commitState: 'committed',
  switchMode: 'hot',
  restartStrategy: 'none',
}

describe('lib/loopFailoverResume shouldResumeLoopAfterFailover', () => {
  it('resumes a looping pane after an automatic hot switch when opted in', () => {
    expect(shouldResumeLoopAfterFailover(base)).toBe(true)
  })

  it('resumes after a restart that resumes the same conversation', () => {
    expect(shouldResumeLoopAfterFailover({ ...base, switchMode: 'restart', restartStrategy: 'resume' })).toBe(true)
  })

  it('keeps the Continue button when the setting is off (default)', () => {
    expect(shouldResumeLoopAfterFailover({ ...base, enabled: false })).toBe(false)
  })

  it('requires the auto policy', () => {
    expect(shouldResumeLoopAfterFailover({ ...base, policyMode: 'notify' })).toBe(false)
    expect(shouldResumeLoopAfterFailover({ ...base, policyMode: 'off' })).toBe(false)
    expect(shouldResumeLoopAfterFailover({ ...base, policyMode: null })).toBe(false)
  })

  it('does nothing for a pane that is not looping', () => {
    expect(shouldResumeLoopAfterFailover({ ...base, loopActive: false })).toBe(false)
  })

  it('does not resume on a partial commit', () => {
    expect(shouldResumeLoopAfterFailover({ ...base, commitState: 'partial' })).toBe(false)
  })

  it('does not resume into a new conversation or a manual switch', () => {
    expect(shouldResumeLoopAfterFailover({ ...base, switchMode: 'restart', restartStrategy: 'new-conversation' })).toBe(false)
    expect(shouldResumeLoopAfterFailover({ ...base, switchMode: 'manual', restartStrategy: 'resume' })).toBe(false)
  })
})

describe('lib/loopFailoverResume loopFailoverResumeStep', () => {
  const armedAt = 1_000_000

  it('resumes once the flag is cleared and the prompt is free', () => {
    expect(loopFailoverResumeStep({ armedAt, now: armedAt + 5000, limitLit: false, promptFree: true })).toBe('resume')
  })

  it('waits while the exhausted flag is still lit', () => {
    expect(loopFailoverResumeStep({ armedAt, now: armedAt + 5000, limitLit: true, promptFree: true })).toBe('wait')
  })

  it('waits while the CLI is not free at its prompt', () => {
    expect(loopFailoverResumeStep({ armedAt, now: armedAt + 5000, limitLit: false, promptFree: false })).toBe('wait')
  })

  it('gives up (falls back to Continue) after the timeout', () => {
    expect(loopFailoverResumeStep({
      armedAt, now: armedAt + LOOP_FAILOVER_RESUME_TIMEOUT_MS, limitLit: true, promptFree: true,
    })).toBe('give-up')
  })
})
