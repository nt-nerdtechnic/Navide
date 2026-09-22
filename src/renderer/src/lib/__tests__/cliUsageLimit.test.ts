// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'
import {
  QUOTA_READING_VETO,
  USAGE_LIMIT_UNKNOWN_TTL_MS,
  detectUsageLimit,
  isDismissedUsageLimit,
  usageLimitDue,
  usageResumeAt,
  type UsageLimitHit
} from '../cliUsageLimit'
import { LIMIT_RESET_BUFFER_MS } from '../loopPrompt'
import { __resetUsageForTest, initUsage, type UsageSnapshot } from '../../composables/useUsage'
import { __resetSettingsForTest } from '@navide/plugin-ui/shared/testing'

type Handler = (raw: unknown) => void

/** Seed the usage store the way the backend does — the detector reads it as a
 *  second, out-of-buffer signal, so it has to come from the real store. */
function seedUsage(
  windows: UsageSnapshot['windows'],
  status: UsageSnapshot['status'] = 'ok',
  extra: Partial<UsageSnapshot> = {}
): void {
  const handlers = new Map<string, Handler>()
  const backend = {
    status: ref('connected'),
    send: vi.fn(async () => ({ ok: true, payload: {} })),
    on: vi.fn((type: string, cb: Handler) => {
      handlers.set(type, cb)
      return () => handlers.delete(type)
    })
  }
  initUsage(backend as never)
  handlers.get('usage.changed')?.({
    providers: {
      claude: {
        provider: 'claude',
        status,
        planType: null,
        windows,
        fetchedAt: '2026-09-07T00:00:00Z',
        error: null,
        ...extra
      }
    }
  })
}


/** Assert a verdict is a hit and hand it back narrowed.
 *
 *  detectUsageLimit answers three things now — a hit, the veto sentinel, or
 *  nothing — so `hit!` no longer narrows to the object: it only drops null,
 *  and every `.resumeAt` after it is a type error. Asserting against the
 *  sentinel here also makes each caller state that it expects a HIT, which
 *  `not.toBeNull()` on its own no longer says. */
function expectHit(verdict: ReturnType<typeof detectUsageLimit>): UsageLimitHit {
  expect(verdict).not.toBeNull()
  expect(verdict).not.toBe(QUOTA_READING_VETO)
  return verdict as UsageLimitHit
}

const NOW = Date.parse('2026-09-07T06:00:00Z') // 14:00 Asia/Taipei

describe('detectUsageLimit', () => {
  beforeEach(() => {
    __resetUsageForTest()
    __resetSettingsForTest()
  })
  afterEach(() => {
    __resetUsageForTest()
    __resetSettingsForTest()
  })

  it('takes the reset time from the message, not from the /usage reading', () => {
    // The panel reading is up to 15 minutes old and here it disagrees: it still
    // believes the window ends at 18:50. The message was printed just now.
    seedUsage([
      { kind: 'session', label: 'Session (5h)', usedPercent: 100, resetsAt: '2026-09-07T10:50:00Z' }
    ])
    const hit = expectHit(detectUsageLimit(
      'claude',
      "You've hit your session limit · resets 4:30pm (Asia/Taipei)",
      NOW
    ))
    // 16:30 Taipei = 08:30Z, plus the safety buffer.
    expect(hit.resumeAt).toBe(Date.parse('2026-09-07T08:30:00Z') + LIMIT_RESET_BUFFER_MS)
  })

  it('keeps a weekly clock estimate for resume without inventing a dated ledger reset', () => {
    // resetAt is what tells the ledger WHICH of the account's windows ran
    // out. It is the message's own clock and nothing else: the reading here
    // says the session window resets at 10:50Z, and a resetAt taken from it
    // could not distinguish the window the message was about.
    seedUsage([
      { kind: 'session', label: 'Session (5h)', usedPercent: 100, resetsAt: '2026-09-07T10:50:00Z' }
    ])
    const hit = expectHit(detectUsageLimit(
      'claude',
      "You've hit your weekly limit · resets 4:30pm (Asia/Taipei)",
      NOW
    ))
    expect(hit.resetAt).toBeNull()
    expect(hit.windowKind).toBe('weekly')
    expect(hit.resetPrecision).toBe('clock_only')
    expect(hit.resumeAt).toBe(Date.parse('2026-09-07T08:30:00Z') + LIMIT_RESET_BUFFER_MS)
  })

  it('leaves resetAt null when the message carried no readable clock', () => {
    seedUsage([
      { kind: 'session', label: 'Session (5h)', usedPercent: 100, resetsAt: '2026-09-07T10:50:00Z' }
    ])
    // Clockless, and the unreadable-timezone form: neither names a window,
    // so neither may stamp one, even though both still resume off the reading.
    expect(expectHit(detectUsageLimit('claude', 'You have hit your usage limit', NOW)).resetAt)
      .toBeNull()
    expect(expectHit(detectUsageLimit(
      'claude',
      "You've hit your session limit · resets 4:30pm (Middle/Earth)",
      NOW
    )).resetAt).toBeNull()
  })

  it('falls back to the /usage reading when the message time is unreadable', () => {
    seedUsage([
      { kind: 'session', label: 'Session (5h)', usedPercent: 100, resetsAt: '2026-09-07T10:50:00Z' }
    ])
    const hit = expectHit(detectUsageLimit(
      'claude',
      "You've hit your session limit · resets 4:30pm (Middle/Earth)",
      NOW
    ))
    expect(hit.resumeAt).toBe(Date.parse('2026-09-07T10:50:00Z') + LIMIT_RESET_BUFFER_MS)
  })

  it('reports the hit with no resume time when neither source resolves one', () => {
    seedUsage([])
    const hit = expectHit(detectUsageLimit(
      'claude',
      "You've hit your session limit · resets 4:30pm (Middle/Earth)",
      NOW
    ))
    expect(hit.resumeAt).toBeNull()
  })

  it('matches across the TUI hard wrap a narrow pane inserts', () => {
    seedUsage([])
    const hit = expectHit(detectUsageLimit(
      'claude',
      "You've hit your session\nlimit · resets 4:30pm (Asia/\nTaipei)",
      NOW
    ))
    expect(hit.resumeAt).toBe(Date.parse('2026-09-07T08:30:00Z') + LIMIT_RESET_BUFFER_MS)
  })

  it('ignores a clockless limit phrase the quota reading does not confirm', () => {
    // Exactly the false positive this guard exists for: a CLI discussing limits
    // in its own assistant text, with quota to spare.
    seedUsage([
      { kind: 'session', label: 'Session (5h)', usedPercent: 39, resetsAt: '2026-09-07T10:50:00Z' }
    ])
    expect(
      detectUsageLimit('claude', 'the message says you hit your session limit somewhere', NOW)
    ).toBeNull()
  })

  it('believes a clockless limit phrase once the quota reading confirms it', () => {
    seedUsage([
      { kind: 'session', label: 'Session (5h)', usedPercent: 100, resetsAt: '2026-09-07T10:50:00Z' }
    ])
    const hit = expectHit(detectUsageLimit('claude', 'You have hit your usage limit', NOW))
    expect(hit.resumeAt).toBe(Date.parse('2026-09-07T10:50:00Z') + LIMIT_RESET_BUFFER_MS)
  })

  it('does not let a spent per-model bucket confirm a clockless phrase', () => {
    // A promotional "Fable only" bucket reports 100% used without blocking
    // anything, so it must not stand in for real exhaustion.
    seedUsage([
      { kind: 'session', label: 'Session (5h)', usedPercent: 39, resetsAt: '2026-09-07T10:50:00Z' },
      { kind: 'weekly-model', label: 'Weekly (Fable)', usedPercent: 100, resetsAt: '2026-09-09T21:00:00Z' }
    ])
    expect(detectUsageLimit('claude', 'You have hit your usage limit', NOW)).toBeNull()
  })

  it('returns null when there is no limit message at all', () => {
    seedUsage([
      { kind: 'session', label: 'Session (5h)', usedPercent: 100, resetsAt: '2026-09-07T10:50:00Z' }
    ])
    expect(detectUsageLimit('claude', 'Current session: 100% used', NOW)).toBeNull()
  })

  // The account's state outranks the buffer: a clocked sentence is trusted on
  // its own, but not over a reading that says the quota is there.
  const CLOCKED = "You've hit your session limit · resets 4:30pm (Asia/Taipei)"

  it('vetoes a clocked limit message when the reading says quota remains', () => {
    // The exact shape seen in the wild: the pane prints the sentence (a replay,
    // a quote, its own prose), the account has quota, and the CLI goes on
    // answering underneath a badge that would otherwise stand for hours.
    seedUsage([
      { kind: 'session', label: 'Session (5h)', usedPercent: 39, resetsAt: '2026-09-07T10:50:00Z' }
    ])
    // Not null: the caller has to know a verdict was reached on real text, so
    // it can consume the sentence and re-read what overruled it.
    expect(detectUsageLimit('claude', CLOCKED, NOW)).toBe(QUOTA_READING_VETO)
  })

  it('still believes a clocked limit message when the reading agrees', () => {
    seedUsage([
      { kind: 'session', label: 'Session (5h)', usedPercent: 100, resetsAt: '2026-09-07T10:50:00Z' }
    ])
    // Asserted against the sentinel too: `not.toBeNull()` alone would pass on a
    // veto, which is exactly the outcome this test exists to rule out.
    expect(detectUsageLimit('claude', CLOCKED, NOW)).toHaveProperty('resumeAt')
  })

  it.each([
    ['absent', () => seedUsage([])],
    ['errored', () => seedUsage([{ kind: 'session', label: 'S', usedPercent: 10, resetsAt: null }], 'error')],
    [
      'stale',
      () =>
        seedUsage(
          [{ kind: 'session', label: 'S', usedPercent: 10, resetsAt: null }],
          'ok',
          { stale: true }
        )
    ],
    [
      'in flight',
      () =>
        seedUsage(
          [{ kind: 'session', label: 'S', usedPercent: 10, resetsAt: null }],
          'ok',
          { refreshPending: true }
        )
    ]
  ])('lets a clocked limit message stand when the reading is %s', (_label, seed) => {
    // "Don't know" must not veto — and for a vendor with no quota command at
    // all, "don't know" is the permanent state.
    seed()
    expect(detectUsageLimit('claude', CLOCKED, NOW)).toHaveProperty('resumeAt')
  })

  it('does not let a per-model bucket with headroom veto a clocked message', () => {
    // Mirror of the confirmation rule: per-model windows never speak for the
    // account, in either direction. The spent headline window decides.
    seedUsage([
      { kind: 'session', label: 'Session (5h)', usedPercent: 100, resetsAt: '2026-09-07T10:50:00Z' },
      { kind: 'weekly-model', label: 'Weekly (Fable)', usedPercent: 5, resetsAt: '2026-09-09T21:00:00Z' }
    ])
    expect(detectUsageLimit('claude', CLOCKED, NOW)).toHaveProperty('resumeAt')
  })

  it('does not join a limit phrase to an unrelated reset clock further down', () => {
    // The two halves are one message or they are nothing. Before the bound,
    // any "hit your … limit" plus any later "resets <clock>" in the same 2000
    // character tail matched, however far apart.
    seedUsage([])
    const tail = `I hit your usage limit question earlier.${' x'.repeat(200)} The cache resets 3:00pm (Asia/Taipei) daily.`
    expect(detectUsageLimit('claude', tail, NOW)).toBeNull()
  })
})

describe('usageResumeAt', () => {
  beforeEach(() => {
    __resetUsageForTest()
    __resetSettingsForTest()
  })
  afterEach(() => {
    __resetUsageForTest()
    __resetSettingsForTest()
  })

  it('refuses a reset that has already passed', () => {
    // Resuming into a window that "reset" an hour ago per a stale reading would
    // fire straight back into the exhausted quota.
    seedUsage([
      { kind: 'session', label: 'Session (5h)', usedPercent: 100, resetsAt: '2026-09-07T05:00:00Z' }
    ])
    expect(usageResumeAt('claude', NOW)).toBeNull()
  })

  it('prefers the spent window over the session window', () => {
    seedUsage([
      { kind: 'session', label: 'Session (5h)', usedPercent: 20, resetsAt: '2026-09-07T07:00:00Z' },
      { kind: 'weekly', label: 'Weekly (all models)', usedPercent: 100, resetsAt: '2026-09-09T21:00:00Z' }
    ])
    expect(usageResumeAt('claude', NOW)).toBe(
      Date.parse('2026-09-09T21:00:00Z') + LIMIT_RESET_BUFFER_MS
    )
  })

  it('is null for an agent with no usage provider', () => {
    seedUsage([
      { kind: 'session', label: 'Session (5h)', usedPercent: 100, resetsAt: '2026-09-07T10:50:00Z' }
    ])
    expect(usageResumeAt('aider', NOW)).toBeNull()
  })
})

describe('usageLimitDue', () => {
  it('holds the flag until the resolved reset arrives', () => {
    expect(usageLimitDue(NOW, NOW + 60_000, NOW)).toBe(false)
    expect(usageLimitDue(NOW, NOW + 60_000, NOW + 59_999)).toBe(false)
    // The boundary itself releases: the reset already carries a safety buffer.
    expect(usageLimitDue(NOW, NOW + 60_000, NOW + 60_000)).toBe(true)
  })

  it('falls back to the session window when no reset was resolved', () => {
    // Without this the badge sticks for the life of the pane, because nothing
    // else ever clears a flag whose window nobody could name.
    expect(usageLimitDue(NOW, null, NOW + USAGE_LIMIT_UNKNOWN_TTL_MS - 1)).toBe(false)
    expect(usageLimitDue(NOW, null, NOW + USAGE_LIMIT_UNKNOWN_TTL_MS)).toBe(true)
  })

  it('measures the fallback from when the hit was seen, not from now', () => {
    // A flag raised four hours ago must not get a fresh five hours on every
    // poll — that is exactly how a "temporary" state becomes permanent.
    const fourHoursAgo = NOW - 4 * 60 * 60_000
    expect(usageLimitDue(fourHoursAgo, null, NOW)).toBe(false)
    expect(usageLimitDue(fourHoursAgo, null, NOW + 61 * 60_000)).toBe(true)
  })
})

describe('isDismissedUsageLimit', () => {
  const until = Date.UTC(2026, 8, 17, 7, 32, 0, 412)
  const before = until - 90 * 60_000

  it('matches a repaint of the same banner re-resolved a poll later', () => {
    expect(isDismissedUsageLimit(until, until, before)).toBe(true)
    expect(isDismissedUsageLimit(until, until + 873, before)).toBe(true)
    expect(isDismissedUsageLimit(until, until - 873, before)).toBe(true)
  })

  it('stops suppressing once the dismissed reset has arrived', () => {
    // Past the reset the quota is back: the same clock time on the next day
    // is a genuine new limit, not a repaint.
    expect(isDismissedUsageLimit(until, until + 24 * 3600_000 + 500, until + 60_000)).toBe(false)
    expect(isDismissedUsageLimit(until, until, until)).toBe(false)
  })

  it('lets a hit with a different reset time through', () => {
    expect(isDismissedUsageLimit(until, until + 60 * 60_000, before)).toBe(false)
    expect(isDismissedUsageLimit(until, until + 2 * 60_000, before)).toBe(false)
    expect(isDismissedUsageLimit(until, until + 24 * 3600_000, before)).toBe(false)
  })

  it('never suppresses when either reset time is unknown', () => {
    expect(isDismissedUsageLimit(null, until, before)).toBe(false)
    expect(isDismissedUsageLimit(until, null, before)).toBe(false)
    expect(isDismissedUsageLimit(null, null, before)).toBe(false)
  })
})
