import { dockWindowLabelKey } from '@navide/plugin-shell'

// Lives with the panel itself (plugin-shell), whose own @-mention menu labels
// windows too; re-exported so the main window keeps importing it from here.
export { dockWindowLabelKey }

/** Whether a spawn-history entry's CLI is still running. A window pane is
 *  judged by this window's panes, exactly as before; an embedded AI panel is
 *  never one of them, so it is judged by the messaging roster instead, where a
 *  running panel is registered under its pane id. */
export function historyEntryIsLive(
  entry: { paneId: string; surface?: string },
  livePaneIds: ReadonlySet<string>,
  rosterPaneIds: ReadonlySet<string>,
): boolean {
  return dockWindowLabelKey(entry.surface)
    ? rosterPaneIds.has(entry.paneId)
    : livePaneIds.has(entry.paneId)
}

/** An embedded AI panel's restore record from a terminal.dock_record answer:
 *  its agent and session, or null when the read failed or holds no record. */
export function dockRestoreFromResponse(
  response: { ok: boolean; payload?: { record?: { agent?: string; session_id?: string } | null } | null },
): { agentKey: string; sessionId: string } | null {
  const record = response.ok ? response.payload?.record : null
  return record?.agent ? { agentKey: record.agent, sessionId: record.session_id ?? '' } : null
}

/** True when the roster holds the Pipeline Manager panel of `workspacePath`. */
export function workspaceHasPmPanel(
  roster: ReadonlyArray<{ surface?: string; workspacePath: string }>,
  workspacePath: string,
  norm: (path: string) => string,
): boolean {
  if (!workspacePath) return false
  const ws = norm(workspacePath)
  return roster.some((t) => t.surface === 'pm' && norm(t.workspacePath) === ws)
}
