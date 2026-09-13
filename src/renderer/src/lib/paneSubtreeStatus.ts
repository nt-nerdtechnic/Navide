// What a parent pane's row says about the panes it spawned.
//
// A pane's own status pill only says what ITS terminal is doing. A parent that
// has handed work to spawned children sits idle while they run, and once the
// family is folded nothing on screen says so — a child parked on a permission
// prompt was invisible until the user happened to unfold it. Every pane list
// paints the same "↳ n" beside the parent from this one computation, so the
// sidebar and the main-window lists cannot disagree about who is busy.
import type { PaneStatusValue } from './paneStatusLabel'
import { rollupPaneStatus } from './paneStatusRollup'
import { effectiveParents } from './paneLineage'

/** The only fields of a pane this file reads. */
export interface SubtreePane {
  id: string
  spawnedBy?: string
  status: string
}

export interface SubtreeSignal {
  /** The loudest status among every descendant (rollupPaneStatus, so a child
   *  waiting on the user outranks one that is merely running). */
  state: PaneStatusValue
  /** How many descendants are in that state. */
  count: number
}

/** The subtree states worth a badge. Everything from idle down is "nothing to
 *  report" — the parent's row then looks exactly as it did before this badge
 *  existed. */
const SIGNAL_STATES: ReadonlySet<PaneStatusValue> = new Set<PaneStatusValue>([
  'awaiting',
  'error',
  'running',
  'starting',
])

/** Each parent's subtree signal, keyed by pane id; parents with nothing to
 *  report are absent.
 *
 *  Walks `spawnedBy` over ALL panes rather than the rows a list happens to
 *  draw, so folding a family cannot hide the very thing this exists to
 *  surface. Kept out of the pane's own `status` on purpose: that field paints
 *  count pills and group keys too, and a parent must not count as running
 *  there when it is not. */
export function subtreeSignals(panes: readonly SubtreePane[]): Map<string, SubtreeSignal> {
  const parents = effectiveParents(panes)
  const childrenOf = new Map<string, string[]>()
  for (const p of panes) {
    const parent = parents.get(p.id) ?? ''
    if (!parent) continue
    const bucket = childrenOf.get(parent)
    if (bucket) bucket.push(p.id)
    else childrenOf.set(parent, [p.id])
  }
  const statusById = new Map(panes.map((p) => [p.id, p.status]))
  const out = new Map<string, SubtreeSignal>()
  for (const id of childrenOf.keys()) {
    const statuses: string[] = []
    // effectiveParents has already rerooted any cycle, so this cannot loop.
    const stack = [...(childrenOf.get(id) ?? [])]
    while (stack.length) {
      const child = stack.pop() as string
      statuses.push(statusById.get(child) ?? '')
      stack.push(...(childrenOf.get(child) ?? []))
    }
    const state = rollupPaneStatus(statuses)
    if (!state || !SIGNAL_STATES.has(state)) continue
    out.set(id, { state, count: statuses.filter((st) => st === state).length })
  }
  return out
}
