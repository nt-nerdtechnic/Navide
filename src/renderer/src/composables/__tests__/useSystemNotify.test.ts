// @vitest-environment happy-dom
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { __resetSettingsForTest } from '@navide/plugin-ui/shared/testing'
import {
  setSystemNotifyEnabled,
  shouldNotify,
  systemNotifyEnabled,
  useSystemNotify,
  type NotifyKind,
} from '../useSystemNotify'

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
