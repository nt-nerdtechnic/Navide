import { describe, expect, it } from 'vitest'
import { buildResumeCommand } from '../resume-command'

describe('buildResumeCommand', () => {
  it('uses --resume for claude', () => {
    expect(buildResumeCommand('claude', 'abc')).toBe('claude --resume abc')
  })

  it('uses the resume subcommand (no --) for codex', () => {
    expect(buildResumeCommand('codex', 'abc')).toBe('codex resume abc')
  })

  it('uses agy --conversation for antigravity', () => {
    expect(buildResumeCommand('antigravity', 'abc')).toBe('agy --conversation abc')
  })

  it('appends the permission-bypass flag when given', () => {
    expect(buildResumeCommand('claude', 'abc', '--dangerously-skip-permissions')).toBe(
      'claude --resume abc --dangerously-skip-permissions'
    )
    expect(buildResumeCommand('codex', 'abc', '--dangerously-bypass-approvals-and-sandbox')).toBe(
      'codex resume abc --dangerously-bypass-approvals-and-sandbox'
    )
    expect(buildResumeCommand('antigravity', 'abc', '--dangerously-skip-permissions')).toBe(
      'agy --conversation abc --dangerously-skip-permissions'
    )
  })

  it('returns "" for an empty/blank session id so the caller falls back to a fresh spawn', () => {
    expect(buildResumeCommand('claude', '')).toBe('')
    expect(buildResumeCommand('codex', '   ')).toBe('')
  })

  it('trims the session id', () => {
    expect(buildResumeCommand('antigravity', '  abc  ')).toBe('agy --conversation abc')
  })
})
