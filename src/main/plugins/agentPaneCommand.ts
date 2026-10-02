/**
 * The one seam that turns a CLI agent's command line into what the backend can
 * spawn. Every frontend launch path must go through here.
 *
 * The backend wiring (`codex_session_hooks.wire`, `mcp_server.wiring`,
 * push/skills) appends its flags to the LAST element of the command and assumes
 * the documented shape (see `backend/agent_team_backend/cli_vendors/base.py`
 * `command_text`). A raw executable argv here would collapse
 * `--flag -c 'hooks.SessionStart=…'` into a single argument. Centralizing the
 * wrapping keeps a future launch path from rediscovering that the hard way.
 */

import { isWindows, shellCommandArgv } from '../../shared/osplat'

/** Quote one command word for the parser that will read the line back. POSIX:
 *  the shell must see a single word. Windows agent panes are not run through a
 *  shell — the backend parses the string with `CommandLineToArgvW` — so a path
 *  with spaces needs the double-quote form, not POSIX shell quoting. */
export function quoteCommandWord(value: string): string {
  if (isWindows()) return `"${value}"`
  return `'${value.replace(/'/g, "'\\''")}'`
}

/** The launch command for one CLI agent pane: `parts` (executable, per-pane
 *  arguments, unattended flag) joined and wrapped for the platform.
 *
 *  POSIX runs the CLI under the user's login shell; a Windows agent pane is a
 *  plain command string the backend splits itself. */
export function buildAgentPaneCommand(shell: string, parts: readonly string[]): string | string[] {
  return shellCommandArgv(shell || 'bash', parts.join(' '), { agentPane: true })
}
