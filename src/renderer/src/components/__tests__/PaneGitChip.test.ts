// @vitest-environment happy-dom
// The git chip on a local pane's network row: `⎇ branch · N dirty · ↑a ↓b`,
// with "may be stale" once the last fetch is over an hour old.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'

import { i18n } from '@navide/plugin-ui/foundation'
import PaneGitChip, { STALE_AFTER_MS, type PaneGit } from '../PaneGitChip.vue'

const NOW = Date.parse('2026-09-24T12:00:00Z')

function git(overrides: Partial<PaneGit> = {}): PaneGit {
  return {
    branch: 'main',
    worktreeRoot: '/Users/me/Navide',
    isLinkedWorktree: false,
    dirty: 3,
    ahead: 2,
    behind: 1,
    fetchedAt: new Date(NOW - 5 * 60 * 1000).toISOString(),
    ...overrides,
  }
}

let wrapper: VueWrapper | undefined

/** The chip's segments as a reader sees them: the gap between them is CSS. */
function segments(w: VueWrapper): string {
  return w.findAll('.pane-git > span').map((span) => span.text()).join(' ')
}

function render(value: PaneGit, locale = 'en-US'): VueWrapper {
  i18n.global.locale.value = locale as typeof i18n.global.locale.value
  wrapper = mount(PaneGitChip, { props: { git: value, now: NOW }, global: { plugins: [i18n] } })
  return wrapper
}

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  i18n.global.locale.value = 'en-US' as typeof i18n.global.locale.value
})

describe('PaneGitChip', () => {
  it('shows branch, dirty count and drift against origin/main', () => {
    expect(segments(render(git()))).toBe('⎇ main · 3 dirty · ↑2 ↓1')
    expect(wrapper!.classes()).not.toContain('stale')
  })

  it('leaves out what it does not know or what is zero', () => {
    expect(segments(render(git({ dirty: 0, ahead: null, behind: null })))).toBe('⎇ main')
  })

  it('says "may be stale" once the last fetch is over an hour old', () => {
    render(git({ fetchedAt: new Date(NOW - STALE_AFTER_MS - 1000).toISOString() }))
    expect(wrapper!.classes()).toContain('stale')
    expect(wrapper!.text()).toContain('may be stale')
  })

  it('treats a never-fetched clone as stale', () => {
    render(git({ fetchedAt: null }))
    expect(wrapper!.text()).toContain('may be stale')
    expect(wrapper!.attributes('title')).toContain('Never fetched')
  })

  it('is not stale without drift to be stale about', () => {
    render(git({ ahead: null, behind: null, fetchedAt: null }))
    expect(wrapper!.text()).not.toContain('may be stale')
  })

  it('names a linked worktree and its root in the tooltip', () => {
    render(git({ isLinkedWorktree: true, worktreeRoot: '/Users/me/Navide-phase-a' }))
    const title = wrapper!.attributes('title') ?? ''
    expect(title).toContain('/Users/me/Navide-phase-a')
    expect(title).toContain('Linked worktree')
  })

  it('renders nothing outside a repository', () => {
    render(git({ worktreeRoot: null }))
    expect(wrapper!.find('.pane-git').exists()).toBe(false)
  })

  it.each(['zh-TW', 'ja-JP'])('is translated in %s', (locale) => {
    render(git({ fetchedAt: null }), locale)
    const text = wrapper!.text()
    expect(text).not.toContain('settings.p2p.network')
    expect(text).not.toContain('dirty')
    expect(text).not.toContain('may be stale')
  })
})

describe('PaneGitChip in the network view', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const MODAL = readFileSync(resolve(here, '../AccountModal.vue'), 'utf8')

  it('is shown on this machine\'s own rows only', () => {
    expect(MODAL).toContain('<PaneGitChip v-if="device.isLocal && row.pane.git" :git="row.pane.git" />')
  })

  it('has every string in all three locales', () => {
    for (const locale of ['en-US', 'zh-TW', 'ja-JP']) {
      const network = (i18n.global.getLocaleMessage(locale) as Record<string, any>).settings.p2p.network
      for (const key of ['git-dirty', 'git-stale', 'git-linked', 'git-fetched', 'git-never-fetched']) {
        expect(network[key], `${locale}: ${key}`).toBeTruthy()
      }
    }
  })
})
