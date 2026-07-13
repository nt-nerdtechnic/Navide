// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockBackend, withScope } from './mockBackend'

// ⌘= / ⌘- / ⌘0 adjust the focused pane's terminal font size (VS Code
// integrated-terminal parity). The editor window binds the same keys to
// Monaco font zoom; the CLI pane handles them in xterm's custom key handler.
// xterm won't boot in happy-dom, so the mock captures the custom key event
// handler and the test drives it directly.

const ctrl = vi.hoisted(() => ({
  applyFit: vi.fn(),
  sendResizeNow: vi.fn(),
  requestResizeRedraw: vi.fn(),
  attachObserver: vi.fn(),
  dispose: vi.fn(),
  ackedCols: 0,
  ackedRows: 0,
}))

vi.mock('../useTerminalResize', () => ({
  createResizeController: () => ctrl,
}))

const captured = vi.hoisted(() => ({
  keyHandler: undefined as ((e: KeyboardEvent) => boolean) | undefined,
  options: {} as Record<string, unknown>,
}))

vi.mock('@xterm/xterm', () => {
  class Terminal {
    constructor(opts: Record<string, unknown>) {
      this.options = { ...opts }
      captured.options = this.options
    }
    cols = 80
    rows = 24
    options: Record<string, unknown>
    unicode = { activeVersion: '6' }
    buffer = {
      active: { type: 'normal', viewportY: 0, baseY: 0, cursorX: 0, cursorY: 0, getLine: () => undefined },
    }
    loadAddon(): void {}
    open(): void {}
    attachCustomWheelEventHandler(): void {}
    attachCustomKeyEventHandler(handler: (e: KeyboardEvent) => boolean): void {
      captured.keyHandler = handler
    }
    registerLinkProvider(): { dispose(): void } {
      return { dispose(): void {} }
    }
    onData(): { dispose(): void } {
      return { dispose(): void {} }
    }
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
    proposeDimensions(): { cols: number; rows: number } {
      return { cols: 80, rows: 24 }
    }
  },
}))

import { useTerminal } from '../useTerminal'

function keyEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    type: 'keydown',
    key: '',
    shiftKey: false,
    metaKey: false,
    altKey: false,
    ctrlKey: false,
    ...overrides,
  } as KeyboardEvent
}

describe('useTerminal — ⌘=/⌘-/⌘0 font zoom', () => {
  afterEach(() => {
    vi.clearAllMocks()
    captured.keyHandler = undefined
    localStorage.clear() // drop the persisted PTY id so the next spawn is fresh
  })

  async function spawnedTerminal() {
    const mock = createMockBackend()
    mock.setResponse('terminal.create', { terminal_session_id: 'sess-1', pid: 42 })
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))
    result.mount(document.createElement('div'))
    await result.spawn({ command: 'bash', cwd: '/tmp' })
    ctrl.applyFit.mockClear() // mount/spawn call applyFit; count only zoom-driven calls
    return { term: { options: captured.options as { fontSize: number } }, scope }
  }

  it('⌘= grows the font and refits', async () => {
    const { term, scope } = await spawnedTerminal()
    const handled = captured.keyHandler!(keyEvent({ key: '=', metaKey: true }))
    expect(handled).toBe(false)
    expect(term.options.fontSize).toBe(13)
    expect(ctrl.applyFit).toHaveBeenCalledTimes(1)
    scope.stop()
  })

  it('⌘- shrinks the font and clamps at the minimum', async () => {
    const { term, scope } = await spawnedTerminal()
    for (let i = 0; i < 10; i++) captured.keyHandler!(keyEvent({ key: '-', metaKey: true }))
    expect(term.options.fontSize).toBe(6)
    for (let i = 0; i < 3; i++) captured.keyHandler!(keyEvent({ key: '-', metaKey: true }))
    expect(term.options.fontSize).toBe(6) // clamped — no further shrink
    expect(ctrl.applyFit).toHaveBeenCalledTimes(6) // 12→6, clamped presses don't refit
    scope.stop()
  })

  it('⌘= clamps at the maximum', async () => {
    const { term, scope } = await spawnedTerminal()
    for (let i = 0; i < 30; i++) captured.keyHandler!(keyEvent({ key: '=', metaKey: true }))
    expect(term.options.fontSize).toBe(32)
    scope.stop()
  })

  it('⌘0 resets to the default size', async () => {
    const { term, scope } = await spawnedTerminal()
    for (let i = 0; i < 5; i++) captured.keyHandler!(keyEvent({ key: '=', metaKey: true }))
    expect(term.options.fontSize).toBe(17)
    const handled = captured.keyHandler!(keyEvent({ key: '0', metaKey: true }))
    expect(handled).toBe(false)
    expect(term.options.fontSize).toBe(12)
    scope.stop()
  })

  it('leaves plain and shift/alt/ctrl-modified keys to xterm', async () => {
    const { term, scope } = await spawnedTerminal()
    for (const ev of [
      keyEvent({ key: '=' }),
      keyEvent({ key: '-', metaKey: true, shiftKey: true }),
      keyEvent({ key: '=', metaKey: true, altKey: true }),
      keyEvent({ key: '0', metaKey: true, ctrlKey: true }),
    ]) {
      expect(captured.keyHandler!(ev)).toBe(true)
    }
    expect(term.options.fontSize).toBe(12)
    expect(ctrl.applyFit).not.toHaveBeenCalled()
    scope.stop()
  })
})
