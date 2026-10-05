// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  WELCOME_STEPS,
  welcomeActionAlreadyDone,
  welcomeActionDone,
  type WelcomeFacts,
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

const none: WelcomeFacts = {
  workspaceOpen: false,
  agentPanes: 0,
  commandAt: 0,
  everCommanded: false,
  mentionAt: 0,
  dropAt: 0,
  usageAt: 0,
}

// The bubble-by-bubble path: pick a workspace → open an agent → give it a
// first instruction → have two agents work together → see the quota.
describe('welcome tour steps', () => {
  it('is six bubbles, each waiting for one action', () => {
    expect(WELCOME_STEPS.map((s) => [s.id, s.waitFor])).toEqual([
      ['pick-folder', 'workspace-open'],
      ['open-agent', 'agent-pane'],
      ['first-command', 'first-command'],
      ['talk-mention', 'mention'],
      ['talk-drag', 'drop'],
      ['usage-account', 'usage'],
    ])
  })

  it('passes over the quota bubble when this CLI shows no quota badge, and only that one', () => {
    expect(WELCOME_STEPS.filter((s) => s.skipIfMissing).map((s) => s.id)).toEqual(['usage-account'])
  })

  it('points the @ bubble at + until there is a second pane, then at the terminal', () => {
    const mention = WELCOME_STEPS.find((s) => s.id === 'talk-mention')!
    expect(mention.anchor({ ...none, agentPanes: 1 })).toBe('[data-tour="open-agent"]')
    expect(mention.anchor({ ...none, agentPanes: 2 })).toBe('.xterm-host[data-pane-id]')
  })

  it('spotlights the whole pane stage for the drag, where it starts and ends', () => {
    expect(WELCOME_STEPS.find((s) => s.id === 'talk-drag')!.anchor(none)).toBe('[data-tour="pane-stage"]')
  })

  it('keeps every line under tour.welcome, the same keys in every locale, none left over', () => {
    const used = [
      ...WELCOME_STEPS.map((s) => s.textKey),
      'tour.welcome.next',
      'tour.welcome.doneFeedback',
      'tour.welcome.finished',
    ].sort()
    for (const { code, messages } of LOCALES) {
      expect(leafKeys(lookup(messages, 'tour.welcome'), 'tour.welcome').sort(), code).toEqual(used)
      for (const key of used) {
        const value = lookup(messages, key)
        expect(typeof value, `${code} ${key}`).toBe('string')
        expect((value as string).trim(), `${code} ${key}`).not.toBe('')
        // ⌘ is the Win/Super key off macOS: never name it.
        expect(value as string, `${code} ${key}`).not.toMatch(/[⌘⇧⌥]/)
      }
    }
  })

  it('points only at data-tour anchors the components render, and leaves none behind', () => {
    const where: Record<string, string> = {
      'welcome-open-buttons': 'src/renderer/src/components/Welcome.vue',
      'open-agent': 'src/renderer/src/components/ControlPane.vue',
      'pane-stage': 'src/renderer/src/App.vue',
      'usage-badge': 'src/renderer/src/components/TerminalPane.vue',
    }
    const facts = [none, { ...none, agentPanes: 2 }]
    const used = new Set<string>()
    for (const step of WELCOME_STEPS) {
      for (const f of facts) {
        const selector = step.anchor(f)
        expect(() => document.querySelectorAll(selector), step.id).not.toThrow()
        for (const [, name] of selector.matchAll(/\[data-tour="([^"]+)"\]/g)) used.add(name)
      }
    }
    expect([...used].sort()).toEqual(Object.keys(where).sort())
    for (const name of used) expect(source(where[name]), name).toContain(`data-tour="${name}"`)
    for (const file of new Set(Object.values(where))) {
      for (const [, name] of source(file).matchAll(/data-tour="([^"]+)"/g)) {
        expect(used.has(name), `${file}: data-tour="${name}"`).toBe(true)
      }
    }
  })
})

describe('welcomeActionDone / welcomeActionAlreadyDone', () => {
  const since = 1_000

  it('a workspace being open is both done and already done', () => {
    expect(welcomeActionDone('workspace-open', { ...none, workspaceOpen: true }, since)).toBe(true)
    expect(welcomeActionAlreadyDone('workspace-open', { ...none, workspaceOpen: true })).toBe(true)
    expect(welcomeActionDone('workspace-open', none, since)).toBe(false)
  })

  it('counts an agent pane', () => {
    expect(welcomeActionDone('agent-pane', { ...none, agentPanes: 1 }, since)).toBe(true)
    expect(welcomeActionAlreadyDone('agent-pane', { ...none, agentPanes: 1 })).toBe(true)
  })

  it('takes a first command only once it was typed after the bubble came up', () => {
    expect(welcomeActionDone('first-command', { ...none, commandAt: since - 1 }, since)).toBe(false)
    expect(welcomeActionDone('first-command', { ...none, commandAt: since + 1 }, since)).toBe(true)
    expect(welcomeActionAlreadyDone('first-command', { ...none, everCommanded: true })).toBe(true)
  })

  it('takes @, a drop and the quota badge only when they happen while the bubble is up', () => {
    for (const [action, field] of [['mention', 'mentionAt'], ['drop', 'dropAt'], ['usage', 'usageAt']] as const) {
      expect(welcomeActionDone(action, { ...none, [field]: since - 1 }, since), action).toBe(false)
      expect(welcomeActionDone(action, { ...none, [field]: since + 1 }, since), action).toBe(true)
      // Everyone should try these once: never passed over as already done.
      expect(welcomeActionAlreadyDone(action, { ...none, [field]: since + 1 }), action).toBe(false)
    }
  })
})
