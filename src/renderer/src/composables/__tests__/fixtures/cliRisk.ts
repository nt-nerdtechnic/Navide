import type { CliRiskPaneState, CliRiskSignal } from '../../../lib/cliRisk'

/** Wire v1 projections: tests supply observations, never derive findings in the renderer. */
export function networkSignal(over: Partial<CliRiskSignal> = {}): CliRiskSignal {
  return {
    id: 'network:codex:198.51.100.25:443',
    kind: 'network', severity: 'yellow', vendor: 'codex', scope: 'pane',
    firstObservedAt: '2026-09-21T01:10:00Z',
    lastObservedAt: '2026-09-21T01:22:00Z',
    expectedSetObservedAt: '2026-09-21T01:21:00Z',
    stale: false, ip: '198.51.100.25', port: 443, connections: 2,
    ...over,
  }
}

export function diskSignal(over: Partial<CliRiskSignal> = {}): CliRiskSignal {
  return {
    id: 'disk:codex:opaque', kind: 'disk', severity: 'red', vendor: 'codex', scope: 'vendor',
    firstObservedAt: '2026-09-21T01:05:00Z',
    lastObservedAt: '2026-09-21T01:20:00Z',
    absentObservedAt: '2026-09-21T01:10:00Z',
    stale: false, path: '/vendor-data/pending/archive.enc', bytes: 313 * 1024 * 1024, sizeClass: 3,
    ...over,
  }
}

export function riskState(signals: CliRiskSignal[] = [networkSignal()]): CliRiskPaneState {
  return {
    signals,
    network: { status: 'successful', lastSuccessAt: '2026-09-21T01:22:00Z' },
    disk: { status: 'successful', lastSuccessAt: '2026-09-21T01:20:00Z' },
  }
}
