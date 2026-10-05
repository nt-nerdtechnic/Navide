// @vitest-environment happy-dom
// The single release-tour state every announcement surface starts through.
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
  return import('../useReleaseTour')
}

beforeEach(() => store.clear())

describe('useReleaseTour', () => {
  it('starts the tour a version’s announcement carries', async () => {
    const { useReleaseTour, hasReleaseTour } = await load()
    const tour = useReleaseTour()
    expect(hasReleaseTour('0.2.10')).toBe(true)
    expect(tour.start('0.2.10')).toBe(true)
    expect(tour.activeVersion.value).toBe('0.2.10')
    expect(tour.steps.value?.map((s) => s.id)[0]).toBe('welcome')
    expect(tour.steps.value).toHaveLength(6)
  })

  it('starts nothing for a version without a tour, or with no announcement', async () => {
    const { useReleaseTour, hasReleaseTour } = await load()
    const tour = useReleaseTour()
    expect(hasReleaseTour('0.2.9')).toBe(false)
    expect(tour.start('0.2.9')).toBe(false)
    expect(tour.start('9.9.9')).toBe(false)
    expect(tour.activeVersion.value).toBeNull()
    expect(tour.steps.value).toBeNull()
  })

  it('records done only when the tour reached its end, under the 0.2.10 key', async () => {
    const { useReleaseTour } = await load()
    const tour = useReleaseTour()
    tour.start('0.2.10')
    tour.end(false)
    expect(tour.activeVersion.value).toBeNull()
    expect(tour.isDone('0.2.10')).toBe(false)
    expect(store.size).toBe(0)

    tour.start('0.2.10')
    tour.end(true)
    expect(store.get('agentTeam.tour.v0.2.10.done')).toBe(true)
    expect(tour.isDone('0.2.10')).toBe(true)
  })

  it('is one tour for every caller', async () => {
    const { useReleaseTour } = await load()
    const popup = useReleaseTour()
    const centre = useReleaseTour()
    centre.start('0.2.10')
    expect(popup.activeVersion.value).toBe('0.2.10')
    popup.end(true)
    expect(centre.activeVersion.value).toBeNull()
    expect(centre.isDone('0.2.10')).toBe(true)
  })
  it('runs a named tour through the same state, handing its end to the caller', async () => {
    const { useReleaseTour } = await load()
    const tour = useReleaseTour()
    const ends: boolean[] = []
    const steps = [{ id: 'a', titleKey: 't', bodyKey: 'b' }]
    expect(tour.startNamed('welcome-main', steps, (completed) => ends.push(completed))).toBe(true)
    expect(tour.activeVersion.value).toBe('welcome-main')
    expect(tour.steps.value).toEqual(steps)
    // One tour at a time: a release tour cannot start over it, nor a second named one.
    expect(tour.start('0.2.10')).toBe(false)
    expect(tour.startNamed('other', steps)).toBe(false)
    tour.end(false)
    expect(ends).toEqual([false])
    expect(tour.activeVersion.value).toBeNull()
    expect(tour.steps.value).toBeNull()
    // A named tour never writes a release's done record.
    expect(store.size).toBe(0)
  })

  it('keeps Skip on the last step only for a named tour that asks for it', async () => {
    const { useReleaseTour } = await load()
    const tour = useReleaseTour()
    const steps = [{ id: 'a', titleKey: 't', bodyKey: 'b' }]
    tour.start('0.2.10')
    expect(tour.skipOnLast.value).toBe(false)
    tour.end(false)
    tour.startNamed('plain', steps)
    expect(tour.skipOnLast.value).toBe(false)
    tour.end(false)
    tour.startNamed('part', steps, undefined, { skipOnLast: true })
    expect(tour.skipOnLast.value).toBe(true)
    tour.end(false)
    expect(tour.skipOnLast.value).toBe(false)
  })

  it('runs a named tour interactively only when asked, and a release tour never', async () => {
    const { useReleaseTour } = await load()
    const tour = useReleaseTour()
    const steps = [{ id: 'a', titleKey: 't', bodyKey: 'b' }]
    tour.start('0.2.10')
    expect(tour.interactive.value).toBe(false)
    tour.end(false)
    tour.startNamed('part', steps, undefined, { interactive: true })
    expect(tour.interactive.value).toBe(true)
    tour.end(false)
    expect(tour.interactive.value).toBe(false)
  })
})
