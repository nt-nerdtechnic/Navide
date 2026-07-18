import { describe, it, expect } from 'vitest'
import { PLAN_SPEC_HINT_LINE, planSpecHintBlock } from '../planSpecHint'

describe('lib/planSpecHint planSpecHintBlock', () => {
  it('returns the hint line prefixed with a blank line when the spec is available', () => {
    const block = planSpecHintBlock(true)
    expect(block.startsWith('\n\n')).toBe(true)
    expect(block).toContain(PLAN_SPEC_HINT_LINE)
  })

  it('returns an empty string when the spec is not available', () => {
    expect(planSpecHintBlock(false)).toBe('')
  })
})
