// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TOURS, findTourAnchor, tourDoneKey } from '../tours'

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

describe('TOURS', () => {
  it('has text in every locale for every step', () => {
    for (const [id, steps] of Object.entries(TOURS)) {
      for (const step of steps) {
        const keys = [step.titleKey, step.bodyKey, ...(step.missingKey ? [step.missingKey] : [])]
        for (const { code, messages } of LOCALES) {
          for (const key of keys) {
            expect(typeof lookup(messages, key), `${code} ${id}/${step.id} ${key}`).toBe('string')
          }
        }
      }
    }
  })

  it('gives every anchored step a fallback line for when its anchor is missing', () => {
    for (const steps of Object.values(TOURS)) {
      for (const step of steps) if (step.anchor) expect(step.missingKey, step.id).toBeTruthy()
    }
  })

  it('has unique step ids within a tour, and valid selectors', () => {
    for (const steps of Object.values(TOURS)) {
      expect(new Set(steps.map((s) => s.id)).size).toBe(steps.length)
      for (const step of steps) {
        if (step.anchor) expect(() => document.querySelectorAll(step.anchor!)).not.toThrow()
      }
    }
  })

  it('walks 0.2.10 through Channels then Voice Input, pointing at the real UI', () => {
    const steps = TOURS['v0.2.10']
    expect(steps.map((s) => s.id)).toEqual([
      'welcome',
      'channels-settings',
      'channels-pane',
      'voice-settings',
      'voice-dictate',
      'done',
    ])
    expect(steps[1].prepare).toEqual({ kind: 'settings', tab: 'channels' })
    expect(steps[1].anchor).toBe('[data-settings-section="channels"]')
    expect(steps[2].anchor).toContain('[data-testid="channel-connect"]')
    expect(steps[3].prepare).toEqual({ kind: 'settings', tab: 'voice' })
    expect(steps[3].anchor).toBe('[data-settings-section="voice"]')
    // Every step after a Settings step closes it again before pointing at the window.
    expect(steps[2].prepare).toEqual({ kind: 'close-settings' })
    expect(steps[4].prepare).toEqual({ kind: 'close-settings' })
  })

  it('keeps the tour-done flag in the agentTeam.* settings namespace', () => {
    expect(tourDoneKey('v0.2.10')).toBe('agentTeam.tour.v0.2.10.done')
  })
})

describe('findTourAnchor', () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })

  function sized(el: HTMLElement, w: number, h: number): HTMLElement {
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(
      { x: 0, y: 0, top: 0, left: 0, right: w, bottom: h, width: w, height: h, toJSON: () => ({}) } as DOMRect,
    )
    return el
  }

  it('returns null when nothing matches', () => {
    expect(findTourAnchor('[data-testid="channel-connect"]')).toBeNull()
  })

  it('returns null for a selector the browser rejects, instead of throwing', () => {
    expect(findTourAnchor('[[[')).toBeNull()
  })

  it('skips a match with no box (a v-show-hidden Settings page) for a laid-out one', () => {
    const hidden = sized(document.createElement('div'), 0, 0)
    const shown = sized(document.createElement('div'), 200, 100)
    hidden.dataset.settingsSection = 'voice'
    shown.dataset.settingsSection = 'voice'
    document.body.append(hidden, shown)
    expect(findTourAnchor('[data-settings-section="voice"]')).toBe(shown)
  })

  it('treats a match that is only hidden as missing', () => {
    const hidden = sized(document.createElement('div'), 0, 0)
    hidden.dataset.settingsSection = 'voice'
    document.body.append(hidden)
    expect(findTourAnchor('[data-settings-section="voice"]')).toBeNull()
  })
})
