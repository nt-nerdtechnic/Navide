// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The App.vue half of quota-limit detection. The decision itself is covered in
// lib/__tests__/cliUsageLimit.test.ts; what cannot be asserted there is the
// WIRING — that the watch is armed for every pane rather than only the ones a
// loop is running, that the loop consumes the verdict instead of matching the
// text a second time, and that the two matchers sharing one interval do not
// share one baseline. Those are the joints a later edit breaks silently: every
// unit test still passes while the feature quietly reverts to loop-only.
//
// App.vue cannot be mounted by this suite, so the wiring is asserted against
// the source the way the other App.*.test.ts files do.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function paneHealthWatcherBody(): string {
  const start = appSource.indexOf('function startPaneHealthWatcher(')
  expect(start).toBeGreaterThan(-1)
  const end = appSource.indexOf('}, PANE_HEALTH_POLL_MS)', start)
  expect(end).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

function loopWatcherBody(): string {
  const start = appSource.indexOf('function startLoopLimitWatcher(')
  expect(start).toBeGreaterThan(-1)
  const end = appSource.indexOf('}, LOOP_LIMIT_POLL_MS)', start)
  expect(end).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

describe('quota-limit detection is not gated on the loop', () => {
  it('arms the health watcher for every spawned pane', () => {
    // The regression this exists to stop: re-gating the arming call, which is
    // how it used to be (`if (loginCommandFor(...) != null)`). That silently
    // returns the feature to "only claude panes", and before Phase B it was
    // worse than that — only claude panes with a loop running.
    expect(appSource).toContain('    startPaneHealthWatcher(id)')
    const armed = appSource.indexOf('startPaneHealthWatcher(id)')
    const line = appSource.slice(appSource.lastIndexOf('\n', armed) + 1, armed)
    expect(line.trim()).toBe('')
  })

  it('skips only the login half for a vendor with no login spec', () => {
    // The login command is per-vendor; the quota check is not. The early return
    // must therefore sit AFTER the quota call, or the quota half silently
    // becomes claude-only again.
    const body = paneHealthWatcherBody()
    const quota = body.indexOf('checkPaneUsageLimit(')
    const loginGate = body.indexOf('if (loginCommandFor(pane.agentKey) == null) return')
    expect(quota).toBeGreaterThan(-1)
    expect(loginGate).toBeGreaterThan(quota)
  })

  it('gives the two matchers separate consumed-position baselines', () => {
    // One baseline for both means whichever matcher consumes it first hides the
    // same text from the other — a login-expired message would swallow a limit
    // message printed in the same interval, and vice versa.
    const body = paneHealthWatcherBody()
    expect(body).toContain('limitBaseline: paneCleanBytes(paneId)')
    expect(body).toContain('unseenTail(buf, bytes, watcher.baseline, PANE_HEALTH_TAIL_CHARS)')
    const check = appSource.slice(appSource.indexOf('function checkPaneUsageLimit('))
    expect(check).toContain('unseenTail(buf, bytes, watcher.limitBaseline, PANE_HEALTH_TAIL_CHARS)')
  })
})

describe('the loop consumes the verdict rather than re-matching', () => {
  it('no longer matches the limit text itself', () => {
    // Two independent matchers would drift: the badge and the loop could
    // disagree about whether the pane is out of quota, and the loop would
    // schedule off a reset the badge never saw.
    expect(appSource).not.toContain('matchSessionLimit')
    expect(appSource).not.toContain('parseLimitReset')
  })

  it('reads the pane flag as an edge, not as a level', () => {
    // The health watcher keeps the flag lit for the WHOLE window. Reading it as
    // a level would re-schedule and re-notify on every 5-second poll for hours.
    const body = loopWatcherBody()
    expect(body).toContain('pane.usageLimitAt !== watcher.limitSeenAt')
    expect(body).toContain('watcher.limitSeenAt = pane.usageLimitAt')
  })

  it('waits until the health watcher\'s resume time, never its own estimate', () => {
    const body = loopWatcherBody()
    expect(body).toContain('pane.loopWaitUntil = pane.usageLimitUntil')
  })
})

describe('the refresh a limit hit triggers is addressed to a slot', () => {
  it('names the active profile instead of letting the default slot be assumed', () => {
    // refreshUsage(agentKey) substitutes '__default__' for an absent slot, so
    // on a named profile the cooldown cleared belongs to the wrong account and
    // the badge keeps its stale figure for another CLAUDE_CLI_READ_INTERVAL.
    const check = appSource.slice(appSource.indexOf('function checkPaneUsageLimit('))
    expect(check).toContain(
      'refreshUsage(pane.agentKey, cliProfilesApi.defaultProfileId(pane.agentKey))'
    )
  })
})

describe('the two watchers do not talk over each other', () => {
  it('leaves the announcement to the loop when one is running', () => {
    // notifyPaneState dedupes consecutive same-kind notifications per pane and
    // both of these are 'attention'. Notifying unconditionally here fires first
    // (the health watcher is what sets the flag the loop then reads), which
    // swallows the loop's own "paused, resuming at HH:MM" — strictly more
    // information than the plain "out of quota" that replaced it.
    const check = appSource.slice(appSource.indexOf('function checkPaneUsageLimit('))
    const guard = check.indexOf('if (pane.loopActive) return')
    const notify = check.indexOf('usage-limit-notify-title')
    expect(guard).toBeGreaterThan(-1)
    expect(notify).toBeGreaterThan(guard)
  })
})

describe('the flag-expiry rule lives where it can be tested', () => {
  it('delegates to usageLimitDue instead of re-deriving the deadline inline', () => {
    // App.vue cannot be mounted, so an inline `now >= (until ?? at + TTL)` here
    // is unreachable by any behaviour test — including the "measure the
    // fallback from when the hit was seen" case, which is how a temporary flag
    // silently becomes permanent.
    const check = appSource.slice(appSource.indexOf('function checkPaneUsageLimit('))
    expect(check).toContain(
      'usageLimitDue(pane.usageLimitAt, pane.usageLimitUntil ?? null, now)'
    )
    expect(appSource).not.toContain('USAGE_LIMIT_UNKNOWN_TTL_MS')
  })
})

describe('an account switch lets go of the quota flag', () => {
  // The flag belongs to the account that hit the limit, not to the pane.
  // claude is a hot-swap agent: its switches are never `forced`, so the
  // rebuild path never runs for it and the pane object survives the switch
  // with the flag — and the "back HH:MM" badge — intact until the window
  // expires. This is the only switch-time clear, so it is asserted directly.
  function switchHandlerBody(): string {
    const start = appSource.indexOf("backend.on('cli_profiles.changed'")
    expect(start).toBeGreaterThan(-1)
    const end = appSource.indexOf('\n})', start)
    expect(end).toBeGreaterThan(start)
    return appSource.slice(start, end)
  }

  it('clears every pane of the switched agent on set_default, quiet or forced', () => {
    const body = switchHandlerBody()
    const clear = body.indexOf("if (ev?.reason === 'set_default' && ev.agent_key) clearPaneUsageLimits(ev.agent_key)")
    const forced = body.indexOf('forcedRestartAgentKey(ev)')
    expect(clear).toBeGreaterThan(-1)
    // Before the forced-restart early return, or a forced switch skips it.
    expect(forced).toBeGreaterThan(clear)
  })

  it('drops both halves of the flag and consumes the old limit text', () => {
    const start = appSource.indexOf('function clearPaneUsageLimits(')
    expect(start).toBeGreaterThan(-1)
    const body = appSource.slice(start, appSource.indexOf('\n}\n', start))
    expect(body).toContain('pane.usageLimitAt = null')
    expect(body).toContain('pane.usageLimitUntil = null')
    // Without this the limit banner still in the buffer re-matches on the
    // next poll and re-lights the flag one interval after the switch.
    expect(body).toContain('w.limitBaseline = paneCleanBytes(pane.id)')
    // A loop parked on this limit resumes the way the badge click does.
    expect(body).toContain("fireLoopResume(pane.id, 'account-switch')")
  })

  it('keeps the pane badge wired to the flag', () => {
    // Removed once by a sweep commit (9285f925) with no mention of it; the
    // clear above is invisible without the badge that shows the flag.
    expect(appSource).toContain(':usage-limit-hit="p.usageLimitAt != null"')
    expect(appSource).toContain(':usage-limit-until="p.usageLimitUntil"')
    const pane = readFileSync(resolve(process.cwd(), 'src/renderer/src/components/TerminalPane.vue'), 'utf8')
    expect(pane).toContain('v-if="usageLimitHit"')
    expect(pane).toContain("$t('pane.terminal.usage-limit-badge', { time: formatLoopTime(usageLimitUntil) })")
    for (const lang of ['en-US', 'zh-TW']) {
      const locale = JSON.parse(
        readFileSync(resolve(process.cwd(), `packages/plugin-ui/src/foundation/i18n/locales/${lang}.json`), 'utf8')
      )
      for (const key of ['usage-limit-badge', 'usage-limit-badge-unknown', 'usage-limit-tooltip', 'usage-limit-tooltip-unknown']) {
        expect(locale.pane.terminal[key], `${lang} pane.terminal.${key}`).toBeTypeOf('string')
      }
    }
  })
})
