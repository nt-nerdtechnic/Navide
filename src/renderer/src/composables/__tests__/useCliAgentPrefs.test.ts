import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick, watch } from 'vue'

// settings.ts is a backend-KV façade; stub it so the module's singleton refs
// initialise empty and watch-writes are inert in the test environment. The
// change listener is captured so a "another window wrote this" broadcast can
// be replayed.
const h = vi.hoisted(() => ({ listener: null as ((keys: string[]) => void) | null }))

vi.mock('@navide/plugin-ui/shared', () => ({
  settingsGet: vi.fn(() => ''),
  settingsSet: vi.fn(),
  onSettingsChanged: (cb: (keys: string[]) => void) => {
    h.listener = cb
    return () => { h.listener = null }
  },
}))

import { settingsGet, settingsSet } from '@navide/plugin-ui/shared'
import {
  orderedAgentKeys,
  isAgentEnabled,
  useCliAgentPrefs,
  loadCliAgentPrefsFromProject,
  applyingRemoteCliAgentPrefs
} from '../useCliAgentPrefs'

const ORDER_KEY = 'agentTeam.cliAgents.order'
const DISABLED_KEY = 'agentTeam.cliAgents.disabled'

/** What another window's edit looks like from in here: the KV already holds the
 *  new value by the time the broadcast arrives. */
async function remoteWrite(order: string[] | null, disabled: string[] | null): Promise<void> {
  vi.mocked(settingsGet).mockImplementation((key) => {
    if (key === ORDER_KEY && order) return JSON.stringify(order)
    if (key === DISABLED_KEY && disabled) return JSON.stringify(disabled)
    return ''
  })
  h.listener?.([...(order ? [ORDER_KEY] : []), ...(disabled ? [DISABLED_KEY] : [])])
  await nextTick()
}

describe('useCliAgentPrefs', () => {
  beforeEach(async () => {
    const { order, disabled } = useCliAgentPrefs()
    order.value = []
    disabled.value = []
    await nextTick()
    vi.mocked(settingsGet).mockReset().mockReturnValue('')
    vi.mocked(settingsSet).mockClear()
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

  describe('loadCliAgentPrefsFromProject', () => {
    it('adopts the workspace-persisted value, including an explicit empty array', () => {
      loadCliAgentPrefsFromProject(['kimi', 'claude'], ['codex'])
      expect(useCliAgentPrefs().order.value).toEqual(['kimi', 'claude'])
      expect(useCliAgentPrefs().disabled.value).toEqual(['codex'])

      loadCliAgentPrefsFromProject([], [])
      expect(useCliAgentPrefs().order.value).toEqual([])
      expect(useCliAgentPrefs().disabled.value).toEqual([])
    })

    it('falls back to the legacy global default when the workspace never persisted its own', () => {
      vi.mocked(settingsGet).mockImplementation((key) =>
        key === 'agentTeam.cliAgents.order' ? JSON.stringify(['grok', 'claude']) : ''
      )
      loadCliAgentPrefsFromProject(null, undefined)
      expect(useCliAgentPrefs().order.value).toEqual(['grok', 'claude'])
      expect(useCliAgentPrefs().disabled.value).toEqual([])
      vi.mocked(settingsGet).mockReset().mockReturnValue('')
    })

    it('does not write the workspace\u2019s own list back into the global default', async () => {
      // The global KV is the fallback for a workspace that never persisted one.
      // Echoing every workspace load into it would make "the default" mean
      // "whichever project you opened last" \u2014 and would broadcast that
      // project's order to every other window.
      loadCliAgentPrefsFromProject(['kimi', 'claude'], ['codex'])
      await nextTick()
      expect(vi.mocked(settingsSet)).not.toHaveBeenCalled()
    })
  })

  describe('cross-window sync', () => {
    it('adopts a list another window saved', async () => {
      await remoteWrite(['kimi', 'claude'], ['codex'])
      expect(useCliAgentPrefs().order.value).toEqual(['kimi', 'claude'])
      expect(useCliAgentPrefs().disabled.value).toEqual(['codex'])
      expect(isAgentEnabled('codex')).toBe(false)
    })

    it('does not write an adopted value back out', async () => {
      // Both halves of the double write matter here: settingsSet would echo
      // straight back to the peer, and App.vue's per-workspace save watches the
      // same refs \u2014 so without the flag the two windows trade writes forever.
      await remoteWrite(['kimi', 'claude'], null)
      expect(vi.mocked(settingsSet)).not.toHaveBeenCalled()
    })

    it('does not write an adopted value into the workspace either', async () => {
      // The second half of the double write. App.vue persists the same two refs
      // per workspace from its own watcher; this reproduces that watcher rather
      // than asserting the flag, so what is pinned is the behaviour and not the
      // mechanism that produces it.
      const { order, disabled } = useCliAgentPrefs()
      const saveToWorkspace = vi.fn()
      const unwatch = watch([order, disabled], () => {
        if (applyingRemoteCliAgentPrefs.value) return
        saveToWorkspace()
      }, { deep: true })

      await remoteWrite(['grok', 'claude'], null)
      expect(saveToWorkspace).not.toHaveBeenCalled()

      // ...and the guard is down again afterwards, so this window's own edits
      // still reach the workspace record.
      order.value = ['claude', 'grok']
      await nextTick()
      expect(saveToWorkspace).toHaveBeenCalledTimes(1)
      unwatch()
    })

    it('ignores a broadcast about some other setting', async () => {
      useCliAgentPrefs().order.value = ['claude']
      await nextTick()
      h.listener?.(['agentTeam.somethingElse'])
      await nextTick()
      expect(useCliAgentPrefs().order.value).toEqual(['claude'])
    })

    it('does not re-enter on the broadcast its own write causes', async () => {
      const { order } = useCliAgentPrefs()
      order.value = ['claude', 'kimi']
      await nextTick()
      expect(vi.mocked(settingsSet)).toHaveBeenCalledWith(ORDER_KEY, JSON.stringify(['claude', 'kimi']))
      // The backend echoes every write back to every window, this one included.
      await remoteWrite(['claude', 'kimi'], null)
      expect(order.value).toEqual(['claude', 'kimi'])
      expect(vi.mocked(settingsSet)).toHaveBeenCalledTimes(1)
    })
  })
})
