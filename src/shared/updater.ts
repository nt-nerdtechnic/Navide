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
}

export interface UpdateActionResult {
  ok: boolean
  state: UpdateState
  error?: string
}
