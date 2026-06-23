import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { useBackend } from './useBackend'
import { bufferTail, dropTuiNoise, stripAnsi } from '../lib/buffer'

import type { ITheme } from '@xterm/xterm'

// Per-app-theme xterm palettes. CSS vars can't be used directly because
// getPropertyValue returns the raw `var(--gray-12)` token, not the resolved hex.
// The light palette remaps ANSI white/brightWhite so TUI apps (designed for dark
// terminals) stay readable on a light background.
// Shared ANSI 16-color palette for dark themes, aligned to the base.css color
// scales so CLI output (green spinners, syntax highlight, etc.) matches the app
// design instead of falling back to xterm.js's built-in defaults.
const DARK_ANSI = {
  black: '#484f58',   brightBlack: '#6e7681',
  red: '#ff7b72',     brightRed: '#ffa198',
  green: '#3fb950',   brightGreen: '#56d364',
  yellow: '#d29922',  brightYellow: '#e3b341',
  blue: '#58a6ff',    brightBlue: '#79c0ff',
  magenta: '#bc8cff', brightMagenta: '#d2a8ff',
  cyan: '#56d4dd',    brightCyan: '#b3f0ff',
  white: '#b1bac4',   brightWhite: '#ffffff',
}

const XTERM_THEMES: Record<string, ITheme> = {
  'dark-github': {
    background: '#0d1117', foreground: '#e6edf3',
    cursor: '#58a6ff', selectionBackground: 'rgba(56,139,253,0.35)',
    ...DARK_ANSI,
  },
  'dark-midnight': {
    background: '#0a0e14', foreground: '#c5d0e6',
    cursor: '#6cb0ff', selectionBackground: 'rgba(56,139,253,0.3)',
    ...DARK_ANSI,
  },
  'dark-forest': {
    background: '#0c130d', foreground: '#e9f2e7',
    cursor: '#6fc28a', selectionBackground: 'rgba(111,194,138,0.3)',
    ...DARK_ANSI,
  },
  'light': {
    background: '#ffffff', foreground: '#1f2328',
    cursor: '#0969da', selectionBackground: 'rgba(9,105,218,0.2)',
    black: '#1f2328',    brightBlack: '#59636e',
    red: '#cf222e',      brightRed: '#a40e26',
    green: '#1a7f37',    brightGreen: '#22863a',
    yellow: '#9a6700',   brightYellow: '#7d4e00',
    blue: '#0969da',     brightBlue: '#0550ae',
    magenta: '#8250df',  brightMagenta: '#6639ba',
    cyan: '#1b7c83',     brightCyan: '#3192aa',
    white: '#d0d7de',    brightWhite: '#8c959f',  // NOT pure white — readable on light bg
  },
  'high-contrast': {
    // Match the app canvas (--bg-base #0a0c10) like every other theme, so the
    // pane's padding frame is seamless. White-on-#0a0c10 is still ~20:1 contrast.
    background: '#0a0c10', foreground: '#ffffff',
    cursor: '#71b7ff', selectionBackground: 'rgba(113,183,255,0.35)',
    black: '#686868',   brightBlack: '#a0a0a0',
    red: '#ff6b66',     brightRed: '#ff9a94',
    green: '#56d364',   brightGreen: '#7ee787',
    yellow: '#e3b341',  brightYellow: '#f2cc60',
    blue: '#79c0ff',    brightBlue: '#a5d6ff',
    magenta: '#d2a8ff', brightMagenta: '#e2c5ff',
    cyan: '#56d4dd',    brightCyan: '#b3f0ff',
    white: '#e6edf3',   brightWhite: '#ffffff',
  },
}

function readXtermTheme(): ITheme {
  const id = typeof document !== 'undefined'
    ? (document.documentElement.getAttribute('data-theme') ?? 'dark-github')
    : 'dark-github'
  return XTERM_THEMES[id] ?? XTERM_THEMES['dark-github']
}

export interface SpawnOptions {
  command: string | string[]
  cwd: string
  env?: Record<string, string>
  agentKey?: string
  metadata?: Record<string, unknown>
  outputLogFile?: string  // if set, backend writes ANSI-stripped output to this path
  // Stable CLI session id (e.g. claude --session-id). Used as the reattach
  // persistence key so a PTY can be rebound after a reload — the paneId is
  // regenerated on restore and would never match. Falls back to paneId if absent.
  resumeKey?: string
  // True when the command resumes a prior session (reprints the conversation),
  // so the PTY must be created at the real measured width. A fresh spawn is
  // empty and may be created immediately even while hidden (see createWhenMeasurable).
  isResume?: boolean
}

export type TerminalStatus = 'idle' | 'starting' | 'running' | 'exited' | 'error'

export function useTerminal(paneId: string, backend: ReturnType<typeof useBackend>) {
  const term = new Terminal({
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    fontSize: 12,
    cursorBlink: true,
    convertEol: false,
    scrollback: 10000,
    theme: readXtermTheme()
  })
  const fit = new FitAddon()
  term.loadAddon(fit)

  const containerRef = shallowRef<HTMLElement | null>(null)
  const status = ref<TerminalStatus>('idle')
  const sessionId = ref<string>('')
  const error = ref<string>('')
  const lastCommand = ref<string>('')

  // Rolling ANSI-stripped text accumulator used by the pipeline orchestrator
  // to detect stage sentinels and QUESTION blocks. Capped at ~128KB to keep
  // memory predictable across long-running panes.
  const cleanBuffer = ref<string>('')
  // `lastActivityAt` only updates when CLEANED text changes — i.e. real content.
  // Used for analyzer triggers and sentinel scans.
  const lastActivityAt = ref<number>(0)
  // `lastRawActivityAt` updates on ANY non-empty PTY chunk including TUI
  // spinners / status-bar redraws / animated progress glyphs. Used by the
  // idle-stall safety net so a long-thinking agent that's still visibly
  // alive on screen isn't mistaken for a wedged process.
  const lastRawActivityAt = ref<number>(0)
  // When the user clicks/focuses the pane, Claude TUI redraws its status bar
  // & cursor. After ANSI/noise stripping some clean bytes still arrive, which
  // would flip the idle/running badge back to "running" even though the
  // agent isn't actually working. We suppress lastActivityAt updates for a
  // short window after a focus event so the badge stays honest.
  const lastFocusAt = ref<number>(0)
  const FOCUS_GRACE_MS = 3_000

  // ── RUNNING vs IDLE ──────────────────────────────────────────────────────────
  // We want RUNNING only when the CLI is genuinely executing — not for brief
  // nudges, TUI redraws, or prompt echoes that last a second or two.
  //
  // Strategy: track the start of each CONTINUOUS burst of PTY activity.
  // A gap > BURST_GAP_MS in raw output resets the burst start. Only bursts
  // that have lasted > MIN_BURST_MS are shown as RUNNING. Short nudge
  // responses (1–2 s) never reach the threshold; real work (tool chains,
  // file edits, long responses) easily exceeds it.
  //
  // No external signals (hooks, attribution, focus) are involved — this
  // purely tracks what the PTY itself emits.
  const BURST_GAP_MS   = 1_000   // gap that splits two separate bursts
  const MIN_BURST_MS   = 2_000   // burst must last this long to show RUNNING
  const STALE_MS       = 2_000   // no output for this long → not running
  const activityBurstStartAt = ref<number>(0)
  // Tick so displayStatus re-evaluates after output goes quiet.
  const nowTick = ref<number>(Date.now())
  const tickInterval = window.setInterval(() => { nowTick.value = Date.now() }, 1_000)

  const displayStatus = computed<string>(() => {
    // A resume parked for a hidden tab hasn't created its PTY yet — a resumed
    // agent comes up idle, so show 'idle' instead of a stuck 'starting' in the
    // agent list until the tab is shown. (Fresh spawns create immediately, so
    // their brief parked window keeps the normal status.)
    if (pendingSpawn.value?.isResume) return 'idle'
    if (status.value !== 'running') return status.value
    // Spawned but not a single byte of output yet — the CLI is still booting
    // (Gemini stays silent ~5s during auth/init). Show "starting", not "idle".
    if (lastRawActivityAt.value === 0) return 'starting'
    if (nowTick.value - lastRawActivityAt.value > STALE_MS) return 'idle'
    return (nowTick.value - activityBurstStartAt.value) >= MIN_BURST_MS ? 'running' : 'idle'
  })
  const BUFFER_CAP = 128 * 1024

  function appendClean(chunk: string): void {
    // ANY byte counts as "process still alive" — spinners included.
    if (chunk.length > 0) {
      const now = Date.now()
      // If the gap since last output exceeds BURST_GAP_MS, this is a new burst.
      if (now - lastRawActivityAt.value > BURST_GAP_MS) activityBurstStartAt.value = now
      lastRawActivityAt.value = now
    }
    const cleaned = dropTuiNoise(stripAnsi(chunk))
    if (!cleaned) return
    const next = cleanBuffer.value + cleaned
    cleanBuffer.value = bufferTail(next, BUFFER_CAP)
    // Skip the activity timestamp if this chunk arrived inside the focus
    // grace window — those bytes are very likely a focus-triggered TUI
    // redraw, not real agent output. Buffer content is still kept so any
    // genuine output isn't lost; only the timestamp is held back.
    const inFocusGrace = Date.now() - lastFocusAt.value < FOCUS_GRACE_MS
    if (!inFocusGrace) lastActivityAt.value = Date.now()
  }

  function markBufferPosition(): number {
    return cleanBuffer.value.length
  }

  /** Retroactively scrub TUI noise from the existing buffer — useful when
   *  the noise-filter rules change (HMR) or a watcher arms on an old pane. */
  function recleanBuffer(): void {
    cleanBuffer.value = dropTuiNoise(cleanBuffer.value)
  }

  let inputDisposer: { dispose(): void } | null = null
  let outputUnsub: (() => void) | null = null
  let exitUnsub: (() => void) | null = null
  let parserDisposers: { dispose(): void }[] = []
  // DEC private mode 2048 (in-band resize): when a CLI opts in, it learns new
  // sizes through its INPUT stream (ordered with keystrokes) instead of racing
  // the out-of-band SIGWINCH — removing stale-cols repaint residue at the root.
  // Most CLIs (incl. Claude Code today) don't request it; for them this stays
  // false and the backend drain-before-ack barrier handles residue instead.
  let mode2048 = false
  let resizeObserver: ResizeObserver | null = null
  let resizeRafId = 0
  // rAF is throttled/paused while a window is occluded or mid-fullscreen
  // transition, so a fit scheduled purely on rAF can be lost when the dev
  // window is behind another (then the terminal stays at its stale width —
  // visible as empty space on the right). This timer is the fallback so the
  // fit still runs. Mirrors the rAF+timeout pattern spawn() already uses.
  let resizeFrameTimer: ReturnType<typeof setTimeout> | null = null
  let mounted = false
  let mountedEl: HTMLElement | null = null
  let _mousedownHandler: (() => void) | null = null

  // Layout churn is debounced BEFORE the fit: xterm holds its old size while the
  // grid settles, then fits once (so a drag fires one resize, not dozens). Once
  // quiet, applyFit resizes xterm to the container first and tells the PTY after
  // — the VSCode-aligned ordering, so the CLI's SIGWINCH repaint lands at the
  // final width (see applyFit).
  const RESIZE_QUIET_MS = 250
  let resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null
  // Last size the backend CONFIRMED. The reconciler compares against this so a
  // dropped/failed resize message is retried instead of desyncing forever.
  let ackedCols = 0
  let ackedRows = 0
  function sendResize(cols: number, rows: number): Promise<boolean> {
    if (!sessionId.value) return Promise.resolve(false)
    return backend.send('terminal.resize', {
      terminal_session_id: sessionId.value,
      cols,
      rows
    }).then((resp) => {
      if (resp?.ok) {
        ackedCols = cols; ackedRows = rows
        // For 2048-capable CLIs, report the new size in-band right after the
        // ack — the ioctl is done, so the report carries the authoritative
        // values and stays ordered with the user's keystrokes.
        if (mode2048) sendSizeReport()
        return true
      }
      return false
    }).catch(() => false /* reconciler retries */)
  }
  function sendResizeNow(): void {
    void sendResize(term.cols, term.rows)
  }
  // CSI 48 ; rows ; cols ; height_px ; width_px t — the mode-2048 size report.
  // Pixel dims come from the render service when measured, else 0 (spec allows).
  function sendSizeReport(): void {
    if (!sessionId.value) return
    const canvas = (term as any)._core?._renderService?.dimensions?.css?.canvas
    const heightPx = Math.round(canvas?.height ?? 0) || 0
    const widthPx = Math.round(canvas?.width ?? 0) || 0
    pasteText(`\x1b[48;${term.rows};${term.cols};${heightPx};${widthPx}t`)
  }

  // Set when a reattached pane is waiting to repaint. We never force_redraw at
  // reattach time: the renderer is mid-reflow then (reload, or a hidden tab
  // being shown), so the width is transient and would repaint the live agent
  // narrow. The reconciler fires the redraw only once container == xterm ==
  // backend, so Claude's TUI clears the transient frame and repaints at the real
  // width instead of stranding a narrow one in scrollback.
  let pendingReattachRedraw = false

  // TEMP diagnostic sink: route resize/redraw traces to a file the dev can read
  // directly (/tmp/agent-team-resize.log via the backend), instead of the
  // renderer console. Remove with the call sites once resize is confirmed.
  function dbgLog(line: string): void {
    if (!sessionId.value) return
    void backend.send('debug.log', { line: `${paneId} ${line}` }).catch(() => {})
  }

  // After a width change settles, one SIGWINCH-based force_redraw makes the TUI
  // repaint cleanly at the new width — clearing the reflow residue xterm leaves
  // when it re-wraps the old frame (the garbled status footer on narrow
  // drag-resize). Gated so it fires once per settle, only on a real WIDTH
  // change, and only when xterm == backend-acked. We PREFER a quiet gap so the
  // repaint isn't interleaved with a burst, but a continuously-streaming agent
  // never goes quiet — so after a bounded wait we fire anyway (a SIGWINCH is
  // safe mid-output; it's exactly what a real terminal resize raises). Triggered
  // only from the ResizeObserver path (genuine layout churn), not spawn/reattach.
  const RESIZE_REDRAW_SETTLE_MS = 220
  const RESIZE_REDRAW_MAX_WAIT_MS = 1500
  let resizeRedrawTimer: ReturnType<typeof setTimeout> | null = null
  let resizeRedrawDeadline = 0
  let lastRedrawCols = 0
  // Called on a genuine new settle: (re)start the bounded-wait clock, then arm.
  function requestResizeRedraw(): void {
    resizeRedrawDeadline = Date.now() + RESIZE_REDRAW_MAX_WAIT_MS
    armResizeRedraw()
  }
  // Internal poll: reschedules without resetting the deadline so a busy pane
  // can't postpone the redraw indefinitely.
  function armResizeRedraw(): void {
    if (resizeRedrawTimer) clearTimeout(resizeRedrawTimer)
    resizeRedrawTimer = setTimeout(() => {
      resizeRedrawTimer = null
      if (!mounted || !sessionId.value) return
      // Not fully settled yet (xterm still differs from the backend-acked size):
      // wait for the resize to finish, then re-check.
      if (term.cols !== ackedCols || term.rows !== ackedRows) { armResizeRedraw(); return }
      // Width unchanged since the last clean repaint (rows-only / no-op): skip.
      if (term.cols === lastRedrawCols) return
      // Prefer a quiet gap, but don't wait past the deadline for a busy agent.
      const quiet = Date.now() - lastRawActivityAt.value >= RESIZE_QUIET_MS
      if (!quiet && Date.now() < resizeRedrawDeadline) { armResizeRedraw(); return }
      lastRedrawCols = term.cols
      // TEMP diagnostic (remove once resize is confirmed working).
      dbgLog(`redraw fire cols=${term.cols} rows=${term.rows}`)
      void backend.send('terminal.redraw', {
        terminal_session_id: sessionId.value,
        cols: term.cols,
        rows: term.rows,
      })
    }, RESIZE_REDRAW_SETTLE_MS)
  }

  // Self-healing size reconciler. A pane that spawns or resizes while hidden
  // (background tab / spotlight / minimized → display:none) can leave the PTY
  // and xterm at different sizes — the CLI then draws its TUI for one width
  // while xterm renders another, corrupting the layout and cursor position.
  // Every tick: refit if the container disagrees with xterm, re-send if the
  // backend may disagree with xterm. Heals any missed resize within seconds.
  const RECONCILE_MS = 2_000
  const reconcileInterval = window.setInterval(() => {
    if (!mounted) return
    // A spawn parked while hidden creates as soon as the pane is measurable.
    if (pendingSpawn.value) { void createWhenMeasurable(); return }
    if (!sessionId.value) return
    const el = containerRef.value
    if (!el || el.clientWidth === 0) return  // hidden — nothing to reconcile yet
    const dims = fit.proposeDimensions()
    const sized = !!dims && Number.isFinite(dims.cols) && Number.isFinite(dims.rows)
    if (sized && (dims.cols !== term.cols || dims.rows !== term.rows)) {
      applyFit()
      return
    }
    if (term.cols !== ackedCols || term.rows !== ackedRows) {
      sendResizeNow()
      return
    }
    // Fully settled (container == xterm == backend-acked). A reattached pane that
    // has been waiting now repaints at this stable width — a no-op resize won't
    // raise SIGWINCH, so nudge the agent explicitly via force_redraw.
    if (sized && pendingReattachRedraw) {
      pendingReattachRedraw = false
      void backend.send('terminal.reattach', {
        terminal_session_ids: [sessionId.value],
        cols: term.cols,
        rows: term.rows,
      })
    }
  }, RECONCILE_MS)

  // Single source of truth for sizing: fit xterm to its container, then push
  // that size to the backend. Entry points: the (debounced) ResizeObserver,
  // the post-spawn frame, the reconciler, and fitTerminal().
  // Run `cb` on the next animation frame, but fall back to a timer if rAF
  // doesn't fire in time — rAF is paused for occluded/background windows and
  // during fullscreen transitions, which would otherwise strand a pending fit.
  function scheduleFrame(cb: () => void): void {
    cancelAnimationFrame(resizeRafId)
    if (resizeFrameTimer) { clearTimeout(resizeFrameTimer); resizeFrameTimer = null }
    let fired = false
    const fire = (): void => {
      if (fired) return
      fired = true
      cancelAnimationFrame(resizeRafId)
      if (resizeFrameTimer) { clearTimeout(resizeFrameTimer); resizeFrameTimer = null }
      cb()
    }
    resizeRafId = requestAnimationFrame(fire)
    resizeFrameTimer = setTimeout(fire, 100)
  }

  function applyFit(): void {
    let poked = false
    const run = (): void => {
      const el = containerRef.value
      // Hidden (display:none ancestor → clientWidth 0): nothing to fit. It will
      // be retried by the ResizeObserver when the pane is shown.
      if (!el || el.clientWidth === 0) return
      // xterm hasn't measured its character cell yet — happens when the pane was
      // opened while hidden. fit.fit() is a no-op while cell.width is 0, so poke
      // xterm once to force measurement, then retry next frame until it's ready.
      if ((term as any)._core?._renderService?.dimensions?.css?.cell?.width === 0) {
        if (!poked) {
          try { term.resize(Math.max(term.cols, 2), Math.max(term.rows, 1)) } catch { /* ignore */ }
          poked = true
        }
        scheduleFrame(run)
        return
      }
      try {
        // VSCode-aligned ordering: resize xterm to the container FIRST, then
        // tell the PTY. The PTY resize raises SIGWINCH, so the CLI repaints its
        // cursor line (the live footer) directly into an already-correctly-sized
        // xterm — nothing reflows that fresh frame afterward. xterm does not
        // reflow the cursor line itself (reflowCursorLine defaults to false), so
        // the CLI owns that repaint; we just give it the right width first.
        //
        // This replaces the old shrink-grace dance (push PTY narrow first, wait
        // PTY_REPAINT_GRACE_MS, then fit xterm). That ordering left the CLI's
        // narrow repaint sitting in a still-wide xterm, which the subsequent
        // narrowing reflowed into the garbled-footer residue. The backend still
        // drains output around its resize ack, so ordering is preserved server
        // side; the brief client window where xterm is narrower than the PTY is
        // the same tradeoff VSCode's integrated terminal accepts.
        const cwBefore = el.clientWidth
        const colsBefore = term.cols
        fit.fit()
        // TEMP diagnostic (remove once resize is confirmed working): proves the
        // VSCode-aligned path ran and shows the widths it computed.
        dbgLog(`resize cw=${cwBefore} cols ${colsBefore}->${term.cols} rows=${term.rows} acked=${ackedCols}x${ackedRows}`)
        sendResizeNow()
      } catch { /* ignore transient fit errors during teardown */ }
    }
    scheduleFrame(run)
  }

  function mount(el: HTMLElement): void {
    containerRef.value = el
    term.open(el)

    // ── DEC mode 2048 (in-band resize) interception ──────────────────────────
    // Detect a CLI opting into in-band size reports and answer its query. All
    // handlers return false (don't swallow) so xterm still processes the other
    // modes in the same DECSET/DECRST sequence; only the 2048 DECRQM reply is
    // swallowed so a built-in xterm answer can't double-respond.
    parserDisposers.push(
      term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
        if (params.includes(2048) && !mode2048) {
          mode2048 = true
          console.debug(`[pane ${paneId}] DEC mode 2048 (in-band resize) enabled`)
          sendSizeReport()  // spec: report once immediately on enable
        }
        return false
      }),
      term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
        if (params.includes(2048)) mode2048 = false
        return false
      }),
      term.parser.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, (params) => {
        // DECRQM: reply only for mode 2048 (1 = set, 2 = reset).
        if (params[0] === 2048) {
          pasteText(`\x1b[?2048;${mode2048 ? 1 : 2}$y`)
          return true
        }
        return false
      }),
    )

    // Anchor for Shift+Arrow keyboard selection
    let selAnchorX = -1
    let selAnchorY = -1

    // Intercept wheel events to scroll xterm's scrollback buffer.
    // Prevents xterm's alternateScroll mode from converting trackpad swipes
    // into arrow-key escape codes that navigate readline history.
    let scrollRemainder = 0
    term.attachCustomWheelEventHandler((e: WheelEvent) => {
      // deltaY units depend on deltaMode: LINE → lines, PAGE → pages, PIXEL →
      // pixels. PAGE mode (some mice / accessibility settings) reports ~1 per
      // notch; without this branch it fell through to the pixel /3 path and
      // scrolled ~0.3 line per notch (effectively stuck).
      let delta: number
      if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) delta = e.deltaY
      else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) delta = e.deltaY * term.rows
      else delta = e.deltaY / 3
      scrollRemainder += delta
      const lines = Math.trunc(scrollRemainder)
      scrollRemainder -= lines
      if (lines !== 0) term.scrollLines(lines)
      return false
    })

    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type !== 'keydown') return true
      const buf = term.buffer.active
      const curX = buf.cursorX
      const curY = buf.baseY + buf.cursorY

      // ── Shift+←/→: extend selection character by character ────────────────
      if (e.shiftKey && !e.metaKey && !e.altKey && !e.ctrlKey &&
          (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        if (selAnchorX < 0) { selAnchorX = curX; selAnchorY = curY }
        const newX = e.key === 'ArrowLeft' ? Math.max(0, curX - 1) : Math.min(term.cols - 1, curX + 1)
        const len = Math.abs(selAnchorX - newX)
        if (len > 0) term.select(Math.min(selAnchorX, newX), selAnchorY, len)
        else term.clearSelection()
        pasteText(e.key === 'ArrowLeft' ? '\x1b[D' : '\x1b[C')
        return false
      }

      // ── Cmd+Shift+←: select to beginning of line ──────────────────────────
      if (e.metaKey && e.shiftKey && e.key === 'ArrowLeft') {
        if (selAnchorX < 0) { selAnchorX = curX; selAnchorY = curY }
        if (curX > 0) term.select(0, curY, curX)
        else term.clearSelection()
        pasteText('\x01')
        return false
      }

      // ── Cmd+Shift+→: select to end of line ────────────────────────────────
      if (e.metaKey && e.shiftKey && e.key === 'ArrowRight') {
        if (selAnchorX < 0) { selAnchorX = curX; selAnchorY = curY }
        const line = buf.getLine(curY)
        const lineEnd = line ? line.translateToString(true).length : term.cols
        const endX = Math.max(lineEnd, curX)
        if (endX > curX) term.select(curX, curY, endX - curX)
        else term.clearSelection()
        pasteText('\x05')
        return false
      }

      // ── Delete/Backspace with active selection: delete the selected region ───
      if (selAnchorX >= 0 && (e.key === 'Backspace' || e.key === 'Delete') &&
          !e.metaKey && !e.altKey) {
        const count = Math.abs(curX - selAnchorX)
        if (count > 0) {
          // cursor right of anchor → backspace; cursor left → forward-delete
          pasteText(curX > selAnchorX ? '\x7f'.repeat(count) : '\x1b[3~'.repeat(count))
        }
        selAnchorX = -1; selAnchorY = -1
        term.clearSelection()
        return false
      }

      // ── Clear selection for all other keys (except copy/select-all/etc) ────
      const keepForCmd = e.metaKey && 'cavz'.includes(e.key.toLowerCase())
      const isModifierOnly = ['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)
      if (!keepForCmd && !isModifierOnly) {
        selAnchorX = -1
        selAnchorY = -1
        term.clearSelection()
      }

      // ── macOS cursor shortcuts (no Shift) ──────────────────────────────────
      if (e.metaKey && !e.shiftKey && e.key === 'Backspace')  { pasteText('\x15'); return false }
      if (e.metaKey && !e.shiftKey && e.key === 'ArrowLeft')  { pasteText('\x01'); return false }
      if (e.metaKey && !e.shiftKey && e.key === 'ArrowRight') { pasteText('\x05'); return false }
      if (e.altKey  && !e.shiftKey && e.key === 'Backspace')  { pasteText('\x17'); return false }
      return true
    })
    // Make the whole pane click-focusable so the user can type immediately.
    el.tabIndex = 0
    el.style.cursor = 'text'
    _mousedownHandler = () => {
      // Record click moment too — Claude TUI redraws on focus regardless of
      // which path got us there.
      lastFocusAt.value = Date.now()
      try {
        term.focus()
      } catch {
        /* ignore */
      }
    }
    el.addEventListener('mousedown', _mousedownHandler)
    mountedEl = el
    // Debounced: hold the old (PTY-consistent) size through layout churn,
    // then fit + resize the PTY together once the container is still.
    resizeObserver = new ResizeObserver(() => {
      if (resizeDebounceTimer) clearTimeout(resizeDebounceTimer)
      resizeDebounceTimer = setTimeout(() => {
        resizeDebounceTimer = null
        // A hidden-tab pane parked its spawn; becoming measurable (the tab was
        // shown) fires this — create the PTY now, at the real width.
        if (pendingSpawn.value) { void createWhenMeasurable(); return }
        applyFit()
        // Once this resize settles, repaint the TUI clean at the new width.
        requestResizeRedraw()
      }, RESIZE_QUIET_MS)
    })
    resizeObserver.observe(el)
    mounted = true
  }

  function focus(): void {
    // Record focus moment so the next few hundred ms of TUI redraw don't
    // get counted as "agent activity". See FOCUS_GRACE_MS comment above.
    lastFocusAt.value = Date.now()
    try {
      term.focus()
    } catch {
      /* ignore */
    }
  }

  // Persistence key for this pane's backend PTY id (terminal_session_id), stored
  // so we can reattach to the still-running terminal after a reload instead of
  // respawning. Defaults to paneId but is overridden at spawn() time by
  // opts.resumeKey (the stable CLI session id) — the paneId is regenerated on
  // restore and would never match.
  let persistKey = paneId
  function ptyKey(): string { return `terminal-pty:${persistKey}` }
  function rememberSessionId(id: string): void {
    try {
      if (id) localStorage.setItem(ptyKey(), id)
      else localStorage.removeItem(ptyKey())
    } catch { /* ignore */ }
  }
  function persistedSessionId(): string {
    try { return localStorage.getItem(ptyKey()) || '' } catch { return '' }
  }

  // Wire input/output/exit handlers for the current sessionId. Shared by a fresh
  // spawn and a reattach so both bind identically.
  function bindSessionHandlers(): void {
    inputDisposer = term.onData((data) => {
      void backend.send('terminal.input', {
        terminal_session_id: sessionId.value,
        data
      })
    })

    outputUnsub = backend.on('terminal.output', (raw) => {
      const payload = raw as { terminal_session_id: string; data: string }
      if (payload.terminal_session_id !== sessionId.value) return
      term.write(payload.data)
      appendClean(payload.data)
    })

    exitUnsub = backend.on('terminal.exit', (raw) => {
      const payload = raw as { terminal_session_id: string; reason: string; exit_code: number | null }
      if (payload.terminal_session_id !== sessionId.value) return
      status.value = 'exited'
      rememberSessionId('')  // the PTY is gone — don't try to reattach to it
      term.writeln(`\r\n\x1b[33m[session ${payload.reason}, exit=${payload.exit_code}]\x1b[0m`)
      cleanupSession()
    })
  }

  // Wait until the container width holds steady for two consecutive frames
  // (bounded ~500ms) so a fit measures the FINAL width, not a mid-grid-reflow
  // transient. Shared by spawn and reattach — sizing a PTY to a transient width
  // leaves the CLI painting narrow (empty space on the right).
  async function settleContainerWidth(): Promise<void> {
    const settleEl = containerRef.value
    if (!settleEl || settleEl.clientWidth === 0) return
    let lastW = -1
    const deadline = performance.now() + 500
    while (performance.now() < deadline) {
      // rAF with a timeout fallback — rAF is throttled (or fully paused) for
      // occluded/background windows and must never stall.
      await new Promise<void>((resolve) => {
        const raf = requestAnimationFrame(() => { clearTimeout(timer); resolve() })
        const timer = setTimeout(() => { cancelAnimationFrame(raf); resolve() }, 100)
      })
      const w = settleEl.clientWidth
      if (w === lastW) break
      lastW = w
    }
  }

  // Reattach-to-live-PTY on reload is DISABLED. It repainted the running agent
  // at the renderer's transient mid-reflow width, leaving panes stuck narrow.
  // The backend now kills PTYs on disconnect, so a reload fresh-spawns with
  // `<cli> --resume` (correct width, conversation restored from disk). The body
  // below is kept so a future, width-safe version can be re-enabled by flipping
  // this flag; the guard is typed `as boolean` so the body stays type-checked.
  const REATTACH_ON_RELOAD = false as boolean

  // Try to rebind to a PTY that survived a reload. Returns true if the backend
  // confirms the persisted id is still alive (and we've rebound); false if it's
  // gone, in which case the caller spawns a fresh process.
  async function tryReattach(): Promise<boolean> {
    if (!REATTACH_ON_RELOAD) return false
    const prev = persistedSessionId()
    if (!prev) return false
    try {
      // Alive-check + claim the output target only (cols/rows 0 → backend skips
      // force_redraw). The repaint is deferred to the reconciler, which fires it
      // once the width has settled — forcing it now would repaint the live agent
      // at the renderer's transient mid-reflow width (narrow).
      const resp = await backend.send<{ alive: string[]; dead: string[] }>('terminal.reattach', {
        terminal_session_ids: [prev],
        cols: 0,
        rows: 0,
      })
      if (!resp.ok || !resp.payload || !resp.payload.alive.includes(prev)) {
        rememberSessionId('')  // stale id — fall through to a fresh spawn
        return false
      }
    } catch {
      return false  // backend unreachable; let the caller decide (it will spawn)
    }
    sessionId.value = prev
    status.value = 'running'
    bindSessionHandlers()
    pendingReattachRedraw = true  // reconciler repaints once the width is settled
    applyFit()                    // start syncing size (no-op while hidden)
    queueMicrotask(() => focus())
    return true
  }

  // Reattach to a PTY that survived a transient network disconnect. Called when
  // the WS reconnects while the pane is already in 'running' state. Uses the
  // same deferred-redraw pattern as tryReattach: cols/rows 0 skips the immediate
  // SIGWINCH; the reconciler fires it once the width has settled.
  async function reattachAfterReconnect(): Promise<void> {
    if (status.value !== 'running' || !sessionId.value) return
    const id = sessionId.value
    try {
      const resp = await backend.send<{ alive: string[]; dead: string[] }>('terminal.reattach', {
        terminal_session_ids: [id],
        cols: 0,
        rows: 0,
      })
      if (!resp.ok || !resp.payload || !resp.payload.alive.includes(id)) {
        // PTY died while disconnected — mark exited so the user sees it
        status.value = 'exited'
        term.writeln('\r\n\x1b[33m[session ended while disconnected]\x1b[0m')
        rememberSessionId('')
        cleanupSession()
        return
      }
    } catch {
      return // WS not ready yet; the next status-change will retry
    }
    cleanupSession()
    bindSessionHandlers()
    pendingReattachRedraw = true
    applyFit()
  }

  // When the backend WS reconnects while we have a live session, reattach so
  // output resumes and the TUI repaints at the correct width.
  watch(() => backend.status.value, (newStatus, oldStatus) => {
    if (newStatus === 'connected' && oldStatus !== 'connected') {
      void reattachAfterReconnect()
    }
  })

  // A pane may be asked to spawn while its tab is hidden (clientWidth 0), where
  // its width can't be measured. We must NOT create the PTY at a guessed width:
  // the CLI's first paint (especially a `--resume` that reprints the whole
  // conversation) would hard-wrap at that wrong width and stay stuck in
  // scrollback. So the opts are parked here and the PTY is created only once the
  // container is genuinely measurable — i.e. when the tab is shown.
  // A ref so displayStatus can reflect a parked (deferred) spawn as idle.
  const pendingSpawn = shallowRef<SpawnOptions | null>(null)

  // Create the PTY for a parked spawn, but only when the container has a real,
  // measurable width. Returns silently (leaving it parked) until then; the
  // reconciler / ResizeObserver retry it once the pane is shown.
  function cellWidth(): number {
    return (term as any)._core?._renderService?.dimensions?.css?.cell?.width || 0
  }
  // Guarded entry point: only one create may be in flight. pendingSpawn isn't
  // cleared until after the awaits in _doCreate, so without this the reconciler /
  // ResizeObserver could start a second create for the same pane (two PTYs).
  let _creating = false
  async function createWhenMeasurable(): Promise<void> {
    if (_creating || !pendingSpawn.value) return
    _creating = true
    try { await _doCreate() } finally { _creating = false }
  }
  async function _doCreate(): Promise<void> {
    const opts = pendingSpawn.value
    if (!opts) return
    let el = containerRef.value
    const visible = !!el && el.clientWidth > 0
    // A resume reprints the prior conversation and MUST paint at the real width,
    // so wait until the pane is measurable. A fresh spawn is empty: create it now
    // even while hidden (the reconciler corrects the width once the tab is shown).
    // Deferring a fresh spawn would stall e.g. a pipeline stage spawned into a
    // tab the user isn't currently viewing.
    if (opts.isResume && !visible) return  // resume + hidden — retry when shown
    if (visible && cellWidth() === 0) {
      // xterm hasn't measured its character cell yet (just opened): poke once to
      // force measurement, then AWAIT it (bounded) so a fresh spawn resolves
      // 'running' and the caller's role-injection flow proceeds. Poking per
      // attempt (not once ever) is what makes a re-parked pane measure again
      // after it was hidden and shown a second time.
      try { term.resize(Math.max(term.cols, 2), Math.max(term.rows, 1)) } catch { /* ignore */ }
      const deadline = performance.now() + 500
      while (cellWidth() === 0 && performance.now() < deadline) {
        await new Promise<void>((resolve) => {
          const raf = requestAnimationFrame(() => { clearTimeout(t); resolve() })
          const t = setTimeout(() => { cancelAnimationFrame(raf); resolve() }, 100)
        })
        el = containerRef.value
        if (opts.isResume && (!el || el.clientWidth === 0)) return  // hidden mid-wait
      }
    }
    pendingSpawn.value = null  // claim it so a concurrent retry can't double-create
    if (visible) {
      // Settle the width, then fit, so the create below uses the real size.
      await settleContainerWidth()
      // The tab may have been switched away during the settle. A resume must not
      // create at a hidden/stale width (it would paint narrow) — re-park it.
      el = containerRef.value
      if (opts.isResume && (!el || el.clientWidth === 0 || cellWidth() === 0)) {
        pendingSpawn.value = opts
        return
      }
      try { fit.fit() } catch { /* keep current size */ }
    }
    try {
      const resp = await backend.send<{
        terminal_session_id: string
        pid: number
      }>('terminal.create', {
        pane_id: paneId,
        agent_key: opts.agentKey ?? null,
        command: opts.command,
        cwd: opts.cwd,
        env: opts.env ?? null,
        // Visible panes carry the real, measured width (so a resume's reprint
        // isn't hard-wrapped narrow). A fresh hidden pane has no measured size
        // yet → the 80x24 default; the reconciler corrects it once shown.
        cols: term.cols || 80,
        rows: term.rows || 24,
        metadata: opts.metadata ?? null,
        output_log_file: opts.outputLogFile ?? null,
      })
      if (!resp.ok || !resp.payload) {
        status.value = 'error'
        error.value = resp.error?.message ?? 'spawn failed'
        term.writeln(`\r\n\x1b[31m[error] ${error.value}\x1b[0m`)
        return
      }
      sessionId.value = resp.payload.terminal_session_id
      rememberSessionId(sessionId.value)  // enable reattach after a reload
      status.value = 'running'
      // TEMP diagnostic: marks a fresh pane spawn so we can confirm the new code
      // is actually loaded (opening a pane writes a line even without resizing).
      dbgLog(`spawn cols=${term.cols} rows=${term.rows}`)
      applyFit()  // sync the real size to the backend on first paint
      queueMicrotask(() => focus())
      bindSessionHandlers()
    } catch (err) {
      status.value = 'error'
      error.value = String((err as Error).message ?? err)
      term.writeln(`\r\n\x1b[31m[error] ${error.value}\x1b[0m`)
    }
  }

  async function spawn(opts: SpawnOptions): Promise<void> {
    if (status.value === 'starting' || status.value === 'running') {
      throw new Error('terminal already running')
    }
    error.value = ''
    status.value = 'starting'
    mode2048 = false  // a fresh process hasn't opted in yet
    lastCommand.value = Array.isArray(opts.command) ? opts.command.join(' ') : opts.command
    // Use the stable CLI session id as the reattach key when provided, so the
    // lookup below survives a reload (paneId does not).
    if (opts.resumeKey) persistKey = opts.resumeKey
    // True persistence: a PTY from before a reload may still be running. Reattach
    // to it (recovering bash/build panes too, with no --resume round-trip) before
    // spawning anew. Falls through to a fresh spawn if the PTY is gone.
    if (await tryReattach()) return
    // Park the spawn and create the PTY only once the container is measurable, so
    // the CLI paints at the real width. Visible panes create immediately; a
    // hidden-tab pane creates when its tab is first shown (reconciler/observer).
    pendingSpawn.value = opts
    await createWhenMeasurable()
  }

  function pasteText(text: string): void {
    if (!sessionId.value) return
    void backend.send('terminal.input', {
      terminal_session_id: sessionId.value,
      data: text
    })
  }

  async function interrupt(): Promise<void> {
    if (!sessionId.value) return
    await backend.send('terminal.interrupt', { terminal_session_id: sessionId.value })
  }

  async function kill(): Promise<void> {
    if (!sessionId.value) return
    rememberSessionId('')  // explicit kill — never reattach to this PTY
    await backend.send('terminal.kill', { terminal_session_id: sessionId.value })
  }

  function fitTerminal(): void {
    if (!mounted) return
    applyFit()
  }

  // Ask the CLI to repaint its current frame by sending Ctrl+L (the universal
  // redraw key). We deliberately do NOT call term.clear(): clearing xterm's
  // buffer out-of-band wipes the scrollback the user is reading — and since
  // Claude Code repaints its idle UI in place via cursor-up (it never appends
  // new lines while idle), the scrollback then stays empty and there is
  // nothing left to scroll through. It also desyncs the CLI's cursor
  // bookkeeping from xterm. Letting the CLI clear+repaint via its own Ctrl+L
  // stays consistent and keeps the scrollback intact and scrollable.
  function redraw(): void {
    pasteText('\x0c')
  }

  // Hard reset: drop the entire scrollback (including any corrupt frames frozen
  // there from a pre-fix resize, which the CLI can never repaint over), then
  // Ctrl+L so the CLI redraws its current frame into the cleared viewport.
  // Unlike redraw(), this DOES wipe history — it is an explicit, separately
  // labelled action, not the gentle refresh.
  function clearScrollback(): void {
    term.clear()
    pasteText('\x0c')
  }

  function updateXtermTheme(): void {
    term.options.theme = readXtermTheme()
  }

  function cleanupSession(): void {
    inputDisposer?.dispose()
    inputDisposer = null
    outputUnsub?.()
    outputUnsub = null
    exitUnsub?.()
    exitUnsub = null
  }

  onScopeDispose(() => {
    cleanupSession()
    parserDisposers.forEach((d) => d.dispose())
    parserDisposers = []
    clearInterval(tickInterval)
    clearInterval(reconcileInterval)
    cancelAnimationFrame(resizeRafId)
    if (resizeFrameTimer) clearTimeout(resizeFrameTimer)
    if (resizeDebounceTimer) clearTimeout(resizeDebounceTimer)
    if (resizeRedrawTimer) clearTimeout(resizeRedrawTimer)
    resizeObserver?.disconnect()
    if (mountedEl && _mousedownHandler) mountedEl.removeEventListener('mousedown', _mousedownHandler)
    term.dispose()
    if (sessionId.value) {
      // Scope dispose = the pane was closed (NOT a reload — a hard reload tears
      // down the JS without running this). The PTY should die with it, so clear
      // the persisted id too or a future pane could reattach to a killed id.
      rememberSessionId('')
      void backend.send('terminal.kill', { terminal_session_id: sessionId.value }).catch(() => {
        /* ignore */
      })
    }
  })

  return {
    mount,
    spawn,
    interrupt,
    kill,
    focus,
    fitTerminal,
    redraw,
    pasteText,
    status,
    displayStatus,
    sessionId,
    error,
    lastCommand,
    cleanBuffer,
    lastActivityAt,
    lastRawActivityAt,
    markBufferPosition,
    recleanBuffer,
    updateXtermTheme
  }
}
