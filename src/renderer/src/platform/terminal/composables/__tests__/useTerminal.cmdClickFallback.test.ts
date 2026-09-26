// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockBackend, withScope } from './mockBackend'

// ⌘-click on a path that no candidate stat-verifies (e.g. relative to a cwd
// the host cannot see) opens the fuzzy picker with the piece under the click.
// It must keep that piece's `:line` suffix and search for that piece's name —
// not whatever candidate happens to sit second in the de-duplicated list.

const ctrl = vi.hoisted(() => ({
  applyFit: vi.fn(),
  sendResizeNow: vi.fn(),
  requestResizeRedraw: vi.fn(),
  setColsCap: vi.fn(),
  capCols: vi.fn((cols: number) => cols),
  attachObserver: vi.fn(),
  dispose: vi.fn(),
  ackedCols: 0,
  ackedRows: 0,
}))

vi.mock('../useTerminalResize', () => ({
  createResizeController: () => ctrl,
}))

const CELL_W = 10
const CELL_H = 20

const screen = vi.hoisted(() => ({ text: '' }))

vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    unicode = { activeVersion: '6' }
    modes = { mouseTrackingMode: 'none' as string }
    _core = { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } } } }
    buffer = {
      active: {
        type: 'normal', viewportY: 0, baseY: 0, cursorX: 0, cursorY: 0,
        getLine: (row: number) => row === 0
          ? { isWrapped: false, length: screen.text.length, translateToString: () => screen.text }
          : undefined,
      },
    }
    loadAddon(): void {}
    open(parent: HTMLElement): void {
      const el = document.createElement('div')
      el.className = 'xterm-screen'
      parent.appendChild(el)
    }
    attachCustomWheelEventHandler(): void {}
    attachCustomKeyEventHandler(): void {}
    registerLinkProvider(): { dispose(): void } { return { dispose(): void {} } }
    onResize(): { dispose(): void } { return { dispose(): void {} } }
    onData(): { dispose(): void } { return { dispose(): void {} } }
    getSelection(): string { return '' }
    hasSelection(): boolean { return false }
    onSelectionChange(): { dispose(): void } { return { dispose(): void {} } }
    write(): void {}
    writeln(): void {}
    resize(): void {}
    focus(): void {}
    select(): void {}
    clearSelection(): void {}
    scrollLines(): void {}
    scrollToBottom(): void {}
    dispose(): void {}
  }
  return { Terminal }
})

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
    proposeDimensions(): { cols: number; rows: number } { return { cols: 80, rows: 24 } }
  },
}))

const pickerOpen = vi.hoisted(() => vi.fn())
vi.mock('@navide/plugin-ui/file-picker', () => ({
  createTerminalFilePicker: () => ({ open: pickerOpen, close: vi.fn() }),
}))

import { useTerminal } from '../useTerminal'

afterEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})

async function cmdClick(text: string, target: string, existing?: string) {
  screen.text = text
  const mock = createMockBackend()
  Object.assign(mock.backend, {
    statPath: async (path: string) => ({ ok: true, payload: { exists: path === existing } }),
  })
  const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend, { workspacePath: '/ws' }))
  const el = document.createElement('div')
  document.body.appendChild(el)
  result.mount(el)
  const col = text.indexOf(target) + 1
  el.dispatchEvent(new MouseEvent('mousedown', {
    bubbles: true, cancelable: true, metaKey: true, button: 0,
    clientX: col * CELL_W + 1, clientY: CELL_H / 2,
  }))
  await vi.waitFor(() => expect(pickerOpen).toHaveBeenCalledOnce())
  scope.stop()
  el.remove()
  return pickerOpen.mock.calls[0]![0] as { initialQuery: string; lineNum?: number; displayText: string; preferredAbsPath?: string }
}

describe('useTerminal — ⌘-click on an unverified path', () => {
  it('keeps the line suffix of the clicked piece', async () => {
    const opened = await cmdClick('see /a/foo.ts:12 and more', 'foo')

    expect(opened).toMatchObject({ initialQuery: 'foo.ts', lineNum: 12, displayText: '/a/foo.ts' })
  })

  it('keeps the line suffix of a clicked relative path', async () => {
    const opened = await cmdClick('error in src/foo.ts:7 here', 'foo')

    expect(opened).toMatchObject({ initialQuery: 'foo.ts', lineNum: 7, displayText: 'src/foo.ts' })
  })

  // A verified candidate wins over the fallback, and the picker searches for
  // the name of the file it is about to prefer.
  it('searches for the verified candidate, not the fallback piece', async () => {
    const opened = await cmdClick('open docs/README（中文）.md now', 'README', '/ws/docs/README（中文）.md')

    expect(opened.preferredAbsPath).toBe('/ws/docs/README（中文）.md')
    expect(opened).toMatchObject({ initialQuery: 'README（中文）.md', displayText: 'docs/README（中文）.md' })
  })
})
