import { describe, it, expect } from 'vitest'
import { parsePlanFile, writePlanFile } from '../usePlanFile'

const SAMPLE_PLAN = `---
name: Test Plan
overview: A test plan for unit tests.
todos:
  - id: phase-a-first
    content: Do the first thing.
    status: pending
  - id: phase-a-second
    content: Do the second thing.
    status: done
  - id: phase-b-only
    content: Phase B task.
    status: in-progress
isProject: false
---

# Goals

Overview text.

## Phase A — First Phase

Some body content.

## Phase B — Second Phase

More content here.
`

describe('parsePlanFile', () => {
  it('parses name, overview, todos, and sections from a valid plan', () => {
    const result = parsePlanFile(SAMPLE_PLAN)
    expect(result).not.toBeNull()
    expect(result!.name).toBe('Test Plan')
    expect(result!.overview).toBe('A test plan for unit tests.')
    expect(result!.isProject).toBe(false)
    expect(result!.todos).toHaveLength(3)
  })

  it('parses todo fields correctly', () => {
    const result = parsePlanFile(SAMPLE_PLAN)!
    const t0 = result.todos[0]
    expect(t0.id).toBe('phase-a-first')
    expect(t0.content).toBe('Do the first thing.')
    expect(t0.status).toBe('pending')

    const t1 = result.todos[1]
    expect(t1.status).toBe('done')

    const t2 = result.todos[2]
    expect(t2.status).toBe('in-progress')
  })

  it('extracts ## sections from the markdown body', () => {
    const result = parsePlanFile(SAMPLE_PLAN)!
    const headings = result.sections.map((s) => s.heading)
    expect(headings).toContain('Phase A — First Phase')
    expect(headings).toContain('Phase B — Second Phase')
  })

  it('returns null for a file without frontmatter', () => {
    expect(parsePlanFile('# Just a markdown file\n\nNo frontmatter here.')).toBeNull()
  })

  it('returns null for a file with frontmatter that lacks a name field', () => {
    const noName = `---
overview: Something
todos: []
---

# Body
`
    expect(parsePlanFile(noName)).toBeNull()
  })

  it('returns null for malformed frontmatter (no closing ---)', () => {
    const malformed = `---
name: Broken
overview: No closing delimiter
`
    expect(parsePlanFile(malformed)).toBeNull()
  })

  it('defaults unknown status values to pending', () => {
    const raw = `---
name: Plan
overview: Desc
todos:
  - id: t1
    content: Task
    status: unknown-value
isProject: false
---
`
    const result = parsePlanFile(raw)!
    expect(result.todos[0].status).toBe('pending')
  })
})

describe('writePlanFile', () => {
  it('round-trips without changes when todos are unchanged', () => {
    const result = parsePlanFile(SAMPLE_PLAN)!
    const written = writePlanFile(result, SAMPLE_PLAN)
    // Re-parse the written content and check todos are the same.
    const reparsed = parsePlanFile(written)!
    expect(reparsed.todos.map((t) => ({ id: t.id, status: t.status }))).toEqual(
      result.todos.map((t) => ({ id: t.id, status: t.status }))
    )
  })

  it('updates a single todo status and preserves the markdown body', () => {
    const plan = parsePlanFile(SAMPLE_PLAN)!
    const updated = {
      ...plan,
      todos: plan.todos.map((t) =>
        t.id === 'phase-a-first' ? { ...t, status: 'done' as const } : t
      ),
    }
    const written = writePlanFile(updated, SAMPLE_PLAN)

    // Body content is preserved verbatim.
    const bodyStart = written.indexOf('\n---\n') + 5
    const originalBodyStart = SAMPLE_PLAN.indexOf('\n---\n') + 5
    expect(written.slice(bodyStart)).toBe(SAMPLE_PLAN.slice(originalBodyStart))

    // Frontmatter reflects the change.
    const reparsed = parsePlanFile(written)!
    const changedTodo = reparsed.todos.find((t) => t.id === 'phase-a-first')!
    expect(changedTodo.status).toBe('done')

    // Other todos unchanged.
    const other = reparsed.todos.find((t) => t.id === 'phase-a-second')!
    expect(other.status).toBe('done')
  })

  it('only modifies the YAML frontmatter block, not the markdown body', () => {
    const plan = parsePlanFile(SAMPLE_PLAN)!
    const updated = { ...plan, todos: plan.todos.map((t) => ({ ...t, status: 'done' as const })) }
    const written = writePlanFile(updated, SAMPLE_PLAN)

    // Markdown body (after the second ---) must be identical.
    const getBody = (raw: string): string => {
      const idx = raw.indexOf('\n---\n')
      return raw.slice(idx + 5)
    }
    expect(getBody(written)).toBe(getBody(SAMPLE_PLAN))
  })

  it('returns original raw when there is no frontmatter', () => {
    const raw = '# Just markdown'
    const plan = parsePlanFile(SAMPLE_PLAN)!
    expect(writePlanFile(plan, raw)).toBe(raw)
  })
})
