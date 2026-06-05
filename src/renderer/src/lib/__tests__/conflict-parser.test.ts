import { describe, it, expect } from 'vitest'
import { parseConflicts, buildResolved, hasConflicts, countConflicts } from '../conflict-parser'

const SIMPLE = `line before
<<<<<<< HEAD
ours line 1
ours line 2
=======
theirs line 1
>>>>>>> feature
line after
`

const TWO_CONFLICTS = `section1
<<<<<<< HEAD
alpha_ours
=======
alpha_theirs
>>>>>>> feat
section2
<<<<<<< HEAD
beta_ours
=======
beta_theirs
>>>>>>> feat
section3
`

const NO_CONFLICT = `just a normal
file with no markers
`

describe('hasConflicts', () => {
  it('returns true when markers present', () => expect(hasConflicts(SIMPLE)).toBe(true))
  it('returns false for clean file', () => expect(hasConflicts(NO_CONFLICT)).toBe(false))
})

describe('parseConflicts', () => {
  it('splits simple conflict into 3 sections', () => {
    const sections = parseConflicts(SIMPLE)
    expect(sections.map((s) => s.kind)).toEqual(['context', 'conflict', 'context'])
  })

  it('captures ours/theirs lines correctly', () => {
    const sections = parseConflicts(SIMPLE)
    const c = sections[1]
    expect(c.kind).toBe('conflict')
    if (c.kind === 'conflict') {
      expect(c.ours).toEqual(['ours line 1', 'ours line 2'])
      expect(c.theirs).toEqual(['theirs line 1'])
      expect(c.oursLabel).toBe('HEAD')
      expect(c.theirsLabel).toBe('feature')
    }
  })

  it('handles two conflict blocks', () => {
    const sections = parseConflicts(TWO_CONFLICTS)
    expect(countConflicts(sections)).toBe(2)
  })

  it('returns single context for clean file', () => {
    const sections = parseConflicts(NO_CONFLICT)
    expect(sections).toHaveLength(1)
    expect(sections[0].kind).toBe('context')
  })
})

describe('buildResolved', () => {
  it('accept ours', () => {
    const sections = parseConflicts(SIMPLE)
    const result = buildResolved(sections, new Map([[0, 'ours']]), new Map())
    expect(result).toContain('ours line 1')
    expect(result).not.toContain('theirs line 1')
    expect(result).toContain('line before')
    expect(result).toContain('line after')
  })

  it('accept theirs', () => {
    const sections = parseConflicts(SIMPLE)
    const result = buildResolved(sections, new Map([[0, 'theirs']]), new Map())
    expect(result).toContain('theirs line 1')
    expect(result).not.toContain('ours line 1')
  })

  it('accept both: ours first then theirs', () => {
    const sections = parseConflicts(SIMPLE)
    const result = buildResolved(sections, new Map([[0, 'both']]), new Map())
    const oursPos = result.indexOf('ours line 1')
    const theirsPos = result.indexOf('theirs line 1')
    expect(oursPos).toBeGreaterThanOrEqual(0)
    expect(theirsPos).toBeGreaterThanOrEqual(0)
    expect(oursPos).toBeLessThan(theirsPos)
  })

  it('manual edit overrides', () => {
    const sections = parseConflicts(SIMPLE)
    const result = buildResolved(
      sections,
      new Map([[0, 'manual']]),
      new Map([[0, 'hand crafted line']]),
    )
    expect(result).toContain('hand crafted line')
    expect(result).not.toContain('ours line 1')
    expect(result).not.toContain('theirs line 1')
  })

  it('two conflicts with different choices', () => {
    const sections = parseConflicts(TWO_CONFLICTS)
    const result = buildResolved(
      sections,
      new Map([[0, 'ours'], [1, 'theirs']]),
      new Map(),
    )
    expect(result).toContain('alpha_ours')
    expect(result).not.toContain('alpha_theirs')
    expect(result).toContain('beta_theirs')
    expect(result).not.toContain('beta_ours')
  })

  it('always ends with newline', () => {
    const sections = parseConflicts(SIMPLE)
    const result = buildResolved(sections, new Map([[0, 'ours']]), new Map())
    expect(result.endsWith('\n')).toBe(true)
  })
})
