// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockBackend, withScope } from './mockBackend'

// fitTerminal's redraw opt-in is glue between useTerminal and the resize
// controller, so the controller (and xterm, which won't boot in happy-dom)
// are mocked and only the delegation is asserted. The gate behavior behind
// requestResizeRedraw is covered by useTerminalResize.test.ts.

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

vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    buffer = {
      active: { type: 'normal', viewportY: 0, baseY: 0, cursorX: 0, cursorY: 0, getLine: () => undefined },
    }
    loadAddon(): void {}
    open(): void {}
    attachCustomWheelEventHandler(): void {}
    attachCustomKeyEventHandler(): void {}
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

describe('useTerminal.fitTerminal — redrawAfterSettle option', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  function mountedTerminal() {
    const mock = createMockBackend()
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))
    result.mount(document.createElement('div'))
    return { result, scope }
  }

  it('default call fits without arming the redraw (spawn/reconciler paths unchanged)', () => {
    const { result, scope } = mountedTerminal()
    result.fitTerminal()
    expect(ctrl.applyFit).toHaveBeenCalledTimes(1)
    expect(ctrl.requestResizeRedraw).not.toHaveBeenCalled()
    scope.stop()
  })

  it('redrawAfterSettle: true fits then arms the gated redraw', () => {
    const { result, scope } = mountedTerminal()
    result.fitTerminal({ redrawAfterSettle: true })
    expect(ctrl.applyFit).toHaveBeenCalledTimes(1)
    expect(ctrl.requestResizeRedraw).toHaveBeenCalledTimes(1)
    scope.stop()
  })

  it('stays a no-op before mount, even with the flag', () => {
    const mock = createMockBackend()
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))
    result.fitTerminal({ redrawAfterSettle: true })
    expect(ctrl.applyFit).not.toHaveBeenCalled()
    expect(ctrl.requestResizeRedraw).not.toHaveBeenCalled()
    scope.stop()
  })
})
