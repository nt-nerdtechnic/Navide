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

/** A pane that was continuing a conversation (its last command resumed a
 * session) but whose session file is now gone falls back to a fresh pane on
 * restore. Return true to warn the user instead of silently swapping in a new
 * conversation — a resume that can't find its transcript (moved home, deleted,
 * or a transient failure under load) otherwise looks like the app lost it.
 *
 * Requires `lastCommandWasResume` so a genuinely new pane (last launched with a
 * pinned --session-id, no transcript yet) is NOT flagged. Codex is excluded:
 * it is preserved untouched (see shouldPreserveMissingSessionOnRestore), never
 * silently replaced, so it needs no warning here.
 */
export function shouldWarnMissingResume(
  agentKey: string,
  savedSessionId: string,
  canResume: boolean,
  lastCommandWasResume: boolean,
): boolean {
  return (
    agentKey !== 'codex' &&
    !!savedSessionId.trim() &&
    !canResume &&
    lastCommandWasResume
  )
}

/** Collapse restorable panes that point at the SAME conversation. Legacy
 * project.json accumulation can persist several 'spawned' records sharing one
 * session_id; restoring them concurrently spawns multiple `--resume <id>` for a
 * single conversation, which the CLI cannot share — it forks/conflicts and
 * leaks processes. Keep the first record per (agent, session_id). Panes with no
 * session_id (genuinely fresh) are independent and always kept. Order preserved.
 */
export function dedupeRestorablePanes<T extends { agent?: string; session_id?: string }>(
  panes: T[],
): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const p of panes) {
    const id = normalizeResumeSessionId(p.agent ?? '', (p.session_id ?? '').trim())
    if (!id) {
      out.push(p) // no session → independent fresh pane, never merged
      continue
    }
    const key = `${p.agent ?? ''} ${id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
  }
  return out
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
