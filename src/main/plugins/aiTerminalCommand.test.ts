import { join, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { platformId, setPlatformId } from '../../shared/osplat'
import { aiTerminalCommand } from './aiTerminalCommand'

// Load-time baseline, so a suite-wide platform injection survives each test.
const BASELINE = platformId()
afterEach(() => setPlatformId(BASELINE))

const base = {
  profileId: 'claude',
  workspacePath: '/workspace/project',
  resumeKey: 'aa1de001-editor-ai-terminal',
  shell: 'bash',
  yoloStored: null as unknown,
  permissionStored: null as unknown,
}

/** The platform *wrapper* is the shared `shellCommandArgv` contract. These
 *  cases assert the command LINE: executable, flags and quoting. */
function lineOf(command: string | string[] | null): string {
  if (typeof command === 'string') return command
  expect(command).not.toBeNull()
  expect(command).toHaveLength(3)
  return (command as string[])[2]
}

describe('Host AI terminal command builder', () => {
  it('wraps the line for the platform: POSIX shell array, Windows plain string', () => {
    setPlatformId('linux')
    expect(aiTerminalCommand({ ...base, shell: 'zsh' })).toEqual([
      'zsh', '-ilc', 'claude --dangerously-skip-permissions',
    ])
    expect(aiTerminalCommand({ ...base, shell: 'bash' })).toEqual([
      'bash', '-lc', 'claude --dangerously-skip-permissions',
    ])
    setPlatformId('win32')
    // A Windows agent pane is handed one string the backend splits itself; a
    // `[powershell, '-lc', …]` wrapper would not even parse.
    expect(aiTerminalCommand({ ...base, shell: 'powershell.exe' })).toBe(
      'claude --dangerously-skip-permissions',
    )
  })

  it('applies the global YOLO default and per-vendor inherit/force overrides', () => {
    expect(lineOf(aiTerminalCommand({ ...base, yoloStored: null, permissionStored: null })))
      .toBe('claude --dangerously-skip-permissions')
    expect(lineOf(aiTerminalCommand({ ...base, yoloStored: '1', permissionStored: 'inherit' })))
      .toBe('claude --dangerously-skip-permissions')
    expect(lineOf(aiTerminalCommand({ ...base, yoloStored: '0', permissionStored: null })))
      .toBe('claude')
    expect(lineOf(aiTerminalCommand({ ...base, yoloStored: '0', permissionStored: 'force-on' })))
      .toBe('claude --dangerously-skip-permissions')
    expect(lineOf(aiTerminalCommand({ ...base, yoloStored: '1', permissionStored: 'force-off' })))
      .toBe('claude')
  })

  it('leaves opencode flagless even when YOLO is enabled or forced on', () => {
    expect(lineOf(aiTerminalCommand({ ...base, profileId: 'opencode', yoloStored: null })))
      .toBe('opencode')
    expect(lineOf(aiTerminalCommand({
      ...base, profileId: 'opencode', yoloStored: '0', permissionStored: 'force-on',
    }))).toBe('opencode')
  })

  it('keeps Droid’s two-token unattended flag inside the command string', () => {
    expect(lineOf(aiTerminalCommand({ ...base, profileId: 'droid' }))).toBe('droid --auto high')
  })

  it('uses the aider FNV history token and quotes the workspace for the platform', () => {
    const aider = {
      ...base,
      profileId: 'aider',
      workspacePath: "/tmp/o'brien",
      resumeKey: '4d4a11fe-editor-ai-terminal',
    }
    setPlatformId('linux')
    expect(lineOf(aiTerminalCommand(aider))).toBe(
      `aider --chat-history-file '${['', 'tmp', "o'\\''brien", '.aider.chat.history.4d4a11fe.md'].join(sep)}' --yes-always`,
    )
    setPlatformId('win32')
    expect(lineOf(aiTerminalCommand(aider))).toBe(
      `aider --chat-history-file "${join(aider.workspacePath, '.aider.chat.history.4d4a11fe.md')}" --yes-always`,
    )
  })

  it('returns null for an unknown profile instead of accepting a caller command', () => {
    expect(aiTerminalCommand({ ...base, profileId: 'unknown-agent' })).toBeNull()
  })
})
