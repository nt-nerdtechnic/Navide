import { describe, expect, it, vi } from 'vitest'
import {
  normalizeResumeBehavior,
  resolveRestoreDecision,
  stripPinnedSessionId,
  type RestoreDecision,
} from '../resumeBehavior'

describe('normalizeResumeBehavior', () => {
  it('passes through the known behaviors', () => {
    expect(normalizeResumeBehavior('always')).toBe('always')
    expect(normalizeResumeBehavior('never')).toBe('never')
    expect(normalizeResumeBehavior('ask')).toBe('ask')
  })

  it('defaults anything else to always', () => {
    expect(normalizeResumeBehavior(undefined)).toBe('always')
    expect(normalizeResumeBehavior(null)).toBe('always')
    expect(normalizeResumeBehavior('sometimes')).toBe('always')
    expect(normalizeResumeBehavior(42)).toBe('always')
  })
})

describe('stripPinnedSessionId', () => {
  const id = 'abcdef12-3456-7890-abcd-ef1234567890'

  it('removes a space-separated --session-id and its value', () => {
    expect(stripPinnedSessionId(`claude --session-id ${id}`)).toBe('claude')
    expect(stripPinnedSessionId(`claude --session-id ${id} --foo`)).toBe('claude --foo')
  })

  it('removes an =-separated --session-id', () => {
    expect(stripPinnedSessionId(`claude --session-id=${id}`)).toBe('claude')
  })

  it('leaves commands without --session-id untouched', () => {
    expect(stripPinnedSessionId('claude --dangerously-skip-permissions')).toBe(
      'claude --dangerously-skip-permissions'
    )
    expect(stripPinnedSessionId('')).toBe('')
  })
})

describe('resolveRestoreDecision', () => {
  const base = { restorableCount: 3, workspacePath: '/ws/a' }

  it('always → resume without prompting', async () => {
    const ask = vi.fn()
    await expect(
      resolveRestoreDecision({ ...base, behavior: 'always', decisionCache: new Map(), ask })
    ).resolves.toBe('resume')
    expect(ask).not.toHaveBeenCalled()
  })

  it('never → fresh without prompting', async () => {
    const ask = vi.fn()
    await expect(
      resolveRestoreDecision({ ...base, behavior: 'never', decisionCache: new Map(), ask })
    ).resolves.toBe('fresh')
    expect(ask).not.toHaveBeenCalled()
  })

  it('ask with nothing restorable → resume without prompting', async () => {
    const ask = vi.fn()
    await expect(
      resolveRestoreDecision({
        ...base, restorableCount: 0, behavior: 'ask', decisionCache: new Map(), ask,
      })
    ).resolves.toBe('resume')
    expect(ask).not.toHaveBeenCalled()
  })

  it('ask confirmed → resume; declined/dismissed → fresh', async () => {
    await expect(
      resolveRestoreDecision({
        ...base, behavior: 'ask', decisionCache: new Map(), ask: async () => true,
      })
    ).resolves.toBe('resume')
    await expect(
      resolveRestoreDecision({
        ...base, behavior: 'ask', decisionCache: new Map(), ask: async () => false,
      })
    ).resolves.toBe('fresh')
  })

  it('caches the first answer per workspace and skips re-prompting', async () => {
    const cache = new Map<string, RestoreDecision>()
    const ask = vi.fn(async () => false)
    await expect(
      resolveRestoreDecision({ ...base, behavior: 'ask', decisionCache: cache, ask })
    ).resolves.toBe('fresh')
    await expect(
      resolveRestoreDecision({ ...base, behavior: 'ask', decisionCache: cache, ask })
    ).resolves.toBe('fresh')
    expect(ask).toHaveBeenCalledTimes(1)
    // A different workspace is a separate decision.
    await expect(
      resolveRestoreDecision({
        ...base, workspacePath: '/ws/b', behavior: 'ask', decisionCache: cache, ask,
      })
    ).resolves.toBe('fresh')
    expect(ask).toHaveBeenCalledTimes(2)
  })
})
