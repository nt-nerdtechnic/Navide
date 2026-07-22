export type UpdateStatus =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'not-available'
  | 'error'

export interface UpdateState {
  status: UpdateStatus
  currentVersion: string
  availableVersion?: string
  percent?: number
  message?: string
  checkedAt?: string
  releaseNotes?: string
}

export interface UpdateActionResult {
  ok: boolean
  state: UpdateState
  error?: string
}

export type UpdateChannel = 'stable' | 'beta'

export interface UpdaterSettings {
  autoCheck: boolean
  autoDownload: boolean
  channel: UpdateChannel
}

export interface UpdateSettingsResult {
  ok: boolean
  settings: UpdaterSettings
  error?: string
}
