// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, shallowRef, type Ref } from 'vue'
import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import { createResizeController, type ResizeController } from '../useTerminalResize'
import { createMockBackend } from './mockBackend'

// Mirror the timing constants inside useTerminalResize.ts.
const SETTLE_MS = 220 // RESIZE_REDRAW_SETTLE_MS
const MAX_WAIT_MS = 1500 // RESIZE_REDRAW_MAX_WAIT_MS

type FakeTerm = { cols: number; rows: number; clear: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn> }

describe('createResizeController — requestResizeRedraw gates', () => {
  let term: FakeTerm
  let mock: ReturnType<typeof createMockBackend>
  let sessionId: Ref<string>
  let lastRawActivityAt: Ref<number>
  let ctrl: ResizeController
  let onStableWidthChange: ReturnType<typeof vi.fn>

  beforeEach(() => {
    // Only fake what the redraw path uses; microtasks stay real so the mocked
    // backend send() promises settle during advanceTimersByTimeAsync.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
    )
    term = { cols: 80, rows: 24, clear: vi.fn(), resize: vi.fn() }
    mock = createMockBackend()
    sessionId = ref('sess-1')
    lastRawActivityAt = ref(0)
    onStableWidthChange = vi.fn()
    ctrl = createResizeController(
      term as unknown as Terminal,
      { fit: vi.fn() } as unknown as FitAddon,
      sessionId,
      shallowRef<HTMLElement | null>(null),
      lastRawActivityAt,
      mock.backend.send,
      () => {},
      () => false,
      () => {},
      onStableWidthChange
    )
  })

  afterEach(() => {
    // Hard rule: nothing in the resize/redraw path may wipe the scrollback.
    expect(term.clear).not.toHaveBeenCalled()
    ctrl.dispose()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function attach(): void {
    ctrl.attachObserver(document.createElement('div'))
  }

  /** Push the current fake-term size to the backend so acked == xterm. */
  async function ackCurrentSize(): Promise<void> {
    ctrl.sendResizeNow()
    await vi.advanceTimersByTimeAsync(0)
  }

  function redrawCount(): number {
    return mock.sent.filter((s) => s.type === 'terminal.redraw').length
  }

  it('exposes requestResizeRedraw on the controller (ResizeController interface)', () => {
    expect(typeof ctrl.requestResizeRedraw).toBe('function')
  })

  it('never fires while the controller is inactive (observer not attached)', async () => {
    await ackCurrentSize()
    ctrl.requestResizeRedraw()
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS + SETTLE_MS)
    expect(redrawCount()).toBe(0)
  })

  it('never fires without a session id', async () => {
    attach()
    sessionId.value = ''
    ctrl.requestResizeRedraw()
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS + SETTLE_MS)
    expect(redrawCount()).toBe(0)
  })

  it('waits until xterm matches the backend-acked size before firing', async () => {
    attach()
    await ackCurrentSize() // acked 80x24
    term.cols = 100 // xterm refit, backend not acked yet
    ctrl.requestResizeRedraw()
    await vi.advanceTimersByTimeAsync(SETTLE_MS * 4)
    expect(redrawCount()).toBe(0) // still polling — not settled
    await ackCurrentSize() // acked 100x24
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    expect(redrawCount()).toBe(1)
    const redraw = mock.sent.find((s) => s.type === 'terminal.redraw')
    expect(redraw?.payload).toMatchObject({ terminal_session_id: 'sess-1', cols: 100, rows: 24 })
  })

  it('fires at most once per settle — same width is deduped', async () => {
    attach()
    term.cols = 100
    await ackCurrentSize()
    ctrl.requestResizeRedraw()
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    expect(redrawCount()).toBe(1)
    expect(onStableWidthChange).not.toHaveBeenCalled() // initial baseline
    ctrl.requestResizeRedraw() // e.g. explicit refit + ResizeObserver both armed
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS + SETTLE_MS)
    expect(redrawCount()).toBe(1)
  })

  it('reports only later settled width changes, not initial or row-only sizing', async () => {
    attach()
    await ackCurrentSize() // establish 80 cols
    ctrl.requestResizeRedraw()
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    expect(onStableWidthChange).not.toHaveBeenCalled()

    term.rows = 30
    await ackCurrentSize()
    ctrl.requestResizeRedraw()
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    expect(onStableWidthChange).not.toHaveBeenCalled()

    term.cols = 96
    await ackCurrentSize()
    ctrl.requestResizeRedraw()
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    expect(onStableWidthChange).toHaveBeenCalledOnce()
    expect(onStableWidthChange).toHaveBeenCalledWith(96)
  })

  it('coalesces concurrent requests into a single timer/redraw', async () => {
    attach()
    term.cols = 100
    await ackCurrentSize()
    ctrl.requestResizeRedraw()
    ctrl.requestResizeRedraw()
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    expect(redrawCount()).toBe(1)
  })

  it('prefers a CLI-quiet gap: holds while output is fresh, fires once quiet', async () => {
    attach()
    term.cols = 100
    await ackCurrentSize()
    lastRawActivityAt.value = Date.now() // CLI just emitted output
    ctrl.requestResizeRedraw()
    await vi.advanceTimersByTimeAsync(SETTLE_MS) // gap 220ms < 250ms quiet gate
    expect(redrawCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(SETTLE_MS) // gap 440ms — quiet now
    expect(redrawCount()).toBe(1)
  })

  it('fires anyway at the bounded-wait deadline when the CLI never goes quiet', async () => {
    attach()
    term.cols = 100
    await ackCurrentSize()
    ctrl.requestResizeRedraw()
    for (let i = 0; i < 6; i++) {
      lastRawActivityAt.value = Date.now() // continuously streaming agent
      await vi.advanceTimersByTimeAsync(SETTLE_MS)
    }
    expect(redrawCount()).toBe(0) // 1320ms elapsed — still inside the deadline
    lastRawActivityAt.value = Date.now()
    await vi.advanceTimersByTimeAsync(SETTLE_MS) // 1540ms — past the 1500ms deadline
    expect(redrawCount()).toBe(1)
  })
})
