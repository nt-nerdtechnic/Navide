// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  PANE_TOUR_RUNNING_FALLBACK_MS,
  PANE_TOUR_TYPING_QUIET_MS,
  WELCOME_MAIN_STEPS,
  WELCOME_PANE_STEPS,
  WELCOME_REPLAY_STEPS,
  paneTourReady,
  welcomeStage,
  type WelcomePaneProbe,
} from '../welcomeTour'

const LOCALES = ['en-US', 'zh-TW', 'ja-JP'].map((code) => ({
  code,
  messages: JSON.parse(
    readFileSync(
      resolve(process.cwd(), `packages/plugin-ui/src/foundation/i18n/locales/${code}.json`),
      'utf8',
    ),
  ) as Record<string, unknown>,
}))

function lookup(messages: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    messages,
  )
}

const source = (rel: string): string => readFileSync(resolve(process.cwd(), rel), 'utf8')

describe('welcome tour steps', () => {
  it('is three steps on the main screen, then five on the first pane', () => {
    expect(WELCOME_MAIN_STEPS.map((s) => s.id)).toEqual(['open-agent', 'sidebar-views', 'settings'])
    expect(WELCOME_PANE_STEPS.map((s) => s.id)).toEqual(['pane-name', 'typing', 'usage', 'groups', 'more'])
  })

  it('replays both parts in order, as one tour', () => {
    expect(WELCOME_REPLAY_STEPS.map((s) => s.id)).toEqual([
      ...WELCOME_MAIN_STEPS.map((s) => s.id),
      ...WELCOME_PANE_STEPS.map((s) => s.id),
    ])
  })

  it('never opens or closes anything on its own', () => {
    for (const step of WELCOME_REPLAY_STEPS) expect(step.prepare, step.id).toBeUndefined()
  })

  it('keeps its text under tour.welcome, in every locale', () => {
    for (const step of WELCOME_REPLAY_STEPS) {
      const keys = [step.titleKey, step.bodyKey, ...(step.missingKey ? [step.missingKey] : [])]
      for (const key of keys) {
        expect(key.startsWith('tour.welcome.'), key).toBe(true)
        for (const { code, messages } of LOCALES) {
          const value = lookup(messages, key)
          expect(typeof value, `${code} ${key}`).toBe('string')
          expect((value as string).trim(), `${code} ${key}`).not.toBe('')
        }
      }
    }
  })

  it('says where to look whenever a step points at something', () => {
    for (const step of WELCOME_REPLAY_STEPS) {
      if (step.anchor) expect(step.missingKey, step.id).toBeTruthy()
    }
  })

  it('writes no macOS-only shortcut: ⌘ is the Win/Super key off macOS', () => {
    for (const step of WELCOME_REPLAY_STEPS) {
      for (const { code, messages } of LOCALES) {
        for (const key of [step.titleKey, step.bodyKey, step.missingKey].filter(Boolean) as string[]) {
          expect(lookup(messages, key) as string, `${code} ${key}`).not.toMatch(/[⌘⇧⌥]/)
        }
      }
    }
  })

  // An anchor the markup no longer carries degrades to a centred card without
  // any error, so a moved attribute would go unnoticed. Pin each one to the
  // file that renders it.
  it('points only at data-tour anchors the components actually render', () => {
    const where: Record<string, string> = {
      'open-agent': 'src/renderer/src/components/ControlPane.vue',
      'sidebar-views': 'src/renderer/src/components/ControlPane.vue',
      settings: 'src/renderer/src/App.vue',
      'pane-title': 'src/renderer/src/components/TerminalPane.vue',
      'usage-badge': 'src/renderer/src/components/TerminalPane.vue',
      'stage-tabs': 'src/renderer/src/App.vue',
    }
    const used = new Set<string>()
    for (const step of WELCOME_REPLAY_STEPS) {
      for (const [, name] of (step.anchor ?? '').matchAll(/\[data-tour="([^"]+)"\]/g)) used.add(name)
    }
    expect([...used].sort()).toEqual(Object.keys(where).sort())
    for (const name of used) expect(source(where[name]), name).toContain(`data-tour="${name}"`)
    for (const step of WELCOME_REPLAY_STEPS) {
      if (step.anchor) expect(() => document.querySelectorAll(step.anchor!), step.id).not.toThrow()
    }
  })
})

describe('welcomeStage', () => {
  it('is off unless a first run left the tour pending', () => {
    expect(welcomeStage({ pending: false, mainDone: false })).toBe('off')
    expect(welcomeStage({ pending: false, mainDone: true })).toBe('off')
  })

  it('shows the main screen first, then the first pane', () => {
    expect(welcomeStage({ pending: true, mainDone: false })).toBe('main')
    expect(welcomeStage({ pending: true, mainDone: true })).toBe('pane')
  })
})

describe('paneTourReady', () => {
  const idle: WelcomePaneProbe = {
    agentKey: 'claude',
    realized: true,
    loginPane: false,
    status: 'idle',
    hasDraft: false,
    msSinceLastKey: Infinity,
    msSinceSeen: 15_000,
  }

  it('takes an agent pane that has come to rest', () => {
    expect(paneTourReady(idle)).toBe(true)
  })

  it('skips plain terminals, restore placeholders and throwaway login panes', () => {
    expect(paneTourReady({ ...idle, agentKey: 'terminal' })).toBe(false)
    expect(paneTourReady({ ...idle, realized: false })).toBe(false)
    expect(paneTourReady({ ...idle, loginPane: true })).toBe(false)
  })

  it('waits while the person is typing into it', () => {
    expect(paneTourReady({ ...idle, hasDraft: true })).toBe(false)
    expect(paneTourReady({ ...idle, msSinceLastKey: PANE_TOUR_TYPING_QUIET_MS - 1 })).toBe(false)
    expect(paneTourReady({ ...idle, msSinceLastKey: PANE_TOUR_TYPING_QUIET_MS })).toBe(true)
  })

  it('never interrupts a pane that is booting, parked on the user, or gone', () => {
    for (const status of ['starting', 'awaiting', 'exited', 'error', 'stopped', undefined]) {
      expect(paneTourReady({ ...idle, status, msSinceSeen: 10 * 60_000 }), String(status)).toBe(false)
    }
  })

  it('falls back to a pane that has stayed busy for a long time, so a CLI that never rests still gets the tour', () => {
    expect(paneTourReady({ ...idle, status: 'running', msSinceSeen: PANE_TOUR_RUNNING_FALLBACK_MS - 1 })).toBe(false)
    expect(paneTourReady({ ...idle, status: 'running', msSinceSeen: PANE_TOUR_RUNNING_FALLBACK_MS })).toBe(true)
  })
})
