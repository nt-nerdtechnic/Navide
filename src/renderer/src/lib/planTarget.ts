// Validates a plan target arriving over MCP (ui_invoke), which is untrusted
// input: workspace-relative `.agent-team/plans/<file>.html`, no traversal.
const PLAN_REL_PATH_RE = /^\.agent-team\/plans\/[^/\\\0]+\.html$/

export function parsePlanTargetArgs(args: unknown): { relPath?: string } {
  const a = (args ?? {}) as { rel_path?: unknown; relPath?: unknown }
  const raw = a.rel_path ?? a.relPath
  if (raw === undefined || raw === null || raw === '') return {}
  if (typeof raw !== 'string') throw new Error('rel_path must be a string')
  if (!PLAN_REL_PATH_RE.test(raw) || raw.split('/').includes('..')) {
    throw new Error('rel_path must be a relative path like .agent-team/plans/<name>.html')
  }
  return { relPath: raw }
}
