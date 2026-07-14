// Builds the CLI command that resumes a prior conversation by session id, so a
// pane reloads the agent's memory on App restart.
//
// Per-vendor syntax (verified against each CLI; none support pinning an id at
// launch, but all support resuming a known id):
//   • claude --resume <id>
//   • codex resume <id>      ← subcommand, NOT a --flag
//   • agy --conversation <id>
//   • grok -s <id>           ← short flag (12-hex session id)
//
// `skipFlag` is the vendor's permission-bypass flag (or "" when YOLO is off),
// appended verbatim — same flags resolveCommand() uses for a fresh launch.

const CODEX_UUID_AT_END = /([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:\.jsonl)?$/i

/** Canonical id accepted by the vendor resume command.
 *
 * Older Agent-Team builds could persist a Codex rollout filename/path before
 * session_meta was readable. Recover only a strict trailing UUID; arbitrary
 * Codex strings and every other vendor stay unchanged.
 */
export function normalizeResumeSessionId(agentKey: string, sessionId: string): string {
  const id = sessionId.trim()
  if (agentKey !== 'codex' || !id) return id
  return id.match(CODEX_UUID_AT_END)?.[1] ?? id
}

/** A saved Codex conversation is data, not permission to start a replacement.
 * Keep the record untouched when its rollout is unavailable; fresh spawn must
 * remain an explicit user action from Agent History.
 */
export function shouldPreserveMissingSessionOnRestore(
  agentKey: string,
  savedSessionId: string,
  canResume: boolean,
): boolean {
  return agentKey === 'codex' && !!savedSessionId.trim() && !canResume
}

export function buildResumeCommand(
  agentKey: string,
  sessionId: string,
  skipFlag = ''
): string {
  const id = normalizeResumeSessionId(agentKey, sessionId)
  if (!id) return '' // no id → caller falls back to a fresh spawn
  const base =
    agentKey === 'codex'
      ? `codex resume ${id}`
      : agentKey === 'antigravity'
        ? `agy --conversation ${id}`
        : agentKey === 'grok'
          ? `grok -s ${id}`
      : `${agentKey} --resume ${id}`
  const flag = skipFlag.trim()
  return flag ? `${base} ${flag}` : base
}
