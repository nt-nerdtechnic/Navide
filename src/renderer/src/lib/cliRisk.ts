/** Backend observations only; ordering, classification and persistence stay on the backend. */
export interface CliRiskSignal {
  id: string
  kind: 'network' | 'disk'
  severity: 'yellow' | 'red'
  vendor: string
  scope: 'pane' | 'vendor'
  firstObservedAt: string
  lastObservedAt: string
  stale: boolean
  ip?: string
  port?: number
  connections?: number
  path?: string
  bytes?: number
  sizeClass?: number
  absentObservedAt?: string
  expectedSetObservedAt?: string
}

export interface CliRiskObservation {
  status: 'successful' | 'unsupported' | 'unknown'
  lastSuccessAt?: string
}

export interface CliRiskPaneState {
  signals: CliRiskSignal[]
  network: CliRiskObservation
  disk: CliRiskObservation
}

export interface CliRiskProjection {
  cliRisks: Record<string, CliRiskPaneState>
}

export interface CliRiskAction {
  paneId: string
  signalId: string
  action: 'ignore' | 'allow'
}
