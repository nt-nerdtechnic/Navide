import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Zero-flash startup settings: the renderer needs theme/language before first
// paint, so the main process reads the backend-owned ui_settings.json
// synchronously and hands the raw JSON text to the renderer over sendSync IPC
// ('settings:bootstrap'). The backend writes the file atomically (.tmp →
// os.replace), so a read observes either the old or the new complete document,
// never a torn write.

export const UI_SETTINGS_FILE = 'ui_settings.json'

export interface BackendDataDirInputs {
  /** AGENT_TEAM_DATA_DIR override (set by launchers; wins over defaults). */
  envOverride?: string
  /** app.isPackaged — dev backends are pointed at a separate state dir. */
  isPackaged: boolean
  /** app.getPath('appData') — base for the dev-mode state dir. */
  appDataPath: string
  platform: NodeJS.Platform
  homeDir: string
  /** XDG_DATA_HOME, non-macOS fallback (mirrors applog.app_data_dir). */
  xdgDataHome?: string
}

/**
 * Resolve the backend's app-data dir on the TS side.
 *
 * Mirrors backend applog.app_data_dir() (env override → macOS default → XDG
 * fallback) plus the dev-mode override backend.ts injects into the spawned
 * backend's env (<appData>/Agent-Team-dev) so both sides read the same file.
 */
export function resolveBackendDataDir(inputs: BackendDataDirInputs): string {
  const { envOverride, isPackaged, appDataPath, platform, homeDir, xdgDataHome } = inputs
  if (envOverride) {
    // Python-side does expanduser(); cover the common ~ / ~/ forms.
    if (envOverride === '~') return homeDir
    if (envOverride.startsWith('~/')) return join(homeDir, envOverride.slice(2))
    return envOverride
  }
  if (!isPackaged) return join(appDataPath, 'Agent-Team-dev')
  if (platform === 'darwin') return join(homeDir, 'Library', 'Application Support', 'Agent-Team')
  const base = xdgDataHome || join(homeDir, '.local', 'share')
  return join(base, 'Agent-Team')
}

/**
 * Read ui_settings.json as text for the bootstrap IPC. Returns '{}' when the
 * file is missing, unreadable, or does not parse to a JSON object — the
 * renderer then falls back to defaults and reconciles over ws later.
 */
export function readUiSettingsText(filePath: string): string {
  try {
    const text = readFileSync(filePath, 'utf-8')
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return '{}'
    return text
  } catch {
    return '{}'
  }
}
