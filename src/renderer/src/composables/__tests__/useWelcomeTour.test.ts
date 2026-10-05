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
    expect(welcome.startMain()).toBe(false)
    expect(welcome.startPane()).toBe(false)
    expect(useReleaseTour().activeVersion.value).toBeNull()
  })

  it('runs the main-screen part after a first run, then the pane part once it is done', async () => {
    const { useWelcomeTour, useReleaseTour } = await load()
    const welcome = useWelcomeTour()
    const tour = useReleaseTour()
    welcome.markFirstRun()
    expect(welcome.stage()).toBe('main')
    expect(welcome.startPane()).toBe(false)

    expect(welcome.startMain()).toBe(true)
    expect(tour.steps.value?.map((s) => s.id)).toEqual(['open-agent', 'sidebar-views', 'settings'])
    tour.end(true)
    expect(tour.activeVersion.value).toBeNull()
    expect(welcome.stage()).toBe('pane')

    expect(welcome.startPane()).toBe(true)
    expect(tour.steps.value?.[0].id).toBe('pane-name')
    tour.end(true)
    expect(welcome.stage()).toBe('off')
  })

  it('treats a skip as seen, and a skip in the first part ends the second too', async () => {
    const { useWelcomeTour, useReleaseTour } = await load()
    const welcome = useWelcomeTour()
    welcome.markFirstRun()
    welcome.startMain()
    useReleaseTour().end(false)
    expect(welcome.stage()).toBe('off')
    expect(welcome.startPane()).toBe(false)
  })

  it('treats a skip of the pane part as seen', async () => {
    const { useWelcomeTour, useReleaseTour } = await load()
    const welcome = useWelcomeTour()
    welcome.markFirstRun()
    welcome.startMain()
    useReleaseTour().end(true)
    welcome.startPane()
    useReleaseTour().end(false)
    expect(welcome.stage()).toBe('off')
  })

  it('does not start over a tour that is already running', async () => {
    const { useWelcomeTour, useReleaseTour } = await load()
    const welcome = useWelcomeTour()
    const tour = useReleaseTour()
    welcome.markFirstRun()
    tour.start('0.2.10')
    expect(welcome.startMain()).toBe(false)
    expect(tour.activeVersion.value).toBe('0.2.10')
  })

  it('replays both parts on request, recording nothing and leaving a pending tour pending', async () => {
    const { useWelcomeTour, useReleaseTour } = await load()
    const welcome = useWelcomeTour()
    const tour = useReleaseTour()
    expect(welcome.replay()).toBe(true)
    expect(tour.steps.value).toHaveLength(8)
    tour.end(true)
    expect(store.size).toBe(0)

    welcome.markFirstRun()
    welcome.replay()
    tour.end(false)
    expect(welcome.stage()).toBe('main')
  })
})
