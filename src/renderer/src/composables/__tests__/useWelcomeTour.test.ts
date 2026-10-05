// @vitest-environment happy-dom
// The first-run welcome tour: who gets it, where it resumes, and what ending
// it records.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => new Map<string, unknown>())

vi.mock('@navide/plugin-ui/shared', () => ({
  settingsGet: (key: string, fallback: unknown) => (store.has(key) ? store.get(key) : fallback),
  settingsSet: (key: string, value: unknown) => {
    store.set(key, value)
  },
}))

async function load() {
  vi.resetModules()
  return import('../useWelcomeTour')
}

beforeEach(() => store.clear())

describe('useWelcomeTour', () => {
  it('stays off for an install that never ran the first-run wizard (an upgrade)', async () => {
    const { useWelcomeTour } = await load()
    const welcome = useWelcomeTour()
    expect(welcome.pending()).toBe(false)
    expect(welcome.start()).toBe(false)
    expect(welcome.active.value).toBeNull()
  })

  it('starts once a first run marked it, at the first bubble', async () => {
    const { useWelcomeTour } = await load()
    const welcome = useWelcomeTour()
    welcome.markFirstRun()
    expect(welcome.pending()).toBe(true)
    expect(welcome.savedStep()).toBe(0)
    expect(welcome.start()).toBe(true)
    expect(welcome.active.value).toBe('first-run')
    // One at a time.
    expect(welcome.start()).toBe(false)
  })

  it('remembers how far it got, so a restart picks up there', async () => {
    const { useWelcomeTour } = await load()
    const welcome = useWelcomeTour()
    welcome.markFirstRun()
    welcome.start()
    welcome.progress(3)
    expect(welcome.savedStep()).toBe(3)
  })

  it('is off for good once it ends, finished or skipped', async () => {
    const { useWelcomeTour } = await load()
    for (const completed of [true, false]) {
      store.clear()
      const welcome = useWelcomeTour()
      welcome.markFirstRun()
      welcome.start()
      welcome.finish(completed)
      expect(welcome.active.value).toBeNull()
      expect(welcome.pending()).toBe(false)
      expect(welcome.start()).toBe(false)
    }
  })

  it('calls the whole tour off when this turns out not to be a first install', async () => {
    const { useWelcomeTour } = await load()
    const welcome = useWelcomeTour()
    welcome.markFirstRun()
    welcome.cancel()
    expect(welcome.pending()).toBe(false)
    expect(welcome.start()).toBe(false)
  })

  it('replays on request without recording anything, even over a pending tour', async () => {
    const { useWelcomeTour } = await load()
    const welcome = useWelcomeTour()
    welcome.replay()
    expect(welcome.active.value).toBe('replay')
    welcome.progress(4)
    welcome.finish(true)
    expect(store.size).toBe(0)

    welcome.markFirstRun()
    welcome.replay()
    welcome.finish(false)
    expect(welcome.pending()).toBe(true)
    expect(welcome.savedStep()).toBe(0)
  })

  it('records a momentary action only while the tour is running', async () => {
    const { useWelcomeTour, welcomeActionTimes } = await load()
    const welcome = useWelcomeTour()
    welcome.notify('mention')
    expect(welcomeActionTimes.mentionAt).toBe(0)
    welcome.replay()
    welcome.notify('mention')
    welcome.notify('drop')
    welcome.notify('usage')
    expect(welcomeActionTimes.mentionAt).toBeGreaterThan(0)
    expect(welcomeActionTimes.dropAt).toBeGreaterThan(0)
    expect(welcomeActionTimes.usageAt).toBeGreaterThan(0)
  })

  it('keeps its "first install" answer, so a reload or another window does not ask again', async () => {
    const { useWelcomeTour } = await load()
    const welcome = useWelcomeTour()
    welcome.markFirstRun()
    expect(welcome.eligible()).toBe(false)
    welcome.markEligible()
    expect(welcome.eligible()).toBe(true)
    expect(useWelcomeTour().eligible()).toBe(true)
    // A new first run asks again.
    welcome.markFirstRun()
    expect(welcome.eligible()).toBe(false)
  })
})
