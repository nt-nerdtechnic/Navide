// @vitest-environment node
// The push-channel switch as shared state.
//
// SettingsModal.pushChannels.test.ts pins the contract with the backend (which
// key, which vendors, that all-off is allowed). What this file pins is the part
// that used to be missing: the list is one module-scoped ref, so a second
// window editing the same page repaints this one instead of leaving it on a
// copy that is stale until reload.
import { beforeEach, describe, expect, it, vi } from 'vitest'

// In-memory settings backend, with the change listener captured so a "another
// window wrote this" broadcast can be replayed. vi.hoisted because the module
// under test subscribes at import time.
const h = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  listener: null as ((keys: string[]) => void) | null,
}))

vi.mock('@navide/plugin-ui/shared', () => ({
  settingsGet: (key: string, fallback: unknown) =>
    h.store.has(key) ? h.store.get(key) : fallback,
  settingsSet: (key: string, value: unknown) => {
    h.store.set(key, value)
  },
  onSettingsChanged: (cb: (keys: string[]) => void) => {
    h.listener = cb
    return () => {
      h.listener = null
    }
  },
}))

import {
  PUSH_DISABLED_KEY,
  pushChannelEnabled,
  togglePushChannel,
  usePushChannelPrefs,
} from '../usePushChannelPrefs'

const { pushDisabled } = usePushChannelPrefs()

/** What another window doing the same edit looks like from in here. */
function remoteWrite(value: string[]): void {
  h.store.set(PUSH_DISABLED_KEY, value)
  h.listener?.([PUSH_DISABLED_KEY])
}

describe('usePushChannelPrefs', () => {
  beforeEach(() => {
    h.store.clear()
    remoteWrite([])
  })

  it('treats every channel as on until it is switched off', () => {
    expect(pushDisabled.value).toEqual([])
    expect(pushChannelEnabled('claude')).toBe(true)
  })

  it('writes the key the backend reads', () => {
    togglePushChannel('opencode')
    expect(h.store.get(PUSH_DISABLED_KEY)).toEqual(['opencode'])
    expect(pushChannelEnabled('opencode')).toBe(false)
  })

  it('switching it back on removes it again', () => {
    togglePushChannel('qwen')
    togglePushChannel('qwen')
    expect(h.store.get(PUSH_DISABLED_KEY)).toEqual([])
    expect(pushChannelEnabled('qwen')).toBe(true)
  })

  it('allows every channel to be switched off', () => {
    for (const key of ['claude', 'kilo', 'opencode', 'qwen']) togglePushChannel(key)
    expect([...(h.store.get(PUSH_DISABLED_KEY) as string[])].sort())
      .toEqual(['claude', 'kilo', 'opencode', 'qwen'])
  })

  it('picks up a change made in another window', () => {
    remoteWrite(['kilo', 'claude'])
    expect([...pushDisabled.value].sort()).toEqual(['claude', 'kilo'])
    expect(pushChannelEnabled('kilo')).toBe(false)
  })

  it('ignores a broadcast about some other setting', () => {
    togglePushChannel('kilo')
    h.store.set('somethingElse', 1)
    h.listener?.(['somethingElse'])
    expect(pushDisabled.value).toEqual(['kilo'])
  })

  it('does not re-enter on the broadcast its own write causes', () => {
    togglePushChannel('claude')
    // The real backend echoes every write back to every window, this one
    // included; the echo must not undo or double-apply the edit.
    h.listener?.([PUSH_DISABLED_KEY])
    expect(pushDisabled.value).toEqual(['claude'])
  })
})
