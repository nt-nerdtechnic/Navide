import { describe, expect, it } from 'vitest'
import { parsePlanTargetArgs } from '../planTarget'

describe('parsePlanTargetArgs', () => {
  it('returns no target when no args are given', () => {
    expect(parsePlanTargetArgs(undefined)).toEqual({})
    expect(parsePlanTargetArgs({})).toEqual({})
    expect(parsePlanTargetArgs({ rel_path: '' })).toEqual({})
  })

  it('accepts a plan document path and tolerates relPath', () => {
    const p = '.agent-team/plans/foo_ab12cd.html'
    expect(parsePlanTargetArgs({ rel_path: p })).toEqual({ relPath: p })
    expect(parsePlanTargetArgs({ relPath: p })).toEqual({ relPath: p })
  })

  it.each([
    '/etc/passwd.html',
    '/Users/x/.agent-team/plans/a.html',
    '.agent-team/plans/../../secret.html',
    '.agent-team/plans/..\\x.html',
    '.agent-team/plans/sub/a.html',
    '.agent-team/other/a.html',
    '.agent-team/plans/a.md',
    '.agent-team/plans/a.html\0.txt',
    'a.html',
  ])('rejects %j', (p) => {
    expect(() => parsePlanTargetArgs({ rel_path: p })).toThrow()
  })

  it('rejects a non-string rel_path', () => {
    expect(() => parsePlanTargetArgs({ rel_path: 5 })).toThrow()
  })
})
