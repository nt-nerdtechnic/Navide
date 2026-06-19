import { computed, onScopeDispose, ref, shallowRef } from 'vue'
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
    background: '#000000', foreground: '#ffffff',
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

  // xterm and the PTY must never be at different sizes on purpose. If xterm
  // refits immediately while the PTY resize lags, a CLI still streaming at the
  // old width gets wrapped at the new one, and inline TUIs (Claude Code's
  // cursor-up repaints) then overwrite the wrong rows — corruption that stays
  // in scrollback forever. So layout churn is debounced BEFORE the fit (xterm
  // holds its old size, matching the PTY, while the grid settles), and once
  // quiet, the fit and the backend resize are ordered so xterm is never
  // narrower than the PTY (see applyFit).
  const RESIZE_QUIET_MS = 250
  // On a width SHRINK we tell the PTY first, then wait this long before
  // narrowing xterm — long enough for the CLI to process SIGWINCH and repaint
  // its inline UI at the new (narrow) width. Narrowing xterm immediately would
  // reflow the still-wide frame and desync the CLI's cursor-up repaint, leaving
  // two frames overlapping (visible "跑版"). A single fixed timer — not the old
  // quiet-wait loop, which could starve and leave xterm stuck.
  const PTY_REPAINT_GRACE_MS = 180
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
    if (pendingSpawn) { void createWhenMeasurable(); return }
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
        // Invariant: xterm must never be NARROWER than the width the CLI
        // believes, or in-flight old-width output wraps and the CLI's cursor-up
        // repaints land on the wrong rows. So on a SHRINK we push the new size
        // to the PTY first and only fit xterm once the resize is acked — and
        // the backend drains all old-width output before that ack (see
        // terminals.drain_output), so nothing wide is still arriving when we
        // narrow. GROW (or rows-only) is safe to fit immediately, then send.
        const dims = fit.proposeDimensions()
        console.log(`[WD-FIT ${paneId.slice(0, 6)}] cw=${el.clientWidth} prop=${dims?.cols} term=${term.cols} -> ${dims && Number.isFinite(dims.cols) && dims.cols < term.cols ? 'SHRINK' : 'grow/eq'}`)  // [WD] temp
        if (dims && Number.isFinite(dims.cols) && Number.isFinite(dims.rows) &&
            dims.cols < term.cols && sessionId.value) {
          void sendResize(dims.cols, dims.rows).then(() => {
            // Let the CLI repaint narrow into the still-wide xterm first, THEN
            // narrow xterm so nothing reflows. Fixed delay (timers run even when
            // the window is occluded, unlike rAF).
            setTimeout(() => {
              try {
                fit.fit()
                // Container may have changed again while waiting.
                if (term.cols !== ackedCols || term.rows !== ackedRows) sendResizeNow()
              } catch { /* ignore transient fit errors during teardown */ }
            }, PTY_REPAINT_GRACE_MS)
          })
        } else {
          fit.fit()
          sendResizeNow()
        }
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
        console.log(`[WD-RO ${paneId.slice(0, 6)}] observer fired cw=${containerRef.value?.clientWidth} term=${term.cols} pending=${!!pendingSpawn}`)  // [WD] temp
        // A hidden-tab pane parked its spawn; becoming measurable (the tab was
        // shown) fires this — create the PTY now, at the real width.
        if (pendingSpawn) { void createWhenMeasurable(); return }
        applyFit()
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

  // A pane may be asked to spawn while its tab is hidden (clientWidth 0), where
  // its width can't be measured. We must NOT create the PTY at a guessed width:
  // the CLI's first paint (especially a `--resume` that reprints the whole
  // conversation) would hard-wrap at that wrong width and stay stuck in
  // scrollback. So the opts are parked here and the PTY is created only once the
  // container is genuinely measurable — i.e. when the tab is shown.
  let pendingSpawn: SpawnOptions | null = null
  let _spawnPoked = false

  // Create the PTY for a parked spawn, but only when the container has a real,
  // measurable width. Returns silently (leaving it parked) until then; the
  // reconciler / ResizeObserver retry it once the pane is shown.
  function cellWidth(): number {
    return (term as any)._core?._renderService?.dimensions?.css?.cell?.width || 0
  }
  async function createWhenMeasurable(): Promise<void> {
    const opts = pendingSpawn
    if (!opts) return
    let el = containerRef.value
    if (!el || el.clientWidth === 0) return  // hidden — wait until the tab is shown
    // Visible but xterm hasn't measured its character cell yet (just opened):
    // poke, then AWAIT measurement (bounded). We await rather than defer so a
    // fresh spawn resolves with status 'running' and the caller's role-injection
    // flow proceeds; a hidden pane already returned above.
    if (cellWidth() === 0) {
      if (!_spawnPoked) {
        try { term.resize(Math.max(term.cols, 2), Math.max(term.rows, 1)) } catch { /* ignore */ }
        _spawnPoked = true
      }
      const deadline = performance.now() + 500
      while (cellWidth() === 0 && performance.now() < deadline) {
        await new Promise<void>((resolve) => {
          const raf = requestAnimationFrame(() => { clearTimeout(t); resolve() })
          const t = setTimeout(() => { cancelAnimationFrame(raf); resolve() }, 100)
        })
        el = containerRef.value
        if (!el || el.clientWidth === 0) return  // hidden mid-wait — defer again
      }
      if (cellWidth() === 0) return  // still unmeasured — let the reconciler retry
    }
    pendingSpawn = null  // claim it so a concurrent retry can't double-create
    // Wait for the width to settle, then fit, so the size below is the real one.
    await settleContainerWidth()
    try { fit.fit() } catch { /* keep current size */ }
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
        // The real, dynamically measured width — never a fixed default. The CLI
        // first paints at exactly this width, so a resumed conversation is not
        // hard-wrapped narrow and then stranded in scrollback.
        cols: term.cols,
        rows: term.rows,
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
    pendingSpawn = opts
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
