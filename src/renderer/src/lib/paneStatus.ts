/** Reconcile the buffer-based pane badge status with the authoritative CLI
 *  lifecycle signal. `displayStatus` is derived purely from raw PTY-byte
 *  quiescence, so a finished TUI that keeps repainting its footer stays pinned
 *  at 'running'. When `turn_complete` is the pane's latest lifecycle event
 *  (it ended its turn and has not gone active since), the pane is idle. Only a
 *  stuck 'running' is downgraded; every other status passes through unchanged. */
export function resolvePaneStatus(
  rawStatus: string,
  turnCompleteAt: number,
  lastActiveAt: number,
): string {
  const turnEnded = turnCompleteAt > 0 && lastActiveAt <= turnCompleteAt
  return turnEnded && rawStatus === 'running' ? 'idle' : rawStatus
}
