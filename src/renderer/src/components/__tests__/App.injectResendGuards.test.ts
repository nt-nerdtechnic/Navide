// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Two paths sent the same text to a CLI more than once.
//
// The kickoff retry: injectPane returns false both when the bytes never reached
// the input box AND when they reached it but Enter would not submit them. Only
// the first is worth repeating — retrying the second appends a second copy of
// the prompt to the one already sitting in the composer, and injectText's own
// 3× content retry sits underneath, so the worst case was nine copies.
//
// The messaging dedupe: onTurnCompleteForMessaging deduped on the turn's
// timestamp alone, and an unparseable timestamp reads as fresh by design (a
// missing field must not mute a real turn). That left the vendors whose stamp
// does not parse with no dedupe at all, and no ceiling on the resends.
//
// Both live in App.vue, which the suite cannot mount, so they are asserted
// against the source the way the other App.*.test.ts files do. The part that
// CAN be executed — turnTextFingerprint — is unit-tested in
// lib/__tests__/completion.test.ts.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function fn(name: string): string {
  const start = appSource.indexOf(`function ${name}(`)
  expect(start).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n}\n', start)
  expect(end).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

describe('kickoff injection is retried only when it left nothing behind', () => {
  // Both kickoff sites — the single-pane stage prep and the slot fan-out.
  const sites = appSource
    .split('const MAX_KICKOFF_ATTEMPTS = 3')
    .slice(1)
    .map((s) => s.slice(0, 1400))

  it('covers both kickoff retry loops', () => {
    expect(sites).toHaveLength(2)
  })

  it('asks injectPane for the echo evidence of each attempt', () => {
    // Without the evidence out-parameter the caller cannot tell the two failure
    // shapes apart — a bare `false` is all it would see.
    for (const site of sites) {
      expect(site).toContain('attemptEvidence')
      expect(site).toMatch(/injectPane\([^)]*attemptEvidence\)/s)
    }
  })

  it('stops instead of resending once the text reached the input box', () => {
    for (const site of sites) {
      const guard = site.indexOf('if (attemptEvidence.echo != null)')
      expect(guard).toBeGreaterThan(-1)
      // The guard must precede the retry, or the second copy goes out first.
      expect(guard).toBeLessThan(site.indexOf('if (attempt < MAX_KICKOFF_ATTEMPTS)'))
      expect(site.slice(guard, guard + 260)).toContain('break')
    }
  })

  it('still retries the failure that sent nothing', () => {
    // The guard must not swallow the case it was never meant to cover: bytes
    // dropped under back-pressure deserve another attempt.
    for (const site of sites) {
      expect(site).toContain('await sleep(3_000)')
    }
  })
})

describe('turn text is deduped even when its timestamp is not', () => {
  const body = fn('onTurnCompleteForMessaging')

  it('parses the vendors that stamp turns in bare epoch milliseconds', () => {
    // Date.parse returns NaN for "1757500000000" (Kimi), which sent that vendor
    // down the always-fresh path on every single turn.
    expect(body).toContain('parseEventMs(timestamp)')
    expect(body).not.toContain('Date.parse(timestamp)')
  })

  it('keeps the strictly-increasing gate for turns that do carry a stamp', () => {
    expect(body).toContain('eventMs > (paneMsgProcessedAt.get(paneId) ?? 0)')
  })

  it('falls back to the text itself when the stamp cannot be read', () => {
    expect(body).toContain('turnTextFingerprint(text)')
    expect(body).toContain('fingerprint !== paneMsgProcessedFingerprint.get(paneId)')
  })

  it('no longer treats an unreadable stamp as unconditionally fresh', () => {
    expect(body).not.toContain('Number.isNaN(eventMs) || eventMs >')
  })

  it('records whichever mark it judged on, so the next arrival is caught', () => {
    const stamped = body.indexOf('paneMsgProcessedAt.set(paneId, eventMs)')
    const printed = body.indexOf('paneMsgProcessedFingerprint.set(paneId, fingerprint)')
    expect(stamped).toBeGreaterThan(-1)
    expect(printed).toBeGreaterThan(-1)
    // Recorded before the messages go out: sendMessage is async-dispatching and
    // a re-entrant turn_complete must not find the mark still unset.
    expect(Math.max(stamped, printed)).toBeLessThan(body.indexOf('const parsed = parseMessages(text)'))
  })

  it('does not hold the fingerprint of a pane that is gone', () => {
    // Paired with paneMsgProcessedAt, which is cleared in the same teardown.
    const teardown = appSource.indexOf('paneMsgProcessedAt.delete(paneId)')
    expect(teardown).toBeGreaterThan(-1)
    expect(appSource.slice(teardown, teardown + 120)).toContain(
      'paneMsgProcessedFingerprint.delete(paneId)',
    )
  })
})
