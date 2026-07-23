// Pure path-rewrite helpers used to keep open editor tabs bound to files
// after the explorer renames or moves them (fs.rename), including folder
// renames that shift every open tab underneath the folder.

/**
 * Map a workspace-relative path across a rename/move of `oldRel` → `newRel`.
 * Returns the rebased path when `rel` is `oldRel` itself or lives under it
 * (folder rename/move), or `null` when unaffected. Prefix matching is
 * segment-aware: renaming `src/a` never touches `src/ab`.
 */
export function rebindPath(rel: string, oldRel: string, newRel: string): string | null {
  if (rel === oldRel) return newRel
  if (rel.startsWith(oldRel + '/')) return newRel + rel.slice(oldRel.length)
  return null
}

export interface RenameableTab {
  kind: string
  relPath: string
  name: string
}

/**
 * Rewrite the `relPath`/`name` of every open file tab affected by a
 * rename/move of `oldRel` → `newRel`, mutating the tabs in place (they are
 * reactive objects). Non-file tabs (diff/conflict/…, which use synthetic
 * relPath keys) and unaffected paths are left untouched.
 * Returns the affected tabs with their previous paths so the caller can
 * migrate any state keyed by the old relPath.
 */
export function rebindTabs<T extends RenameableTab>(
  tabs: T[],
  oldRel: string,
  newRel: string,
): Array<{ tab: T; prevRelPath: string }> {
  const moved: Array<{ tab: T; prevRelPath: string }> = []
  for (const tab of tabs) {
    if (tab.kind !== 'file') continue
    const next = rebindPath(tab.relPath, oldRel, newRel)
    if (next === null) continue
    moved.push({ tab, prevRelPath: tab.relPath })
    tab.relPath = next
    tab.name = next.split('/').pop() || next
  }
  return moved
}
