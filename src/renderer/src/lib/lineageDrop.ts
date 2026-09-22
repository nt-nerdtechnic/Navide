// Decision logic for the "drop a pane onto a sidebar row to make it that row's
// child" gesture. Pure: takes the dragged batch, the target and the pane list,
// answers with the writes to make or the reason the drop is refused. App.vue
// only wires drag events to this and runs the writes through reparentPane /
// persistPaneRunGroup. Kept out of the component so the refusals — which the
// backend enforces too — can be pre-checked on dragover without a round trip
// and without the row lighting up for a drop that would then bounce.

import { effectiveParents, withDescendants } from './paneLineage'

/** Same trailing-slash trim as workspaceGroups.ts: a workspace can be listed
 *  as `/x/` while its panes record `/x`, and the two must compare equal. */
const norm = (p: string): string => p.replace(/\/+$/, '')

/** The only fields of a pane this file reads. */
export interface LineageDropPane {
  id: string
  spawnedBy?: string
  workspacePath: string
  runGroupId?: string
}

export interface LineageWrite {
  paneId: string
  /** New parent id; '' makes the pane a root. */
  spawnedBy: string
}

export interface GroupWrite {
  paneId: string
  /** New run group id; '' is the ungrouped (manual) tab. */
  runGroupId: string
}

export type LineageDropRefusal =
  /** None of the dragged ids is a pane of this window (a drag from another window). */
  | 'unknown-pane'
  | 'unknown-target'
  /** The target is the dragged pane itself or another member of its batch. */
  | 'target-in-batch'
  /** The target hangs under one of the dragged panes — nesting would loop. */
  | 'cycle'
  | 'cross-workspace'
  /** Every dragged pane already hangs where the drop would put it. */
  | 'already-child'

export type LineageDropDecision =
  | {
      ok: true
      /** Parent changes, one per batch root, in `panes` order. */
      writes: LineageWrite[]
      /** Group moves so a nested pane (and its descendants) sit in the same
       *  run group as the new parent — the sidebar splits sections by each
       *  pane's own group while keeping the tree's depth, so a child left in
       *  another group renders indented under nothing and vanishes when the
       *  parent folds. Empty when everything is already in the right group. */
      groupWrites: GroupWrite[]
    }
  | { ok: false; reason: LineageDropRefusal }

/** Known batch ids in `panes` order, reduced to the batch's top-level members:
 *  a pane whose ancestor is also in the batch keeps its parent and travels
 *  with it. Re-parenting both would flatten a subtree the user selected as a
 *  whole (shift-range over parent and children). */
function batchRoots(batchIds: readonly string[], panes: readonly LineageDropPane[]): string[] {
  const batch = new Set(batchIds)
  const parents = effectiveParents(panes)
  return panes
    .filter((p) => batch.has(p.id))
    .filter((p) => {
      let cur = parents.get(p.id) ?? ''
      const seen = new Set<string>()
      while (cur && !seen.has(cur)) {
        if (batch.has(cur)) return false
        seen.add(cur)
        cur = parents.get(cur) ?? ''
      }
      return true
    })
    .map((p) => p.id)
}

/** Group moves that put `roots` and everything under them into `runGroupId`.
 *  Only the panes whose group actually differs, so a batch already in place
 *  writes nothing. */
function groupWritesFor(
  roots: readonly string[],
  runGroupId: string,
  panes: readonly LineageDropPane[],
): GroupWrite[] {
  const moving = new Set(withDescendants(roots, panes))
  return panes
    .filter((p) => moving.has(p.id) && (p.runGroupId ?? '') !== runGroupId)
    .map((p) => ({ paneId: p.id, runGroupId }))
}

/** Drop `batchIds` onto the row of `targetId`: every batch root becomes a
 *  child of the target. */
export function resolveLineageDrop(
  batchIds: readonly string[],
  targetId: string,
  panes: readonly LineageDropPane[],
): LineageDropDecision {
  const byId = new Map(panes.map((p) => [p.id, p]))
  const target = byId.get(targetId)
  if (!target) return { ok: false, reason: 'unknown-target' }
  const known = batchIds.filter((id) => byId.has(id))
  if (!known.length) return { ok: false, reason: 'unknown-pane' }
  if (known.includes(targetId)) return { ok: false, reason: 'target-in-batch' }
  if (known.some((id) => norm(byId.get(id)?.workspacePath ?? '') !== norm(target.workspacePath))) {
    return { ok: false, reason: 'cross-workspace' }
  }
  // Walk up from the target: an ancestor inside the batch means the target
  // is a descendant of what is being dropped on it.
  const parents = effectiveParents(panes)
  const batch = new Set(known)
  const seen = new Set<string>()
  let cur = parents.get(targetId) ?? ''
  while (cur && !seen.has(cur)) {
    if (batch.has(cur)) return { ok: false, reason: 'cycle' }
    seen.add(cur)
    cur = parents.get(cur) ?? ''
  }

  const roots = batchRoots(known, panes)
  const writes = roots
    .filter((id) => (byId.get(id)?.spawnedBy ?? '') !== targetId)
    .map((id) => ({ paneId: id, spawnedBy: targetId }))
  if (!writes.length) return { ok: false, reason: 'already-child' }
  return { ok: true, writes, groupWrites: groupWritesFor(roots, target.runGroupId ?? '', panes) }
}

/** Drop `batchIds` onto a run group's header row: every batch root becomes a
 *  root of the lineage, and the batch (with descendants) moves into that
 *  group. A pane that is already a root of that group is left alone. */
export function resolveRootDrop(
  batchIds: readonly string[],
  workspacePath: string,
  runGroupId: string,
  panes: readonly LineageDropPane[],
): LineageDropDecision {
  const byId = new Map(panes.map((p) => [p.id, p]))
  const known = batchIds.filter((id) => byId.has(id))
  if (!known.length) return { ok: false, reason: 'unknown-pane' }
  if (known.some((id) => norm(byId.get(id)?.workspacePath ?? '') !== norm(workspacePath))) {
    return { ok: false, reason: 'cross-workspace' }
  }
  const roots = batchRoots(known, panes)
  // The raw pointer, not effectiveParents: a pane whose parent is closed or in
  // another window is drawn as a root but still records that parent, and the
  // record is what a restore reads — leave it and the pane tucks itself back
  // under the parent the moment it comes back.
  const writes = roots
    .filter((id) => (byId.get(id)?.spawnedBy ?? '') !== '')
    .map((id) => ({ paneId: id, spawnedBy: '' }))
  const groupWrites = groupWritesFor(roots, runGroupId, panes)
  if (!writes.length && !groupWrites.length) return { ok: false, reason: 'already-child' }
  return { ok: true, writes, groupWrites }
}
