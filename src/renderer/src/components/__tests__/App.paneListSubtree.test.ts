// @vitest-environment happy-dom
// The "↳ n" subtree chip on a parent card in the main-window pane lists — the
// Auto sidebar's cards and the fullscreen PiP rows. Mounting App starts
// backend, terminal and onboarding lifecycles, so — like the other
// App.*.test.ts files — the wiring is asserted against its source. The
// computation underneath runs for real in lib/__tests__/paneSubtreeStatus.test.ts.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

describe('the subtree chip on parent cards', () => {
  it('is computed once from the live views, through the shared lib', () => {
    // One definition for every list — and the same one the sidebar tree uses —
    // so no two surfaces can disagree about which family is busy.
    expect(appSource).toContain("import { subtreeSignals } from './lib/paneSubtreeStatus'")
    expect(appSource).toContain('const paneListSubtree = computed(() => subtreeSignals(paneViews.value))')
  })

  it('renders on both card lists, beside the loop tag and before the status badge', () => {
    const chips = appSource.match(/class="meeting-subtree"\s+v-bind="paneListSubtreeAttrs\(p\.id\)"/g) ?? []
    expect(chips).toHaveLength(2)
    // Only when there is something to say: an all-idle family leaves the card
    // exactly as it was.
    const guards = appSource.match(/v-if="paneListSubtree\.has\(p\.id\)"/g) ?? []
    expect(guards).toHaveLength(2)
  })

  it('carries its legend on the chip, not just a colour', () => {
    expect(appSource).toContain("i18n.global.t('pane.terminal.subtree-tooltip', {")
  })

  it('styles every state it can show', () => {
    for (const state of ['running', 'starting', 'error', 'awaiting']) {
      expect(appSource).toContain(`.meeting-subtree[data-status="${state}"]`)
    }
  })
})

describe('the loop tag on cards', () => {
  it('is icon-only, with the word on hover', () => {
    // The word was dropped to give the pane name back its width.
    expect(appSource).not.toContain('∞ Loop')
    const titled = appSource.match(/:title="\$t\('pane\.terminal\.loop-tag-tooltip'\)"\s*>∞<\/span>/g) ?? []
    expect(titled).toHaveLength(3)
  })
})
