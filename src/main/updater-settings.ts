import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import type { UpdateChannel, UpdaterSettings } from '../shared/updater'

// Persisted user preferences for the auto-updater. The file lives under the
// Electron userData dir; the caller resolves the path (this module stays
// electron-free so it can be unit tested in isolation).
export const DEFAULT_UPDATER_SETTINGS: UpdaterSettings = {
  autoCheck: true,
  autoDownload: true,
  channel: 'stable',
}

function clampChannel(value: unknown): UpdateChannel {
  return value === 'beta' ? 'beta' : 'stable'
}

// Validate an arbitrary parsed document into a full UpdaterSettings, ignoring
// unknown fields and falling back to defaults for missing/invalid ones.
export function parseUpdaterSettingsDoc(text: string | null): UpdaterSettings {
  if (!text) return { ...DEFAULT_UPDATER_SETTINGS }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ...DEFAULT_UPDATER_SETTINGS }
  }
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_UPDATER_SETTINGS }
  const doc = raw as Record<string, unknown>
  return {
    autoCheck:
      typeof doc.autoCheck === 'boolean' ? doc.autoCheck : DEFAULT_UPDATER_SETTINGS.autoCheck,
    autoDownload:
      typeof doc.autoDownload === 'boolean'
        ? doc.autoDownload
        : DEFAULT_UPDATER_SETTINGS.autoDownload,
    channel: clampChannel(doc.channel),
  }
}

export function readUpdaterSettings(filePath: string): UpdaterSettings {
  try {
    return parseUpdaterSettingsDoc(readFileSync(filePath, 'utf-8'))
  } catch {
    return { ...DEFAULT_UPDATER_SETTINGS }
  }
}

// Merge a partial patch onto the current settings, re-validate, and persist
// atomically (write temp + rename). Returns the settings actually stored.
export function writeUpdaterSettings(
  filePath: string,
  patch: Partial<UpdaterSettings>,
): UpdaterSettings {
  const current = readUpdaterSettings(filePath)
  const merged: Record<string, unknown> = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) merged[key] = value
  }
  const next = parseUpdaterSettingsDoc(JSON.stringify(merged))
  const tmp = `${filePath}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8')
  renameSync(tmp, filePath)
  return next
}
