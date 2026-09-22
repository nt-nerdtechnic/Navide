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
  /** Label of the enabled shared-CDN range holding `ip`: recorded, never lights the pill. */
  sharedCdn?: string
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

/** A shared-CDN range row from `cli_risk.ranges.*`. */
export interface SharedRange {
  cidr: string
  label: string
  source: 'builtin' | 'user'
  enabled: boolean
  createdAt: number
  updatedAt: number
}

/** Shape check only; the backend is the authority (host bits, duplicates). */
export function looksLikeCidr(value: string): boolean {
  const match = /^([^/\s]+)\/(\d{1,3})$/.exec(value.trim())
  if (!match) return false
  const [, ip, bits] = match
  const prefix = Number(bits)
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return prefix <= 32 && ip.split('.').every((part) => Number(part) <= 255)
  return ip.includes(':') && /^[0-9a-fA-F:.]+$/.test(ip) && prefix <= 128
}
