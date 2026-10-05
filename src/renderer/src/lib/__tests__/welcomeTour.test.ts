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
  WELCOME_START_STEPS,
  paneTourReady,
  welcomeActionAlreadyDone,
  welcomeActionDone,
  welcomeStage,
  type WelcomeFacts,
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

function leafKeys(node: unknown, prefix: string): string[] {
  if (!node || typeof node !== 'object') return [prefix]
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => leafKeys(v, `${prefix}.${k}`))
}

const source = (rel: string): string => readFileSync(resolve(process.cwd(), rel), 'utf8')

function keysOf(step: (typeof WELCOME_REPLAY_STEPS)[number]): string[] {
  return [step.titleKey, step.bodyKey, step.missingKey, step.primaryKey].filter(Boolean) as string[]
}

describe('welcome tour steps', () => {
  // One path: pick a workspace → open the first agent → give it a first
  // instruction. A card off that path does not get its own step.
  it('is two cards on Welcome, one on the main screen, six on the first pane', () => {
    expect(WELCOME_START_STEPS.map((s) => s.id)).toEqual(['why-folder', 'pick-folder'])
    expect(WELCOME_MAIN_STEPS.map((s) => s.id)).toEqual(['open-agent'])
    expect(WELCOME_PANE_STEPS.map((s) => s.id)).toEqual(['first-command', 'open-second', 'talk-mention', 'talk-drag', 'usage-account', 'more'])
  })

  it('replays all three parts in order, as one tour', () => {
    expect(WELCOME_REPLAY_STEPS.map((s) => s.id)).toEqual([
      ...WELCOME_START_STEPS.map((s) => s.id),
      ...WELCOME_MAIN_STEPS.map((s) => s.id),
      ...WELCOME_PANE_STEPS.map((s) => s.id),
    ])
  })

  it('ends each of the first two parts on a button named for the action that comes next', () => {
    expect(WELCOME_START_STEPS.at(-1)!.primaryKey).toBe('tour.welcome.pickFolder.go')
    expect(WELCOME_MAIN_STEPS.at(-1)!.primaryKey).toBe('tour.welcome.openAgent.go')
    expect(WELCOME_PANE_STEPS.at(-1)!.primaryKey).toBeUndefined()
  })

  it('never opens or closes anything on its own', () => {
    for (const step of WELCOME_REPLAY_STEPS) expect(step.prepare, step.id).toBeUndefined()
  })

  it('keeps its text under tour.welcome, in every locale', () => {
    for (const step of WELCOME_REPLAY_STEPS) {
      for (const key of keysOf(step)) {
        expect(key.startsWith('tour.welcome.'), key).toBe(true)
        for (const { code, messages } of LOCALES) {
          const value = lookup(messages, key)
          expect(typeof value, `${code} ${key}`).toBe('string')
          expect((value as string).trim(), `${code} ${key}`).not.toBe('')
        }
      }
    }
  })

  it('has the same tour.welcome keys in every locale, and none left over', () => {
    const used = new Set(WELCOME_REPLAY_STEPS.flatMap(keysOf))
    for (const { code, messages } of LOCALES) {
      const keys = leafKeys(lookup(messages, 'tour.welcome'), 'tour.welcome').sort()
      expect(keys, code).toEqual([...used].sort())
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
        for (const key of keysOf(step)) {
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
      'welcome-open': 'src/renderer/src/components/Welcome.vue',
      'welcome-open-buttons': 'src/renderer/src/components/Welcome.vue',
      'open-agent': 'src/renderer/src/components/ControlPane.vue',
      'pane-stage': 'src/renderer/src/App.vue',
      'usage-badge': 'src/renderer/src/components/TerminalPane.vue',
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

  it('leaves no data-tour anchor behind that no step points at', () => {
    const files = [
      'src/renderer/src/App.vue',
      'src/renderer/src/components/ControlPane.vue',
      'src/renderer/src/components/TerminalPane.vue',
      'src/renderer/src/components/Welcome.vue',
    ]
    const used = new Set(
      WELCOME_REPLAY_STEPS.flatMap((s) => [...(s.anchor ?? '').matchAll(/\[data-tour="([^"]+)"\]/g)].map((m) => m[1])),
    )
    for (const file of files) {
      for (const [, name] of source(file).matchAll(/data-tour="([^"]+)"/g)) {
        expect(used.has(name), `${file}: data-tour="${name}"`).toBe(true)
      }
    }
  })
})

describe('welcomeStage', () => {
  it('is off unless a first run left the tour pending', () => {
    expect(welcomeStage({ pending: false, startDone: false, mainDone: false })).toBe('off')
    expect(welcomeStage({ pending: false, startDone: true, mainDone: true })).toBe('off')
  })

  it('goes Welcome, then the main screen, then the first pane', () => {
    expect(welcomeStage({ pending: true, startDone: false, mainDone: false })).toBe('start')
    expect(welcomeStage({ pending: true, startDone: true, mainDone: false })).toBe('main')
    expect(welcomeStage({ pending: true, startDone: true, mainDone: true })).toBe('pane')
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

describe('interactive cards', () => {
  it('waits for an action on every card but the concept card and the last one', () => {
    const waits = Object.fromEntries(WELCOME_REPLAY_STEPS.map((s) => [s.id, s.waitFor ?? null]))
    expect(waits).toEqual({
      'why-folder': null,
      'pick-folder': 'workspace-open',
      'open-agent': 'agent-pane',
      'first-command': 'first-command',
      'open-second': 'second-pane',
      'talk-mention': 'mention',
      'talk-drag': 'drop',
      'usage-account': 'usage',
      more: null,
    })
  })

  it('passes over the quota card when this CLI shows no quota badge', () => {
    expect(WELCOME_REPLAY_STEPS.find((s) => s.id === 'usage-account')!.skipIfMissing).toBe(true)
    expect(WELCOME_REPLAY_STEPS.filter((s) => s.skipIfMissing).map((s) => s.id)).toEqual(['usage-account'])
  })
})

describe('welcomeActionDone / welcomeActionAlreadyDone', () => {
  const none: WelcomeFacts = {
    workspaceOpen: false,
    agentPanes: 0,
    commandAt: 0,
    everCommanded: false,
    mentionAt: 0,
    dropAt: 0,
    usageAt: 0,
  }
  const since = 1_000

  it('a workspace being open is both done and already done', () => {
    expect(welcomeActionDone('workspace-open', { ...none, workspaceOpen: true }, since)).toBe(true)
    expect(welcomeActionAlreadyDone('workspace-open', { ...none, workspaceOpen: true })).toBe(true)
    expect(welcomeActionDone('workspace-open', none, since)).toBe(false)
  })

  it('counts agent panes for the first and the second pane', () => {
    expect(welcomeActionDone('agent-pane', { ...none, agentPanes: 1 }, since)).toBe(true)
    expect(welcomeActionDone('second-pane', { ...none, agentPanes: 1 }, since)).toBe(false)
    expect(welcomeActionDone('second-pane', { ...none, agentPanes: 2 }, since)).toBe(true)
    expect(welcomeActionAlreadyDone('second-pane', { ...none, agentPanes: 2 })).toBe(true)
  })

  it('takes a first command only once it was typed after the card came up', () => {
    expect(welcomeActionDone('first-command', { ...none, commandAt: since - 1 }, since)).toBe(false)
    expect(welcomeActionDone('first-command', { ...none, commandAt: since + 1 }, since)).toBe(true)
    expect(welcomeActionAlreadyDone('first-command', { ...none, everCommanded: true })).toBe(true)
  })

  it('takes @, a drop and the quota badge only when they happen while the card is up', () => {
    for (const [action, field] of [['mention', 'mentionAt'], ['drop', 'dropAt'], ['usage', 'usageAt']] as const) {
      expect(welcomeActionDone(action, { ...none, [field]: since - 1 }, since), action).toBe(false)
      expect(welcomeActionDone(action, { ...none, [field]: since + 1 }, since), action).toBe(true)
      // Everyone should try these once: never passed over as already done.
      expect(welcomeActionAlreadyDone(action, { ...none, [field]: since + 1 }), action).toBe(false)
    }
  })

  it('knows nothing of an action it does not name', () => {
    expect(welcomeActionDone('nope', { ...none, workspaceOpen: true }, since)).toBe(false)
    expect(welcomeActionAlreadyDone('nope', { ...none, workspaceOpen: true })).toBe(false)
  })
})

describe('the drag card', () => {
  // A drag starts on one pane's title bar and ends on another pane's terminal:
  // with only one pane spotlit, both ends would sit outside the hole, where an
  // action card's blockers take the click.
  it('spotlights the whole pane stage for the drag card, so both panes take the drag', () => {
    expect(WELCOME_REPLAY_STEPS.find((s) => s.id === 'talk-drag')!.anchor).toBe('[data-tour="pane-stage"]')
  })
})
