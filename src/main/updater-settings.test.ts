import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_UPDATER_SETTINGS,
  parseUpdaterSettingsDoc,
  readUpdaterSettings,
  writeUpdaterSettings,
} from './updater-settings'

describe('parseUpdaterSettingsDoc', () => {
  it('returns defaults for missing or corrupt content', () => {
    for (const text of [null, '', 'not json', '[]']) {
      expect(parseUpdaterSettingsDoc(text)).toEqual(DEFAULT_UPDATER_SETTINGS)
    }
  })

  it('fills missing fields with defaults and ignores unknown keys', () => {
    const parsed = parseUpdaterSettingsDoc(JSON.stringify({ autoCheck: false, extra: 'nope' }))
    expect(parsed).toEqual({ autoCheck: false, autoDownload: true, channel: 'stable' })
  })

  it('clamps the channel to the two allowed values', () => {
    expect(parseUpdaterSettingsDoc(JSON.stringify({ channel: 'beta' })).channel).toBe('beta')
    expect(parseUpdaterSettingsDoc(JSON.stringify({ channel: 'nightly' })).channel).toBe('stable')
    expect(parseUpdaterSettingsDoc(JSON.stringify({ channel: 42 })).channel).toBe('stable')
  })

  it('rejects non-boolean flags in favour of defaults', () => {
    const parsed = parseUpdaterSettingsDoc(JSON.stringify({ autoCheck: 'yes', autoDownload: 0 }))
    expect(parsed.autoCheck).toBe(true)
    expect(parsed.autoDownload).toBe(true)
  })
})

describe('readUpdaterSettings / writeUpdaterSettings', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'updater-settings-'))
    file = join(dir, 'updater-settings.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reads defaults when no file exists yet', () => {
    expect(readUpdaterSettings(file)).toEqual(DEFAULT_UPDATER_SETTINGS)
  })

  it('round-trips a merged patch', () => {
    const saved = writeUpdaterSettings(file, { autoDownload: false, channel: 'beta' })
    expect(saved).toEqual({ autoCheck: true, autoDownload: false, channel: 'beta' })
    expect(readUpdaterSettings(file)).toEqual(saved)
  })

  it('merges successive patches without dropping prior fields', () => {
    writeUpdaterSettings(file, { channel: 'beta' })
    writeUpdaterSettings(file, { autoCheck: false })
    expect(readUpdaterSettings(file)).toEqual({
      autoCheck: false,
      autoDownload: true,
      channel: 'beta',
    })
  })

  it('recovers to defaults when the file on disk is corrupt', () => {
    writeFileSync(file, '{truncated', 'utf-8')
    expect(readUpdaterSettings(file)).toEqual(DEFAULT_UPDATER_SETTINGS)
  })
})
