import { describe, expect, it } from 'vitest'
import { decidePlansV2Retry, type PlansV2RetryState } from './plansRecovery'

const state = (overrides: Partial<PlansV2RetryState> = {}): PlansV2RetryState => ({
  recoveryEnabled: true,
  forced: false,
  hasCompleteV2Package: true,
  retriesLeft: 2,
  ...overrides,
})

describe('decidePlansV2Retry', () => {
  it('re-arms a registered package that is still in recovery', () => {
    expect(decidePlansV2Retry(state())).toEqual({ outcome: 'arm' })
  })

  it('reports a session that is not in recovery rather than refusing it', () => {
    // The caller answers ok:true for this: nothing to retry is not a failure.
    expect(decidePlansV2Retry(state({ recoveryEnabled: false }))).toEqual({
      outcome: 'not-in-recovery',
    })
  })

  it('refuses when the operator forced legacy recovery', () => {
    const decision = decidePlansV2Retry(state({ forced: true }))
    expect(decision.outcome).toBe('refused')
  })

  it('refuses when no complete v2 package is registered to re-arm', () => {
    // Nothing to re-arm: a missing or incomplete package cannot be fixed by
    // clearing an availability bit, so the retry must not claim success.
    const decision = decidePlansV2Retry(state({ hasCompleteV2Package: false }))
    expect(decision.outcome).toBe('refused')
  })

  it('stops once the session budget is spent', () => {
    expect(decidePlansV2Retry(state({ retriesLeft: 0 })).outcome).toBe('refused')
  })
})
