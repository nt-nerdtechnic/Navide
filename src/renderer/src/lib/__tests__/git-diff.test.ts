import { describe, it, expect } from 'vitest'
import { parseHunks, buildPatch, hunkHasChanges, toSideBySide } from '../git-diff'

const SAMPLE = `diff --git a/foo.txt b/foo.txt
index 0000001..0000002 100644
--- a/foo.txt
+++ b/foo.txt
@@ -1,3 +1,4 @@
 line1
+added line
 line2
 line3
@@ -10,2 +11,2 @@
 ctx
-removed
+replacement
 tail`

describe('parseHunks', () => {
  it('splits file header from hunks', () => {
    const parsed = parseHunks(SAMPLE)
    expect(parsed.fileHeader).toContain('diff --git a/foo.txt b/foo.txt')
    expect(parsed.fileHeader).toContain('--- a/foo.txt')
    expect(parsed.fileHeader).toContain('+++ b/foo.txt')
    expect(parsed.fileHeader).not.toContain('@@')
  })

  it('parses two hunks with correct ranges', () => {
    const { hunks } = parseHunks(SAMPLE)
    expect(hunks).toHaveLength(2)
    expect(hunks[0]).toMatchObject({ oldStart: 1, oldCount: 3, newStart: 1, newCount: 4 })
    expect(hunks[1]).toMatchObject({ oldStart: 10, oldCount: 2, newStart: 11, newCount: 2 })
  })

  it('classifies line kinds', () => {
    const { hunks } = parseHunks(SAMPLE)
    const kinds = hunks[0].lines.map((l) => l.kind)
    expect(kinds).toEqual([' ', '+', ' ', ' '])
  })

  it('defaults count to 1 when omitted (@@ -5 +5,2 @@)', () => {
    const raw = `--- a/x\n+++ b/x\n@@ -5 +5,2 @@\n ctx\n+new`
    const { hunks } = parseHunks(raw)
    expect(hunks[0]).toMatchObject({ oldStart: 5, oldCount: 1, newStart: 5, newCount: 2 })
  })

  it('returns no hunks for binary / placeholder diffs (DiffBlock falls back to plain)', () => {
    expect(parseHunks('(no diff)').hunks).toHaveLength(0)
    expect(parseHunks('Binary files a/img.png and b/img.png differ').hunks).toHaveLength(0)
    expect(parseHunks('').hunks).toHaveLength(0)
  })
})

describe('hunkHasChanges', () => {
  it('is true when add/remove present, false for pure context', () => {
    const { hunks } = parseHunks(SAMPLE)
    expect(hunkHasChanges(hunks[0])).toBe(true)
    const ctxOnly = { ...hunks[0], lines: hunks[0].lines.filter((l) => l.kind === ' ') }
    expect(hunkHasChanges(ctxOnly)).toBe(false)
  })
})

describe('buildPatch — whole hunk', () => {
  it('emits the hunk verbatim with recomputed counts and pinned newStart', () => {
    const parsed = parseHunks(SAMPLE)
    const patch = buildPatch(parsed, parsed.hunks[0])
    expect(patch).toContain('diff --git a/foo.txt b/foo.txt')
    // 3 old (ctx+ctx+ctx), 4 new (ctx+add+ctx+ctx) ; newStart pinned to oldStart=1
    expect(patch).toContain('@@ -1,3 +1,4 @@')
    expect(patch).toContain('+added line')
    expect(patch.endsWith('\n')).toBe(true)
  })
})

describe('buildPatch — selected lines', () => {
  it('drops unselected additions entirely', () => {
    const parsed = parseHunks(SAMPLE)
    const hunk = parsed.hunks[0]
    // select nothing -> the added line must not appear; counts become 3/3
    const patch = buildPatch(parsed, hunk, new Set<number>())
    expect(patch).not.toContain('+added line')
    expect(patch).toContain('@@ -1,3 +1,3 @@')
  })

  it('keeps a selected addition', () => {
    const parsed = parseHunks(SAMPLE)
    const hunk = parsed.hunks[0]
    const addIdx = hunk.lines.findIndex((l) => l.kind === '+')
    const patch = buildPatch(parsed, hunk, new Set([addIdx]))
    expect(patch).toContain('+added line')
    expect(patch).toContain('@@ -1,3 +1,4 @@')
  })

  it('turns an unselected removal into context', () => {
    const parsed = parseHunks(SAMPLE)
    const hunk = parsed.hunks[1] // has a '-removed' and '+replacement'
    // select only the addition, not the removal
    const addIdx = hunk.lines.findIndex((l) => l.kind === '+')
    const patch = buildPatch(parsed, hunk, new Set([addIdx]))
    // removed line should now be a context line (leading space, no '-')
    expect(patch).toContain(' removed')
    expect(patch).not.toContain('-removed')
    expect(patch).toContain('+replacement')
    // old: ctx + (removed->ctx) + tail = 3 ; new: ctx + replacement + (removed->ctx) + tail = 4
    expect(patch).toContain('@@ -10,3 +10,4 @@')
  })
})

describe('toSideBySide', () => {
  it('aligns context lines on both sides with matching line numbers', () => {
    const { hunks } = parseHunks(SAMPLE)
    const rows = toSideBySide(hunks[0]) // ctx, +added, ctx, ctx
    const first = rows[0]
    expect(first.left).toMatchObject({ kind: ' ', text: 'line1', lineNo: 1 })
    expect(first.right).toMatchObject({ kind: ' ', text: 'line1', lineNo: 1 })
  })

  it('puts a pure addition on the right with an empty left', () => {
    const { hunks } = parseHunks(SAMPLE)
    const rows = toSideBySide(hunks[0])
    const addRow = rows.find((r) => r.right?.kind === '+')
    expect(addRow).toBeDefined()
    expect(addRow!.left).toBeNull()
    expect(addRow!.right).toMatchObject({ text: 'added line' })
  })

  it('pairs a removal with an addition (replace) on the same row', () => {
    const { hunks } = parseHunks(SAMPLE)
    const rows = toSideBySide(hunks[1]) // ctx, -removed, +replacement, ctx
    const pair = rows.find((r) => r.left?.kind === '-' && r.right?.kind === '+')
    expect(pair).toBeDefined()
    expect(pair!.left!.text).toBe('removed')
    expect(pair!.right!.text).toBe('replacement')
  })

  it('pads the shorter side when counts differ (2 dels, 1 add)', () => {
    const raw = `--- a/x\n+++ b/x\n@@ -1,3 +1,2 @@\n-a\n-b\n+c\n d`
    const { hunks } = parseHunks(raw)
    const rows = toSideBySide(hunks[0])
    // two removals, one addition -> second removal has empty right
    const dels = rows.filter((r) => r.left?.kind === '-')
    expect(dels).toHaveLength(2)
    expect(dels[1].right).toBeNull()
  })

  it('carries hunk.lines index for staging selection', () => {
    const { hunks } = parseHunks(SAMPLE)
    const rows = toSideBySide(hunks[0])
    const addRow = rows.find((r) => r.right?.kind === '+')!
    expect(hunks[0].lines[addRow.right!.idx].kind).toBe('+')
  })
})
