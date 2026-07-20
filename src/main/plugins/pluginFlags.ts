// Dev/rollout feature flags for the plugin layer. Pure env reads kept in one
// electron-free module so the routing decisions they gate are unit-testable.

/**
 * Whether the mini-IDE should open as an isolated plugin `WebContentsView`
 * instead of the legacy `openEditorWindow` BrowserWindow (M5).
 *
 * Defaults OFF: the old editor window stays the default so nothing changes for
 * the user until they opt in with `AGENT_TEAM_MINI_IDE_PLUGIN=1`. Both paths
 * coexist — this only picks which one `window:openEditor` dispatches to.
 */
export function miniIdePluginEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['AGENT_TEAM_MINI_IDE_PLUGIN'] === '1'
}
