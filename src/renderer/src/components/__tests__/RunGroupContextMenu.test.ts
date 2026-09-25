// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import RunGroupContextMenu from '../RunGroupContextMenu.vue'

// The shared run-group menu keeps one shape: every item always present, with
// the ones a group cannot use disabled rather than removed.

function items(): HTMLButtonElement[] {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>('.rg-ctx .rg-ctx-item'))
}

const all = { canRename: true, canMove: true, canDetach: true, rebuildCount: 2, reclaimCount: 3, paneCount: 5 }

describe('RunGroupContextMenu', () => {
  let wrapper: VueWrapper
  afterEach(() => wrapper.unmount())

  function mountMenu(over: Partial<typeof all> = {}): void {
    wrapper = mount(RunGroupContextMenu, {
      props: { x: 20, y: 30, ...all, ...over },
      global: { plugins: [i18n] },
      attachTo: document.body
    })
  }

  it('always renders the same seven items in order: batch block, then the close pair', () => {
    mountMenu({ canRename: false, canMove: false, canDetach: false, rebuildCount: 0, reclaimCount: 0, paneCount: 0 })
    const t = i18n.global.t
    expect(items().map((b) => b.textContent)).toEqual([
      t('stageTab.rename'),
      t('stageTab.open-in-window'),
      t('stageTab.rebuild-panes', { count: 0 }),
      t('stageTab.reclaim-panes', { count: 0 }),
      t('stageTab.remove-panes', { count: 0 }),
      t('stageTab.close-group'),
      t('stageTab.close-group-and-panes')
    ])
  })

  it('disables each item from its own prop, and close-with-panes never', () => {
    mountMenu({ canRename: false, canMove: true, canDetach: false, rebuildCount: 1, reclaimCount: 0, paneCount: 2 })
    expect(items().map((b) => b.disabled)).toEqual([true, true, false, true, false, false, false])
    wrapper.unmount()
    mountMenu({ canRename: true, canMove: false, canDetach: true, rebuildCount: 0, reclaimCount: 4, paneCount: 0 })
    expect(items().map((b) => b.disabled)).toEqual([false, false, true, false, true, true, false])
  })

  it('shows the counts in the batch labels', () => {
    mountMenu()
    expect(items()[2].textContent).toBe(i18n.global.t('stageTab.rebuild-panes', { count: 2 }))
    expect(items()[3].textContent).toBe(i18n.global.t('stageTab.reclaim-panes', { count: 3 }))
  })

  it('tells the three close items apart: keep panes, keep group, keep nothing', () => {
    mountMenu()
    const [, , , , removePanes, closeGroup, closeWithPanes] = items()
    expect(removePanes.textContent).toBe(i18n.global.t('stageTab.remove-panes', { count: 5 }))
    closeGroup.click()
    removePanes.click()
    closeWithPanes.click()
    expect(wrapper.emitted('move')).toHaveLength(1)
    expect(wrapper.emitted('remove-panes')).toHaveLength(1)
    expect(wrapper.emitted('close-panes')).toHaveLength(1)
    expect([removePanes, closeWithPanes].every((b) => b.classList.contains('danger'))).toBe(true)
  })

  it('emits one event per item and dismiss from the backdrop', () => {
    mountMenu()
    for (const b of items()) b.click()
    document.body.querySelector<HTMLElement>('.rg-ctx-backdrop')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    for (const ev of ['rename', 'move', 'detach', 'rebuild', 'reclaim', 'remove-panes', 'close-panes', 'dismiss']) {
      expect(wrapper.emitted(ev), ev).toHaveLength(1)
    }
  })

  it('opens at the pointer', () => {
    mountMenu()
    const el = document.body.querySelector<HTMLElement>('.rg-ctx')!
    expect([el.style.left, el.style.top]).toEqual(['20px', '30px'])
  })
})
