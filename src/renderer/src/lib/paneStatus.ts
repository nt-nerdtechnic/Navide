/** Reconcile the buffer-based pane badge status with the authoritative CLI
 *  lifecycle signal.
 *
 *  `displayStatus` (the caller's `rawStatus`) is derived purely from raw
 *  PTY-byte quiescence, so it cannot tell a repaint we triggered ourselves
 *  (focus, a window-resize refit, a finished TUI redrawing its footer) from the
 *  agent actually working — any of those keep it pinned at 'running'.
 *
 *  The CLI lifecycle events are authoritative: the backend emits `agent_active`
 *  (JSONL shows a new tool_use / text chunk) and `turn_complete` (assistant turn
 *  ended). We treat the byte heuristic as a veto-only signal: it may keep a pane
 *  idle, but it can NOT assert 'running' on its own. 'running' is confirmed only
 *  when `agent_active` is the pane's latest lifecycle event (lastActiveAt beats
 *  turnCompleteAt). This makes focus/resize repaints — which produce no
 *  lifecycle event — unable to flip the badge.
 *
 *  Panes with no lifecycle signal yet (both timestamps 0, e.g. an idle resumed
 *  session right after app start) resolve to 'idle' rather than a repaint-faked
 *  'running'. Every non-'running' rawStatus (idle / starting / exited / …)
 *  passes through untouched. */
export function resolvePaneStatus(
  rawStatus: string,
  turnCompleteAt: number,
  lastActiveAt: number,
): string {
  if (rawStatus !== 'running') return rawStatus
  return lastActiveAt > turnCompleteAt ? 'running' : 'idle'
}
