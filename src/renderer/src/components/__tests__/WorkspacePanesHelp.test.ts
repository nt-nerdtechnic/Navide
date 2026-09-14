// @vitest-environment happy-dom
import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18n } from '@navide/plugin-ui/foundation'

import WorkspacePanesHelp from '../WorkspacePanesHelp.vue'
import { expectNoChineseText } from './helpLocaleAssertions'
const HTML_ADVISORY = '[intlify] Detected HTML in '

function unexpectedWarnings(warn: ReturnType<typeof vi.spyOn>): unknown[][] {
  return warn.mock.calls.filter(([first]) => !String(first).startsWith(HTML_ADVISORY))
}

function mountHelp(): VueWrapper {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return mount(WorkspacePanesHelp as any, { global: { plugins: [i18n] } })
}

// Row counts per table, in document order.
const TABLE_ROWS = [6, 4, 3, 5, 3, 4, 15]

describe('WorkspacePanesHelp', () => {
  const originalLocale = i18n.global.locale.value
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    i18n.global.locale.value = originalLocale
    warn.mockRestore()
  })

  it('renders entirely in English under en-US', () => {
    i18n.global.locale.value = 'en-US'
    const wrapper = mountHelp()

    const text = wrapper.text()
    expectNoChineseText(text)
    expect(text).toContain('Three terms')
    expect(text).toContain('Shortcut quick reference')
    expect(wrapper.findAll('.wph-h2')).toHaveLength(7)
    expect(wrapper.findAll('.wph-table').map((t) => t.findAll('tbody tr').length)).toEqual(
      TABLE_ROWS,
    )

    expect(unexpectedWarnings(warn)).toEqual([])
  })

  it('renders the Traditional Chinese prose under zh-TW', () => {
    i18n.global.locale.value = 'zh-TW'
    const wrapper = mountHelp()

    const text = wrapper.text()
    expect(text).toContain('三個名詞')
    expect(text).toContain('閒置自動回收')
    expect(text).toContain('快捷鍵速查')
    expect(wrapper.findAll('.wph-h2')).toHaveLength(7)
    expect(wrapper.findAll('.wph-table').map((t) => t.findAll('tbody tr').length)).toEqual(
      TABLE_ROWS,
    )

    expect(unexpectedWarnings(warn)).toEqual([])
  })

  it('draws both mock screenshots, in the locale being rendered', () => {
    i18n.global.locale.value = 'en-US'
    const wrapper = mountHelp()

    // Two figures: the window anatomy and the group/grid pair.
    const figures = wrapper.findAll('.mk-fig')
    expect(figures).toHaveLength(2)
    // Five marked regions on the first, four on the second.
    expect(figures.map((f) => f.findAll('.mk-fig-legend li').length)).toEqual([5, 4])
    // Each figure draws the same six sidebar rows and three panes.
    expect(figures.map((f) => f.findAll('.mk-row').length)).toEqual([6, 6])
    expect(figures.map((f) => f.findAll('.mk-pane').length)).toEqual([3, 3])
    // Only the first carries window chrome; the second is a zoom on the stage.
    expect(figures.map((f) => f.findAll('.mk-win-status').length)).toEqual([1, 0])

    // Every word inside a mock is a locale lookup, so the pictures have to
    // turn English along with the prose around them.
    const mockText = figures.map((f) => f.text()).join(' ')
    expectNoChineseText(mockText)
    expect(mockText).toContain('Status bar')
    expect(mockText).toContain('running')

    expect(unexpectedWarnings(warn)).toEqual([])
  })

  it('renders the mock labels in Traditional Chinese under zh-TW', () => {
    i18n.global.locale.value = 'zh-TW'
    const wrapper = mountHelp()

    const mockText = wrapper.findAll('.mk-fig').map((f) => f.text()).join(' ')
    expect(mockText).toContain('狀態列')
    expect(mockText).toContain('執行中')
    // Sample project and pane names stay identical in both locales.
    expect(mockText).toContain('my-project')

    expect(unexpectedWarnings(warn)).toEqual([])
  })

  it('injects the inline markup from the locale strings', () => {
    i18n.global.locale.value = 'en-US'
    const wrapper = mountHelp()

    // `.wph-list` items are v-html, so their <code>/<strong> come from the
    // locale strings rather than the template.
    expect(wrapper.find('.wph-list code').exists()).toBe(true)
    expect(wrapper.find('.wph-list strong').exists()).toBe(true)
    expect(wrapper.find('.wph-list kbd.wph-kbd').exists()).toBe(true)
    expect(wrapper.find('.wph-card .wph-p code').exists()).toBe(true)
    expect(wrapper.find('.wph-p em').exists()).toBe(true)

    expect(unexpectedWarnings(warn)).toEqual([])
  })
})
