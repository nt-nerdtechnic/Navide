// Unit tests for the format-agnostic plan store adapter (Stage 1). The focus is
// equivalence: each store composes the existing usePlanHtml / usePlanFile helpers
// and mirrors the optimistic-lock flows from PlanReviewToolbar.writeMeta and
// PlanWindowApp.writePlanBody, so writes must be byte-identical to calling those
// helpers directly. A stateful mock backend tracks mtime and can simulate
// conflicts, matching the PlanReviewToolbar.test.ts convention.
import { describe, it, expect, vi } from 'vitest'
import { resolvePlanStore, type PlanCtx } from '../planStore'
import type { PlanMeta } from '../planModel'
import type { useBackend } from '../useBackend'
import {
  parseHtmlPlanMeta,
  replaceHtmlPlanMeta,
  syncStageMarkup,
  syncTodoMarkup,
  replaceSectionBody as replaceHtmlSectionBody,
  deleteSection as deleteHtmlSection,
  type HtmlPlanMeta,
} from '../usePlanHtml'
import {
  parsePlanMeta,
  writePlanMeta,
  replacePlanSectionBody,
  deleteSection as deleteMarkdownSection,
} from '../usePlanFile'

type Backend = ReturnType<typeof useBackend>

const REL_HTML = '.agent-team/plans/test-plan_a1b2c3.html'
const REL_MD = '.cursor/plans/test.plan.md'

// ── Stateful mock backend ──────────────────────────────────────────────────
function makeBackend(initial: string, opts: { conflictWrites?: number } = {}) {
  let current = initial
  let mtimeNow = 1000
  let conflictsLeft = opts.conflictWrites ?? 0
  const writes: { content: string; expectedMtime?: number }[] = []
  const backend = {
    send: vi.fn(async (type: string, payload: Record<string, unknown>) => {
      if (type === 'fs.read_file') {
        return { payload: { ok: true, content: current, mtime: mtimeNow } }
      }
      if (type === 'fs.write_file') {
        const expected = payload.expected_mtime as number | undefined
        writes.push({ content: payload.content as string, expectedMtime: expected })
        if (conflictsLeft > 0 || (expected !== undefined && expected !== mtimeNow)) {
          if (conflictsLeft > 0) conflictsLeft--
          return { payload: { ok: false, conflict: true, mtime: mtimeNow, error: 'file changed on disk' } }
        }
        current = payload.content as string
        mtimeNow++
        return { payload: { ok: true, mtime: mtimeNow } }
      }
      return { payload: { ok: true } }
    }),
  }
  return {
    backend: backend as unknown as Backend,
    writes,
    getContent: () => current,
  }
}

function ctx(env: { backend: Backend }, relPath: string): PlanCtx {
  return { backend: env.backend, workspacePath: '/ws', relPath }
}

// ── HTML fixtures ──────────────────────────────────────────────────────────
const HTML_META: HtmlPlanMeta = {
  schemaVersion: 1,
  name: 'HTML Plan',
  overview: 'ov',
  stage: 'in-review',
  approvedAt: null,
  todos: [
    { id: 'phase-a', content: 'Phase A', status: 'pending' },
    { id: 'phase-b', content: 'Phase B', status: 'done' },
  ],
  reviewNotes: [],
}

function htmlDoc(meta: HtmlPlanMeta): string {
  return [
    '<!doctype html><html><head>',
    '<script type="application/json" id="plan-meta">',
    JSON.stringify(meta, null, 2),
    '</scr' + 'ipt>',
    '</head><body>',
    '<header><h1>HTML Plan<span class="pill draft">draft</span></h1></header>',
    '<section><h2>Goals</h2><p>Original goal text.</p></section>',
    '<section><h2>Phases</h2>',
    '<ul class="todos">',
    '  <li data-status="pending" data-todo-id="phase-a"><span class="st">pending</span><span>Phase A</span></li>',
    '  <li data-status="done" data-todo-id="phase-b"><span class="st">done</span><span>Phase B</span></li>',
    '</ul>',
    '</section>',
    '</body></html>',
  ].join('\n')
}

// ── Markdown fixture ───────────────────────────────────────────────────────
const MD_PLAN = `---
name: MD Plan
overview: markdown overview
todos:
  - id: t1
    content: First
    status: pending
  - id: t2
    content: Second
    status: completed
isProject: false
stage: in-review
approvedAt: null
reviewNotes: []
---

# Goals

Intro.

## Phase A

Body A.

## Phase B

Body B.
`

describe('resolvePlanStore', () => {
  it('routes .html to the HTML store', () => {
    expect(resolvePlanStore('a/b.html').format).toBe('html')
  })
  it('routes .plan.md to the markdown store', () => {
    expect(resolvePlanStore('a/b.plan.md').format).toBe('markdown')
  })
  it('routes .md to the markdown store', () => {
    expect(resolvePlanStore('a/b.md').format).toBe('markdown')
  })
})

describe('HtmlPlanStore.readMeta', () => {
  const store = resolvePlanStore(REL_HTML)

  it('parses meta, injects format html, returns raw/mtime/warnings', async () => {
    const doc = htmlDoc(HTML_META)
    const env = makeBackend(doc)
    const r = await store.readMeta(ctx(env, REL_HTML))
    expect(r).not.toBeNull()
    expect(r!.meta.format).toBe('html')
    expect(r!.meta.name).toBe('HTML Plan')
    expect(r!.raw).toBe(doc)
    expect(r!.mtime).toBe(1000)
    expect(r!.warnings).toEqual([])
  })

  it('returns null for a file without a plan-meta island', async () => {
    const env = makeBackend('<html><body>plain</body></html>')
    expect(await store.readMeta(ctx(env, REL_HTML))).toBeNull()
  })
})

describe('HtmlPlanStore.writeMeta', () => {
  const store = resolvePlanStore(REL_HTML)
  // Pure mutation reused by store and manual reference path.
  const mutate = (fresh: PlanMeta): PlanMeta => ({
    ...fresh,
    stage: 'approved',
    approvedAt: '2026-01-01T00:00:00Z',
    todos: fresh.todos.map((t) => ({ ...t, status: 'done' as const })),
  })

  it('writes byte-identical to replaceHtmlPlanMeta + syncStageMarkup + syncTodoMarkup', async () => {
    const doc = htmlDoc(HTML_META)
    const env = makeBackend(doc)
    const res = await store.writeMeta(ctx(env, REL_HTML), mutate)
    expect(res.ok).toBe(true)

    // Manual reference in the exact order the store uses.
    const parsed = parseHtmlPlanMeta(doc)!.meta
    const next = mutate({ ...parsed, format: 'html' } as PlanMeta)
    const { format: _f, ...htmlNext } = next
    let expected = replaceHtmlPlanMeta(doc, htmlNext as HtmlPlanMeta)
    expected = syncStageMarkup(expected, htmlNext.stage)
    for (const todo of htmlNext.todos) expected = syncTodoMarkup(expected, todo.id, todo.status)

    expect(env.writes.at(-1)!.content).toBe(expected)
    expect(res.raw).toBe(expected)
  })

  it('never persists the memory-only format field', async () => {
    const env = makeBackend(htmlDoc(HTML_META))
    await store.writeMeta(ctx(env, REL_HTML), mutate)
    const island = parseHtmlPlanMeta(env.getContent())!.meta
    expect('format' in island).toBe(false)
  })

  it('carries expected_mtime and retries once on a single conflict', async () => {
    const env = makeBackend(htmlDoc(HTML_META), { conflictWrites: 1 })
    const res = await store.writeMeta(ctx(env, REL_HTML), (f) => ({ ...f, stage: 'approved' }))
    expect(res.ok).toBe(true)
    expect(env.writes).toHaveLength(2)
    expect(env.writes[0].expectedMtime).toBe(1000)
  })

  it('fails with conflict on a second conflict', async () => {
    const env = makeBackend(htmlDoc(HTML_META), { conflictWrites: 2 })
    const res = await store.writeMeta(ctx(env, REL_HTML), (f) => ({ ...f, stage: 'approved' }))
    expect(res.ok).toBe(false)
    expect(res.conflict).toBe(true)
    expect(env.writes).toHaveLength(2)
  })

  it('abandons without writing when mutate returns null', async () => {
    const doc = htmlDoc(HTML_META)
    const env = makeBackend(doc)
    const res = await store.writeMeta(ctx(env, REL_HTML), () => null)
    expect(res.ok).toBe(false)
    expect(env.writes).toHaveLength(0)
    expect(res.raw).toBe(doc)
  })
})

describe('HtmlPlanStore body edits', () => {
  const store = resolvePlanStore(REL_HTML)

  it('replaceSectionBody equals usePlanHtml.replaceSectionBody', async () => {
    const doc = htmlDoc(HTML_META)
    const env = makeBackend(doc)
    const res = await store.replaceSectionBody(ctx(env, REL_HTML), 'Goals', {
      kind: 'html',
      sanitized: '<p>New goal.</p>',
    })
    expect(res.ok).toBe(true)
    expect(env.getContent()).toBe(replaceHtmlSectionBody(doc, 'Goals', '<p>New goal.</p>'))
  })

  it('deleteSection equals usePlanHtml.deleteSection', async () => {
    const doc = htmlDoc(HTML_META)
    const env = makeBackend(doc)
    await store.deleteSection(ctx(env, REL_HTML), 'Goals')
    expect(env.getContent()).toBe(deleteHtmlSection(doc, 'Goals'))
  })

  it('is a silent no-op (no write) when the anchor is absent', async () => {
    const env = makeBackend(htmlDoc(HTML_META))
    const res = await store.replaceSectionBody(ctx(env, REL_HTML), 'Nonexistent', {
      kind: 'html',
      sanitized: '<p>x</p>',
    })
    expect(res.ok).toBe(true)
    expect(env.writes).toHaveLength(0)
  })

  it('outline lists h2 anchors in document order', () => {
    expect(store.outline(htmlDoc(HTML_META))).toEqual(['Goals', 'Phases'])
  })
})

describe('MarkdownPlanStore', () => {
  const store = resolvePlanStore(REL_MD)

  it('readMeta parses meta with format markdown', async () => {
    const env = makeBackend(MD_PLAN)
    const r = await store.readMeta(ctx(env, REL_MD))
    expect(r).not.toBeNull()
    expect(r!.meta.format).toBe('markdown')
    expect(r!.meta.name).toBe('MD Plan')
    expect(r!.mtime).toBe(1000)
    expect(r!.warnings).toEqual([])
  })

  it('writeMeta serializes via writePlanMeta and round-trips', async () => {
    const env = makeBackend(MD_PLAN)
    const mutate = (f: PlanMeta): PlanMeta => ({
      ...f,
      stage: 'approved',
      approvedAt: '2026-01-01T00:00:00Z',
    })
    const res = await store.writeMeta(ctx(env, REL_MD), mutate)
    expect(res.ok).toBe(true)
    expect(env.getContent()).toBe(writePlanMeta(mutate(parsePlanMeta(MD_PLAN)!), MD_PLAN))
    const reparsed = parsePlanMeta(env.getContent())!
    expect(reparsed.stage).toBe('approved')
    expect(reparsed.approvedAt).toBe('2026-01-01T00:00:00Z')
  })

  it('replaceSectionBody equals usePlanFile.replacePlanSectionBody', async () => {
    const env = makeBackend(MD_PLAN)
    const res = await store.replaceSectionBody(ctx(env, REL_MD), 'Phase A', {
      kind: 'markdown',
      text: 'New body A.',
    })
    expect(res.ok).toBe(true)
    expect(env.getContent()).toBe(replacePlanSectionBody(MD_PLAN, 'Phase A', 'New body A.'))
  })

  it('deleteSection equals usePlanFile.deleteSection', async () => {
    const env = makeBackend(MD_PLAN)
    await store.deleteSection(ctx(env, REL_MD), 'Phase A')
    expect(env.getContent()).toBe(deleteMarkdownSection(MD_PLAN, 'Phase A'))
  })

  it('outline lists ## headings from the markdown body', () => {
    expect(store.outline(MD_PLAN)).toEqual(['Phase A', 'Phase B'])
  })

  it('outline omits empty-body ## sections (no anchor to scroll to)', () => {
    const withEmpty = `---
name: MD Plan
overview: ov
todos: []
---

## Filled

Has a body.

## Empty

## Also Filled

Body here.
`
    expect(store.outline(withEmpty)).toEqual(['Filled', 'Also Filled'])
  })
})
