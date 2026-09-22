/**
 * Aggregates the mounted GitPane instances for one receiver close preparation.
 *
 * A pane that cannot classify itself fails closed as busy. Drafts are only
 * discarded after an explicit confirmation; a pane that became busy while the
 * user decided still refuses the whole preparation.
 */

export type PaneCloseState = 'accepted' | 'busy' | 'draft'

export type PaneCloseGuard = {
  getCloseState?: () => { state: PaneCloseState }
  setClosePrepared?: (prepared: boolean) => void
}

export type PaneCloseDecision =
  | { accepted: true }
  | { accepted: false; reason: 'busy' | 'refused' }

function stateOf(pane: PaneCloseGuard): PaneCloseState {
  return pane.getCloseState?.().state ?? 'busy'
}

export async function preparePaneClose(
  panes: readonly PaneCloseGuard[],
  confirmDiscard: () => Promise<boolean>,
): Promise<PaneCloseDecision> {
  for (const pane of panes) {
    if (stateOf(pane) === 'busy') return { accepted: false, reason: 'busy' }
  }
  if (panes.some((pane) => stateOf(pane) === 'draft')) {
    if (!(await confirmDiscard())) return { accepted: false, reason: 'refused' }
    for (const pane of panes) {
      if (stateOf(pane) === 'busy') return { accepted: false, reason: 'busy' }
    }
  }
  for (const pane of panes) pane.setClosePrepared?.(true)
  return { accepted: true }
}

export function releasePaneClose(panes: readonly PaneCloseGuard[]): void {
  for (const pane of panes) pane.setClosePrepared?.(false)
}
