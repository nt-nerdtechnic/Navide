import { describe, expect, it } from 'vitest'
import { parseSidebarMode, SIDEBAR_MODE_KEY } from '../sidebarMode'

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
