/** Reconcile the buffer-based pane badge status with the authoritative CLI
 *  lifecycle signal.
 *
 *  `rawStatus` is the byte-quiescence heuristic ('starting' / 'idle' /
 *  'running'): it cannot tell a repaint we triggered ourselves (focus, a
 *  window-resize refit, a finished TUI redrawing its footer) from the agent
 *  actually working, and it also reads a long tool call — output quiet for
 *  seconds — as idle.
 *
 *  The CLI lifecycle events are authoritative: the backend emits `agent_active`
 *  (JSONL shows a new tool_use / text chunk) and `turn_complete` (assistant turn
 *  ended). When either timestamp is set, the lifecycle decides: `agent_active`
 *  is the latest signal → 'running' (even while output is quiet), else → 'idle'.
 *  Focus / resize repaints emit no lifecycle event, so they can never flip the
 *  badge; a long silent tool call stays 'running' because agent_active is still
 *  the latest signal.
 *
 *  Dead states ('exited' / 'error') are definitive and always pass through.
 *  Panes with no lifecycle signal yet (both timestamps 0) fall back to the byte
 *  heuristic. */
export function resolvePaneStatus(
  rawStatus: string,
  turnCompleteAt: number,
  lastActiveAt: number,
): string {
  if (rawStatus === 'exited' || rawStatus === 'error') return rawStatus
  if (turnCompleteAt > 0 || lastActiveAt > 0) {
    return lastActiveAt > turnCompleteAt ? 'running' : 'idle'
  }
  return rawStatus
}
