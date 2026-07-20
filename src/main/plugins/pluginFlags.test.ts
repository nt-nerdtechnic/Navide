import { describe, expect, it } from 'vitest'
import { miniIdePluginEnabled } from './pluginFlags'

describe('miniIdePluginEnabled', () => {
  it('defaults OFF (legacy editor window stays the default)', () => {
    expect(miniIdePluginEnabled({})).toBe(false)
  })

  it('is ON only for the exact opt-in value', () => {
    expect(miniIdePluginEnabled({ AGENT_TEAM_MINI_IDE_PLUGIN: '1' })).toBe(true)
    expect(miniIdePluginEnabled({ AGENT_TEAM_MINI_IDE_PLUGIN: '0' })).toBe(false)
    expect(miniIdePluginEnabled({ AGENT_TEAM_MINI_IDE_PLUGIN: 'true' })).toBe(false)
    expect(miniIdePluginEnabled({ AGENT_TEAM_MINI_IDE_PLUGIN: '' })).toBe(false)
  })
})
