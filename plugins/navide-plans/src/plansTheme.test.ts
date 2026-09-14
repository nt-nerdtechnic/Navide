// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyPlansTheme,
  bindPlansTheme,
  bootstrapPlansTheme,
  extractThemeFromSettingsEvent,
  parsePlansThemeFromQuery,
  PLANS_THEME_KEY,
  resolvePlansTheme,
} from './plansTheme'
import { settingsGet } from '@navide/plugin-ui/shared'
import { __resetSettingsForTest } from '@navide/plugin-ui/shared/testing'

beforeEach(() => {
  __resetSettingsForTest()
  document.documentElement.removeAttribute('data-theme')
})

describe('Plans theme resolution', () => {
  it('accepts a shipped theme id in both wire encodings', () => {
    expect(resolvePlansTheme('light')).toBe('light')
    expect(resolvePlansTheme('"light"')).toBe('light')
    expect(resolvePlansTheme('high-contrast')).toBe('high-contrast')
  })

  it('rejects ids the app does not ship and non-strings', () => {
    expect(resolvePlansTheme('solarized')).toBeNull()
    expect(resolvePlansTheme('"solarized"')).toBeNull()
    expect(resolvePlansTheme(null)).toBeNull()
    expect(resolvePlansTheme(42)).toBeNull()
  })

  it('reads the theme out of the entry query', () => {
    expect(parsePlansThemeFromQuery('?workspace_path=/tmp&theme=light')).toBe('light')
    expect(parsePlansThemeFromQuery('workspace_path=/tmp')).toBeNull()
  })
})

describe('Plans theme bootstrap', () => {
  it('stamps data-theme and seeds the cache so loadTheme keeps the host theme', () => {
    expect(bootstrapPlansTheme('?theme=light')).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    // useTheme reads the store's JSON-string encoding.
    expect(settingsGet(PLANS_THEME_KEY, null)).toBe(JSON.stringify('light'))
  })

  it('falls back to the default theme when the host sent none', () => {
    expect(bootstrapPlansTheme('?workspace_path=/tmp')).toBe('dark-github')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark-github')
  })
})

describe('Plans theme host events', () => {
  it('takes the theme only from a host-sourced settings event', () => {
    const settings = { [PLANS_THEME_KEY]: JSON.stringify('light') }
    expect(extractThemeFromSettingsEvent({ source: 'host', settings })).toBe('light')
    expect(extractThemeFromSettingsEvent({ source: 'plugin', settings })).toBeNull()
    expect(extractThemeFromSettingsEvent({ source: 'host', settings: {} })).toBeNull()
    expect(extractThemeFromSettingsEvent(null)).toBeNull()
  })

  it('follows later switches and ignores unrelated settings', () => {
    applyPlansTheme('light')
    let listener: ((payload: unknown) => void) | null = null
    const dispose = vi.fn()
    const stop = bindPlansTheme((type, cb) => {
      expect(type).toBe('ui.settings_changed')
      listener = cb
      return dispose
    })

    listener!({ source: 'host', settings: { 'agent-team:language': 'en-US' } })
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')

    listener!({ source: 'host', settings: { [PLANS_THEME_KEY]: JSON.stringify('dark-forest') } })
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark-forest')

    stop()
    expect(dispose).toHaveBeenCalled()
  })
})
