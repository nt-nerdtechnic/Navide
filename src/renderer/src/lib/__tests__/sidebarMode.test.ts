import { describe, expect, it } from 'vitest'
import { countUntouchedElsewhere, parseSidebarMode, SIDEBAR_MODE_KEY } from '../sidebarMode'

describe('parseSidebarMode', () => {
  it('reads the two stored spellings', () => {
    expect(parseSidebarMode('workspace')).toBe('workspace')
    expect(parseSidebarMode('free')).toBe('free')
  })

  it('falls back to the pre-existing behaviour for anything else', () => {
    // A value written by another version, a cleared setting, or a settings
    // cache that has not filled yet must never leave the sidebar in a shape
    // nobody chose.
    for (const junk of [undefined, null, '', 'Free', 'flat', 0, {}]) {
      expect(parseSidebarMode(junk)).toBe('workspace')
    }
  })

  it('stores under the global ui_settings key, like the grid preset', () => {
    expect(SIDEBAR_MODE_KEY).toBe('agentTeam.sidebarMode')
  })
})

describe('countUntouchedElsewhere', () => {
  const stage = [
    { id: 'a', group: 'g1' },
    { id: 'b', group: 'g1' },
    { id: 'x', group: 'g1' },
    { id: 'y', group: 'g2' },
  ]
  const inView = [{ id: 'a' }, { id: 'b' }]

  it('counts the aimed-at panes on the stage that the workspace on screen does not own', () => {
    expect(countUntouchedElsewhere(stage, inView, (p) => p.group === 'g1')).toBe(1)
    expect(countUntouchedElsewhere(stage, inView, () => true)).toBe(2)
  })

  it('is zero when the stage and the workspace on screen agree', () => {
    expect(countUntouchedElsewhere(inView, inView, () => true)).toBe(0)
  })
})
