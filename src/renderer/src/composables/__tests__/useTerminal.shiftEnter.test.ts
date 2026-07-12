// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockBackend, withScope } from './mockBackend'

// Shift+Enter must reach the CLI as ESC+CR (\x1b\r) — the sequence Claude
// Code's /terminal-setup installs for xterm.js terminals — so agent TUIs
// insert a newline instead of submitting. This regression-locks the third
// iteration of the feature (CSI-u and bracketed-paste LF both failed).
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
}))

vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
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

describe('useTerminal — Shift+Enter key handling', () => {
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
    return { mock, scope }
  }

  function inputsSent(mock: ReturnType<typeof createMockBackend>) {
    return mock.sent.filter((s) => s.type === 'terminal.input')
  }

  it('sends ESC+CR to the PTY and swallows the key', async () => {
    const { mock, scope } = await spawnedTerminal()
    const handled = captured.keyHandler!(keyEvent({ key: 'Enter', shiftKey: true }))
    expect(handled).toBe(false)
    expect(inputsSent(mock)).toEqual([
      { type: 'terminal.input', payload: { terminal_session_id: 'sess-1', data: '\x1b\r' } },
    ])
    scope.stop()
  })

  it('leaves plain Enter to xterm default handling', async () => {
    const { mock, scope } = await spawnedTerminal()
    const handled = captured.keyHandler!(keyEvent({ key: 'Enter' }))
    expect(handled).toBe(true)
    expect(inputsSent(mock)).toEqual([])
    scope.stop()
  })

  it('ignores Enter combined with other modifiers', async () => {
    const { mock, scope } = await spawnedTerminal()
    for (const mod of [{ metaKey: true }, { altKey: true }, { ctrlKey: true }]) {
      const handled = captured.keyHandler!(keyEvent({ key: 'Enter', shiftKey: true, ...mod }))
      expect(handled).toBe(true)
    }
    expect(inputsSent(mock)).toEqual([])
    scope.stop()
  })
})
