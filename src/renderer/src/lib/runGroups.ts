/** Pick a still-valid active tab after runGroups changed underneath us (e.g. a
 *  peer window deleted the group this window was viewing). Keeps the current tab
 *  if it still exists or is the special 'manual' tab; otherwise falls back to the
 *  last remaining group, or 'manual' when no groups remain. */
export function resolveActiveTab(groups: { id: string }[], current: string): string {
  if (current === 'manual') return current
  if (groups.some((g) => g.id === current)) return current
  return groups[groups.length - 1]?.id ?? 'manual'
}
