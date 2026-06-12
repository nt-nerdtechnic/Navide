// Builds the CLI command that resumes a prior conversation by session id, so a
// pane reloads the agent's memory on App restart.
//
// Per-vendor syntax (verified against each CLI; none support pinning an id at
// launch, but all support resuming a known id):
//   • claude --resume <id>
//   • codex resume <id>      ← subcommand, NOT a --flag
//   • gemini --session-file <path>
//   • agy --conversation <id>
//
// `skipFlag` is the vendor's permission-bypass flag (or "" when YOLO is off),
// appended verbatim — same flags resolveCommand() uses for a fresh launch.

export function buildResumeCommand(
  agentKey: string,
  sessionId: string,
  skipFlag = ''
): string {
  const id = sessionId.trim()
  if (!id) return '' // no id → caller falls back to a fresh spawn
  const base =
    agentKey === 'codex'
      ? `codex resume ${id}`
      : agentKey === 'gemini'
        ? `gemini --session-file ${JSON.stringify(id)}`
      : agentKey === 'antigravity'
        ? `agy --conversation ${id}`
      : `${agentKey} --resume ${id}`
  const flag = skipFlag.trim()
  return flag ? `${base} ${flag}` : base
}
