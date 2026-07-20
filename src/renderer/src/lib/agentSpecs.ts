/**
 * agentSpecs.ts
 *
 * Canonical list of CLI agent specs, shared between the main window
 * (App.vue spawn UI) and the plan window (execute-dispatch agent picker).
 * Shape mirrors the `AgentSpec` interface in components/ControlPane.vue
 * (structurally identical so either import site typechecks).
 */

export interface AgentSpec {
  agentKey: string
  label: string
  defaultCommand: string
  skipPermissionFlag?: string
  hint?: string
}

// skipPermissionFlag: CLI-specific flag that bypasses interactive permission /
// trust prompts so the agent runs unattended. Appended automatically when the
// user enables YOLO mode (default) and hasn't supplied a custom command.
export const AGENT_SPECS: AgentSpec[] = [
  {
    agentKey: 'claude',
    label: 'Claude Code',
    defaultCommand: 'claude',
    skipPermissionFlag: '--dangerously-skip-permissions',
    hint: 'planner + reviewer'
  },
  {
    agentKey: 'codex',
    label: 'Codex',
    defaultCommand: 'codex',
    skipPermissionFlag: '--dangerously-bypass-approvals-and-sandbox',
    hint: 'implementer'
  },
  {
    agentKey: 'antigravity',
    label: 'Antigravity CLI',
    defaultCommand: 'agy',
    skipPermissionFlag: '--dangerously-skip-permissions',
    hint: 'generalist'
  },
  {
    agentKey: 'grok',
    label: 'Grok CLI',
    defaultCommand: 'grok',
    // no skipPermissionFlag: grok-cli has no tool-confirmation gate at all
    hint: 'generalist'
  },
  {
    agentKey: 'kimi',
    label: 'Kimi Code',
    defaultCommand: 'kimi',
    skipPermissionFlag: '--yolo',
    hint: 'generalist'
  },
  {
    agentKey: 'terminal',
    label: 'Terminal',
    defaultCommand: '',
    hint: 'plain shell'
  }
]

/** Specs that are real CLI agents (excludes the plain-shell terminal entry). */
export const CLI_AGENT_SPECS: AgentSpec[] = AGENT_SPECS.filter((s) => s.agentKey !== 'terminal')
