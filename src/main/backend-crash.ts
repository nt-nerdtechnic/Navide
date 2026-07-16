// Crash detection for a backend that dies AFTER a successful start, extracted
// electron-free (same pattern as backend-broadcast.ts) so it can be
// unit-tested. Without a post-start exit watcher, main keeps reporting
// status 'ready' with a dead port after a backend crash, and every renderer
// reconnect-loops against it forever with no error UI.

export function formatBackendExitError(code: number | null, signal: string | null): string {
  const detail = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`
  return `backend exited unexpectedly (${detail})`
}

/** The one ChildProcess capability the watcher needs, kept structural so tests
 *  can use a plain EventEmitter. */
export interface ExitWatchable {
  once(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown
}

/**
 * Watch a started backend process for an unexpected exit. `isCurrent` guards
 * on handle identity: deliberate stop/restart/quit paths clear the active
 * handle BEFORE killing the process, so their exit events are ignored here
 * and only a genuine crash reaches `onCrash`.
 */
export function watchBackendExit(
  proc: ExitWatchable,
  isCurrent: () => boolean,
  onCrash: (message: string) => void
): void {
  proc.once('exit', (code, signal) => {
    if (!isCurrent()) return
    onCrash(formatBackendExitError(code, signal))
  })
}
