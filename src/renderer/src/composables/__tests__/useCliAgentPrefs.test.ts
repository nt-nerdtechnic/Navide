import { describe, it, expect, beforeEach, vi } from 'vitest'

// settings.ts is a backend-KV façade; stub it so the module's singleton refs
// initialise empty and watch-writes are inert in the test environment.
vi.mock('../../lib/settings', () => ({
  settingsGet: vi.fn(() => ''),
  settingsSet: vi.fn(),
}))

import { orderedAgentKeys, isAgentEnabled, useCliAgentPrefs } from '../useCliAgentPrefs'

describe('useCliAgentPrefs', () => {
  beforeEach(() => {
    const { order, disabled } = useCliAgentPrefs()
    order.value = []
    disabled.value = []
  })

  it('orderedAgentKeys: no custom preference keeps the original order', () => {
    expect(orderedAgentKeys(['claude', 'codex', 'kimi'])).toEqual(['claude', 'codex', 'kimi'])
  })

  it('orderedAgentKeys: applies the custom order; keys not in it are appended stably', () => {
    useCliAgentPrefs().order.value = ['kimi', 'claude']
    expect(orderedAgentKeys(['claude', 'codex', 'kimi', 'grok'])).toEqual([
      'kimi',
      'claude',
      'codex',
      'grok',
    ])
  })

  it('isAgentEnabled: reflects the disabled set', () => {
    useCliAgentPrefs().disabled.value = ['codex']
    expect(isAgentEnabled('codex')).toBe(false)
    expect(isAgentEnabled('claude')).toBe(true)
  })

  it('orderedAgentKeys does not mutate its input', () => {
    useCliAgentPrefs().order.value = ['kimi']
    const input = ['claude', 'kimi']
    orderedAgentKeys(input)
    expect(input).toEqual(['claude', 'kimi'])
  })
})
