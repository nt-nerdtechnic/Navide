// @vitest-environment happy-dom
// HBars — pure SVG, no state of its own; assertions are on the emitted markup
// (attributes, data-parts, titles) and the `select` event. happy-dom has no
// layout, so geometry is read from attributes, never from getBBox.
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import HBars, { type HBarRow } from '../HBars.vue'

const rows: HBarRow[] = [
  { label: 'v1.2.0', value: 100, sub: '12 turns' },
  { label: 'v1.1.0', value: 50, color: 'var(--ansi-blue)' },
  { label: 'v1.0.0', value: 0, title: 'custom title' },
]

function mountChart(props: Partial<InstanceType<typeof HBars>['$props']> = {}) {
  return mount(HBars, { props: { rows, ariaLabel: 'Versions', emptyText: 'No versions', ...props } })
}

describe('HBars', () => {
  it('renders one bar per row with data-index and a label column', () => {
    const w = mountChart()
    expect(w.findAll('[data-part="bar"]').map((b) => b.attributes('data-index'))).toEqual(['0', '1', '2'])
    expect(w.findAll('[data-part="y-label"]').map((t) => t.text())).toEqual(['v1.2.0', 'v1.1.0', 'v1.0.0'])
    expect(w.find('svg').attributes('role')).toBe('img')
    expect(w.find('svg').attributes('aria-label')).toBe('Versions')
    expect(w.find('[data-part="axis"]').exists()).toBe(true)
  })

  it('sizes the SVG from the row count and rowHeight', () => {
    const viewBox = mountChart({ rowHeight: 30 }).find('svg').attributes('viewBox') ?? ''
    const height = Number(viewBox.split(' ')[3])
    expect(height).toBeGreaterThanOrEqual(3 * 30)
    expect(height).toBeLessThan(3 * 30 + 40)
  })

  it('renders the empty state instead of the SVG when rows is empty', () => {
    const w = mountChart({ rows: [] })
    expect(w.find('svg').exists()).toBe(false)
    expect(w.find('[data-part="empty"]').text()).toBe('No versions')
  })

  it('scales bar width by value and gives a zero row a zero-width rect', () => {
    const [first, second, zero] = mountChart().findAll('[data-part="bar"]')
    const w1 = Number(first.attributes('width'))
    const w2 = Number(second.attributes('width'))
    expect(w1).toBeGreaterThan(0)
    expect(Math.abs(w2 - w1 / 2)).toBeLessThanOrEqual(1)
    expect(zero.attributes('width')).toBe('0')
  })

  it('emits select with the row index on click and marks the selected row', async () => {
    const w = mountChart({ selected: 2 })
    await w.findAll('[data-part="bar"]')[0].trigger('click')
    expect(w.emitted('select')).toEqual([[0]])
    const barEls = w.findAll('[data-part="bar"]')
    expect(barEls[2].attributes('data-selected')).toBe('true')
    expect(barEls[0].attributes('data-selected')).toBeUndefined()
  })

  it('renders the value with sub when present and applies the row colour via style', () => {
    const w = mountChart()
    const values = w.findAll('[data-part="value"]')
    expect(values[0].text()).toBe('100 · 12 turns')
    expect(values[0].find('[data-part="sub"]').text()).toBe('· 12 turns')
    expect(values[1].find('[data-part="sub"]').exists()).toBe(false)
    const bars = w.findAll('[data-part="bar"]')
    expect(bars[1].attributes('style')).toContain('var(--ansi-blue)')
    expect(bars[0].attributes('style')).toContain('var(--accent-fg)')
  })

  it('builds titles and values with valueFormat, preferring an explicit row title', () => {
    const w = mountChart({ valueFormat: (n) => `${n}t` })
    expect(w.findAll('[data-part="row"] title').map((t) => t.text())).toEqual(['v1.2.0: 100t', 'v1.1.0: 50t', 'custom title'])
    expect(w.findAll('[data-part="value"]').map((t) => t.text())).toEqual(['100t · 12 turns', '50t', '0t'])
  })
})
