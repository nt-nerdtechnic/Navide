import { onScopeDispose, ref, shallowRef, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { useBackend } from './useBackend'
import { bufferTail, dropTuiNoise, stripAnsi } from '../lib/buffer'

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
    theme: {
      background: '#0d1117',
      foreground: '#e6edf3'
    }
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
  let mounted = false

  function mount(el: HTMLElement): void {
    containerRef.value = el
    term.open(el)
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
    queueMicrotask(() => {
      fit.fit()
    })
    resizeObserver = new ResizeObserver(() => {
      try {
        fit.fit()
        if (sessionId.value) {
          void backend.send('terminal.resize', {
            terminal_session_id: sessionId.value,
            cols: term.cols,
            rows: term.rows
          })
        }
      } catch (err) {
        // ignore transient fit errors during teardown
      }
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
        cols: term.cols,
        rows: term.rows,
        metadata: opts.metadata ?? null,
        output_log_file: opts.outputLogFile ?? null
      })
      if (!resp.ok || !resp.payload) {
        status.value = 'error'
        error.value = resp.error?.message ?? 'spawn failed'
        term.writeln(`\r\n\x1b[31m[error] ${error.value}\x1b[0m`)
        return
      }
      sessionId.value = resp.payload.terminal_session_id
      status.value = 'running'
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

  async function interrupt(): Promise<void> {
    if (!sessionId.value) return
    await backend.send('terminal.interrupt', { terminal_session_id: sessionId.value })
  }

  async function kill(): Promise<void> {
    if (!sessionId.value) return
    await backend.send('terminal.kill', { terminal_session_id: sessionId.value })
  }

  function cleanupSession(): void {
    inputDisposer?.dispose()
    inputDisposer = null
    outputUnsub?.()
    outputUnsub = null
    exitUnsub?.()
    exitUnsub = null
  }

  watch(
    () => mounted,
    () => {
      if (mounted) fit.fit()
    }
  )

  onScopeDispose(() => {
    cleanupSession()
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
    status,
    sessionId,
    error,
    lastCommand,
    cleanBuffer,
    lastActivityAt,
    lastRawActivityAt,
    markBufferPosition,
    recleanBuffer
  }
}
