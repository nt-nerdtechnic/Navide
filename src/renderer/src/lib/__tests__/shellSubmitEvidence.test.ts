import { describe, it, expect } from 'vitest'
import { normalizeForMatch, shellSubmitEvidence, submitBaseline, submitEvidence, TAIL_MATCH_LEN } from '../injectEcho'

const cmd = 'git status --short'
const tail = normalizeForMatch(cmd).slice(-TAIL_MATCH_LEN)

describe('shellSubmitEvidence', () => {
  it('submitEvidence reads a command that ran as unsubmitted — why shells need their own check', () => {
    const before = 'user@mac repo % git status --short'
    const after = 'user@mac repo % git status --short\n M a.txt\nuser@mac repo % '
    const baseline = submitBaseline({ screen: before, tail })
    expect(submitEvidence({ tailWasOnScreen: true, tail, screen: after, grownBy: 30, baseline })).toBeNull()
  })

  it('the cursor on the next prompt is a submit', () => {
    expect(shellSubmitEvidence('user@mac repo % ', tail)).toBe('tail-left')
  })

  it('the cursor still after the typed text is not', () => {
    expect(shellSubmitEvidence('user@mac repo % git status --short', tail)).toBeNull()
  })

  it('no readable cursor line is no evidence', () => {
    expect(shellSubmitEvidence(null, tail)).toBeNull()
  })
})
