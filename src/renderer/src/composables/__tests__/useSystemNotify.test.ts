import { describe, it, expect } from 'vitest'
import { shouldNotify, type NotifyKind } from '../useSystemNotify'

describe('shouldNotify', () => {
  const cases: Array<{
    name: string
    appFocused: boolean
    lastKind: NotifyKind | undefined
    kind: NotifyKind
    expected: boolean
  }> = [
    {
      name: 'background + first signal → notify',
      appFocused: false, lastKind: undefined, kind: 'done', expected: true,
    },
    {
      name: 'background + different kind than last → notify',
      appFocused: false, lastKind: 'attention', kind: 'done', expected: true,
    },
    {
      name: 'background + same kind as last → suppress (dedup)',
      appFocused: false, lastKind: 'done', kind: 'done', expected: false,
    },
    {
      name: 'focused → never notify even on a fresh signal',
      appFocused: true, lastKind: undefined, kind: 'attention', expected: false,
    },
    {
      name: 'focused + state change → still suppressed',
      appFocused: true, lastKind: 'done', kind: 'attention', expected: false,
    },
  ]

  for (const c of cases) {
    it(c.name, () => {
      expect(shouldNotify({ appFocused: c.appFocused, lastKind: c.lastKind, kind: c.kind }))
        .toBe(c.expected)
    })
  }
})
