// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// A failed first `onboarding.status` fails open (the shell must stay usable),
// but it used to fail open FOR GOOD: the connect watch only re-checked while
// the gate was still `null`, so a first-run user whose first check timed out
// never saw the wizard that session, and a reconnect did not retry either.
//
// App.vue cannot be mounted by this suite (see App.spawnAdvisories.test.ts),
// so these assert the wiring against the source text.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function fn(name: string): string {
  const start = appSource.indexOf(`function ${name}(`)
  expect(start, `function ${name} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n}\n', start)
  expect(end).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

describe('a failed onboarding check can still show the wizard later', () => {
  const check = fn('checkOnboarding')
  const catchBlock = check.slice(check.lastIndexOf('} catch (e) {'))

  it('still fails open, so the shell is not blocked', () => {
    expect(catchBlock).toContain('onboardingComplete.value = true')
  })

  it('logs why it failed open instead of swallowing the error', () => {
    expect(catchBlock).toContain('console.warn(')
  })

  it('remembers that the open gate is only a fallback', () => {
    expect(catchBlock).toContain('onboardingCheckFailed.value = true')
  })

  it('forgets the failure once a check succeeds', () => {
    const tryBlock = check.slice(0, check.lastIndexOf('} catch (e) {'))
    expect(tryBlock).toContain('onboardingCheckFailed.value = false')
  })

  it('re-checks on the next connect after a failed check', () => {
    const start = appSource.indexOf('watch(\n  () => backend.status.value,')
    expect(start).toBeGreaterThan(-1)
    const watcher = appSource.slice(start, appSource.indexOf('\n)\n', start))
    expect(watcher).toContain(
      "s === 'connected' && (onboardingComplete.value === null || onboardingCheckFailed.value)"
    )
  })

  it('retries once on its own, since a timeout does not drop the connection', () => {
    expect(catchBlock).toContain('scheduleOnboardingRetry()')
    const retry = fn('scheduleOnboardingRetry')
    // Once per session: a backend that keeps failing must not be polled forever.
    expect(retry).toContain('if (onboardingRetryScheduled) return')
    expect(retry).toContain('onboardingCheckFailed.value')
    expect(retry).toContain("backend.status.value === 'connected'")
    expect(retry).toContain('void checkOnboarding()')
  })
})
