// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockBackend, withScope } from './mockBackend'

// The RUNNING/idle badge is driven by useTerminal's clean-content quiescence
// heuristic: a sustained burst of CLEANED PTY output (>MIN_BURST_MS ~2s) shows
// RUNNING. Two things must NOT count as agent activity:
//   1. A repaint WE trigger (focusing/clicking a pane, or a refit) — otherwise
//      the badge flips to RUNNING on a mere click.
//   2. An idle CLI's own footer/cursor repaints — raw bytes that are empty
//      after ANSI/noise stripping. This is why the badge tracks CLEANED
//      content, not raw bytes: an idle Claude repainting its prompt must read
//      as idle, not RUNNING.
// These tests pin all three: real clean output → RUNNING; a focus/refit grace
// → non-running; and a pure-ANSI repaint stream → non-running.
//
// (Note: spawn() focuses the pane, so a fresh pane is graced for FOCUS_GRACE_MS;
// the control streams long enough to outlast that initial grace.)
//
// xterm won't boot in happy-dom, so it's mocked; ctrl.requestResizeRedraw is a
// no-op stub (the fitTerminal redraw grace is set before it runs).

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
    unicode = { activeVersion: '6' }
    textarea = document.createElement('textarea')
    buffer = {
      active: { type: 'normal', viewportY: 0, baseY: 0, cursorX: 0, cursorY: 0, getLine: () => undefined },
    }
    loadAddon(): void {}
    open(): void {}
    attachCustomWheelEventHandler(): void {}
    attachCustomKeyEventHandler(): void {}
    registerLinkProvider(): { dispose(): void } { return { dispose(): void {} } }
    onResize(): { dispose(): void } { return { dispose(): void {} } }
    onData(): { dispose(): void } { return { dispose(): void {} } }
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

import { useTerminal } from '../useTerminal'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('useTerminal — RUNNING badge vs self-triggered repaints', () => {
  afterEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  async function spawned() {
    const mock = createMockBackend()
    mock.setResponse('terminal.create', { terminal_session_id: 'sess-1', pid: 42 })
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))
    result.mount(document.createElement('div'))
    await result.spawn({ command: 'bash', cwd: '/tmp' })
    return { result, mock, scope }
  }

  // Feed a sub-BURST_GAP_MS (1s) stream of PTY bytes for `ms`, running `onTick`
  // before each chunk (used to keep re-arming a focus/refit grace).
  async function stream(
    mock: ReturnType<typeof createMockBackend>,
    ms: number,
    onTick?: () => void,
  ): Promise<void> {
    const deadline = Date.now() + ms
    do {
      onTick?.()
      mock.emit('terminal.output', { terminal_session_id: 'sess-1', data: '.' })
      await sleep(250)
    } while (Date.now() < deadline)
  }

  it('shows RUNNING for a genuine sustained output burst', async () => {
    const { result, mock, scope } = await spawned()
    // Long enough to outlast spawn's initial focus grace (~3s) AND then sustain
    // a burst past MIN_BURST_MS (~2s) → ~5.5s+.
    await stream(mock, 6000)
    expect(result.displayStatus.value).toBe('running')
    scope.stop()
  }, 12_000)

  it('stays non-running while a focus grace is continuously active', async () => {
    const { result, mock, scope } = await spawned()
    // Identical byte pattern and duration, but the pane is re-focused each tick
    // — every chunk lands inside the focus grace, so no RUNNING burst forms.
    await stream(mock, 6000, () => result.focus())
    expect(result.displayStatus.value).not.toBe('running')
    scope.stop()
  }, 12_000)

  it('stays non-running while a refit-triggered redraw grace is active', async () => {
    const { result, mock, scope } = await spawned()
    await stream(mock, 6000, () => result.fitTerminal({ redrawAfterSettle: true }))
    expect(result.displayStatus.value).not.toBe('running')
    scope.stop()
  }, 12_000)

  it('stays non-running while the CLI only emits idle TUI repaints (no clean content)', async () => {
    const { result, mock, scope } = await spawned()
    // A pure erase-line + cursor-home repaint. stripAnsi removes it entirely, so
    // it carries no clean content — exactly what an idle Claude emits when it
    // repaints its prompt/cursor while waiting for input. Raw bytes keep
    // arriving (liveness stays alive) but no RUNNING burst may form.
    const deadline = Date.now() + 6000
    do {
      mock.emit('terminal.output', { terminal_session_id: 'sess-1', data: '\x1b[2K\x1b[1G' })
      await sleep(250)
    } while (Date.now() < deadline)
    expect(result.displayStatus.value).not.toBe('running')
    scope.stop()
  }, 12_000)
})
