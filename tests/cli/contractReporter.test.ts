import { describe, expect, it } from 'vitest'
import { missingContracts } from './contractReporter'

describe('frontend CLI execution coverage invariant', () => {
  const passed = { name: 'frontend contract claude', state: 'passed', receipt: 'claude' }
  it('accepts a successfully executed contract and rejects a newly registered uncovered vendor', () => {
    expect(missingContracts(['claude'], [passed])).toEqual([])
    expect(missingContracts(['claude', 'new-vendor'], [passed])).toEqual(['new-vendor'])
  })
  it('rejects an uncollected suite or removed contract', () => {
    expect(missingContracts(['claude'], [])).toEqual(['claude'])
  })
  it.each(['skipped', 'pending', 'failed'])('rejects a %s contract', (state) => {
    expect(missingContracts(['claude'], [{ ...passed, state }])).toEqual(['claude'])
  })
  it('rejects an empty passing test without the post-assertion execution receipt', () => {
    expect(missingContracts(['claude'], [{ ...passed, receipt: undefined }])).toEqual(['claude'])
  })
  it('rejects duplicate identities instead of hiding one failed case behind a pass', () => {
    expect(missingContracts(['claude'], [passed, { ...passed, state: 'failed' }])).toEqual(['claude'])
  })
})
