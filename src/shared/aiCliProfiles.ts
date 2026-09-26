/**
 * Host-owned executable profiles shared by renderer adapters and the main
 * process. Rich renderer agent specs add UI and resume metadata, but the
 * executable and unattended-mode flag live here so the two launch paths cannot
 * silently drift.
 */
export const AI_CLI_PROFILES = {
  claude: { label: 'Claude Code', command: 'claude', yoloFlag: '--dangerously-skip-permissions' },
  codex: { label: 'Codex', command: 'codex', yoloFlag: '--dangerously-bypass-approvals-and-sandbox' },
  antigravity: { label: 'Antigravity CLI', command: 'agy', yoloFlag: '--dangerously-skip-permissions' },
  grok: { label: 'Grok CLI', command: 'grok' },
  kimi: { label: 'Kimi Code', command: 'kimi', yoloFlag: '--yolo' },
  opencode: { label: 'OpenCode', command: 'opencode', yoloFlag: '--auto' },
  qwen: { label: 'Qwen Code', command: 'qwen', yoloFlag: '--yolo' },
  kilo: { label: 'Kilo Code', command: 'kilo', yoloFlag: '--auto' },
  pi: { label: 'Pi', command: 'pi' },
  copilot: { label: 'Copilot CLI', command: 'copilot', yoloFlag: '--yolo' },
  cursor: { label: 'Cursor CLI', command: 'agent', yoloFlag: '--force' },
  aider: { label: 'Aider', command: 'aider', yoloFlag: '--yes-always' },
  muse: { label: 'Muse Code', command: 'muse', yoloFlag: '--disable-approval' },
} as const

export type AiCliProfileId = keyof typeof AI_CLI_PROFILES

/** Presentation metadata for the existing embedded editor terminal. Keeping
 * its richer profile set opt-in preserves current Git/Plans launch defaults. */
export const TERMINAL_AI_CLI_PROFILES = {
  ...AI_CLI_PROFILES,
  opencode: { label: 'OpenCode', command: 'opencode' },
  droid: { label: 'Droid', command: 'droid', yoloFlag: '--auto high' },
} as const

export const FULL_SCREEN_AI_CLI_PROFILES: readonly string[] = [
  'claude', 'antigravity', 'opencode', 'qwen', 'kilo', 'copilot',
]

export const BRACKETED_PASTE_AI_CLI_PROFILES: readonly string[] = [
  'claude', 'codex', 'antigravity', 'droid', 'grok', 'kimi',
]

/** Profiles whose terminal adapter uses a dedicated Shift+Enter sequence. */
export const AI_CLI_SHIFT_ENTER_SEQUENCES: Readonly<Record<string, string>> = {
  codex: '\x1b[13;2u',
}
