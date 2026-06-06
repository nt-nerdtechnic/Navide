import { onScopeDispose, ref, shallowRef } from 'vue'
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
const XTERM_THEMES: Record<string, ITheme> = {
  'dark-github': {
    background: '#0d1117', foreground: '#e6edf3',
    cursor: '#58a6ff', selectionBackground: 'rgba(56,139,253,0.35)',
  },
  'dark-midnight': {
    background: '#0a0e14', foreground: '#c5d0e6',
    cursor: '#6cb0ff', selectionBackground: 'rgba(56,139,253,0.3)',
  },
  'dark-forest': {
    background: '#0c130d', foreground: '#e9f2e7',
    cursor: '#6fc28a', selectionBackground: 'rgba(111,194,138,0.3)',
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
  const BUFFER_CAP = 128 * 1024

  function appendClean(chunk: string): void {
    // ANY byte counts as "process still alive" — spinners included.
    if (chunk.length > 0) lastRawActivityAt.value = Date.now()
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
  let resizeObserver: ResizeObserver | null = null
  let resizeRafId = 0
  let mounted = false

  // Debounce the size we push to the backend PTY. Layout transitions and
  // app startup churn the pane size repeatedly (e.g. grid→spotlight); pushing
  // every intermediate size resizes the live CLI's TUI over and over, and any
  // output it printed at a transient narrow width can't reflow when it grows
  // back. Only the size that survives RESIZE_QUIET_MS of stillness is sent.
  const RESIZE_QUIET_MS = 250
  let resizeSendTimer: ReturnType<typeof setTimeout> | null = null
  function pushResize(): void {
    if (!sessionId.value) return
    if (resizeSendTimer) clearTimeout(resizeSendTimer)
    const cols = term.cols
    const rows = term.rows
    resizeSendTimer = setTimeout(() => {
      resizeSendTimer = null
      // Re-read in case xterm changed again; send the latest stable size.
      void backend.send('terminal.resize', {
        terminal_session_id: sessionId.value,
        cols: term.cols || cols,
        rows: term.rows || rows
      })
    }, RESIZE_QUIET_MS)
  }

  // Single source of truth for sizing: fit xterm to its container, then push the
  // (debounced) size to the backend. The only entry point used by the
  // ResizeObserver, the post-spawn frame, and fitTerminal().
  function fitAndSend(): void {
    cancelAnimationFrame(resizeRafId)
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
        resizeRafId = requestAnimationFrame(run)
        return
      }
      try {
        fit.fit()
        pushResize()
      } catch { /* ignore transient fit errors during teardown */ }
    }
    resizeRafId = requestAnimationFrame(run)
  }

  function mount(el: HTMLElement): void {
    containerRef.value = el
    term.open(el)
    // Anchor for Shift+Arrow keyboard selection
    let selAnchorX = -1
    let selAnchorY = -1

    // Intercept wheel events to scroll xterm's scrollback buffer.
    // Prevents xterm's alternateScroll mode from converting trackpad swipes
    // into arrow-key escape codes that navigate readline history.
    let scrollRemainder = 0
    term.attachCustomWheelEventHandler((e: WheelEvent) => {
      const delta = e.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? e.deltaY
        : e.deltaY / 3
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
    el.addEventListener('mousedown', () => {
      // Record click moment too — Claude TUI redraws on focus regardless of
      // which path got us there.
      lastFocusAt.value = Date.now()
      try {
        term.focus()
      } catch {
        /* ignore */
      }
    })
    resizeObserver = new ResizeObserver(() => fitAndSend())
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

  async function spawn(opts: SpawnOptions): Promise<void> {
    if (status.value === 'starting' || status.value === 'running') {
      throw new Error('terminal already running')
    }
    error.value = ''
    status.value = 'starting'
    lastCommand.value = Array.isArray(opts.command) ? opts.command.join(' ') : opts.command
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
        // Provisional size only — fitAndSend() pushes the real container size as
        // soon as the pane is visible. The few ms at 80×24 are never seen.
        cols: 80,
        rows: 24,
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
      status.value = 'running'

      // Push the real size now that sessionId exists. The ResizeObserver's
      // initial fire happened before spawn (no session yet, so it bailed), so
      // this is what syncs the backend to the actual container on first paint.
      fitAndSend()

      // Auto-focus once the PTY is wired up so the user can immediately type
      // without having to click the pane.
      queueMicrotask(() => focus())

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
        term.writeln(`\r\n\x1b[33m[session ${payload.reason}, exit=${payload.exit_code}]\x1b[0m`)
        cleanupSession()
      })
    } catch (err) {
      status.value = 'error'
      error.value = String((err as Error).message ?? err)
      term.writeln(`\r\n\x1b[31m[error] ${error.value}\x1b[0m`)
    }
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
    await backend.send('terminal.kill', { terminal_session_id: sessionId.value })
  }

  function fitTerminal(): void {
    if (!mounted) return
    fitAndSend()
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
    cancelAnimationFrame(resizeRafId)
    if (resizeSendTimer) clearTimeout(resizeSendTimer)
    resizeObserver?.disconnect()
    term.dispose()
    if (sessionId.value) {
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
    pasteText,
    status,
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
