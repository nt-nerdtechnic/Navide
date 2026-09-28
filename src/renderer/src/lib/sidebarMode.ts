/** How the sidebar organises its agent list.
 *
 *  'workspace' is the list as it has always been: a heading per project, run
 *  groups under it, lineage indented under those. 'free' drops all three of
 *  those layers and lists the panes themselves — the same flat list the sidebar
 *  already falls back to when no project is grouped yet, so nothing new has to
 *  render it. Parent/child indentation survives: that is a pane's own lineage,
 *  not a grouping the mode removes.
 *
 *  A way of LOOKING, not a place you are, which is why it lives in the global
 *  ui_settings (like `agentTeam.gridPreset`) rather than in this window's
 *  sessionStorage (like `agentTeam.activeWorkspaceRail`): the preference should
 *  follow the user into the next window and the next restart.
 */
export type SidebarMode = 'workspace' | 'free'

export const SIDEBAR_MODE_KEY = 'agentTeam.sidebarMode'

/** Anything unrecognised reads as 'workspace'.
 *
 *  The stored value is a plain string shared across versions and windows, so an
 *  unknown one must fall back to the behaviour that was there before the
 *  setting existed rather than to a blank or a flat list nobody chose. */
export function parseSidebarMode(value: unknown): SidebarMode {
  return value === 'free' ? 'free' : 'workspace'
}
