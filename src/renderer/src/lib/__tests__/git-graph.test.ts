import { describe, it, expect } from 'vitest'
import { computeGraph, laneColor } from '../git-graph'

describe('computeGraph — linear history', () => {
  it('keeps every commit on lane 0', () => {
    const { rows, width } = computeGraph([
      { hash: 'A', parents: ['B'] },
      { hash: 'B', parents: ['C'] },
      { hash: 'C', parents: [] },
    ])
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0])
    expect(width).toBe(1)
  })
})

describe('computeGraph — branch + merge', () => {
  const layout = computeGraph([
    { hash: 'M', parents: ['A', 'B'] }, // merge commit (newest)
    { hash: 'A', parents: ['C'] },
    { hash: 'B', parents: ['C'] },
    { hash: 'C', parents: [] }, // shared ancestor (root)
  ])

  it('places the second parent on a new lane', () => {
    expect(layout.width).toBe(2)
    expect(layout.rows.map((r) => r.lane)).toEqual([0, 0, 1, 0])
  })

  it('merge row draws a bottom diagonal to the second parent lane', () => {
    const mRow = layout.rows[0]
    const diagonal = mRow.segments.find((s) => s.half === 'bottom' && s.fromLane === 0 && s.toLane === 1)
    expect(diagonal).toBeDefined()
  })

  it('shared ancestor row routes both incoming lanes into the dot', () => {
    const cRow = layout.rows[3]
    const tops = cRow.segments.filter((s) => s.half === 'top').map((s) => `${s.fromLane}->${s.toLane}`)
    // both lane 0 and lane 1 were waiting for C and converge on lane 0
    expect(tops).toContain('0->0')
    expect(tops).toContain('1->0')
  })
})

describe('laneColor', () => {
  it('is stable and cycles through the palette', () => {
    expect(laneColor(0)).toBe(laneColor(8)) // palette has 8 entries
    expect(laneColor(0)).not.toBe(laneColor(1))
  })
})
