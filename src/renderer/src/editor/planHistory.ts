/**
 * planHistory.ts
 *
 * Pure helpers for the plan history panel (plan-doc-interactivity Phase C).
 * The backend writes stage-transition snapshots to
 * `.agent-team/plans/.history/<plan-stem>/<YYYYMMDDTHHMMSS>_<stage>.html`;
 * this module maps plan paths to their history directory, parses snapshot
 * filenames, and computes a lightweight summary diff between two plan
 * documents (meta-level changes plus line add/remove counts — no HTML diff
 * engine).
 */
import { parseHtmlPlanMeta } from '../composables/usePlanHtml'

/** History directory for a plan: `.agent-team/plans/.history/<stem>`. */
export function planHistoryDirRelPath(planRelPath: string): string {
  const name = planRelPath.slice(planRelPath.lastIndexOf('/') + 1)
  const stem = name.replace(/\.html$/, '')
  return `.agent-team/plans/.history/${stem}`
}

export interface PlanSnapshotName {
  /** Raw `YYYYMMDDTHHMMSS` timestamp — sortable lexicographically. */
  ts: string
  stage: string
  date: Date
}

const SNAPSHOT_NAME_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})_([a-z-]+)\.html$/

/** Parse a `<YYYYMMDDTHHMMSS>_<stage>.html` snapshot filename; null if not one. */
export function parseSnapshotName(name: string): PlanSnapshotName | null {
  const m = SNAPSHOT_NAME_RE.exec(name)
  if (!m) return null
  const [, y, mo, d, h, mi, s, stage] = m
  const month = Number(mo)
  const day = Number(d)
  const hour = Number(h)
  const min = Number(mi)
  const sec = Number(s)
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || min > 59 || sec > 59) {
    return null
  }
  return {
    ts: `${y}${mo}${d}T${h}${mi}${s}`,
    stage,
    date: new Date(Number(y), month - 1, day, hour, min, sec),
  }
}

export interface PlanDiffSummary {
  stageFrom: string | null
  stageTo: string | null
  todoChanges: Array<{ id: string; from: string; to: string }>
  todosAdded: number
  todosRemoved: number
  /** New review-note count minus old (signed). */
  notesDelta: number
  linesAdded: number
  linesRemoved: number
}

/**
 * Summary diff between two plan documents: stage/todo/note changes come from
 * the plan-meta blocks (null-safe when either side has none); line counts use
 * a simple per-line multiset comparison.
 */
export function diffPlanContents(oldContent: string, newContent: string): PlanDiffSummary {
  const oldMeta = parseHtmlPlanMeta(oldContent)?.meta ?? null
  const newMeta = parseHtmlPlanMeta(newContent)?.meta ?? null

  const oldTodos = new Map((oldMeta?.todos ?? []).map((todo) => [todo.id, todo.status]))
  const newTodos = new Map((newMeta?.todos ?? []).map((todo) => [todo.id, todo.status]))
  const todoChanges: Array<{ id: string; from: string; to: string }> = []
  let todosAdded = 0
  for (const [id, to] of newTodos) {
    const from = oldTodos.get(id)
    if (from === undefined) todosAdded++
    else if (from !== to) todoChanges.push({ id, from, to })
  }
  let todosRemoved = 0
  for (const id of oldTodos.keys()) {
    if (!newTodos.has(id)) todosRemoved++
  }

  // Line multiset: added = new lines without a matching old occurrence,
  // removed = old occurrences left unconsumed.
  const counts = new Map<string, number>()
  for (const line of oldContent.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1)
  let linesAdded = 0
  for (const line of newContent.split('\n')) {
    const remaining = counts.get(line) ?? 0
    if (remaining > 0) counts.set(line, remaining - 1)
    else linesAdded++
  }
  let linesRemoved = 0
  for (const remaining of counts.values()) linesRemoved += remaining

  return {
    stageFrom: oldMeta?.stage ?? null,
    stageTo: newMeta?.stage ?? null,
    todoChanges,
    todosAdded,
    todosRemoved,
    notesDelta: (newMeta?.reviewNotes.length ?? 0) - (oldMeta?.reviewNotes.length ?? 0),
    linesAdded,
    linesRemoved,
  }
}
