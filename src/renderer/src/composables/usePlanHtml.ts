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
  /** Unknown fields are preserved verbatim for forward compatibility. */
  [key: string]: unknown
}

export interface HtmlPlanReviewNote {
  id: string
  author: 'user' | 'ai'
  text: string
  resolved: boolean
  reply: string
  /** Optional section anchor (outline heading text); '' when not anchored. */
  anchor: string
  /** Unknown fields are preserved verbatim for forward compatibility. */
  [key: string]: unknown
}

/** One dispatch record: which agent was sent to execute the plan, and when. */
export interface PlanExecution {
  agent: string
  startedAt: string
  /** Unknown fields are preserved verbatim for forward compatibility. */
  [key: string]: unknown
}

export interface HtmlPlanMeta {
  schemaVersion: 1
  name: string
  overview: string
  stage: PlanStage
  approvedAt: string | null
  todos: HtmlPlanTodo[]
  reviewNotes: HtmlPlanReviewNote[]
  /** Optional dispatch log; absent means never dispatched. */
  executions?: PlanExecution[]
  /** Unknown fields are preserved verbatim for forward compatibility. */
  [key: string]: unknown
}

export interface HtmlPlanProgress {
  total: number
  done: number
}

// Matches the single machine-readable island. Attribute order tolerant; the
// spec guarantees exactly one such block per plan file. Case-insensitive and
// quote-style tolerant; the `\s` before `id` keeps `data-id="plan-meta"`
// from matching.
const PLAN_META_RE = /<script\b[^>]*\s(?:id="plan-meta"|id='plan-meta')[^>]*>([\s\S]*?)<\/script>/i

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
      todos.push({ ...t, id: asString(t.id), content: asString(t.content), status })
    }
  }

  const reviewNotes: HtmlPlanReviewNote[] = []
  if (Array.isArray(obj.reviewNotes)) {
    for (const entry of obj.reviewNotes) {
      if (typeof entry !== 'object' || entry === null) continue
      const n = entry as Record<string, unknown>
      reviewNotes.push({
        ...n,
        id: asString(n.id),
        author: n.author === 'ai' ? 'ai' : 'user',
        text: asString(n.text),
        resolved: n.resolved === true,
        reply: asString(n.reply),
        anchor: asString(n.anchor),
      })
    }
  }

  let executions: PlanExecution[] | undefined
  if (obj.executions !== undefined) {
    if (Array.isArray(obj.executions)) {
      executions = []
      for (const entry of obj.executions) {
        if (typeof entry !== 'object' || entry === null) continue
        const e = entry as Record<string, unknown>
        executions.push({ ...e, agent: asString(e.agent), startedAt: asString(e.startedAt) })
      }
    } else {
      warnings.push('invalid executions (not an array) — dropped')
    }
  }

  // Spread first so unknown top-level fields survive the round-trip; known
  // fields are then overwritten with their validated values (spread keeps the
  // original key positions, so serialization order is stable).
  const meta: HtmlPlanMeta = {
    ...obj,
    schemaVersion: 1,
    name: obj.name,
    overview: asString(obj.overview),
    stage,
    approvedAt: typeof obj.approvedAt === 'string' ? obj.approvedAt : null,
    todos,
    reviewNotes,
  }
  if (executions !== undefined) meta.executions = executions
  else delete meta.executions
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
  // JSON-escape every "<" (unicode escape) so strings like "</script>" or
  // "<!--" in the meta cannot terminate the script block early. JSON
  // semantics are unchanged; JSON.parse decodes the escape back natively.
  const json = JSON.stringify(meta, null, 2).replace(/</g, '\\u003c')
  return `${content.slice(0, innerStart)}\n${json}\n${content.slice(innerEnd)}`
}

/** done/total counts for list display; `skipped` counts toward neither. */
export function htmlPlanProgress(todos: HtmlPlanTodo[]): HtmlPlanProgress {
  return {
    total: todos.length,
    done: todos.filter((t) => t.status === 'done').length,
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Sync the visible todo markup with a status change: update the `data-status`
 * attribute on the `<li data-todo-id="...">` element and the text of its
 * `<span class="st">` status pill. Returns the content unchanged when the
 * markup is not found — meta stays authoritative, markup sync is best-effort.
 */
export function syncTodoMarkup(content: string, todoId: string, status: HtmlTodoStatus): string {
  const liRe = new RegExp(`<li\\b[^>]*data-todo-id=["']${escapeRegExp(todoId)}["'][^>]*>`, 'i')
  const match = content.match(liRe)
  if (!match || match.index === undefined) return content

  const openTag = match[0].replace(/data-status=["'][^"']*["']/i, `data-status="${status}"`)
  const afterTag = match.index + match[0].length
  const closeIdx = content.indexOf('</li>', afterTag)
  const scopeEnd = closeIdx === -1 ? content.length : closeIdx
  const scope = content
    .slice(afterTag, scopeEnd)
    .replace(/(<span\b[^>]*class=["']st["'][^>]*>)[\s\S]*?(<\/span>)/i, `$1${status}$2`)
  return content.slice(0, match.index) + openTag + scope + content.slice(scopeEnd)
}

/**
 * Sync the header stage pill with a stage change: rewrite the stage class on
 * the first `<span class="pill ...">` and its visible text. Returns the
 * content unchanged when no pill markup is found.
 */
export function syncStageMarkup(content: string, stage: PlanStage): string {
  return content.replace(
    /(<span\b[^>]*class=["']pill\s+)[a-z-]+(["'][^>]*>)[\s\S]*?(<\/span>)/i,
    `$1${stage}$2${stage}$3`,
  )
}

/**
 * Inject a `plan-meta` JSON island into a plain HTML doc, promoting it to a
 * plan. Inserted before `</head>` when present, otherwise right after the
 * `<html>` open tag, otherwise prepended. Returns the content unchanged when
 * an island already exists.
 */
export function injectPlanMeta(content: string, meta: HtmlPlanMeta): string {
  if (PLAN_META_RE.test(content)) return content
  const json = JSON.stringify(meta, null, 2).replace(/</g, '\\u003c')
  const block = `<script type="application/json" id="plan-meta">\n${json}\n</script>\n`
  const headClose = content.search(/<\/head>/i)
  if (headClose !== -1) return content.slice(0, headClose) + block + content.slice(headClose)
  const htmlOpen = content.match(/<html\b[^>]*>/i)
  if (htmlOpen && htmlOpen.index !== undefined) {
    const at = htmlOpen.index + htmlOpen[0].length
    return `${content.slice(0, at)}\n${block}${content.slice(at)}`
  }
  return block + content
}
