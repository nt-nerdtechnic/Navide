import { describe, expect, it } from 'vitest'
import { aiTerminalCommand } from './aiTerminalCommand'

const base = {
  profileId: 'claude',
  workspacePath: '/workspace/project',
  resumeKey: 'aa1de001-editor-ai-terminal',
  shell: 'bash',
  yoloStored: null as unknown,
  permissionStored: null as unknown,
}

describe('Host AI terminal command builder', () => {
  it('keeps zsh interactive/login and bash login invocation parity', () => {
    expect(aiTerminalCommand({ ...base, shell: 'zsh' })).toEqual([
      'zsh', '-ilc', 'claude --dangerously-skip-permissions',
    ])
    expect(aiTerminalCommand({ ...base, shell: 'bash' })).toEqual([
      'bash', '-lc', 'claude --dangerously-skip-permissions',
    ])
  })

  it('applies the global YOLO default and per-vendor inherit/force overrides', () => {
    expect(aiTerminalCommand({ ...base, yoloStored: null, permissionStored: null })).toEqual([
      'bash', '-lc', 'claude --dangerously-skip-permissions',
    ])
    expect(aiTerminalCommand({ ...base, yoloStored: '1', permissionStored: 'inherit' })).toEqual([
      'bash', '-lc', 'claude --dangerously-skip-permissions',
    ])
    expect(aiTerminalCommand({ ...base, yoloStored: '0', permissionStored: null })).toEqual([
      'bash', '-lc', 'claude',
    ])
    expect(aiTerminalCommand({ ...base, yoloStored: '0', permissionStored: 'force-on' })).toEqual([
      'bash', '-lc', 'claude --dangerously-skip-permissions',
    ])
    expect(aiTerminalCommand({ ...base, yoloStored: '1', permissionStored: 'force-off' })).toEqual([
      'bash', '-lc', 'claude',
    ])
  })

  it('leaves opencode flagless even when YOLO is enabled or forced on', () => {
    expect(aiTerminalCommand({ ...base, profileId: 'opencode', yoloStored: null })).toEqual([
      'bash', '-lc', 'opencode',
    ])
    expect(aiTerminalCommand({ ...base, profileId: 'opencode', yoloStored: '0', permissionStored: 'force-on' })).toEqual([
      'bash', '-lc', 'opencode',
    ])
  })

  it('keeps Droid’s two-token unattended flag inside the command string', () => {
    expect(aiTerminalCommand({ ...base, profileId: 'droid' })).toEqual([
      'bash', '-lc', 'droid --auto high',
    ])
  })

  it('uses the aider FNV history token and shell-quotes an apostrophe in the workspace', () => {
    expect(aiTerminalCommand({
      ...base,
      profileId: 'aider',
      workspacePath: "/tmp/o'brien",
      resumeKey: '4d4a11fe-editor-ai-terminal',
    })).toEqual([
      'bash', '-lc', "aider --chat-history-file '/tmp/o'\\''brien/.aider.chat.history.4d4a11fe.md' --yes-always",
    ])
  })

  it('returns null for an unknown profile instead of accepting a caller command', () => {
    expect(aiTerminalCommand({ ...base, profileId: 'unknown-agent' })).toBeNull()
  })
})
