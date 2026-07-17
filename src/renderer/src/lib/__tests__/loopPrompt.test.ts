import { describe, it, expect } from 'vitest'
import {
  parseLimitReset,
  LIMIT_RESET_BUFFER_MS,
  SESSION_LIMIT_RE,
  matchSessionLimit,
  unseenTail,
} from '../loopPrompt'

// parseLimitReset resolves the CLI session-limit message ("You've hit your
// session limit · resets 4:30am (Asia/Taipei)") to the epoch ms to auto-resume
// at: next wall-clock occurrence in the message's timezone + 2min buffer.
// UTC is used in the deterministic cases so expected values are exact.

const LIMIT_MSG = (time: string, tz: string): string =>
  `You've hit your session limit · resets ${time} (${tz})`

describe('lib/loopPrompt parseLimitReset', () => {
  it('matches the real CLI limit message shape', () => {
    expect(SESSION_LIMIT_RE.test(LIMIT_MSG('4:30am', 'Asia/Taipei'))).toBe(true)
  })

  it('resolves a later-today reset time (with the 2min buffer)', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0)
    expect(parseLimitReset(LIMIT_MSG('4:30am', 'UTC'), now)).toBe(
      Date.UTC(2026, 0, 1, 4, 30, 0) + LIMIT_RESET_BUFFER_MS
    )
  })

  it('rolls to the next day when the reset time already passed', () => {
    const now = Date.UTC(2026, 0, 1, 10, 0, 0)
    expect(parseLimitReset(LIMIT_MSG('4:30am', 'UTC'), now)).toBe(
      Date.UTC(2026, 0, 2, 4, 30, 0) + LIMIT_RESET_BUFFER_MS
    )
  })

  it('handles pm times and missing minutes', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0)
    expect(parseLimitReset(LIMIT_MSG('11pm', 'UTC'), now)).toBe(
      Date.UTC(2026, 0, 1, 23, 0, 0) + LIMIT_RESET_BUFFER_MS
    )
  })

  it('treats 12am as midnight', () => {
    const now = Date.UTC(2026, 0, 1, 10, 0, 0)
    expect(parseLimitReset(LIMIT_MSG('12am', 'UTC'), now)).toBe(
      Date.UTC(2026, 0, 2, 0, 0, 0) + LIMIT_RESET_BUFFER_MS
    )
  })

  it('resolves a non-UTC IANA timezone to a future timestamp within 24h', () => {
    const now = Date.now()
    const resumeAt = parseLimitReset(LIMIT_MSG('4:30am', 'Asia/Taipei'), now)
    expect(resumeAt).not.toBeNull()
    expect(resumeAt!).toBeGreaterThan(now)
    expect(resumeAt!).toBeLessThanOrEqual(now + 24 * 3600_000 + LIMIT_RESET_BUFFER_MS)
  })

  it('returns null when the message does not match', () => {
    expect(parseLimitReset('all good, no limits here', Date.now())).toBeNull()
  })

  it('returns null for an unknown timezone name (fail open)', () => {
    expect(parseLimitReset(LIMIT_MSG('4:30am', 'Not/AZone'), Date.now())).toBeNull()
  })

  it('returns null for an out-of-range hour (fail open)', () => {
    expect(parseLimitReset(LIMIT_MSG('13:30am', 'UTC'), Date.now())).toBeNull()
  })
})

// matchSessionLimit tolerates the TUI hard-wrapping the limit message across
// lines in narrow panes (cleanBuffer keeps the wrap \n, which the raw regex's
// `.` gaps cannot cross). It returns the whitespace-normalized matched message
// so parseLimitReset keeps working on the result.
describe('lib/loopPrompt matchSessionLimit', () => {
  it('matches the single-line message and returns a parseable substring', () => {
    const matched = matchSessionLimit(`noise before\n${LIMIT_MSG('4:30am', 'UTC')}\nnoise after`)
    expect(matched).not.toBeNull()
    const now = Date.UTC(2026, 0, 1, 0, 0, 0)
    expect(parseLimitReset(matched!, now)).toBe(Date.UTC(2026, 0, 1, 4, 30, 0) + LIMIT_RESET_BUFFER_MS)
  })

  it('matches when wrapped after "limit ·"', () => {
    const matched = matchSessionLimit("You've hit your session limit ·\nresets 4:30am (UTC)")
    expect(matched).not.toBeNull()
    expect(parseLimitReset(matched!, Date.UTC(2026, 0, 1, 0, 0, 0))).toBe(
      Date.UTC(2026, 0, 1, 4, 30, 0) + LIMIT_RESET_BUFFER_MS
    )
  })

  it('matches when wrapped before "resets" inside the leading gap', () => {
    const matched = matchSessionLimit("You've hit your\nsession limit · resets\n4:30am (UTC)")
    expect(matched).not.toBeNull()
    expect(parseLimitReset(matched!, Date.UTC(2026, 0, 1, 0, 0, 0))).toBe(
      Date.UTC(2026, 0, 1, 4, 30, 0) + LIMIT_RESET_BUFFER_MS
    )
  })

  it('matches when wrapped inside the timezone parens and still parses', () => {
    const matched = matchSessionLimit("You've hit your session limit · resets 4:30am (Asia/\nTaipei)")
    expect(matched).not.toBeNull()
    const now = Date.now()
    const resumeAt = parseLimitReset(matched!, now)
    expect(resumeAt).not.toBeNull()
    expect(resumeAt!).toBeGreaterThan(now)
  })

  it('returns null for non-matching text', () => {
    expect(matchSessionLimit('all good, no limits here')).toBeNull()
  })
})

// unseenTail slices the not-yet-consumed region of a rolling capped buffer
// using the monotonic total-chars counter (cleanBytesSeen) as the position
// space — the loop watcher's consumed-position baseline math.
describe('lib/loopPrompt unseenTail', () => {
  it('returns everything after the baseline', () => {
    expect(unseenTail('abcdef', 6, 4, 100)).toBe('ef')
  })

  it('returns empty when the baseline is at the current end', () => {
    expect(unseenTail('abcdef', 6, 6, 100)).toBe('')
  })

  it('caps the result to the last maxChars of the unseen region', () => {
    expect(unseenTail('abcdef', 6, 0, 3)).toBe('def')
  })

  it('clamps to the whole buffer when the cap trimmed unseen text away', () => {
    // totalSeen 20 with only 6 chars retained: baseline 2 lies before the
    // retained window, so the unseen region is the entire buffer.
    expect(unseenTail('uvwxyz', 20, 2, 100)).toBe('uvwxyz')
  })

  it('returns empty for a baseline at/past totalSeen', () => {
    expect(unseenTail('abcdef', 6, 9, 100)).toBe('')
  })
})
