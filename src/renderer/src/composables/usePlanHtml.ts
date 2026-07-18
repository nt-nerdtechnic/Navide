/**
 * usePlanHtml.ts
 *
 * Parses and rewrites the `plan-meta` JSON island inside `.agent-team/plans/*.html`
 * plan documents. Contract: `.agent-team/plans/_spec.md` (schema v1).
 * Legacy `.plan.md` handling lives in usePlanFile.ts and is intentionally untouched.
 */

export const PLAN_STAGES = ['draft', 'in-review', 'approved', 'in-progress', 'done', 'abandoned'] as const
export type PlanStage = (typeof PLAN_STAGES)[number]

export const HTML_TODO_STATUSES = ['pending', 'in-progress', 'done', 'skipped'] as const
export type HtmlTodoStatus = (typeof HTML_TODO_STATUSES)[number]

export interface HtmlPlanTodo {
  id: string
  content: string
  status: HtmlTodoStatus
}

export interface HtmlPlanReviewNote {
  id: string
  author: 'user' | 'ai'
  text: string
  resolved: boolean
  reply: string
}

export interface HtmlPlanMeta {
  schemaVersion: 1
  name: string
  overview: string
  stage: PlanStage
  approvedAt: string | null
  todos: HtmlPlanTodo[]
  reviewNotes: HtmlPlanReviewNote[]
}

export interface HtmlPlanProgress {
  total: number
  done: number
}

// Matches the single machine-readable island. Attribute order tolerant; the
// spec guarantees exactly one such block per plan file.
const PLAN_META_RE = /<script\b[^>]*\bid="plan-meta"[^>]*>([\s\S]*?)<\/script>/

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Extract and validate the `plan-meta` JSON island.
 * Returns `null` when the block is missing, the JSON is malformed, or a hard
 * requirement fails (schemaVersion !== 1, name missing/empty) — callers treat
 * such files as plain docs. Recoverable issues (bad stage, bad todo status)
 * are downgraded to defaults and reported in `warnings`.
 */
export function parseHtmlPlanMeta(content: string): { meta: HtmlPlanMeta; warnings: string[] } | null {
  const match = content.match(PLAN_META_RE)
  if (!match) return null

  let raw: unknown
  try {
    raw = JSON.parse(match[1])
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>

  if (obj.schemaVersion !== 1) return null
  if (typeof obj.name !== 'string' || obj.name.trim() === '') return null

  const warnings: string[] = []

  let stage: PlanStage = 'draft'
  if (typeof obj.stage === 'string' && (PLAN_STAGES as readonly string[]).includes(obj.stage)) {
    stage = obj.stage as PlanStage
  } else {
    warnings.push(`invalid stage "${String(obj.stage)}" — downgraded to "draft"`)
  }

  const todos: HtmlPlanTodo[] = []
  if (Array.isArray(obj.todos)) {
    for (const entry of obj.todos) {
      if (typeof entry !== 'object' || entry === null) continue
      const t = entry as Record<string, unknown>
      let status: HtmlTodoStatus = 'pending'
      if (typeof t.status === 'string' && (HTML_TODO_STATUSES as readonly string[]).includes(t.status)) {
        status = t.status as HtmlTodoStatus
      } else {
        warnings.push(`invalid todo status "${String(t.status)}" on "${asString(t.id)}" — downgraded to "pending"`)
      }
      todos.push({ id: asString(t.id), content: asString(t.content), status })
    }
  }

  const reviewNotes: HtmlPlanReviewNote[] = []
  if (Array.isArray(obj.reviewNotes)) {
    for (const entry of obj.reviewNotes) {
      if (typeof entry !== 'object' || entry === null) continue
      const n = entry as Record<string, unknown>
      reviewNotes.push({
        id: asString(n.id),
        author: n.author === 'ai' ? 'ai' : 'user',
        text: asString(n.text),
        resolved: n.resolved === true,
        reply: asString(n.reply),
      })
    }
  }

  const meta: HtmlPlanMeta = {
    schemaVersion: 1,
    name: obj.name,
    overview: asString(obj.overview),
    stage,
    approvedAt: typeof obj.approvedAt === 'string' ? obj.approvedAt : null,
    todos,
    reviewNotes,
  }
  return { meta, warnings }
}

/**
 * Replace the JSON inside the `plan-meta` script block with the serialized
 * `meta` (2-space indent). Every byte outside the block is preserved verbatim.
 * Returns the input unchanged when no block is found.
 */
export function replaceHtmlPlanMeta(content: string, meta: HtmlPlanMeta): string {
  const match = content.match(PLAN_META_RE)
  if (!match || match.index === undefined) return content
  const openTagLength = match[0].length - match[1].length - '</script>'.length
  const innerStart = match.index + openTagLength
  const innerEnd = innerStart + match[1].length
  return `${content.slice(0, innerStart)}\n${JSON.stringify(meta, null, 2)}\n${content.slice(innerEnd)}`
}

/** done/total counts for list display; `skipped` counts toward neither. */
export function htmlPlanProgress(todos: HtmlPlanTodo[]): HtmlPlanProgress {
  return {
    total: todos.length,
    done: todos.filter((t) => t.status === 'done').length,
  }
}
