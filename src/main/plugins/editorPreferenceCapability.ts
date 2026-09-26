import {
  EDITOR_HOST_PREFERENCE_KEYS, EDITOR_WRITABLE_PREFERENCE_KEYS,
  type EditorHostPreferences,
} from '../../../packages/plugin-contracts/src/editorPreferences'
import { isJsonValue } from './pluginStorageJson'

export const EDITOR_PREFERENCE_METHODS = ['ui.readEditorPreferences', 'ui.writeEditorPreference'] as const
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export function isPreferenceJsonValue(value: unknown): boolean {
  return isJsonValue(value)
}

export function validateEditorPreferenceRequest(address: string, value: unknown): value is Record<string, unknown> {
  if (!record(value)) return false
  if (address === 'ui.readEditorPreferences') return Object.keys(value).length === 0
  return address === 'ui.writeEditorPreference' && Object.keys(value).every(key => key === 'key' || key === 'value') &&
    EDITOR_WRITABLE_PREFERENCE_KEYS.includes(value.key as typeof EDITOR_WRITABLE_PREFERENCE_KEYS[number]) &&
    isPreferenceJsonValue(value.value)
}

export function projectEditorPreferences(value: unknown): EditorHostPreferences {
  if (!record(value)) return {}
  return Object.fromEntries(Object.entries(value).filter(([key, item]) =>
    EDITOR_HOST_PREFERENCE_KEYS.includes(key as typeof EDITOR_HOST_PREFERENCE_KEYS[number]) && isPreferenceJsonValue(item),
  )) as EditorHostPreferences
}

export function validateEditorPreferencesEvent(value: unknown): boolean {
  return record(value) && Object.keys(value).every(key => key === 'preferences') && record(value.preferences) &&
    Object.keys(projectEditorPreferences(value.preferences)).length === Object.keys(value.preferences).length
}
