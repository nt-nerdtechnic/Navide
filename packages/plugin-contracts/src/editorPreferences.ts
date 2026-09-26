import type { JsonValue } from './index.js'

/** Existing Host settings consumed by editor composition; not Plugin Storage. */
export const EDITOR_HOST_PREFERENCE_KEYS = [
  'agentTeam.yolo', 'agentTeam.analyzerModel', 'agent-team:theme',
  'agent-team:theme-custom', 'agent-team:language', 'agentTeam.uiScale',
  'agentTeam.git.logScope', 'agentTeam.git.logOrder',
  'agentTeam.git.autoCommit', 'agentTeam.gitTopRatio',
] as const
export const EDITOR_WRITABLE_PREFERENCE_KEYS = [
  'agent-team:theme', 'agent-team:theme-custom',
  'agentTeam.git.logScope', 'agentTeam.git.logOrder',
  'agentTeam.git.autoCommit', 'agentTeam.gitTopRatio',
] as const
export type EditorHostPreferenceKey = typeof EDITOR_HOST_PREFERENCE_KEYS[number]
export type EditorWritablePreferenceKey = typeof EDITOR_WRITABLE_PREFERENCE_KEYS[number]
export type EditorHostPreferences = Partial<Record<EditorHostPreferenceKey, JsonValue>>
export interface EditorPreferenceParams {
  'ui.readEditorPreferences': Record<string, never>
  'ui.writeEditorPreference': { key: EditorWritablePreferenceKey; value: JsonValue }
}
export interface EditorPreferenceResults {
  'ui.readEditorPreferences': { preferences: EditorHostPreferences }
  'ui.writeEditorPreference': { ok: boolean }
}
export interface EditorPreferenceEvents {
  'ui.editorPreferencesChanged': { preferences: EditorHostPreferences }
}
