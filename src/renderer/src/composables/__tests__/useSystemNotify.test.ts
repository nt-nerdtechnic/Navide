// @vitest-environment happy-dom
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { __resetSettingsForTest } from '@navide/plugin-ui/shared/testing'
import {
  isPaneMuted,
  setPaneMuted,
  setSystemNotifyEnabled,
  shouldNotify,
  systemNotifyEnabled,
  useSystemNotify,
  type NotifyKind,
} from '../useSystemNotify'
import { setNotifySoundEnabled } from '../useSoundNotify'

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

describe('shouldNotify — enabled gate', () => {
  it('disabled suppresses even a fresh background signal', () => {
    expect(shouldNotify({ appFocused: false, lastKind: undefined, kind: 'done', enabled: false }))
      .toBe(false)
  })

  it('enabled: true behaves like the default', () => {
    expect(shouldNotify({ appFocused: false, lastKind: undefined, kind: 'done', enabled: true }))
      .toBe(true)
  })
})

describe('notifyPaneState — system notification toggle', () => {
  const notify = vi.fn(() => Promise.resolve())

  beforeEach(() => {
    __resetSettingsForTest()
    notify.mockClear()
    ;(window as unknown as { agentTeam: unknown }).agentTeam = { notify }
    // Background the window: the gate never fires while focused.
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
  })

  it('defaults to enabled', () => {
    expect(systemNotifyEnabled()).toBe(true)
  })

  it('disabled: no OS notification, but the Dock badge still counts the pane', () => {
    const sys = useSystemNotify()
    const before = sys.pendingCount.value
    setSystemNotifyEnabled(false)
    sys.notifyPaneState('pane-toggle-off', 'done', 't', 'b')
    expect(notify).not.toHaveBeenCalled()
    expect(sys.pendingCount.value).toBe(before + 1)
    sys.forgetPane('pane-toggle-off')
  })

  it('re-enabling lets the next signal through (dedup was not recorded while off)', () => {
    const sys = useSystemNotify()
    setSystemNotifyEnabled(false)
    sys.notifyPaneState('pane-toggle-rearm', 'done', 't', 'b')
    setSystemNotifyEnabled(true)
    sys.notifyPaneState('pane-toggle-rearm', 'done', 't', 'b')
    expect(notify).toHaveBeenCalledTimes(1)
    sys.forgetPane('pane-toggle-rearm')
  })
})

describe('Dock badge pending state — clear rules', () => {
  const notify = vi.fn(() => Promise.resolve())

  function setWindowFocus(focused: boolean): void {
    // useSystemNotify tracks focus through the window focus/blur events once
    // its listeners are bound; dispatching them is the only honest way to move
    // the module-level flag.
    window.dispatchEvent(new Event(focused ? 'focus' : 'blur'))
  }

  beforeEach(() => {
    __resetSettingsForTest()
    notify.mockClear()
    ;(window as unknown as { agentTeam: unknown }).agentTeam = { notify }
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
  })

  it('the same pane signalled twice counts once', () => {
    const sys = useSystemNotify()
    const before = sys.pendingCount.value
    sys.notifyPaneState('badge-dup', 'done', 't', 'b')
    sys.notifyPaneState('badge-dup', 'attention', 't', 'b')
    expect(sys.pendingCount.value).toBe(before + 1)
    sys.forgetPane('badge-dup')
  })

  it('markSeen while the app is backgrounded does NOT clear (programmatic focus is not "seen")', () => {
    const sys = useSystemNotify()
    setWindowFocus(false)
    const before = sys.pendingCount.value
    sys.notifyPaneState('badge-bg', 'done', 't', 'b')
    sys.markSeen('badge-bg')
    expect(sys.pendingCount.value).toBe(before + 1)
    sys.forgetPane('badge-bg')
  })

  it('markSeen with the app focused clears the pane', () => {
    const sys = useSystemNotify()
    setWindowFocus(false)
    const before = sys.pendingCount.value
    sys.notifyPaneState('badge-seen', 'done', 't', 'b')
    setWindowFocus(true)
    sys.markSeen('badge-seen')
    expect(sys.pendingCount.value).toBe(before)
    setWindowFocus(false)
  })

  it('markActive (new turn) clears pending AND re-arms dedup for the same kind', () => {
    const sys = useSystemNotify()
    setWindowFocus(false)
    const before = sys.pendingCount.value
    sys.notifyPaneState('badge-active', 'done', 't', 'b')
    expect(notify).toHaveBeenCalledTimes(1)
    sys.markActive('badge-active')
    expect(sys.pendingCount.value).toBe(before)
    sys.notifyPaneState('badge-active', 'done', 't', 'b')
    expect(notify).toHaveBeenCalledTimes(2)
    sys.forgetPane('badge-active')
  })

  it('forgetPane (pane closed) clears pending and dedup', () => {
    const sys = useSystemNotify()
    setWindowFocus(false)
    const before = sys.pendingCount.value
    sys.notifyPaneState('badge-forget', 'done', 't', 'b')
    sys.forgetPane('badge-forget')
    expect(sys.pendingCount.value).toBe(before)
    sys.notifyPaneState('badge-forget', 'done', 't', 'b')
    expect(notify).toHaveBeenCalledTimes(2)
    sys.forgetPane('badge-forget')
  })

  it('forgetPane on a pane that was never pending is a no-op', () => {
    const sys = useSystemNotify()
    const before = sys.pendingCount.value
    sys.forgetPane('badge-never')
    expect(sys.pendingCount.value).toBe(before)
  })
})

describe('per-pane mute', () => {
  const notify = vi.fn(() => Promise.resolve())

  beforeEach(() => {
    __resetSettingsForTest()
    notify.mockClear()
    ;(window as unknown as { agentTeam: unknown }).agentTeam = { notify }
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    window.dispatchEvent(new Event('blur'))
  })

  it('defaults to unmuted', () => {
    expect(isPaneMuted('mute-default')).toBe(false)
  })

  it('a muted pane sends no OS notification but still counts toward the badge', () => {
    const sys = useSystemNotify()
    const before = sys.pendingCount.value
    setPaneMuted('mute-on', true)
    sys.notifyPaneState('mute-on', 'done', 't', 'b')
    expect(notify).not.toHaveBeenCalled()
    expect(sys.pendingCount.value).toBe(before + 1)
    sys.forgetPane('mute-on')
  })

  it('mute is per pane: another pane still notifies', () => {
    const sys = useSystemNotify()
    setPaneMuted('mute-a', true)
    sys.notifyPaneState('mute-a', 'done', 't', 'b')
    sys.notifyPaneState('mute-b', 'done', 't', 'b')
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ paneId: 'mute-b' }))
    sys.forgetPane('mute-a'); sys.forgetPane('mute-b')
  })

  it('unmuting lets the very next same-kind signal through (dedup not recorded while muted)', () => {
    const sys = useSystemNotify()
    setPaneMuted('mute-rearm', true)
    sys.notifyPaneState('mute-rearm', 'done', 't', 'b')
    setPaneMuted('mute-rearm', false)
    sys.notifyPaneState('mute-rearm', 'done', 't', 'b')
    expect(notify).toHaveBeenCalledTimes(1)
    sys.forgetPane('mute-rearm')
  })

  it('forgetPane (process gone) keeps the mute: rebuild and idle reclaim run it on a seat that survives', () => {
    const sys = useSystemNotify()
    const before = sys.pendingCount.value
    setPaneMuted('mute-forget', true)
    sys.notifyPaneState('mute-forget', 'done', 't', 'b')
    sys.forgetPane('mute-forget')
    expect(sys.pendingCount.value).toBe(before)
    expect(isPaneMuted('mute-forget')).toBe(true)
    setPaneMuted('mute-forget', false)
    expect(isPaneMuted('mute-forget')).toBe(false)
  })

  it('mutedPanes is exposed read-only and tracks set/unset', () => {
    const sys = useSystemNotify()
    setPaneMuted('mute-ro', true)
    expect(sys.mutedPanes.value.has('mute-ro')).toBe(true)
    setPaneMuted('mute-ro', false)
    expect(sys.mutedPanes.value.has('mute-ro')).toBe(false)
  })
})

describe('OS notification sound follows the sound toggle', () => {
  const notify = vi.fn(() => Promise.resolve())

  beforeEach(() => {
    __resetSettingsForTest()
    notify.mockClear()
    ;(window as unknown as { agentTeam: unknown }).agentTeam = { notify }
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    window.dispatchEvent(new Event('blur'))
  })

  it('sound on → notification is not silent', () => {
    const sys = useSystemNotify()
    sys.notifyPaneState('snd-on', 'done', 't', 'b')
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ silent: false }))
    sys.forgetPane('snd-on')
  })

  it('sound off → notification is delivered silent', () => {
    const sys = useSystemNotify()
    setNotifySoundEnabled(false)
    sys.notifyPaneState('snd-off', 'done', 't', 'b')
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ silent: true }))
    sys.forgetPane('snd-off')
  })
})
