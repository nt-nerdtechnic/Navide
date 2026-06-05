// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useTheme, DEFAULT_THEME } from '../useTheme'

const THEME_KEY = 'agent-team:theme'
const CUSTOM_KEY = 'agent-team:theme-custom'

function html(): HTMLElement {
  return document.documentElement
}

describe('useTheme', () => {
  beforeEach(() => {
    // Reset persisted + DOM state. The composable is a module-level singleton,
    // so each test starts from a clean, explicit baseline.
    localStorage.clear()
    html().removeAttribute('data-theme')
    html().removeAttribute('style')
    const { resetCustom, setTheme } = useTheme()
    resetCustom()
    setTheme(DEFAULT_THEME)
    localStorage.clear()
  })

  it('defaults to dark-github when nothing is stored', () => {
    const { loadTheme, theme } = useTheme()
    const res = loadTheme()
    expect(res.fromLocal).toBe(false)
    expect(theme.value).toBe('dark-github')
    expect(html().getAttribute('data-theme')).toBe('dark-github')
  })

  it('loads the theme from localStorage', () => {
    localStorage.setItem(THEME_KEY, JSON.stringify('dark-forest'))
    const { loadTheme, theme } = useTheme()
    const res = loadTheme()
    expect(res.fromLocal).toBe(true)
    expect(theme.value).toBe('dark-forest')
    expect(html().getAttribute('data-theme')).toBe('dark-forest')
  })

  it('adopts the backend fallback when localStorage is empty and promotes it', () => {
    const { loadTheme, theme } = useTheme()
    const res = loadTheme({ theme: 'light', theme_custom: { '--accent-fg': '#abcdef' } })
    expect(res.fromLocal).toBe(false)
    expect(theme.value).toBe('light')
    // Promoted to the source of truth so later loads are stable.
    expect(JSON.parse(localStorage.getItem(THEME_KEY) as string)).toBe('light')
    expect(JSON.parse(localStorage.getItem(CUSTOM_KEY) as string)).toEqual({
      '--accent-fg': '#abcdef',
    })
  })

  it('localStorage wins over the backend fallback', () => {
    localStorage.setItem(THEME_KEY, JSON.stringify('high-contrast'))
    const { loadTheme, theme } = useTheme()
    loadTheme({ theme: 'light' })
    expect(theme.value).toBe('high-contrast')
  })

  it('falls back to default for an unknown stored theme', () => {
    localStorage.setItem(THEME_KEY, JSON.stringify('nonsense'))
    const { loadTheme, theme } = useTheme()
    loadTheme()
    expect(theme.value).toBe(DEFAULT_THEME)
  })

  it('setTheme updates the attribute + localStorage and keeps overrides', () => {
    const { setCustomOverride, setTheme, theme, customOverrides } = useTheme()
    setCustomOverride('--accent-fg', '#112233')
    setTheme('dark-midnight')
    expect(theme.value).toBe('dark-midnight')
    expect(html().getAttribute('data-theme')).toBe('dark-midnight')
    expect(JSON.parse(localStorage.getItem(THEME_KEY) as string)).toBe('dark-midnight')
    // Custom override survives the built-in theme switch.
    expect(customOverrides.value['--accent-fg']).toBe('#112233')
    expect(html().style.getPropertyValue('--accent-fg')).toBe('#112233')
  })

  it('ignores an invalid theme id in setTheme', () => {
    const { setTheme, theme } = useTheme()
    setTheme('dark-forest')
    setTheme('not-a-theme')
    expect(theme.value).toBe('dark-forest')
  })

  it('setCustomOverride applies inline var and clears with null', () => {
    const { setCustomOverride, customOverrides } = useTheme()
    setCustomOverride('--danger-fg', '#ff0000')
    expect(html().style.getPropertyValue('--danger-fg')).toBe('#ff0000')
    expect(JSON.parse(localStorage.getItem(CUSTOM_KEY) as string)).toEqual({
      '--danger-fg': '#ff0000',
    })
    setCustomOverride('--danger-fg', null)
    expect(html().style.getPropertyValue('--danger-fg')).toBe('')
    expect(customOverrides.value['--danger-fg']).toBeUndefined()
  })

  it('resetCustom clears every override', () => {
    const { setCustomOverride, resetCustom, customOverrides } = useTheme()
    setCustomOverride('--accent-fg', '#111111')
    setCustomOverride('--success-fg', '#222222')
    resetCustom()
    expect(customOverrides.value).toEqual({})
    expect(html().style.getPropertyValue('--accent-fg')).toBe('')
    expect(html().style.getPropertyValue('--success-fg')).toBe('')
    expect(JSON.parse(localStorage.getItem(CUSTOM_KEY) as string)).toEqual({})
  })

  it('syncToBackend sends the right payload and swallows errors', async () => {
    const { setTheme, syncToBackend } = useTheme()
    setTheme('light')
    const ok = vi.fn().mockResolvedValue({ ok: true })
    await syncToBackend(ok, '/ws')
    expect(ok).toHaveBeenCalledWith('project.set_theme', {
      workspace_path: '/ws',
      theme: 'light',
      theme_custom: {},
    })

    // A rejecting sender must not throw (backup is best-effort).
    const bad = vi.fn().mockRejectedValue(new Error('offline'))
    await expect(syncToBackend(bad, '/ws')).resolves.toBeUndefined()

    // Empty workspace → no call.
    const noop = vi.fn()
    await syncToBackend(noop, '')
    expect(noop).not.toHaveBeenCalled()
  })
})
