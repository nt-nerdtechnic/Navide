// @vitest-environment happy-dom
import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18n } from '@navide/plugin-ui/foundation'

import CrossPlatformHelp from '../CrossPlatformHelp.vue'
import { expectNoChineseText } from './helpLocaleAssertions'
const HTML_ADVISORY = '[intlify] Detected HTML in '

// Row counts per table, in document order: downloads, update paths,
// credential stores.
const TABLE_ROWS = [5, 4, 3]

function unexpectedWarnings(warn: ReturnType<typeof vi.spyOn>): unknown[][] {
  return warn.mock.calls.filter(([first]) => !String(first).startsWith(HTML_ADVISORY))
}

function mountHelp(): VueWrapper {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return mount(CrossPlatformHelp as any, { global: { plugins: [i18n] } })
}

function tableRowCounts(wrapper: VueWrapper): number[] {
  return wrapper.findAll('.cph-table').map((t) => t.findAll('tbody tr').length)
}

describe('CrossPlatformHelp', () => {
  const originalLocale = i18n.global.locale.value
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    i18n.global.locale.value = originalLocale
    warn.mockRestore()
  })

  it('renders entirely in English under en-US', { timeout: 30_000 }, () => {
    i18n.global.locale.value = 'en-US'
    const wrapper = mountHelp()

    const text = wrapper.text()
    expect(text).toContain('Getting it and installing it')
    expect(text).toContain('Known platform limitations')
    expect(text).toContain('One person, several machines')
    expectNoChineseText(text)

    expect(wrapper.findAll('.cph-h2')).toHaveLength(7)
    expect(tableRowCounts(wrapper)).toEqual(TABLE_ROWS)

    // The title-bar comparison. Its own text is checked separately: the
    // page-wide Chinese check would still pass if the picture failed to
    // render at all.
    const figures = wrapper.findAll('.mk-fig')
    expect(figures).toHaveLength(1)
    expect(figures[0].text().trim()).not.toBe('')
    expectNoChineseText(figures[0].text())

    expect(unexpectedWarnings(warn)).toEqual([])
  })

  it('renders the Traditional Chinese prose under zh-TW', () => {
    i18n.global.locale.value = 'zh-TW'
    const wrapper = mountHelp()

    const text = wrapper.text()
    expect(text).toContain('取得與安裝')
    expect(text).toContain('已知的平台限制')
    expect(text).toContain('同一個人、好幾台機器')

    expect(wrapper.findAll('.cph-h2')).toHaveLength(7)
    expect(tableRowCounts(wrapper)).toEqual(TABLE_ROWS)

    expect(unexpectedWarnings(warn)).toEqual([])
  })

  it('keeps the inline markup from the locale strings', () => {
    i18n.global.locale.value = 'en-US'
    const wrapper = mountHelp()

    // Prose comes through v-html, so the markup the locale strings carry
    // must survive as elements rather than literal text.
    expect(wrapper.find('.cph-p strong').exists()).toBe(true)
    expect(wrapper.find('.cph-p code').exists()).toBe(true)
    expect(wrapper.find('kbd').exists()).toBe(true)

    expect(unexpectedWarnings(warn)).toEqual([])
  })
})
