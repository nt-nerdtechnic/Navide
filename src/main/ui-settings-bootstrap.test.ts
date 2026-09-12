import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveBackendDataDir, readUiSettingsText, UI_SETTINGS_FILE } from './ui-settings-bootstrap'

const base = {
  isPackaged: true,
  appDataPath: '/Users/u/Library/Application Support',
  platform: 'darwin' as NodeJS.Platform,
  homeDir: '/Users/u',
}

describe('resolveBackendDataDir', () => {
  it('honours an absolute AGENT_TEAM_DATA_DIR override', () => {
    expect(resolveBackendDataDir({ ...base, envOverride: '/tmp/custom-dir' })).toBe('/tmp/custom-dir')
  })

  it('expands a ~/ override against the home dir', () => {
    expect(resolveBackendDataDir({ ...base, envOverride: '~/custom' })).toBe('/Users/u/custom')
    expect(resolveBackendDataDir({ ...base, envOverride: '~' })).toBe('/Users/u')
  })

  it('uses the dev state dir when not packaged (mirrors backend.ts spawn env)', () => {
    expect(resolveBackendDataDir({ ...base, isPackaged: false })).toBe(
      '/Users/u/Library/Application Support/Agent-Team-dev'
    )
  })

  it('env override wins over the dev fallback', () => {
    expect(resolveBackendDataDir({ ...base, isPackaged: false, envOverride: '/pre/set' })).toBe('/pre/set')
  })

  it('uses the macOS default when packaged on darwin', () => {
    expect(resolveBackendDataDir(base)).toBe('/Users/u/Library/Application Support/Agent-Team')
  })

  it('uses XDG_DATA_HOME on non-macOS when set', () => {
    expect(
      resolveBackendDataDir({ ...base, platform: 'linux', homeDir: '/home/u', xdgDataHome: '/xdg/data' })
    ).toBe('/xdg/data/Agent-Team')
  })

  it('falls back to ~/.local/share on non-macOS without XDG_DATA_HOME', () => {
    expect(resolveBackendDataDir({ ...base, platform: 'linux', homeDir: '/home/u' })).toBe(
      '/home/u/.local/share/Agent-Team'
    )
  })

  it('uses %APPDATA% on Windows when set', () => {
    expect(
      resolveBackendDataDir({
        ...base,
        platform: 'win32',
        homeDir: 'C:\\Users\\u',
        appData: 'D:\\Roaming',
        xdgDataHome: '/xdg/data',
      })
    ).toBe('D:\\Roaming\\Agent-Team')
  })

  it('falls back to the profile Roaming dir on Windows without APPDATA', () => {
    expect(resolveBackendDataDir({ ...base, platform: 'win32', homeDir: 'C:\\Users\\u' })).toBe(
      'C:\\Users\\u\\AppData\\Roaming\\Agent-Team'
    )
  })

  // The contract: this must land on the same directory the backend's
  // osplat.paths.app_support_dir("Agent-Team") returns per platform, or the
  // two sides read different ui_settings.json files.
  it('pins the packaged default for all three platforms', () => {
    expect(resolveBackendDataDir({ ...base, platform: 'darwin' })).toBe(
      '/Users/u/Library/Application Support/Agent-Team'
    )
    expect(resolveBackendDataDir({ ...base, platform: 'linux', homeDir: '/home/u' })).toBe(
      '/home/u/.local/share/Agent-Team'
    )
    expect(
      resolveBackendDataDir({
        ...base,
        platform: 'win32',
        homeDir: 'C:\\Users\\u',
        appData: 'C:\\Users\\u\\AppData\\Roaming',
      })
    ).toBe('C:\\Users\\u\\AppData\\Roaming\\Agent-Team')
  })
})

describe('readUiSettingsText', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ui-settings-bootstrap-'))
    file = join(dir, UI_SETTINGS_FILE)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("returns '{}' when the file does not exist", () => {
    expect(readUiSettingsText(file)).toBe('{}')
  })

  it('returns the raw text of a valid settings object', () => {
    const text = JSON.stringify({ 'agent-team:theme': 'dark', 'agent-team:language': 'zh-TW' })
    writeFileSync(file, text, 'utf-8')
    expect(readUiSettingsText(file)).toBe(text)
  })

  it("returns '{}' for corrupt JSON", () => {
    writeFileSync(file, '{"agent-team:theme": "da', 'utf-8')
    expect(readUiSettingsText(file)).toBe('{}')
  })

  it("returns '{}' when the root is not an object", () => {
    for (const bad of ['[1,2]', '"str"', '42', 'null']) {
      writeFileSync(file, bad, 'utf-8')
      expect(readUiSettingsText(file)).toBe('{}')
    }
  })
})
