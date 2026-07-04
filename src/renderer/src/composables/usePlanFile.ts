/**
 * usePlanFile.ts
 *
 * Parses and writes `.plan.md` files with YAML frontmatter.
 * No external YAML library required — the format is simple enough to handle inline.
 *
 * Frontmatter schema:
 *   name: string
 *   overview: string
 *   todos:
 *     - id: string
 *       content: string
 *       status: 'pending' | 'in-progress' | 'done'
 *   isProject: boolean
 */

export type TodoStatus = 'pending' | 'in-progress' | 'done'
export type RawTodoStatus = TodoStatus | 'completed' | 'in_progress' | 'complete' | 'finished'

export interface PlanTodo {
  id: string
  content: string
  status: TodoStatus
}

export interface PlanSection {
  heading: string
  body: string
}

export interface ParsedPlan {
  name: string
  overview: string
  todos: PlanTodo[]
  sections: PlanSection[]
  isProject: boolean
}

export interface PlanProgress {
  total: number
  done: number
  inProgress: number
  pending: number
  complete: boolean
}

export function normalizeTodoStatus(value: string): TodoStatus {
  const v = value.trim().toLowerCase().replace(/_/g, '-')
  if (v === 'done' || v === 'completed' || v === 'complete' || v === 'finished') return 'done'
  if (v === 'in-progress' || v === 'inprogress' || v === 'active') return 'in-progress'
  return 'pending'
}

export function planProgress(todos: PlanTodo[]): PlanProgress {
  const done = todos.filter((t) => t.status === 'done').length
  const inProgress = todos.filter((t) => t.status === 'in-progress').length
  const pending = todos.length - done - inProgress
  return {
    total: todos.length,
    done,
    inProgress,
    pending,
    complete: todos.length > 0 && done === todos.length,
  }
}

/** Serialize a status back to the Cursor-compatible alias used on disk. */
function serializeStatus(status: TodoStatus): string {
  if (status === 'done') return 'completed'
  if (status === 'in-progress') return 'in_progress'
  return 'pending'
}

function unquoteYamlScalar(value: string): string {
  const v = value.trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1)
  }
  return v
}

/**
 * Split a `.plan.md` raw string into frontmatter YAML and markdown body.
 * Returns null if the file doesn't start with `---`.
 */
function splitFrontmatter(raw: string): { yaml: string; body: string } | null {
  if (!raw.startsWith('---')) return null
  const after = raw.slice(3)
  const end = after.indexOf('\n---')
  if (end === -1) return null
  return {
    yaml: after.slice(0, end).trim(),
    // Preserve the exact body after the closing `---` (typically starts with `\n`).
    body: after.slice(end + 4),
  }
}

/**
 * Parse the YAML frontmatter into a structured object.
 * Handles only the specific subset of YAML used in plan files.
 */
function parseYaml(yaml: string): { name: string; overview: string; todos: PlanTodo[]; isProject: boolean } | null {
  const lines = yaml.split('\n')
  let name = ''
  let overview = ''
  let isProject = false
  const todos: PlanTodo[] = []

  let inTodos = false
  let currentTodo: Partial<PlanTodo> | null = null

  function flushTodo(): void {
    if (currentTodo?.id && currentTodo.content !== undefined && currentTodo.status) {
      todos.push(currentTodo as PlanTodo)
    }
    currentTodo = null
  }

  for (const line of lines) {
    if (line.match(/^name:\s*/)) {
      name = unquoteYamlScalar(line.replace(/^name:\s*/, ''))
      inTodos = false
    } else if (line.match(/^overview:\s*/)) {
      overview = unquoteYamlScalar(line.replace(/^overview:\s*/, ''))
      inTodos = false
    } else if (line.match(/^isProject:\s*/)) {
      isProject = line.replace(/^isProject:\s*/, '').trim() === 'true'
      inTodos = false
    } else if (line.match(/^todos:\s*$/)) {
      inTodos = true
    } else if (inTodos && line.match(/^\s+-\s+id:\s*/)) {
      flushTodo()
      currentTodo = { id: unquoteYamlScalar(line.replace(/^\s+-\s+id:\s*/, '')), status: 'pending' }
    } else if (inTodos && currentTodo && line.match(/^\s+content:\s*/)) {
      currentTodo.content = unquoteYamlScalar(line.replace(/^\s+content:\s*/, ''))
    } else if (inTodos && currentTodo && line.match(/^\s+status:\s*/)) {
      const val = line.replace(/^\s+status:\s*/, '').trim()
      currentTodo.status = normalizeTodoStatus(val)
    } else if (line.match(/^\w/) && !line.match(/^todos:/)) {
      // Non-indented line means we've left the todos block.
      flushTodo()
      inTodos = false
    }
  }
  flushTodo()

  if (!name) return null
  return { name, overview, todos, isProject }
}

/**
 * Extract `## Heading` sections from the markdown body.
 * Each section includes everything up to the next `##` heading.
 */
function parseSections(body: string): PlanSection[] {
  const sections: PlanSection[] = []
  const lines = body.split('\n')
  let current: PlanSection | null = null

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+)/)
    if (headingMatch) {
      if (current) sections.push({ ...current, body: current.body.trimEnd() })
      current = { heading: headingMatch[1].trim(), body: '' }
    } else if (current) {
      current.body += line + '\n'
    }
  }
  if (current) sections.push({ ...current, body: current.body.trimEnd() })
  return sections
}

/**
 * Parse a raw `.plan.md` string.
 * Returns `null` when:
 *   - there is no valid `---` frontmatter
 *   - the YAML cannot be parsed (malformed)
 *   - the `name` field is missing (not a plan file)
 */
export function parsePlanFile(raw: string): ParsedPlan | null {
  const parts = splitFrontmatter(raw)
  if (!parts) return null

  const yamlData = parseYaml(parts.yaml)
  if (!yamlData) return null

  const sections = parseSections(parts.body)

  return {
    name: yamlData.name,
    overview: yamlData.overview,
    todos: yamlData.todos,
    sections,
    isProject: yamlData.isProject,
  }
}

/**
 * Serialize `todos` back into the original raw file, replacing only the
 * frontmatter block. The markdown body (everything after the second `---`)
 * is preserved character-for-character.
 *
 * Also synchronises `- [ ]` / `- [x]` body checkboxes to match each todo's status.
 */
export function writePlanFile(parsed: ParsedPlan, originalRaw: string): string {
  const parts = splitFrontmatter(originalRaw)
  if (!parts) return originalRaw

  // Rebuild the YAML frontmatter preserving non-todos lines, replacing todos block.
  const originalYamlLines = parts.yaml.split('\n')
  const newYamlLines: string[] = []

  let inTodos = false
  let todosWritten = false
  let currentItemIdx = -1

  for (const line of originalYamlLines) {
    if (line.match(/^todos:\s*$/)) {
      inTodos = true
      todosWritten = false
      newYamlLines.push(line)
      // Write all updated todos immediately after the `todos:` header.
      for (const todo of parsed.todos) {
        newYamlLines.push(`  - id: ${todo.id}`)
        newYamlLines.push(`    content: ${todo.content}`)
        newYamlLines.push(`    status: ${serializeStatus(todo.status)}`)
      }
      todosWritten = true
    } else if (inTodos && (line.match(/^\s+-\s+id:/) || line.match(/^\s+(content|status):/))) {
      // Skip original todo lines — we've already written the updated ones.
      continue
    } else {
      if (inTodos && !line.match(/^\s/) && !line.match(/^$/)) {
        // First non-indented, non-empty line after todos — done with todos block.
        inTodos = false
        void currentItemIdx
        void todosWritten
      }
      newYamlLines.push(line)
    }
  }

  // Frontmatter without a `todos:` block: append one so newly added todos persist.
  if (!todosWritten && parsed.todos.length > 0) {
    newYamlLines.push('todos:')
    for (const todo of parsed.todos) {
      newYamlLines.push(`  - id: ${todo.id}`)
      newYamlLines.push(`    content: ${todo.content}`)
      newYamlLines.push(`    status: ${serializeStatus(todo.status)}`)
    }
  }

  // Sync body checkboxes only when they map 1:1 onto the frontmatter todos.
  // Plans whose Detailed Todos are finer-grained than the phase-level todos
  // (more checkboxes than todos) would be corrupted by an order-based mapping,
  // so those bodies are left untouched.
  let body = parts.body
  const checkboxPattern = /^(\s*-\s+)\[[ x]\](\s*status:\s*[A-Za-z_-]+\s*\|)?/gm
  const boxCount = (body.match(checkboxPattern) ?? []).length
  if (boxCount === parsed.todos.length) {
    let todoIdx = 0
    body = body.replace(checkboxPattern, (_match, prefix: string, label?: string) => {
      const todo = parsed.todos[todoIdx++]
      if (!todo) return _match
      const mark = todo.status === 'done' ? 'x' : ' '
      const newLabel = label !== undefined ? ` status: ${serializeStatus(todo.status)} |` : ''
      return `${prefix}[${mark}]${newLabel}`
    })
  }

  // body already starts with `\n` (e.g. `\n\n# Goals...`), so no extra separator needed.
  return `---\n${newYamlLines.join('\n')}\n---${body}`
}
