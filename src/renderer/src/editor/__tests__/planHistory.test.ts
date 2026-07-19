// Unit tests for the Phase C plan-history helpers: history dir mapping,
// snapshot filename parsing, and the meta-level + line-count summary diff.
import { describe, it, expect } from 'vitest'
import { diffPlanContents, parseSnapshotName, planHistoryDirRelPath } from '../planHistory'
import type { HtmlPlanMeta } from '../../composables/usePlanHtml'

describe('planHistoryDirRelPath', () => {
  it('maps a plan rel path to its .history stem directory', () => {
    expect(planHistoryDirRelPath('.agent-team/plans/feature_a1b2c3.html')).toBe(
      '.agent-team/plans/.history/feature_a1b2c3',
    )
  })
})

describe('parseSnapshotName', () => {
  it('parses a valid <YYYYMMDDTHHMMSS>_<stage>.html name', () => {
    const parsed = parseSnapshotName('20260718T093015_in-review.html')
    expect(parsed).not.toBeNull()
    expect(parsed!.ts).toBe('20260718T093015')
    expect(parsed!.stage).toBe('in-review')
    expect(parsed!.date.getFullYear()).toBe(2026)
    expect(parsed!.date.getMonth()).toBe(6) // July (0-based)
    expect(parsed!.date.getDate()).toBe(18)
    expect(parsed!.date.getHours()).toBe(9)
    expect(parsed!.date.getMinutes()).toBe(30)
    expect(parsed!.date.getSeconds()).toBe(15)
  })

  it('rejects names that do not match the snapshot pattern', () => {
    expect(parseSnapshotName('feature_a1b2c3.html')).toBeNull()
    expect(parseSnapshotName('20260718T093015_in-review.txt')).toBeNull()
    expect(parseSnapshotName('20260718_in-review.html')).toBeNull()
    expect(parseSnapshotName('20260718T093015_.html')).toBeNull()
    expect(parseSnapshotName('20260718T093015_In-Review.html')).toBeNull()
    expect(parseSnapshotName('.DS_Store')).toBeNull()
  })

  it('rejects timestamps with out-of-range components', () => {
    expect(parseSnapshotName('20261318T093015_draft.html')).toBeNull() // month 13
    expect(parseSnapshotName('20260700T093015_draft.html')).toBeNull() // day 0
    expect(parseSnapshotName('20260718T243015_draft.html')).toBeNull() // hour 24
    expect(parseSnapshotName('20260718T096015_draft.html')).toBeNull() // minute 60
    expect(parseSnapshotName('20260718T093060_draft.html')).toBeNull() // second 60
  })
})

function planDoc(meta: HtmlPlanMeta): string {
  return [
    '<html><head><title>Plan</title></head><body>',
    '<script type="application/json" id="plan-meta">',
    JSON.stringify(meta, null, 2),
    '</scr' + 'ipt>',
    '</body></html>',
  ].join('\n')
}

function baseMeta(overrides: Partial<HtmlPlanMeta> = {}): HtmlPlanMeta {
  return {
    schemaVersion: 1,
    name: 'Plan',
    overview: '',
    stage: 'draft',
    approvedAt: null,
    todos: [
      { id: 'phase-a', content: 'Phase A', status: 'pending' },
      { id: 'phase-b', content: 'Phase B', status: 'pending' },
    ],
    reviewNotes: [],
    ...overrides,
  }
}

describe('diffPlanContents', () => {
  it('reports a stage change between the two metas', () => {
    const diff = diffPlanContents(
      planDoc(baseMeta({ stage: 'draft' })),
      planDoc(baseMeta({ stage: 'in-review' })),
    )
    expect(diff.stageFrom).toBe('draft')
    expect(diff.stageTo).toBe('in-review')
  })

  it('reports per-todo status changes', () => {
    const diff = diffPlanContents(
      planDoc(baseMeta()),
      planDoc(
        baseMeta({
          todos: [
            { id: 'phase-a', content: 'Phase A', status: 'done' },
            { id: 'phase-b', content: 'Phase B', status: 'pending' },
          ],
        }),
      ),
    )
    expect(diff.todoChanges).toEqual([{ id: 'phase-a', from: 'pending', to: 'done' }])
    expect(diff.todosAdded).toBe(0)
    expect(diff.todosRemoved).toBe(0)
  })

  it('counts added and removed todos by id', () => {
    const diff = diffPlanContents(
      planDoc(baseMeta()),
      planDoc(
        baseMeta({
          todos: [
            { id: 'phase-a', content: 'Phase A', status: 'pending' },
            { id: 'phase-c', content: 'Phase C', status: 'pending' },
            { id: 'phase-d', content: 'Phase D', status: 'pending' },
          ],
        }),
      ),
    )
    expect(diff.todosAdded).toBe(2) // phase-c, phase-d
    expect(diff.todosRemoved).toBe(1) // phase-b
    expect(diff.todoChanges).toEqual([])
  })

  it('reports the signed review-note delta', () => {
    const note = {
      id: 'n1',
      author: 'user' as const,
      text: 'x',
      resolved: false,
      reply: '',
      anchor: '',
    }
    const grown = diffPlanContents(
      planDoc(baseMeta()),
      planDoc(baseMeta({ reviewNotes: [note, { ...note, id: 'n2' }] })),
    )
    expect(grown.notesDelta).toBe(2)
    const shrunk = diffPlanContents(planDoc(baseMeta({ reviewNotes: [note] })), planDoc(baseMeta()))
    expect(shrunk.notesDelta).toBe(-1)
  })

  it('counts added and removed lines via multiset comparison', () => {
    const diff = diffPlanContents('a\nb\nc\nb', 'a\nb\nx\ny')
    // old {a, b×2, c}, new {a, b, x, y}: x and y are new, one b and c are gone.
    expect(diff.linesAdded).toBe(2)
    expect(diff.linesRemoved).toBe(2)
  })

  it('reports zero line changes for identical content', () => {
    const doc = planDoc(baseMeta())
    const diff = diffPlanContents(doc, doc)
    expect(diff.linesAdded).toBe(0)
    expect(diff.linesRemoved).toBe(0)
    expect(diff.stageFrom).toBe(diff.stageTo)
    expect(diff.todoChanges).toEqual([])
    expect(diff.notesDelta).toBe(0)
  })

  it('is null-safe when either side has no plan-meta', () => {
    const diff = diffPlanContents('<html><body>plain</body></html>', planDoc(baseMeta()))
    expect(diff.stageFrom).toBeNull()
    expect(diff.stageTo).toBe('draft')
    expect(diff.todosAdded).toBe(2)
    expect(diff.todosRemoved).toBe(0)
    expect(diff.notesDelta).toBe(0)
    expect(diff.linesAdded).toBeGreaterThan(0)
  })
})
