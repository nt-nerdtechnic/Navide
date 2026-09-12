import { join } from 'node:path'
import { TERMINAL_AI_CLI_PROFILES } from '../../shared/aiCliProfiles'

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/** Same inputs as the existing embedded terminal command builder. The Host
 * chooses every executable/flag, shell and history key; consumers select only
 * an allowlisted profile. Backend binary resolution retains its ownership. */
export function aiTerminalCommand(input: {
  profileId: string
  workspacePath: string
  resumeKey: string
  shell: string
  yoloStored: unknown
  permissionStored: unknown
}): string[] | null {
  if (!Object.hasOwn(TERMINAL_AI_CLI_PROFILES, input.profileId)) return null
  const profile = TERMINAL_AI_CLI_PROFILES[input.profileId as keyof typeof TERMINAL_AI_CLI_PROFILES]
  const parts: string[] = [profile.command]
  if (input.profileId === 'aider') {
    const token = input.resumeKey.slice(0, 8)
    const historyName = /^[0-9a-f]{8}$/.test(token)
      ? `.aider.chat.history.${token}.md` : '.aider.chat.history.md'
    parts.push('--chat-history-file', shellQuote(join(input.workspacePath, historyName)))
  }
  const enabled = input.permissionStored === 'force-on' ||
    (input.permissionStored !== 'force-off' && (input.yoloStored == null || input.yoloStored === '1'))
  if (enabled && 'yoloFlag' in profile) parts.push(profile.yoloFlag)
  const shell = input.shell || 'bash'
  return [shell, shell.endsWith('zsh') ? '-ilc' : '-lc', parts.join(' ')]
}
