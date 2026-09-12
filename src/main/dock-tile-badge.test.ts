import { afterEach, describe, expect, it, vi } from 'vitest'
import { setWindowDockTileBadge } from './dock-tile-badge'

// Only the guards are exercised here. The FFI path sends real objc_msgSend
// calls through koffi; driving it with a fake window handle on a mac would
// dereference garbage, so it stays a manual check.

function setPlatform(p: string): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

function fakeWindow(destroyed: boolean) {
  const getNativeWindowHandle = vi.fn()
  return {
    win: { isDestroyed: () => destroyed, getNativeWindowHandle } as unknown as import('electron').BrowserWindow,
    getNativeWindowHandle,
  }
}

describe('setWindowDockTileBadge guards', () => {
  const realPlatform = process.platform
  afterEach(() => setPlatform(realPlatform))

  it('returns false off macOS before touching the window', () => {
    setPlatform('linux')
    const { win, getNativeWindowHandle } = fakeWindow(false)
    expect(setWindowDockTileBadge(win, '3')).toBe(false)
    expect(getNativeWindowHandle).not.toHaveBeenCalled()
  })

  it('returns false for a destroyed window before loading the FFI', () => {
    setPlatform('darwin')
    const { win, getNativeWindowHandle } = fakeWindow(true)
    expect(setWindowDockTileBadge(win, '')).toBe(false)
    expect(getNativeWindowHandle).not.toHaveBeenCalled()
  })
})
