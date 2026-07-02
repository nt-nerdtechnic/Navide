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
      name = line.replace(/^name:\s*/, '').trim()
      inTodos = false
    } else if (line.match(/^overview:\s*/)) {
      overview = line.replace(/^overview:\s*/, '').trim()
      inTodos = false
    } else if (line.match(/^isProject:\s*/)) {
      isProject = line.replace(/^isProject:\s*/, '').trim() === 'true'
      inTodos = false
    } else if (line.match(/^todos:\s*$/)) {
      inTodos = true
    } else if (inTodos && line.match(/^\s+-\s+id:\s*/)) {
      flushTodo()
      currentTodo = { id: line.replace(/^\s+-\s+id:\s*/, '').trim(), status: 'pending' }
    } else if (inTodos && currentTodo && line.match(/^\s+content:\s*/)) {
      currentTodo.content = line.replace(/^\s+content:\s*/, '').trim()
    } else if (inTodos && currentTodo && line.match(/^\s+status:\s*/)) {
      const val = line.replace(/^\s+status:\s*/, '').trim()
      currentTodo.status = val === 'done' || val === 'in-progress' ? val : 'pending'
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
        newYamlLines.push(`    status: ${todo.status}`)
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

  // Sync body checkboxes: map each `- [ ]`/`- [x]` line to its corresponding todo.
  // We match todos to checkboxes in document order.
  let body = parts.body
  let todoIdx = 0
  body = body.replace(/^(\s*-\s+)\[[ x]\]/gm, (_match, prefix) => {
    const todo = parsed.todos[todoIdx++]
    if (!todo) return _match
    return `${prefix}[${todo.status === 'done' ? 'x' : ' '}]`
  })

  // body already starts with `\n` (e.g. `\n\n# Goals...`), so no extra separator needed.
  return `---\n${newYamlLines.join('\n')}\n---${body}`
}
