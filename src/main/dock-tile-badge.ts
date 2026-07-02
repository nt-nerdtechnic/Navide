import type { BrowserWindow } from 'electron'

// macOS per-window Dock tile badge (Terminal.app-style): when a window is
// minimized, its Dock tile can carry the same system red badge as the app icon
// via NSWindow.dockTile.badgeLabel. Electron has no API for this, so we call
// libobjc directly through koffi FFI — no native addon build step required.
//
// ObjC objects are passed as raw uint64 pointer values, which matches the C ABI
// of objc_msgSend for these object-typed signatures on arm64 and x86_64. Values
// may come back as number or BigInt depending on magnitude; both are accepted
// as uint64 arguments by koffi. All calls happen on the Electron main process
// thread, which is the AppKit main thread.

type ObjcApi = {
  getClass: (name: string) => number | bigint
  sel: (name: string) => number | bigint
  send: (self: number | bigint, sel: number | bigint) => number | bigint
  sendPtr: (self: number | bigint, sel: number | bigint, arg: number | bigint) => number | bigint
  sendStr: (self: number | bigint, sel: number | bigint, arg: string) => number | bigint
}

let api: ObjcApi | null = null
let loadFailed = false

function loadApi(): ObjcApi | null {
  if (api || loadFailed) return api
  try {
    // Lazy-required so non-darwin platforms and test environments never load
    // the native FFI library.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi')
    const objc = koffi.load('libobjc.A.dylib')
    api = {
      getClass: objc.func('objc_getClass', 'uint64', ['str']),
      sel: objc.func('sel_registerName', 'uint64', ['str']),
      send: objc.func('objc_msgSend', 'uint64', ['uint64', 'uint64']),
      sendPtr: objc.func('objc_msgSend', 'uint64', ['uint64', 'uint64', 'uint64']),
      sendStr: objc.func('objc_msgSend', 'uint64', ['uint64', 'uint64', 'str']),
    }
  } catch (err) {
    loadFailed = true
    console.error('[dock-tile-badge] FFI unavailable, per-window badges disabled', err)
  }
  return api
}

/** Set (or clear, with '') the red badge on a window's minimized Dock tile. */
export function setWindowDockTileBadge(win: BrowserWindow, label: string): boolean {
  if (process.platform !== 'darwin' || win.isDestroyed()) return false
  const a = loadApi()
  if (!a) return false
  try {
    const view = win.getNativeWindowHandle().readBigUInt64LE(0) // NSView*
    if (!view) return false
    const nsWindow = a.send(view, a.sel('window'))
    if (!nsWindow) return false
    const dockTile = a.send(nsWindow, a.sel('dockTile'))
    if (!dockTile) return false
    const nsLabel = label
      ? a.sendStr(a.getClass('NSString'), a.sel('stringWithUTF8String:'), label)
      : 0
    a.sendPtr(dockTile, a.sel('setBadgeLabel:'), nsLabel)
    return true
  } catch (err) {
    console.error('[dock-tile-badge] setBadgeLabel failed', err)
    return false
  }
}
