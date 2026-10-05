// @vitest-environment happy-dom
// The guided tour walks data-driven steps over the live window. Rendered via
// <Teleport to="body">, so every query goes to document.body.
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18n } from '@navide/plugin-ui/foundation'

import GuidedTour from '../GuidedTour.vue'
import { TOUR_DONE_ADVANCE_MS, TOUR_STUCK_HINT_MS, type TourPrepare, type TourStep } from '../../lib/tours'
import { whatsNewFor } from '../../lib/whatsNew'

const STEPS: TourStep[] = [
  { id: 'one', titleKey: 'tour.v0_2_10.welcome.title', bodyKey: 'tour.v0_2_10.welcome.body' },
  {
    id: 'two',
    anchor: '#target',
    prepare: { kind: 'settings', tab: 'channels' },
    titleKey: 'tour.v0_2_10.channelsSettings.title',
    bodyKey: 'tour.v0_2_10.channelsSettings.body',
    missingKey: 'tour.v0_2_10.channelsSettings.missing',
  },
  { id: 'three', titleKey: 'tour.v0_2_10.done.title', bodyKey: 'tour.v0_2_10.done.body' },
]

let wrapper: ReturnType<typeof mount> | null = null

function start(steps: TourStep[], runPrepare?: (p: TourPrepare) => void | Promise<void>) {
  wrapper = mount(GuidedTour, {
    props: { steps, runPrepare, anchorTimeoutMs: 300 },
    global: { plugins: [i18n] },
  })
  return wrapper
}

const card = (): HTMLElement | null => document.body.querySelector<HTMLElement>('.tour-card')
const stepId = (): string | undefined => card()?.dataset.step
const click = (testid: string): void =>
  document.body.querySelector<HTMLElement>(`[data-testid="${testid}"]`)!.click()
function key(k: string, target: EventTarget = document.body): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })
  target.dispatchEvent(e)
  return e
}
/** Let a step finish its prepare and its anchor lookup. */
async function settle(): Promise<void> {
  await flushPromises()
  await vi.advanceTimersByTimeAsync(400)
  await flushPromises()
}

function addTarget(): HTMLElement {
  const el = document.createElement('div')
  el.id = 'target'
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    x: 100, y: 100, top: 100, left: 100, right: 300, bottom: 150, width: 200, height: 50,
    toJSON: () => ({}),
  } as DOMRect)
  document.body.append(el)
  return el
}

beforeEach(() => {
  vi.useFakeTimers()
  i18n.global.locale.value = 'en-US'
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.replaceChildren()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('GuidedTour', () => {
  it('starts at the first step with its progress, title and body', async () => {
    start(STEPS)
    await settle()
    expect(stepId()).toBe('one')
    expect(card()?.textContent).toContain('Step 1 of 3')
    expect(card()?.textContent).toContain(i18n.global.t('tour.v0_2_10.welcome.title'))
    expect(card()?.getAttribute('role')).toBe('dialog')
    // No Back on the first step.
    expect(document.body.querySelector('[data-testid="tour-back"]')).toBeNull()
  })

  it('moves forward and back with the buttons', async () => {
    addTarget()
    start(STEPS)
    await settle()
    click('tour-next')
    await settle()
    expect(stepId()).toBe('two')
    click('tour-back')
    await settle()
    expect(stepId()).toBe('one')
  })

  it('runs each step’s prepare before looking for its anchor', async () => {
    const calls: TourPrepare[] = []
    start(STEPS, (p) => {
      calls.push(p)
      addTarget() // the anchor only exists once Settings is open
    })
    await settle()
    expect(calls).toEqual([])
    click('tour-next')
    await settle()
    expect(calls).toEqual([{ kind: 'settings', tab: 'channels' }])
    expect(document.body.querySelector('[data-testid="tour-hole"]')).not.toBeNull()
    expect(document.body.querySelector('[data-testid="tour-missing"]')).toBeNull()
  })

  it('spotlights a found anchor and places the card beside it', async () => {
    addTarget()
    start(STEPS)
    await settle()
    click('tour-next')
    await settle()
    const hole = document.body.querySelector<HTMLElement>('[data-testid="tour-hole"]')!
    expect(hole.style.top).toBe('94px')
    expect(hole.style.width).toBe('212px')
    expect(card()?.classList.contains('centred')).toBe(false)
    expect(card()?.style.top).toBe('168px')
  })

  it('shows a missing anchor as a centred card with where-to-find-it text', async () => {
    start(STEPS)
    await settle()
    click('tour-next')
    await settle()
    expect(stepId()).toBe('two')
    expect(document.body.querySelector('[data-testid="tour-hole"]')).toBeNull()
    expect(card()?.classList.contains('centred')).toBe(true)
    expect(document.body.querySelector('[data-testid="tour-missing"]')?.textContent).toContain(
      i18n.global.t('tour.v0_2_10.channelsSettings.missing'),
    )
    // …and the tour carries on.
    click('tour-next')
    await settle()
    expect(stepId()).toBe('three')
  })

  it('does not wait for an anchor on a step with no prepare: a missing one shows at once', async () => {
    // No prepare means the window is already as the step expects it, so the
    // anchor is either there now or not at all — the 2s budget is for prepare.
    wrapper = mount(GuidedTour, {
      props: {
        steps: [
          { id: 'here', anchor: '#nowhere', titleKey: 'tour.next', bodyKey: 'tour.back', missingKey: 'tour.skip' },
        ],
        anchorTimeoutMs: 2000,
      },
      global: { plugins: [i18n] },
    })
    await flushPromises()
    await vi.advanceTimersByTimeAsync(100)
    await flushPromises()
    expect(stepId()).toBe('here')
    expect(card()?.classList.contains('centred')).toBe(true)
    expect(document.body.querySelector('[data-testid="tour-missing"]')).not.toBeNull()
  })

  it('still waits up to the budget for an anchor that a step’s prepare brings in', async () => {
    start(STEPS, () => {
      setTimeout(addTarget, 200) // Settings takes a moment to render its page
    })
    await settle()
    click('tour-next')
    await flushPromises()
    await vi.advanceTimersByTimeAsync(260)
    await flushPromises()
    expect(stepId()).toBe('two')
    expect(document.body.querySelector('[data-testid="tour-hole"]')).not.toBeNull()
    expect(document.body.querySelector('[data-testid="tour-missing"]')).toBeNull()
  })

  it('draws a prepare step’s card at once, centred, while its prepare runs', async () => {
    start(STEPS, () => new Promise<void>(() => {}))
    await settle()
    click('tour-next')
    await flushPromises()
    expect(stepId()).toBe('two')
    expect(card()?.classList.contains('centred')).toBe(true)
    // Not "missing" yet: the lookup has not finished.
    expect(document.body.querySelector('[data-testid="tour-missing"]')).toBeNull()
  })

  it('keeps the previous card on screen while the next step looks for its anchor', async () => {
    addTarget()
    start([
      { id: 'first', titleKey: 'tour.next', bodyKey: 'tour.back' },
      { id: 'second', anchor: '#target', titleKey: 'tour.back', bodyKey: 'tour.next', missingKey: 'tour.skip' },
    ])
    await settle()
    expect(stepId()).toBe('first')
    click('tour-next')
    await flushPromises()
    // Never an empty dimmed window between two cards.
    expect(card()).not.toBeNull()
    await vi.advanceTimersByTimeAsync(100)
    await flushPromises()
    expect(stepId()).toBe('second')
    expect(document.body.querySelector('[data-testid="tour-hole"]')).not.toBeNull()
  })

  it('keeps going when a step’s prepare throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    start(STEPS, () => {
      throw new Error('settings would not open')
    })
    await settle()
    click('tour-next')
    await settle()
    expect(stepId()).toBe('two')
    expect(document.body.querySelector('[data-testid="tour-missing"]')).not.toBeNull()
  })

  it('does not let a slow earlier lookup overwrite the current step', async () => {
    let release: () => void = () => {}
    const calls: TourPrepare[] = []
    start(STEPS, (p) => {
      calls.push(p)
      return new Promise<void>((r) => {
        release = r
      })
    })
    await settle()
    click('tour-next') // step two: prepare pending, card not drawn yet
    await flushPromises()
    key('ArrowLeft') // back to step one before it resolves
    await settle()
    addTarget()
    release()
    await settle()
    expect(stepId()).toBe('one')
    expect(document.body.querySelector('[data-testid="tour-hole"]')).toBeNull()
  })

  it('still shows the step when its prepare never settles', async () => {
    start(STEPS, () => new Promise<void>(() => {}))
    await settle()
    click('tour-next')
    await settle()
    await settle()
    expect(stepId()).toBe('two')
    expect(document.body.querySelector('[data-testid="tour-missing"]')).not.toBeNull()
  })

  it('emits close(true) from Done on the last step, and has no Skip there', async () => {
    const w = start(STEPS)
    await settle()
    click('tour-next')
    await settle()
    click('tour-next')
    await settle()
    expect(stepId()).toBe('three')
    expect(document.body.querySelector('[data-testid="tour-skip"]')).toBeNull()
    expect(document.body.querySelector('[data-testid="tour-next"]')?.textContent).toContain('Done')
    click('tour-next')
    expect(w.emitted('close')).toEqual([[true]])
  })

  it('keeps Skip on the last step when the tour is one part of a longer one', async () => {
    const w = mount(GuidedTour, {
      props: { steps: [STEPS[0]], skipOnLast: true, anchorTimeoutMs: 300 },
      global: { plugins: [i18n] },
    })
    wrapper = w
    await settle()
    expect(document.body.querySelector('[data-testid="tour-skip"]')).not.toBeNull()
    click('tour-skip')
    expect(w.emitted('close')).toEqual([[false]])
  })

  it('labels the primary button with the step’s own text when it has one', async () => {
    start([{ ...STEPS[0], primaryKey: 'tour.next' }, { ...STEPS[2], primaryKey: 'tour.back' }])
    await settle()
    expect(document.body.querySelector('[data-testid="tour-next"]')?.textContent?.trim()).toBe('Next')
    click('tour-next')
    await settle()
    // The last step's own label replaces Done.
    expect(document.body.querySelector('[data-testid="tour-next"]')?.textContent?.trim()).toBe('Back')
  })

  it('emits close(false) from Skip', async () => {
    const w = start(STEPS)
    await settle()
    click('tour-skip')
    expect(w.emitted('close')).toEqual([[false]])
  })

  it('handles →, ← and Esc, and keeps them from reaching the window beneath', async () => {
    const beneath = vi.fn()
    window.addEventListener('keydown', beneath)
    const w = start(STEPS)
    await settle()
    key('ArrowRight')
    await settle()
    expect(stepId()).toBe('two')
    key('ArrowLeft')
    await settle()
    expect(stepId()).toBe('one')
    const esc = key('Escape')
    expect(esc.defaultPrevented).toBe(true)
    expect(w.emitted('close')).toEqual([[false]])
    expect(beneath).not.toHaveBeenCalled()
    window.removeEventListener('keydown', beneath)
  })

  it('swallows typing aimed at the dimmed window', async () => {
    start(STEPS)
    await settle()
    expect(key('a').defaultPrevented).toBe(true)
    // …but not app shortcuts such as ⌘Q.
    const quit = new KeyboardEvent('keydown', { key: 'q', metaKey: true, bubbles: true, cancelable: true })
    document.body.dispatchEvent(quit)
    expect(quit.defaultPrevented).toBe(false)
  })

  it('moves focus to the primary button and keeps Tab inside the card', async () => {
    start(STEPS)
    await settle()
    const next = document.body.querySelector<HTMLElement>('[data-testid="tour-next"]')!
    expect(document.activeElement).toBe(next)
    key('Tab', next)
    expect(document.activeElement).toBe(document.body.querySelector('[data-testid="tour-skip"]'))
    key('Tab', document.activeElement!)
    expect(document.activeElement).toBe(next)
  })

  it('gives focus back to where it was once the tour unmounts', async () => {
    const before = document.createElement('button')
    document.body.append(before)
    before.focus()
    const w = start(STEPS)
    await settle()
    expect(document.activeElement).toBe(document.body.querySelector('[data-testid="tour-next"]'))
    w.unmount()
    wrapper = null
    expect(document.activeElement).toBe(before)
  })

  it('leaves focus alone on unmount when the element focused before is gone', async () => {
    const before = document.createElement('button')
    document.body.append(before)
    before.focus()
    const w = start(STEPS)
    await settle()
    before.remove()
    const focus = vi.spyOn(before, 'focus')
    w.unmount()
    wrapper = null
    expect(focus).not.toHaveBeenCalled()
  })

  it('walks the real 0.2.10 tour to the end with no anchors present', async () => {
    const steps = whatsNewFor('0.2.10')!.tour!
    const prepares: TourPrepare[] = []
    const w = start(steps, (p) => {
      prepares.push(p)
    })
    const seen: string[] = []
    for (let i = 0; i < steps.length; i++) {
      await settle()
      seen.push(stepId()!)
      click('tour-next')
    }
    expect(seen).toEqual(steps.map((s) => s.id))
    expect(prepares.map((p) => (p.kind === 'settings' ? p.tab : p.kind))).toEqual([
      'close-settings',
      'channels',
      'close-settings',
      'voice',
      'close-settings',
    ])
    expect(w.emitted('close')).toEqual([[true]])
  })
})

// Interactive mode: the first-run tour waits for the person to do what a card
// asks. Release tours never pass `interactive`, so none of this reaches them.
describe('GuidedTour, interactive', () => {
  const ACTION: TourStep = {
    id: 'act',
    waitFor: 'thing',
    titleKey: 'tour.next',
    bodyKey: 'tour.back',
    missingKey: 'tour.skip',
  }
  const CONCEPT: TourStep = { id: 'concept', titleKey: 'tour.next', bodyKey: 'tour.back' }
  const LAST: TourStep = { id: 'last', titleKey: 'tour.done', bodyKey: 'tour.back' }

  function startInteractive(
    steps: TourStep[],
    opts: { done?: () => boolean; skip?: (s: TourStep) => boolean; suspended?: boolean } = {},
  ) {
    const done = opts.done ?? (() => false)
    wrapper = mount(GuidedTour, {
      props: {
        steps,
        interactive: true,
        isComplete: () => done(),
        shouldSkip: opts.skip ?? (() => false),
        suspended: opts.suspended ?? false,
        anchorTimeoutMs: 300,
      },
      global: { plugins: [i18n] },
    })
    return wrapper
  }

  it('shows an action card waiting for the person, with no Next, and a per-step skip', async () => {
    startInteractive([ACTION, LAST])
    await settle()
    expect(stepId()).toBe('act')
    expect(document.body.querySelector('[data-testid="tour-next"]')).toBeNull()
    expect(document.body.querySelector('[data-testid="tour-waiting"]')).not.toBeNull()
    expect(document.body.querySelector('[data-testid="tour-skip-step"]')).not.toBeNull()
    click('tour-skip-step')
    await settle()
    expect(stepId()).toBe('last')
  })

  it('says it is done once the action happens, then moves on by itself', async () => {
    const { ref } = await import('vue')
    const happened = ref(false)
    startInteractive([ACTION, LAST], { done: () => happened.value })
    await settle()
    happened.value = true
    await flushPromises()
    expect(document.body.querySelector('[data-testid="tour-done-feedback"]')).not.toBeNull()
    expect(stepId()).toBe('act')
    await vi.advanceTimersByTimeAsync(TOUR_DONE_ADVANCE_MS)
    await settle()
    expect(stepId()).toBe('last')
  })

  it('ends the tour as completed when the last card’s action happens', async () => {
    const { ref } = await import('vue')
    const happened = ref(false)
    const w = startInteractive([ACTION], { done: () => happened.value })
    await settle()
    happened.value = true
    await flushPromises()
    await vi.advanceTimersByTimeAsync(TOUR_DONE_ADVANCE_MS)
    expect(w.emitted('close')).toEqual([[true]])
  })

  it('lets clicks and keys reach the window on an action card', async () => {
    startInteractive([ACTION, LAST])
    await settle()
    expect(document.body.querySelector('.tour')?.classList.contains('tour--pass')).toBe(true)
    expect(key('a').defaultPrevented).toBe(false)
    expect(key('Enter').defaultPrevented).toBe(false)
    expect(key('Escape').defaultPrevented).toBe(false)
    expect(stepId()).toBe('act')
  })

  it('keeps a concept card and the last card as they are: dimmed, keys held by the tour', async () => {
    startInteractive([CONCEPT, LAST])
    await settle()
    expect(document.body.querySelector('.tour')?.classList.contains('tour--pass')).toBe(false)
    expect(key('a').defaultPrevented).toBe(true)
    expect(document.body.querySelector('[data-testid="tour-next"]')).not.toBeNull()
    key('ArrowRight')
    await settle()
    expect(stepId()).toBe('last')
    expect(key('a').defaultPrevented).toBe(true)
  })

  it('passes over a card whose action is already done', async () => {
    startInteractive([CONCEPT, ACTION, LAST], { skip: (s) => s.id === 'act' })
    await settle()
    click('tour-next')
    await settle()
    expect(stepId()).toBe('last')
    // Back from there passes over it too, instead of bouncing forward again.
    click('tour-back')
    await settle()
    expect(stepId()).toBe('concept')
  })

  it('ends the tour as completed when its remaining cards are all done already', async () => {
    const w = startInteractive([ACTION], { skip: () => true })
    await settle()
    expect(w.emitted('close')).toEqual([[true]])
  })

  it('passes over an action card that asks to, when what it points at is not there', async () => {
    startInteractive([{ ...ACTION, anchor: '#nowhere', skipIfMissing: true }, LAST])
    await settle()
    expect(stepId()).toBe('last')
  })

  it('points out where to look once a card has waited a long time', async () => {
    startInteractive([ACTION, LAST])
    await settle()
    expect(document.body.querySelector('[data-testid="tour-stuck"]')).toBeNull()
    await vi.advanceTimersByTimeAsync(TOUR_STUCK_HINT_MS)
    await flushPromises()
    expect(document.body.querySelector('[data-testid="tour-stuck"]')?.textContent).toContain(
      i18n.global.t('tour.skip'),
    )
  })

  it('steps aside while something else is on screen, then comes back', async () => {
    const { ref } = await import('vue')
    const away = ref(true)
    wrapper = mount(GuidedTour, {
      props: { steps: [CONCEPT, LAST], interactive: true, suspended: true, anchorTimeoutMs: 300 },
      global: { plugins: [i18n] },
    })
    await settle()
    expect(card()).toBeNull()
    expect(key('a').defaultPrevented).toBe(false)
    away.value = false
    await wrapper.setProps({ suspended: false })
    await settle()
    expect(stepId()).toBe('concept')
  })

  it('ignores waitFor entirely when not interactive (a replay or a release tour)', async () => {
    start([ACTION, LAST])
    await settle()
    expect(document.body.querySelector('[data-testid="tour-next"]')).not.toBeNull()
    expect(document.body.querySelector('[data-testid="tour-waiting"]')).toBeNull()
    expect(key('a').defaultPrevented).toBe(true)
  })
})
