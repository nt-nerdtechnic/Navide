// @vitest-environment happy-dom
// The first-run welcome tour: who gets it, in which order, and what ending it
// records.
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
  const welcome = await import('../useWelcomeTour')
  const release = await import('../useReleaseTour')
  return { ...welcome, ...release }
}

beforeEach(() => store.clear())

describe('useWelcomeTour', () => {
  it('stays off for an install that never ran the first-run wizard (an upgrade)', async () => {
    const { useWelcomeTour, useReleaseTour } = await load()
    const welcome = useWelcomeTour()
    expect(welcome.stage()).toBe('off')
    expect(welcome.startWelcome()).toBe(false)
    expect(welcome.startMain()).toBe(false)
    expect(welcome.startPane()).toBe(false)
    expect(useReleaseTour().activeVersion.value).toBeNull()
  })

  it('runs Welcome, then the main screen, then the first pane, each only once the one before is done', async () => {
    const { useWelcomeTour, useReleaseTour } = await load()
    const welcome = useWelcomeTour()
    const tour = useReleaseTour()
    welcome.markFirstRun()
    expect(welcome.stage()).toBe('start')
    expect(welcome.startMain()).toBe(false)
    expect(welcome.startPane()).toBe(false)

    expect(welcome.startWelcome()).toBe(true)
    expect(tour.steps.value?.map((s) => s.id)).toEqual(['why-folder', 'pick-folder'])
    tour.end(true)
    expect(welcome.stage()).toBe('main')

    expect(welcome.startMain()).toBe(true)
    expect(tour.steps.value?.map((s) => s.id)).toEqual(['open-agent'])
    tour.end(true)
    expect(welcome.stage()).toBe('pane')

    expect(welcome.startPane()).toBe(true)
    expect(tour.steps.value?.map((s) => s.id)).toEqual(['first-command', 'more'])
    tour.end(true)
    expect(welcome.stage()).toBe('off')
  })

  it('offers Skip on the last card of the first two parts, not on the very last card', async () => {
    const { useWelcomeTour, useReleaseTour } = await load()
    const welcome = useWelcomeTour()
    const tour = useReleaseTour()
    welcome.markFirstRun()
    welcome.startWelcome()
    expect(tour.skipOnLast.value).toBe(true)
    tour.end(true)
    welcome.startMain()
    expect(tour.skipOnLast.value).toBe(true)
    tour.end(true)
    welcome.startPane()
    expect(tour.skipOnLast.value).toBe(false)
  })

  it('treats a skip on the very first card as seen, ending all three parts', async () => {
    const { useWelcomeTour, useReleaseTour } = await load()
    const welcome = useWelcomeTour()
    welcome.markFirstRun()
    welcome.startWelcome()
    useReleaseTour().end(false)
    expect(welcome.stage()).toBe('off')
    expect(welcome.startMain()).toBe(false)
    expect(welcome.startPane()).toBe(false)
  })

  it('treats a skip in a later part as seen too', async () => {
    const { useWelcomeTour, useReleaseTour } = await load()
    const welcome = useWelcomeTour()
    const tour = useReleaseTour()
    welcome.markFirstRun()
    welcome.startWelcome()
    tour.end(true)
    welcome.startMain()
    tour.end(false)
    expect(welcome.stage()).toBe('off')
  })

  it('moves past Welcome without showing it when a workspace is already open', async () => {
    const { useWelcomeTour, useReleaseTour } = await load()
    const welcome = useWelcomeTour()
    welcome.markFirstRun()
    welcome.passWelcome()
    expect(welcome.stage()).toBe('main')
    expect(useReleaseTour().activeVersion.value).toBeNull()
  })

  it('does not start over a tour that is already running', async () => {
    const { useWelcomeTour, useReleaseTour } = await load()
    const welcome = useWelcomeTour()
    const tour = useReleaseTour()
    welcome.markFirstRun()
    tour.start('0.2.10')
    expect(welcome.startWelcome()).toBe(false)
    expect(tour.activeVersion.value).toBe('0.2.10')
  })

  it('replays all three parts on request, recording nothing and leaving a pending tour pending', async () => {
    const { useWelcomeTour, useReleaseTour } = await load()
    const welcome = useWelcomeTour()
    const tour = useReleaseTour()
    expect(welcome.replay()).toBe(true)
    expect(tour.steps.value).toHaveLength(5)
    expect(tour.skipOnLast.value).toBe(false)
    tour.end(true)
    expect(store.size).toBe(0)

    welcome.markFirstRun()
    welcome.replay()
    tour.end(false)
    expect(welcome.stage()).toBe('start')
  })
})
