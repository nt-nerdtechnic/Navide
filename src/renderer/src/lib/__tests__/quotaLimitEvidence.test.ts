import { describe, expect, it } from 'vitest'
import { matchSessionLimit, parseLimitEvidence } from '../loopPrompt'
import { detectUsageLimit, quotaExhaustedPayload, QUOTA_READING_VETO } from '../cliUsageLimit'

const NOW = Date.parse('2026-09-21T03:00:00Z')
function payload(message: string) {
  const hit = detectUsageLimit(undefined, message, NOW)
  expect(hit).not.toBeNull()
  expect(hit).not.toBe(QUOTA_READING_VETO)
  if (!hit || hit === QUOTA_READING_VETO) throw new Error('Expected a real detector hit')
  return quotaExhaustedPayload(hit, { agentKey: 'claude', paneId: 'pane-a' }, NOW)
}

describe('quota limit attribution evidence', () => {
  it('propagates a weekly clock without inventing a dated reset', () => {
    expect(payload("You've hit your weekly limit · resets 3:30pm (Asia/Taipei)")).toMatchObject({
      agent_key: 'claude', pane_id: 'pane-a', at: '2026-09-21T03:00:00.000Z',
      resets_at: null, window_kind: 'weekly', model_scope: null, reset_precision: 'clock_only'
    })
  })
  it('keeps explicit session clock-only attribution and cross-midnight rollover', () => {
    expect(payload("You've hit your session limit · resets 3:30pm (Asia/Taipei)")).toMatchObject({ resets_at: '2026-09-21T07:30:00.000Z', window_kind: 'session', reset_precision: 'clock_only' })
    expect(parseLimitEvidence('hit your session limit resets 1:00am (Asia/Taipei)', NOW).resetAt).toBe(Date.parse('2026-09-21T17:00:00Z'))
  })
  it('propagates exact UTC dates and explicit all-model identity', () => {
    expect(payload("You've hit your weekly (all models) limit · resets 2026-09-24T07:30:00Z")).toMatchObject({ resets_at: '2026-09-24T07:30:00.000Z', window_kind: 'weekly', model_scope: 'all', reset_precision: 'exact' })
  })
  it('resolves dated IANA clocks and keeps their model scope and precision', () => {
    const text = "You've hit your weekly (Fable only) limit · resets 2026-09-24 3:30pm (Asia/Taipei)"
    expect(matchSessionLimit(text)).toContain('2026-09-24')
    expect(payload(text)).toMatchObject({ resets_at: '2026-09-24T07:30:00.000Z', model_scope: 'Fable only', reset_precision: 'minute' })
  })
  it('does not lend an ambiguous usage clock to a session', () => {
    expect(payload("You've hit your usage limit · resets 3:30pm (Asia/Taipei)")).toMatchObject({ window_kind: null, resets_at: null, reset_precision: 'clock_only' })
  })
  it.each(['2026-02-30 3:30pm (Asia/Taipei)', '2026-09-24 13:30pm (Asia/Taipei)', '2026-09-24 3:30pm (Middle/Earth)'])('rejects an invalid dated reset: %s', (clock) => {
    expect(parseLimitEvidence('hit your weekly limit resets ' + clock, NOW)).toMatchObject({ resetAt: null, resetPrecision: 'unknown' })
  })
})
