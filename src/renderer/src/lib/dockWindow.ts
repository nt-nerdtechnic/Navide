/** The window an embedded AI panel (AiCliDock) lives in, as the main window
 *  names it next to its own panes. A panel registers with a surface ('pm' for
 *  the Pipeline Manager modal, else its own window); a window pane has none —
 *  or 'main' — and gets no label, so it is drawn exactly as before. */
const DOCK_WINDOW_KEYS: Readonly<Record<string, string>> = {
  pm: 'dockWindow.pm',
  plans: 'dockWindow.plans',
  git: 'dockWindow.git',
  editor: 'dockWindow.editor',
}

/** i18n key naming the panel's window, or null for a window pane. */
export function dockWindowLabelKey(surface: string | undefined): string | null {
  return (surface && DOCK_WINDOW_KEYS[surface]) || null
}

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
