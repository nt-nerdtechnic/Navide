import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const windows = vi.hoisted(() => [] as FakeWindow[])
class FakeWindow extends EventEmitter {
  destroyed = false
  minimized = false
  webContents = { send: vi.fn() }
  show = vi.fn()
  focus = vi.fn()
  restore = vi.fn(() => { this.minimized = false })
  constructor(readonly options: Record<string, unknown>) {
    super()
    windows.push(this)
  }
  isDestroyed(): boolean { return this.destroyed }
  isMinimized(): boolean { return this.minimized }
}
vi.mock('electron', () => ({
  BrowserWindow: class extends EventEmitter {
    constructor(options: Record<string, unknown>) {
      super()
      return new FakeWindow(options)
    }
  },
}))
import { createTokenMonitorWindowOpener } from './token-monitor-window'

function setup() {
  const load = vi.fn()
  const open = createTokenMonitorWindowOpener({
    preload: '/host/preload/index.js',
    frame: { titleBarStyle: 'hidden' },
    locale: () => 'en-US',
    load,
  })
  return { open, load }
}

beforeEach(() => { windows.length = 0 })

describe('Token Monitor window', () => {
  it('loads an isolated Host renderer and reveals only after its first paint', () => {
    const { open, load } = setup()
    open()
    const win = windows[0]
    expect(win.options).toMatchObject({
      title: 'Token Monitor', show: false, titleBarStyle: 'hidden',
      webPreferences: {
        preload: '/host/preload/index.js', contextIsolation: true, nodeIntegration: false,
      },
    })
    expect(load).toHaveBeenCalledWith(win, { window: 'token-monitor', locale: 'en-US' })
    expect(win.show).not.toHaveBeenCalled()
    win.emit('ready-to-show')
    expect(win.show).toHaveBeenCalledOnce()
    expect(win.focus).toHaveBeenCalledOnce()
  })

  it('reuses the loading window and restores a minimized monitor without reloading', () => {
    const { open, load } = setup()
    open()
    windows[0].minimized = true
    open()
    expect(windows).toHaveLength(1)
    expect(load).toHaveBeenCalledOnce()
    expect(windows[0].restore).toHaveBeenCalledOnce()
    expect(windows[0].focus).toHaveBeenCalledOnce()
    expect(windows[0].webContents.send).toHaveBeenCalledWith('settings:language-changed', 'en-US')
  })

  it('reopens after close and ignores delayed events from an obsolete window', () => {
    const { open } = setup()
    open()
    const old = windows[0]
    old.destroyed = true
    open()
    old.emit('closed')
    old.emit('ready-to-show')
    open()
    expect(windows).toHaveLength(2)
    expect(old.show).not.toHaveBeenCalled()
    windows[1].emit('closed')
    open()
    expect(windows).toHaveLength(3)
  })
})
