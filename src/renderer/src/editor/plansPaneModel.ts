/**
 * plansPaneModel.ts
 *
 * Pure list-shaping helpers for PlansPane: search matching, within-group row
 * ordering, and the fail-safe localStorage persistence for the pane's stage
 * filter and sort choices. Extracted from PlansPane.vue so the logic is
 * unit-testable without mounting the component.
 */

export const PLAN_SORT_MODES = ['title', 'updated', 'progress'] as const
export type PlanSortMode = (typeof PLAN_SORT_MODES)[number]

export interface PlanSearchFields {
  title: string
  filename: string
  overview?: string
}

/** Case-insensitive substring match over title, filename and overview. */
export function planMatchesQuery(query: string, fields: PlanSearchFields): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    fields.title.toLowerCase().includes(q) ||
    fields.filename.toLowerCase().includes(q) ||
    (fields.overview ?? '').toLowerCase().includes(q)
  )
}

export interface SortablePlanRow {
  title: string
  /** File mtime in seconds; undefined when the backend did not report one. */
  mtime?: number
  done: number
  total: number
}

/**
 * Comparator for within-group ordering.
 * - 'title': locale order by plan title (the pane's historical default).
 * - 'updated': newest file mtime first; rows without an mtime sort last.
 * - 'progress': highest done/total ratio first; todo-less plans sort last.
 * Ties always fall back to title order so the result is stable.
 */
export function comparePlanRows(mode: PlanSortMode, a: SortablePlanRow, b: SortablePlanRow): number {
  if (mode === 'updated') {
    const diff = (b.mtime ?? 0) - (a.mtime ?? 0)
    if (diff !== 0) return diff
  } else if (mode === 'progress') {
    const ratio = (row: SortablePlanRow): number => (row.total > 0 ? row.done / row.total : -1)
    const diff = ratio(b) - ratio(a)
    if (diff !== 0) return diff
  }
  return a.title.localeCompare(b.title)
}

/**
 * Fail-safe localStorage read of a persisted choice: anything missing,
 * unreadable, or outside `allowed` falls back to `fallback` — a storage
 * problem must never break the pane (same contract as the collapse state).
 */
export function loadStoredChoice<T extends string>(
  storageKey: string,
  allowed: readonly T[],
  fallback: T,
): T {
  try {
    const raw = localStorage.getItem(storageKey)
    if (raw !== null && (allowed as readonly string[]).includes(raw)) return raw as T
    return fallback
  } catch {
    return fallback
  }
}

export function saveStoredChoice(storageKey: string, value: string): void {
  try {
    localStorage.setItem(storageKey, value)
  } catch {
    // Storage unavailable (quota/private mode) — persistence is best-effort.
  }
}
