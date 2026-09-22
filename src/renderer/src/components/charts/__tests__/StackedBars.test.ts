// @vitest-environment happy-dom
// StackedBars — pure SVG, no state of its own; assertions are on the emitted
// markup (attributes, data-parts, titles) and the `select` event. happy-dom
// has no layout, so geometry is read from attributes, never from getBBox.
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import StackedBars, { type StackedBar } from '../StackedBars.vue'

const bars: StackedBar[] = [
  { label: 'Jan', segments: [{ key: 'a', label: 'Alice', value: 60, color: 'var(--ansi-cyan)' }, { key: 'b', label: 'Bob', value: 40, color: 'var(--ansi-magenta)' }] },
  { label: 'Feb', note: 'in progress', segments: [{ key: 'a', label: 'Alice', value: 50, color: 'var(--ansi-cyan)' }] },
]

function mountChart(props: Partial<InstanceType<typeof StackedBars>['$props']> = {}) {
  return mount(StackedBars, { props: { bars, ariaLabel: 'Monthly totals', emptyText: 'No data', ...props } })
}

describe('StackedBars', () => {
  it('renders one bar per datum with data-index and one rect per segment', () => {
    const w = mountChart()
    const barEls = w.findAll('[data-part="bar"]')
    expect(barEls.map((b) => b.attributes('data-index'))).toEqual(['0', '1'])
    expect(barEls[0].findAll('[data-part="segment"]').map((s) => s.attributes('data-key'))).toEqual(['a', 'b'])
    expect(barEls[1].findAll('[data-part="segment"]')).toHaveLength(1)
    expect(w.find('svg').attributes('role')).toBe('img')
    expect(w.find('svg').attributes('aria-label')).toBe('Monthly totals')
    expect(w.find('[data-part="axis"]').exists()).toBe(true)
    expect(w.findAll('[data-part="x-label"]').map((t) => t.text())).toEqual(['Jan', 'Feb'])
    expect(w.findAll('[data-part="x-note"]').map((t) => t.text())).toEqual(['in progress'])
  })

  it('renders the empty state instead of the SVG when bars is empty', () => {
    const w = mountChart({ bars: [] })
    expect(w.find('svg').exists()).toBe(false)
    expect(w.find('[data-part="empty"]').text()).toBe('No data')
    expect(w.find('[data-part="empty"]').classes()).toContain('chart-empty')
  })

  it('scales bar height by total and stacks segments to exactly the bar height', () => {
    const w = mountChart()
    const [first, second] = w.findAll('[data-part="bar"]')
    const heightOf = (bar: typeof first) => bar.findAll('[data-part="segment"]').reduce((sum, s) => sum + Number(s.attributes('height')), 0)
    const h1 = heightOf(first)
    const h2 = heightOf(second)
    expect(h1).toBeGreaterThan(0)
    expect(Math.abs(h2 - h1 / 2)).toBeLessThanOrEqual(1)
    // Segments of the first bar sum to its height and touch: the top of the
    // lower segment is the bottom of the upper one.
    const [lower, upper] = first.findAll('[data-part="segment"]')
    expect(Number(lower.attributes('y'))).toBe(Number(upper.attributes('y')) + Number(upper.attributes('height')))
    expect(Number(lower.attributes('y')) + Number(lower.attributes('height'))).toBe(Number(w.find('[data-part="axis"]').attributes('y1')))
    expect(Number(upper.attributes('height')) + Number(lower.attributes('height'))).toBe(h1)
  })

  it('emits select with the bar index on click and marks the selected bar', async () => {
    const w = mountChart({ selected: 1 })
    await w.findAll('[data-part="bar"]')[1].trigger('click')
    expect(w.emitted('select')).toEqual([[1]])
    const barEls = w.findAll('[data-part="bar"]')
    expect(barEls[1].attributes('data-selected')).toBe('true')
    expect(barEls[0].attributes('data-selected')).toBeUndefined()
  })

  it('derives one legend item per distinct segment key, or uses the given legend', () => {
    const derived = mountChart().findAll('[data-part="legend-item"]')
    expect(derived.map((li) => li.attributes('data-key'))).toEqual(['a', 'b'])
    expect(derived.map((li) => li.text())).toEqual(['Alice', 'Bob'])
    const given = mountChart({ legend: [{ key: 'z', label: 'Zed', color: 'var(--ansi-yellow)' }] }).findAll('[data-part="legend-item"]')
    expect(given.map((li) => li.attributes('data-key'))).toEqual(['z'])
  })

  it('builds segment titles, bar totals and ticks with valueFormat', () => {
    const w = mountChart({ valueFormat: (n) => `${n}t` })
    expect(w.find('[data-part="segment"] title').text()).toBe('Jan · Alice: 60t')
    expect(w.findAll('[data-part="bar-total"]').map((t) => t.text())).toEqual(['100t', '50t'])
    expect(w.findAll('[data-part="tick"]').map((t) => t.text())).toEqual(['0t', '50t', '100t'])
  })

  it('applies the segment colour through style so CSS variables work', () => {
    const style = mountChart().find('[data-part="segment"]').attributes('style') ?? ''
    expect(style).toContain('var(--ansi-cyan)')
  })
})
