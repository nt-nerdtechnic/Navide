import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizePlatformId, setPlatformId } from '../shared/osplat'
import { setWindowDockTileBadge } from './dock-tile-badge'

// Only the guards are exercised here. The FFI path sends real objc_msgSend
// calls through koffi; driving it with a fake window handle on a mac would
// dereference garbage, so it stays a manual check.


function fakeWindow(destroyed: boolean) {
  const getNativeWindowHandle = vi.fn()
  return {
    win: { isDestroyed: () => destroyed, getNativeWindowHandle } as unknown as import('electron').BrowserWindow,
    getNativeWindowHandle,
  }
}

describe('setWindowDockTileBadge guards', () => {
  afterEach(() => setPlatformId(normalizePlatformId(process.platform)))

  it('returns false off macOS before touching the window', () => {
    setPlatformId('linux')
    const { win, getNativeWindowHandle } = fakeWindow(false)
    expect(setWindowDockTileBadge(win, '3')).toBe(false)
    expect(getNativeWindowHandle).not.toHaveBeenCalled()
  })

  it('returns false for a destroyed window before loading the FFI', () => {
    setPlatformId('darwin')
    const { win, getNativeWindowHandle } = fakeWindow(true)
    expect(setWindowDockTileBadge(win, '')).toBe(false)
    expect(getNativeWindowHandle).not.toHaveBeenCalled()
  })
})
