// @vitest-environment happy-dom
// BarsWithLine — pure SVG, no state of its own; assertions are on the emitted
// markup (attributes, data-parts, titles) and the `select` event. happy-dom
// has no layout, so geometry is read from attributes, never from getBBox.
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import BarsWithLine, { type BarWithLine } from '../BarsWithLine.vue'

const bars: BarWithLine[] = [
  { label: 'Cycle 1', value: 100, percent: 40, exhausted: false },
  { label: 'Cycle 2', value: 50, percent: 100, exhausted: true },
  { label: 'Cycle 3', note: 'in progress', value: 25, percent: null, exhausted: false },
]

function mountChart(props: Partial<InstanceType<typeof BarsWithLine>['$props']> = {}) {
  return mount(BarsWithLine, { props: { bars, ariaLabel: 'Quota cycles', emptyText: 'No cycles', ...props } })
}

describe('BarsWithLine', () => {
  it('renders one bar per datum with data-index, labels and the axes', () => {
    const w = mountChart()
    expect(w.findAll('[data-part="bar"]').map((b) => b.attributes('data-index'))).toEqual(['0', '1', '2'])
    expect(w.find('svg').attributes('role')).toBe('img')
    expect(w.find('svg').attributes('aria-label')).toBe('Quota cycles')
    expect(w.find('[data-part="axis"]').exists()).toBe(true)
    expect(w.findAll('[data-part="pct-label"]').map((t) => t.text())).toEqual(['0%', '50%', '100%'])
    expect(w.findAll('[data-part="x-label"]').map((t) => t.text())).toEqual(['Cycle 1', 'Cycle 2', 'Cycle 3'])
    expect(w.findAll('[data-part="x-note"]').map((t) => t.text())).toEqual(['in progress'])
  })

  it('renders the empty state instead of the SVG when bars is empty', () => {
    const w = mountChart({ bars: [] })
    expect(w.find('svg').exists()).toBe(false)
    expect(w.find('[data-part="empty"]').text()).toBe('No cycles')
  })

  it('scales bar height by value', () => {
    const [first, second] = mountChart().findAll('[data-part="bar"]')
    const h1 = Number(first.attributes('height'))
    const h2 = Number(second.attributes('height'))
    expect(h1).toBeGreaterThan(0)
    expect(Math.abs(h2 - h1 / 2)).toBeLessThanOrEqual(1)
  })

  it('emits select with the bar index on click and marks the selected bar', async () => {
    const w = mountChart({ selected: 0 })
    await w.findAll('[data-part="bar"]')[1].trigger('click')
    expect(w.emitted('select')).toEqual([[1]])
    const barEls = w.findAll('[data-part="bar"]')
    expect(barEls[0].attributes('data-selected')).toBe('true')
    expect(barEls[1].attributes('data-selected')).toBeUndefined()
  })

  it('draws the line through non-null percents only and a red dot on exhausted cycles', () => {
    const w = mountChart()
    const points = (w.find('[data-part="line"]').attributes('points') ?? '').trim().split(/\s+/)
    expect(points).toHaveLength(2)
    // The 100% point sits at the top of the plot and the 40% one below it.
    const y = points.map((p) => Number(p.split(',')[1]))
    expect(y[1]).toBeLessThan(y[0])
    expect(w.findAll('[data-part="point"]')).toHaveLength(1)
    const dots = w.findAll('[data-part="dot"][data-exhausted="true"]')
    expect(dots).toHaveLength(1)
    expect(dots[0].attributes('r')).toBe('4')
    // The null-percent bar contributes neither a point nor a dot.
    expect(w.findAll('[data-part="point"], [data-part="dot"]')).toHaveLength(2)
  })

  it('omits the polyline when no bar has a percent', () => {
    const w = mountChart({ bars: [{ label: 'Only', value: 10, percent: null, exhausted: false }] })
    expect(w.find('[data-part="line"]').exists()).toBe(false)
    expect(w.findAll('[data-part="bar"]')).toHaveLength(1)
  })

  it('builds titles, totals and ticks with valueFormat and percentFormat', () => {
    const w = mountChart({ valueFormat: (n) => `${n}t`, percentFormat: (p) => `${p} pct` })
    const titles = w.findAll('[data-part="bar-group"] title').map((t) => t.text())
    expect(titles).toEqual(['Cycle 1: 100t · 40 pct', 'Cycle 2: 50t · 100 pct', 'Cycle 3: 25t · in progress'])
    expect(w.findAll('[data-part="bar-total"]').map((t) => t.text())).toEqual(['100t', '50t', '25t'])
    expect(w.findAll('[data-part="tick"]').map((t) => t.text())).toEqual(['0t', '50t', '100t'])
    expect(w.findAll('[data-part="pct-label"]').map((t) => t.text())).toEqual(['0 pct', '50 pct', '100 pct'])
  })
})
