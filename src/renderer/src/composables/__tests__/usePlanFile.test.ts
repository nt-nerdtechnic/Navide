import { describe, it, expect } from 'vitest'
import {
  parsePlanFile,
  planProgress,
  writePlanFile,
  replacePlanSectionBody,
  parsePlanMeta,
  writePlanMeta,
  toPlanMeta,
  deleteSection,
} from '../usePlanFile'

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

  it('normalizes Cursor-style status aliases and quoted scalar values', () => {
    const raw = `---
name: "Plan"
overview: "Desc"
todos:
  - id: t1
    content: "Completed task"
    status: completed
  - id: t2
    content: Active task
    status: in_progress
isProject: false
---
`
    const result = parsePlanFile(raw)!
    expect(result.name).toBe('Plan')
    expect(result.overview).toBe('Desc')
    expect(result.todos[0]).toEqual({ id: 't1', content: 'Completed task', status: 'done' })
    expect(result.todos[1].status).toBe('in-progress')
  })

  it('computes plan progress', () => {
    const result = parsePlanFile(SAMPLE_PLAN)!
    expect(planProgress(result.todos)).toEqual({
      total: 3,
      done: 1,
      inProgress: 1,
      pending: 1,
      complete: false,
    })
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

  it('syncs body checkboxes and status labels when they map 1:1 onto todos', () => {
    const raw = `---
name: P
overview: O
todos:
  - id: t1
    content: First
    status: pending
  - id: t2
    content: Second
    status: pending
isProject: false
---

# Detailed Todos

- [ ] status: pending | First
- [ ] status: pending | Second
`
    const plan = parsePlanFile(raw)!
    const updated = {
      ...plan,
      todos: plan.todos.map((t, i) => (i === 0 ? { ...t, status: 'done' as const } : t)),
    }
    const written = writePlanFile(updated, raw)
    expect(written).toContain('- [x] status: completed | First')
    expect(written).toContain('- [ ] status: pending | Second')
  })

  it('leaves body checkboxes untouched when counts do not match the todos', () => {
    const raw = `---
name: P
overview: O
todos:
  - id: t1
    content: Phase A
    status: pending
isProject: false
---

- [ ] status: pending | fine-grained one
- [ ] status: pending | fine-grained two
`
    const plan = parsePlanFile(raw)!
    const updated = { ...plan, todos: [{ ...plan.todos[0], status: 'done' as const }] }
    const written = writePlanFile(updated, raw)
    // Body untouched (2 checkboxes vs 1 todo), frontmatter updated.
    expect(written).toContain('- [ ] status: pending | fine-grained one')
    expect(written).toContain('- [ ] status: pending | fine-grained two')
    expect(written).toContain('    status: completed')
  })
})

describe('replacePlanSectionBody', () => {
  const RAW = `---
name: Doc Plan
overview: O
todos:
  - id: t1
    content: A
    status: pending
isProject: false
---

## Overview

Original overview body.

## Details

Detail one.
Detail two.

## Notes

Keep me.
`

  it('replaces only the targeted section body', () => {
    const out = replacePlanSectionBody(RAW, 'Details', 'Brand new detail.')
    expect(out).toContain('## Details\n\nBrand new detail.')
    expect(out).not.toContain('Detail one.')
    expect(out).not.toContain('Detail two.')
    // Neighbouring sections and their bodies stay intact.
    expect(out).toContain('## Overview\n\nOriginal overview body.')
    expect(out).toContain('## Notes\n\nKeep me.')
  })

  it('preserves the frontmatter byte-for-byte', () => {
    const out = replacePlanSectionBody(RAW, 'Overview', 'New overview.')
    const frontmatter = RAW.slice(0, RAW.indexOf('\n---', 3) + 4)
    expect(out.startsWith(frontmatter)).toBe(true)
  })

  it('replaces the last section up to end of file', () => {
    const out = replacePlanSectionBody(RAW, 'Notes', 'Replaced tail.')
    expect(out).toContain('## Notes\n\nReplaced tail.')
    expect(out).not.toContain('Keep me.')
    expect(out).toContain('## Details\n\nDetail one.\nDetail two.')
  })

  it('returns the input unchanged when the heading is not found', () => {
    const out = replacePlanSectionBody(RAW, 'Nonexistent', 'x')
    expect(out).toBe(RAW)
  })

  it('targets the first occurrence when a heading is duplicated', () => {
    const dup = `---
name: D
---

## Dup

first body.

## Dup

second body.
`
    const out = replacePlanSectionBody(dup, 'Dup', 'edited first.')
    expect(out).toContain('## Dup\n\nedited first.')
    expect(out).toContain('## Dup\n\nsecond body.')
    expect(out).not.toContain('first body.')
  })

  it('does not treat frontmatter lines as headings', () => {
    const withHashInFm = `---
name: P
overview: "## not a heading"
---

## Real

body.
`
    const out = replacePlanSectionBody(withHashInFm, 'Real', 'edited.')
    expect(out).toContain('overview: "## not a heading"')
    expect(out).toContain('## Real\n\nedited.')
  })

  it('normalises surrounding blank lines from the new body', () => {
    const out = replacePlanSectionBody(RAW, 'Details', '\n\nSpaced body.\n\n')
    expect(out).toContain('## Details\n\nSpaced body.\n\n## Notes')
  })
})

describe('backward-compatible stage defaults (legacy .plan.md without new fields)', () => {
  it('derives stage "draft" when the todo list is not fully done', () => {
    const result = parsePlanFile(SAMPLE_PLAN)!
    expect(result.stage).toBe('draft')
    expect(result.approvedAt).toBeNull()
    expect(result.reviewNotes).toEqual([])
    expect(result.executions).toBeUndefined()
    expect(result.isProject).toBe(false)
  })

  it('derives stage "done" when a non-empty todo list is all done', () => {
    const raw = `---
name: All Done
overview: O
todos:
  - id: t1
    content: A
    status: completed
  - id: t2
    content: B
    status: done
---

# Body
`
    expect(parsePlanFile(raw)!.stage).toBe('done')
  })

  it('honours an explicit stage over the derived default', () => {
    const raw = `---
name: Explicit
overview: O
stage: approved
approvedAt: "2026-07-20T00:00:00Z"
todos: []
---

# Body
`
    const result = parsePlanFile(raw)!
    expect(result.stage).toBe('approved')
    expect(result.approvedAt).toBe('2026-07-20T00:00:00Z')
  })
})

describe('parsePlanMeta / writePlanMeta (unified model)', () => {
  const META_PLAN = `---
name: Meta Plan
overview: Full meta plan.
stage: in-progress
approvedAt: "2026-07-19T10:00:00Z"
todos:
  - id: t1
    content: First
    status: skipped
  - id: t2
    content: Second
    status: in_progress
reviewNotes:
  - id: n1
    author: user
    text: Please clarify the scope.
    resolved: false
    reply: ""
    anchor: Goals
executions:
  - agent: claude
    startedAt: "2026-07-19T11:00:00Z"
isProject: true
---

# Goals

Body content preserved verbatim.

## Phase A

Some text.
`

  it('parses stage, approvedAt, reviewNotes, executions and 4-value todo status', () => {
    const meta = parsePlanMeta(META_PLAN)!
    expect(meta.schemaVersion).toBe(1)
    expect(meta.format).toBe('markdown')
    expect(meta.stage).toBe('in-progress')
    expect(meta.approvedAt).toBe('2026-07-19T10:00:00Z')
    expect(meta.isProject).toBe(true)
    expect(meta.todos[0].status).toBe('skipped')
    expect(meta.todos[1].status).toBe('in-progress')
    expect(meta.reviewNotes).toHaveLength(1)
    expect(meta.reviewNotes[0]).toMatchObject({
      id: 'n1',
      author: 'user',
      text: 'Please clarify the scope.',
      resolved: false,
      reply: '',
      anchor: 'Goals',
    })
    expect(meta.executions).toEqual([{ agent: 'claude', startedAt: '2026-07-19T11:00:00Z' }])
  })

  it('round-trips a full meta plan without losing stage / reviewNotes / executions', () => {
    const meta = parsePlanMeta(META_PLAN)!
    const written = writePlanMeta(meta, META_PLAN)
    const reparsed = parsePlanMeta(written)!
    expect(reparsed.stage).toBe('in-progress')
    expect(reparsed.approvedAt).toBe('2026-07-19T10:00:00Z')
    expect(reparsed.isProject).toBe(true)
    expect(reparsed.todos.map((t) => ({ id: t.id, status: t.status }))).toEqual([
      { id: 't1', status: 'skipped' },
      { id: 't2', status: 'in-progress' },
    ])
    expect(reparsed.reviewNotes).toEqual(meta.reviewNotes)
    expect(reparsed.executions).toEqual(meta.executions)
  })

  it('preserves the markdown body byte-for-byte on write', () => {
    const meta = parsePlanMeta(META_PLAN)!
    const written = writePlanMeta(meta, META_PLAN)
    const bodyOf = (raw: string): string => raw.slice(raw.indexOf('\n---', 3) + 4)
    expect(bodyOf(written)).toBe(bodyOf(META_PLAN))
  })

  it('reads and writes the skipped status through the meta path', () => {
    const raw = `---
name: Skips
overview: O
todos:
  - id: t1
    content: Skip me
    status: skipped
---

# Body
`
    const meta = parsePlanMeta(raw)!
    expect(meta.todos[0].status).toBe('skipped')
    const written = writePlanMeta(meta, raw)
    expect(written).toContain('status: skipped')
    expect(parsePlanMeta(written)!.todos[0].status).toBe('skipped')
  })

  it('omits the executions block entirely when empty or undefined', () => {
    const meta = parsePlanMeta(SAMPLE_PLAN)!
    expect(meta.executions).toBeUndefined()
    const written = writePlanMeta(meta, SAMPLE_PLAN)
    expect(written).not.toContain('executions')
  })

  it('escapes YAML special characters in review note text/reply', () => {
    const meta = parsePlanMeta(SAMPLE_PLAN)!
    meta.reviewNotes = [
      {
        id: 'n1',
        author: 'ai',
        text: 'key: value, and a "quoted" phrase',
        resolved: true,
        reply: "it's fine: really",
        anchor: '',
      },
    ]
    const written = writePlanMeta(meta, SAMPLE_PLAN)
    const reparsed = parsePlanMeta(written)!
    expect(reparsed.reviewNotes[0].text).toBe('key: value, and a "quoted" phrase')
    expect(reparsed.reviewNotes[0].reply).toBe("it's fine: really")
    expect(reparsed.reviewNotes[0].resolved).toBe(true)
  })

  it('bridges a legacy ParsedPlan to PlanMeta via toPlanMeta', () => {
    const parsed = parsePlanFile(SAMPLE_PLAN)!
    const meta = toPlanMeta(parsed)
    expect(meta.format).toBe('markdown')
    expect(meta.schemaVersion).toBe(1)
    expect(meta.stage).toBe('draft')
    expect(meta.todos.map((t) => t.id)).toEqual(parsed.todos.map((t) => t.id))
  })
})

describe('deleteSection', () => {
  const RAW = `---
name: Doc Plan
overview: O
todos:
  - id: t1
    content: A
    status: pending
---

## Overview

Original overview body.

## Details

Detail one.
Detail two.

## Notes

Keep me.
`

  it('removes the targeted section and preserves the others', () => {
    const out = deleteSection(RAW, 'Details')
    expect(out).not.toContain('## Details')
    expect(out).not.toContain('Detail one.')
    expect(out).not.toContain('Detail two.')
    expect(out).toContain('## Overview\n\nOriginal overview body.')
    expect(out).toContain('## Notes\n\nKeep me.')
  })

  it('preserves the frontmatter byte-for-byte', () => {
    const out = deleteSection(RAW, 'Details')
    const frontmatter = RAW.slice(0, RAW.indexOf('\n---', 3) + 4)
    expect(out.startsWith(frontmatter)).toBe(true)
  })

  it('removes the last section up to end of file', () => {
    const out = deleteSection(RAW, 'Notes')
    expect(out).not.toContain('## Notes')
    expect(out).not.toContain('Keep me.')
    expect(out).toContain('## Details\n\nDetail one.\nDetail two.')
  })

  it('is a no-op when the heading is not found', () => {
    expect(deleteSection(RAW, 'Nonexistent')).toBe(RAW)
  })

  it('deletes only the first occurrence when a heading is duplicated', () => {
    const dup = `---
name: D
---

## Dup

first body.

## Keep

middle.

## Dup

second body.
`
    const out = deleteSection(dup, 'Dup')
    expect(out).not.toContain('first body.')
    expect(out).toContain('second body.')
    expect(out).toContain('## Keep\n\nmiddle.')
  })
})
