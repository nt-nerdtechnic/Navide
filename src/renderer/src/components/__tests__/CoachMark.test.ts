// @vitest-environment happy-dom
// The first-run tour as coach marks: a bubble beside the real control, the
// whole window usable, the bubble moving on once the person has done it.
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

import { i18n } from '@navide/plugin-ui/foundation'

import CoachMark from '../CoachMark.vue'
import {
  COACH_ASIDE_MS,
  COACH_DONE_MS,
  COACH_MISSING_SKIP_MS,
  COACH_TICK_MS,
  type CoachStep,
  type WelcomeFacts,
} from '../../lib/welcomeTour'

const facts = reactive<WelcomeFacts>({
  workspaceOpen: false,
  agentPanes: 0,
  commandAt: 0,
  everCommanded: false,
  mentionAt: 0,
  dropAt: 0,
  usageAt: 0,
})

const STEPS: CoachStep[] = [
  { id: 'one', anchor: () => '#a', textKey: 'tour.next', waitFor: 'workspace-open' },
  { id: 'two', anchor: () => '#b', textKey: 'tour.back', waitFor: 'mention' },
]

let wrapper: ReturnType<typeof mount> | null = null

function start(opts: { steps?: CoachStep[]; replay?: boolean; suspended?: boolean; startIndex?: number } = {}) {
  wrapper = mount(CoachMark, {
    props: {
      steps: opts.steps ?? STEPS,
      facts: () => facts,
      startIndex: opts.startIndex ?? 0,
      replay: opts.replay ?? false,
      suspended: opts.suspended ?? false,
    },
    global: { plugins: [i18n] },
  })
  return wrapper
}

function addTarget(id: string): HTMLElement {
  const el = document.createElement('button')
  el.id = id
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    x: 100, y: 100, top: 100, left: 100, right: 160, bottom: 130, width: 60, height: 30,
    toJSON: () => ({}),
  } as DOMRect)
  document.body.append(el)
  return el
}

const bubble = (): HTMLElement | null => document.body.querySelector<HTMLElement>('[data-testid="coach-bubble"]')
const stepId = (): string | undefined => bubble()?.dataset.step
const byTestId = (id: string): HTMLElement | null => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`)
async function tick(ms = COACH_TICK_MS): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await flushPromises()
}
function key(k: string, target: EventTarget = document.body): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })
  target.dispatchEvent(e)
  return e
}

beforeEach(() => {
  vi.useFakeTimers()
  i18n.global.locale.value = 'en-US'
  Object.assign(facts, { workspaceOpen: false, agentPanes: 0, commandAt: 0, everCommanded: false, mentionAt: 0, dropAt: 0, usageAt: 0 })
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.replaceChildren()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('CoachMark', () => {
  it('shows a bubble beside the control, with the step count and Skip, and no Next or Back', async () => {
    addTarget('a')
    start()
    await tick()
    expect(stepId()).toBe('one')
    expect(bubble()?.textContent).toContain(i18n.global.t('tour.next'))
    expect(bubble()?.textContent).toContain(i18n.global.t('tour.progress', { n: 1, total: 2 }))
    expect(byTestId('coach-skip')).not.toBeNull()
    expect(byTestId('coach-next')).toBeNull()
    expect(byTestId('tour-back')).toBeNull()
  })

  it('never takes a click or a key from the window: the layer and the highlight let them through', async () => {
    addTarget('a')
    start()
    await tick()
    const layer = byTestId('coach-layer')!
    const ring = byTestId('coach-ring')!
    expect(layer.style.pointerEvents).toBe('none')
    expect(ring.style.pointerEvents).toBe('none')
    // Only the bubble itself is clickable.
    expect(bubble()!.style.pointerEvents).toBe('auto')
    for (const k of ['a', 'Enter', 'ArrowRight', 'Tab']) expect(key(k).defaultPrevented, k).toBe(false)
    expect(stepId()).toBe('one')
  })

  it('moves on by itself once the action is done, saying so first', async () => {
    addTarget('a')
    addTarget('b')
    const w = start()
    await tick()
    facts.workspaceOpen = true
    await flushPromises()
    expect(byTestId('coach-done')).not.toBeNull()
    expect(stepId()).toBe('one')
    await tick(COACH_DONE_MS)
    await tick()
    expect(stepId()).toBe('two')
    expect(w.emitted('progress')).toEqual([[1]])
  })

  // 22:41: "at the quota step it just left the tour". The quota step is the
  // last; resting the pointer on the badge — as the bubble asks, and on the
  // way to the bubble — completed it, and the tour closed 0.8s later while
  // the person was still reading the badge. The last step never closes by
  // itself: it says done and waits for Done.
  it('says the last action is done and waits for Done instead of closing by itself', async () => {
    addTarget('b')
    const w = start({ startIndex: 1 })
    await tick()
    facts.mentionAt = Date.now() + 1
    await flushPromises()
    await tick(COACH_DONE_MS * 3)
    expect(w.emitted('finish')).toBeUndefined()
    expect(stepId()).toBe('two')
    expect(byTestId('coach-done')).not.toBeNull()
    byTestId('coach-finish')!.click()
    expect(w.emitted('finish')).toEqual([[true]])
  })

  it('does the same on a replay', async () => {
    addTarget('b')
    const w = start({ replay: true, startIndex: 1 })
    await tick()
    facts.mentionAt = Date.now() + 1
    await flushPromises()
    await tick(COACH_DONE_MS * 3)
    expect(w.emitted('finish')).toBeUndefined()
    // The last step offers Done, not Next.
    expect(byTestId('coach-next')).toBeNull()
    byTestId('coach-finish')!.click()
    expect(w.emitted('finish')).toEqual([[true]])
  })

  it('walks a replay through all six steps, each one waiting, ending only at the last one’s Done', async () => {
    const { WELCOME_STEPS } = await import('../../lib/welcomeTour')
    // The window a replay usually meets: a workspace, two panes, a first turn done.
    Object.assign(facts, { workspaceOpen: true, agentPanes: 2, everCommanded: true })
    for (const sel of ['open-agent', 'pane-stage', 'usage-badge']) {
      const el = addTarget(sel)
      el.removeAttribute('id')
      el.setAttribute('data-tour', sel)
    }
    const host = addTarget('host')
    host.removeAttribute('id')
    host.className = 'xterm-host'
    host.setAttribute('data-pane-id', 'p1')
    const w = start({ steps: WELCOME_STEPS, replay: true })
    const seen: string[] = []
    for (let i = 0; i < WELCOME_STEPS.length; i++) {
      await tick(COACH_DONE_MS * 3)
      seen.push(stepId()!)
      expect(w.emitted('finish'), `ended at ${stepId()}`).toBeUndefined()
      if (i < WELCOME_STEPS.length - 1) byTestId('coach-next')!.click()
    }
    expect(seen).toEqual(WELCOME_STEPS.map((s) => s.id))
    // Resting on the quota badge at the last step does not end it either.
    facts.usageAt = Date.now() + 1
    await flushPromises()
    await tick(COACH_DONE_MS * 3)
    expect(w.emitted('finish')).toBeUndefined()
    byTestId('coach-finish')!.click()
    expect(w.emitted('finish')).toEqual([[true]])
  })

  it('passes over a step already done when it comes up', async () => {
    facts.workspaceOpen = true
    addTarget('b')
    const w = start()
    await tick()
    expect(stepId()).toBe('two')
    expect(w.emitted('progress')).toEqual([[1]])
  })

  it('ends as skipped from Skip', async () => {
    addTarget('a')
    const w = start()
    await tick()
    byTestId('coach-skip')!.click()
    expect(w.emitted('finish')).toEqual([[false]])
  })

  it('takes Esc as Skip, but not while the person is in a terminal, where Esc belongs to the CLI', async () => {
    addTarget('a')
    const term = document.createElement('div')
    term.className = 'xterm'
    const input = document.createElement('textarea')
    term.append(input)
    document.body.append(term)
    const w = start()
    await tick()
    input.focus()
    const inTerminal = key('Escape', input)
    expect(inTerminal.defaultPrevented).toBe(false)
    expect(w.emitted('finish')).toBeUndefined()
    input.blur()
    key('Escape')
    expect(w.emitted('finish')).toEqual([[false]])
  })

  it('offers Next on a replay, so it can be read through without doing anything', async () => {
    addTarget('a')
    addTarget('b')
    const w = start({ replay: true })
    await tick()
    byTestId('coach-next')!.click()
    await tick()
    expect(stepId()).toBe('two')
    expect(w.emitted('progress')).toEqual([[1]])
  })

  it('waits, without a bubble, while what a step points at is not on screen', async () => {
    start()
    await tick(COACH_MISSING_SKIP_MS * 2)
    expect(bubble()).toBeNull()
    addTarget('a')
    await tick()
    expect(stepId()).toBe('one')
  })

  it('passes over a step that asks to when what it points at stays away', async () => {
    addTarget('b')
    const w = start({ steps: [{ ...STEPS[0], skipIfMissing: true }, STEPS[1]] })
    await tick(COACH_MISSING_SKIP_MS - COACH_TICK_MS)
    expect(w.emitted('progress')).toBeUndefined()
    await tick(COACH_TICK_MS * 2)
    expect(stepId()).toBe('two')
  })

  it('follows a step whose target depends on the window', async () => {
    addTarget('a')
    addTarget('b')
    start({ steps: [{ id: 'moving', anchor: (f) => (f.agentPanes < 2 ? '#a' : '#b'), textKey: 'tour.next', waitFor: 'mention' }] })
    await tick()
    expect(byTestId('coach-ring')!.dataset.target).toBe('a')
    facts.agentPanes = 2
    await tick()
    expect(byTestId('coach-ring')!.dataset.target).toBe('b')
  })

  it('draws nothing and leaves keys alone while something else has the screen', async () => {
    addTarget('a')
    const w = start({ suspended: true })
    await tick()
    expect(byTestId('coach-layer')).toBeNull()
    key('Escape')
    expect(w.emitted('finish')).toBeUndefined()
  })

  // 22:01: "I called it up on purpose." A replay is asked for: every bubble
  // shows, in order, whatever the window already has.
  describe('replay', () => {
    it('shows a step already done instead of passing over it, and leaves it to Next', async () => {
      facts.workspaceOpen = true
      addTarget('a')
      addTarget('b')
      const w = start({ replay: true })
      await tick()
      expect(stepId()).toBe('one')
      await tick(COACH_DONE_MS * 2)
      expect(stepId()).toBe('one')
      expect(w.emitted('progress')).toBeUndefined()
      byTestId('coach-next')!.click()
      await tick()
      expect(stepId()).toBe('two')
    })

    it('still moves on by itself when a step before the last is done while it is up', async () => {
      addTarget('a')
      addTarget('b')
      const w = start({ replay: true, steps: [{ ...STEPS[1], id: 'first' }, STEPS[1]] })
      await tick()
      facts.mentionAt = Date.now() + 1
      await flushPromises()
      await tick(COACH_DONE_MS)
      await tick()
      expect(w.emitted('progress')).toEqual([[1]])
    })

    it('shows the bubble in the middle, with Next, when what it is about is not on screen', async () => {
      addTarget('b')
      start({ replay: true })
      await tick(COACH_MISSING_SKIP_MS * 2)
      expect(stepId()).toBe('one')
      expect(bubble()!.classList.contains('centred')).toBe(true)
      expect(byTestId('coach-ring')).toBeNull()
      byTestId('coach-next')!.click()
      await tick()
      expect(stepId()).toBe('two')
      expect(bubble()!.classList.contains('centred')).toBe(false)
    })
  })

  it('on a first run still passes over a step already done', async () => {
    facts.agentPanes = 1
    addTarget('a')
    const w = start({ steps: [{ id: 'pane', anchor: () => '#a', textKey: 'tour.next', waitFor: 'agent-pane' }, STEPS[1]] })
    await tick()
    expect(w.emitted('progress')).toEqual([[1]])
  })

  // 23:01: on Welcome no bubble showed at all. The bubbles sat at
  // z-modal − 1, under the Welcome overlay (z-modal + 110). They belong above
  // it and below Settings (z-modal + 120); real modals suspend the tour anyway.
  it('draws above the Welcome screen and below Settings', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const offset = (file: string, selector: string): number => {
      const css = readFileSync(resolve(process.cwd(), file), 'utf8')
      const block = css.slice(css.indexOf(`${selector} {`))
      const m = /z-index:\s*calc\(var\(--z-modal\)\s*([+-])\s*(\d+)\)/.exec(block.slice(0, block.indexOf('}')))
      expect(m, `${file} ${selector}`).not.toBeNull()
      return (m![1] === '-' ? -1 : 1) * Number(m![2])
    }
    const coach = offset('src/renderer/src/components/CoachMark.vue', '.coach')
    expect(coach).toBeGreaterThan(offset('src/renderer/src/components/Welcome.vue', '.welcome-overlay'))
    expect(coach).toBeLessThan(120)
  })

  // Pressing + opens the CLI menu right where the bubble sits (below +). Once
  // the person acts on the control, the bubble gets out of the way.
  it('steps the bubble aside while the person works the spotlit control, keeping the ring', async () => {
    const a = addTarget('a')
    addTarget('b')
    start()
    await tick()
    a.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 120, clientY: 110 }))
    await flushPromises()
    expect(bubble()).toBeNull()
    expect(byTestId('coach-ring')).not.toBeNull()
    // Back if nothing comes of it.
    await tick(COACH_ASIDE_MS)
    expect(stepId()).toBe('one')
  })

  it('comes back for the next step once the action is done', async () => {
    const a = addTarget('a')
    addTarget('b')
    start()
    await tick()
    a.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 120, clientY: 110 }))
    facts.workspaceOpen = true
    await flushPromises()
    await tick(COACH_DONE_MS)
    await tick()
    expect(stepId()).toBe('two')
  })

  it('stays put for a press elsewhere', async () => {
    addTarget('a')
    start()
    await tick()
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 600, clientY: 600 }))
    await flushPromises()
    expect(stepId()).toBe('one')
  })
})
