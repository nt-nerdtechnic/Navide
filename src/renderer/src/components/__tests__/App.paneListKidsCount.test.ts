// @vitest-environment happy-dom
// The count ahead of a parent card's name in the pane lists — rendered, not
// grepped. App.paneListLineage.test.ts asserts the wiring against App.vue's
// source; this file lifts the actual family control out of that source and
// mounts it, so the number the user sees is what these assertions read.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { describe, expect, it, vi } from 'vitest'

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

/** Every `<button … class="pane-list-kids" …>…</button>` on the card lists,
 *  as written in App.vue. The Spotlight thumb's compact variant carries the
 *  dots too and is not the control this file is about. */
function cardListControls(): string[] {
  const out: string[] = []
  const re = /<button\s+v-if="p\.descendantCount > 0"\s+class="pane-list-kids"[\s\S]*?<\/button>/g
  for (const m of appSource.matchAll(re)) out.push(m[0])
  return out
}

interface Row {
  id: string
  descendantCount: number
  expanded: boolean
}

function mountControl(template: string, p: Row) {
  const togglePaneFamily = vi.fn()
  const wrapper = mount(
    defineComponent({
      template: `<div class="card"><span class="name-row">${template}<span class="meeting-name">收費</span></span></div>`,
      setup: () => ({ p, togglePaneFamily }),
    }),
    {
      global: {
        mocks: {
          $t: (key: string, args?: Record<string, unknown>) => `${key}:${JSON.stringify(args ?? {})}`,
        },
      },
    }
  )
  return { wrapper, togglePaneFamily }
}

describe('the family control on the two card lists', () => {
  const controls = cardListControls()

  it('exists once per card list, and the two are the same markup', () => {
    // The PiP list's template is a copy of the sidebar card's; the count was
    // added to both. If one drifts, the user sees a number in one mode and
    // not the other.
    expect(controls).toHaveLength(2)
    expect(controls[0]).toBe(controls[1])
  })

  it.each([0, 1])('list %i: prints caret and descendant count ahead of the name', (i) => {
    const { wrapper } = mountControl(controls[i], { id: 'a', descendantCount: 3, expanded: false })
    const button = wrapper.get('button.pane-list-kids')
    expect(button.get('.pane-list-kids-caret').text()).toBe('▸')
    expect(button.get('.pane-list-kids-count').text()).toBe('3')
    // Ahead of the name: the control precedes the label in DOM order.
    const html = wrapper.get('.name-row').html()
    expect(html.indexOf('pane-list-kids-count')).toBeLessThan(html.indexOf('meeting-name'))
    // The full wording stays on hover.
    expect(button.attributes('title')).toBe('label.descendant-count:{"count":3}')
  })

  it('keeps the count while the family is open, only the caret turns', () => {
    const { wrapper } = mountControl(controls[0], { id: 'a', descendantCount: 3, expanded: true })
    const button = wrapper.get('button.pane-list-kids')
    expect(button.classes()).toContain('is-open')
    expect(button.get('.pane-list-kids-caret').text()).toBe('▾')
    expect(button.get('.pane-list-kids-count').text()).toBe('3')
  })

  it('renders nothing at all for a pane with no descendants', () => {
    // A leaf's card must look exactly as it did before the count existed.
    const { wrapper } = mountControl(controls[0], { id: 'a', descendantCount: 0, expanded: true })
    expect(wrapper.find('button.pane-list-kids').exists()).toBe(false)
    expect(wrapper.find('.pane-list-kids-count').exists()).toBe(false)
    expect(wrapper.get('.name-row').text()).toBe('收費')
  })

  it('still opens the family on click without focusing the card', () => {
    // The count rides inside the same button, so clicking the number opens
    // the family too — and the click must not reach the card, which would
    // focus the pane.
    const { wrapper, togglePaneFamily } = mountControl(controls[0], { id: 'p-1', descendantCount: 2, expanded: false })
    const onCard = vi.fn()
    wrapper.get('.card').element.addEventListener('click', onCard)
    wrapper.get('.pane-list-kids-count').trigger('click')
    expect(togglePaneFamily).toHaveBeenCalledWith('p-1')
    expect(onCard).not.toHaveBeenCalled()
  })
})
