import { describe, expect, it } from 'vitest'
import {
  buildResumeCommand,
  dedupeRestorablePanes,
  normalizeResumeSessionId,
  shouldPreserveMissingSessionOnRestore,
  shouldWarnMissingResume,
} from '../resume-command'

describe('normalizeResumeSessionId', () => {
  const uuid = '019f6155-a2ae-72a2-a455-bf454b8f9f90'

  it('keeps an existing Codex UUID unchanged', () => {
    expect(normalizeResumeSessionId('codex', uuid)).toBe(uuid)
  })

  it('repairs a legacy Codex rollout filename', () => {
    expect(normalizeResumeSessionId(
      'codex',
      `rollout-2026-07-14T23-53-50-${uuid}`
    )).toBe(uuid)
  })

  it('repairs a full Codex rollout path with a jsonl suffix', () => {
    expect(normalizeResumeSessionId(
      'codex',
      `/tmp/sessions/rollout-2026-07-14T23-53-50-${uuid}.jsonl`
    )).toBe(uuid)
  })

  it('does not rewrite arbitrary Codex strings or another vendor id', () => {
    expect(normalizeResumeSessionId('codex', 'test-session')).toBe('test-session')
    expect(normalizeResumeSessionId('claude', `rollout-prefix-${uuid}`)).toBe(`rollout-prefix-${uuid}`)
  })
})

describe('shouldPreserveMissingSessionOnRestore', () => {
  it('protects a saved Codex session that fails preflight', () => {
    expect(shouldPreserveMissingSessionOnRestore('codex', 'missing-id', false)).toBe(true)
  })

  it('does not block valid Codex resumes or ordinary fresh launches', () => {
    expect(shouldPreserveMissingSessionOnRestore('codex', 'valid-id', true)).toBe(false)
    expect(shouldPreserveMissingSessionOnRestore('codex', '', false)).toBe(false)
  })

  it('does not change the existing restore policy for other agents', () => {
    expect(shouldPreserveMissingSessionOnRestore('claude', 'missing-id', false)).toBe(false)
  })
})

describe('shouldWarnMissingResume', () => {
  it('warns when a resuming claude pane loses its transcript', () => {
    // was continuing a conversation (last cmd resumed), now the file is gone
    expect(shouldWarnMissingResume('claude', 'sess-1', false, true)).toBe(true)
  })

  it('does not warn a genuinely fresh pane (last command was not a resume)', () => {
    expect(shouldWarnMissingResume('claude', 'sess-1', false, false)).toBe(false)
  })

  it('does not warn when the session is resumable', () => {
    expect(shouldWarnMissingResume('claude', 'sess-1', true, true)).toBe(false)
  })

  it('does not warn without a saved session id', () => {
    expect(shouldWarnMissingResume('claude', '', false, true)).toBe(false)
    expect(shouldWarnMissingResume('claude', '   ', false, true)).toBe(false)
  })

  it('excludes codex (preserved untouched, never silently replaced)', () => {
    expect(shouldWarnMissingResume('codex', 'sess-1', false, true)).toBe(false)
  })
})

describe('dedupeRestorablePanes', () => {
  const uuid = '019f6155-a2ae-72a2-a455-bf454b8f9f90'

  it('keeps only the first record per (agent, session_id)', () => {
    const panes = [
      { agent: 'claude', session_id: 's1', pane_id: 'a' },
      { agent: 'claude', session_id: 's1', pane_id: 'b' },
      { agent: 'claude', session_id: 's1', pane_id: 'c' },
    ]
    expect(dedupeRestorablePanes(panes).map((p) => p.pane_id)).toEqual(['a'])
  })

  it('does not merge the same id across different agents', () => {
    const panes = [
      { agent: 'claude', session_id: 's1', pane_id: 'a' },
      { agent: 'grok', session_id: 's1', pane_id: 'b' },
    ]
    expect(dedupeRestorablePanes(panes).map((p) => p.pane_id)).toEqual(['a', 'b'])
  })

  it('always keeps panes without a session id (fresh, independent)', () => {
    const panes = [
      { agent: 'claude', session_id: '', pane_id: 'a' },
      { agent: 'claude', session_id: '', pane_id: 'b' },
      { agent: 'claude', pane_id: 'c' },
    ]
    expect(dedupeRestorablePanes(panes).map((p) => p.pane_id)).toEqual(['a', 'b', 'c'])
  })

  it('dedupes codex records that normalize to the same rollout id', () => {
    const panes = [
      { agent: 'codex', session_id: uuid, pane_id: 'a' },
      { agent: 'codex', session_id: `rollout-2026-07-14T23-53-50-${uuid}.jsonl`, pane_id: 'b' },
    ]
    expect(dedupeRestorablePanes(panes).map((p) => p.pane_id)).toEqual(['a'])
  })

  it('preserves order and mixes deduped + fresh correctly', () => {
    const panes = [
      { agent: 'claude', session_id: 's1', pane_id: 'a' },
      { agent: 'claude', session_id: '', pane_id: 'b' },
      { agent: 'claude', session_id: 's1', pane_id: 'c' }, // dup of a
      { agent: 'claude', session_id: 's2', pane_id: 'd' },
    ]
    expect(dedupeRestorablePanes(panes).map((p) => p.pane_id)).toEqual(['a', 'b', 'd'])
  })
})

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

  it('uses grok -s for grok', () => {
    expect(buildResumeCommand('grok', '1f9e02aabb3c')).toBe('grok -s 1f9e02aabb3c')
  })

  it('grok resume with a blank id falls back to "" like other vendors', () => {
    expect(buildResumeCommand('grok', '  ')).toBe('')
  })

  it('uses kimi --session for kimi (id keeps its session_ prefix)', () => {
    expect(buildResumeCommand('kimi', 'session_4d4a11fe-b08a-46df-9f86-685589531e65')).toBe(
      'kimi --session session_4d4a11fe-b08a-46df-9f86-685589531e65'
    )
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
