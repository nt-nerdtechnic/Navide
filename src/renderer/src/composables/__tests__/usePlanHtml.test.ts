import { describe, it, expect } from 'vitest'
import {
  htmlPlanProgress,
  parseHtmlPlanMeta,
  replaceHtmlPlanMeta,
  type HtmlPlanMeta,
} from '../usePlanHtml'

function wrapHtml(metaJson: string): string {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<title>Sample Plan</title>

<script type="application/json" id="plan-meta">
${metaJson}
</script>

<style>body { color: red; }</style>
</head>
<body>
<h1>Sample Plan<span class="pill in-review">in-review</span></h1>
</body>
</html>
`
}

const VALID_META = {
  schemaVersion: 1,
  name: 'Sample Plan',
  overview: 'A plan used in unit tests.',
  stage: 'in-review',
  approvedAt: null,
  todos: [
    { id: 'phase-a', content: 'First phase', status: 'done' },
    { id: 'phase-b', content: 'Second phase', status: 'pending' },
    { id: 'phase-c', content: 'Third phase', status: 'skipped' },
  ],
  reviewNotes: [{ id: 'n1', author: 'user', text: 'Looks fine.', resolved: false, reply: '' }],
}

const VALID_HTML = wrapHtml(JSON.stringify(VALID_META, null, 2))

describe('parseHtmlPlanMeta', () => {
  it('parses a valid full meta block without warnings', () => {
    const result = parseHtmlPlanMeta(VALID_HTML)
    expect(result).not.toBeNull()
    expect(result!.warnings).toEqual([])
    expect(result!.meta.name).toBe('Sample Plan')
    expect(result!.meta.overview).toBe('A plan used in unit tests.')
    expect(result!.meta.stage).toBe('in-review')
    expect(result!.meta.approvedAt).toBeNull()
    expect(result!.meta.todos).toHaveLength(3)
    expect(result!.meta.todos[2].status).toBe('skipped')
    expect(result!.meta.reviewNotes).toEqual([
      { id: 'n1', author: 'user', text: 'Looks fine.', resolved: false, reply: '' },
    ])
  })

  it('returns null when the name is missing or empty', () => {
    const noName = wrapHtml(JSON.stringify({ ...VALID_META, name: undefined }))
    expect(parseHtmlPlanMeta(noName)).toBeNull()
    const emptyName = wrapHtml(JSON.stringify({ ...VALID_META, name: '  ' }))
    expect(parseHtmlPlanMeta(emptyName)).toBeNull()
  })

  it('returns null for a wrong schemaVersion', () => {
    const wrongVersion = wrapHtml(JSON.stringify({ ...VALID_META, schemaVersion: 2 }))
    expect(parseHtmlPlanMeta(wrongVersion)).toBeNull()
  })

  it('downgrades an invalid stage to draft with a warning', () => {
    const badStage = wrapHtml(JSON.stringify({ ...VALID_META, stage: 'shipping' }))
    const result = parseHtmlPlanMeta(badStage)!
    expect(result.meta.stage).toBe('draft')
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('shipping')
  })

  it('downgrades an invalid todo status to pending with a warning', () => {
    const badStatus = wrapHtml(
      JSON.stringify({
        ...VALID_META,
        todos: [{ id: 'phase-a', content: 'First phase', status: 'completed' }],
      })
    )
    const result = parseHtmlPlanMeta(badStatus)!
    expect(result.meta.todos[0].status).toBe('pending')
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('completed')
  })

  it('fills defaults for missing reviewNote fields', () => {
    const sparseNotes = wrapHtml(JSON.stringify({ ...VALID_META, reviewNotes: [{ id: 'n1' }] }))
    const result = parseHtmlPlanMeta(sparseNotes)!
    expect(result.meta.reviewNotes[0]).toEqual({
      id: 'n1',
      author: 'user',
      text: '',
      resolved: false,
      reply: '',
    })
  })

  it('returns null when there is no plan-meta block', () => {
    expect(parseHtmlPlanMeta('<!doctype html><html><body>plain page</body></html>')).toBeNull()
  })

  it('returns null when the JSON is malformed', () => {
    expect(parseHtmlPlanMeta(wrapHtml('{ "schemaVersion": 1, broken'))).toBeNull()
  })

  it('accepts single-quoted attributes', () => {
    const html = `<html><head><script type='application/json' id='plan-meta'>
${JSON.stringify(VALID_META)}
</script></head><body></body></html>`
    expect(parseHtmlPlanMeta(html)?.meta.name).toBe('Sample Plan')
  })

  it('accepts an uppercase script tag and attributes', () => {
    const html = `<html><head><SCRIPT TYPE="application/json" ID="plan-meta">
${JSON.stringify(VALID_META)}
</SCRIPT></head><body></body></html>`
    expect(parseHtmlPlanMeta(html)?.meta.name).toBe('Sample Plan')
  })

  it('accepts id before type', () => {
    const html = `<html><head><script id="plan-meta" type="application/json">
${JSON.stringify(VALID_META)}
</script></head><body></body></html>`
    expect(parseHtmlPlanMeta(html)?.meta.name).toBe('Sample Plan')
  })

  it('does not match data-id="plan-meta"', () => {
    const html = `<html><head><script type="application/json" data-id="plan-meta">
${JSON.stringify(VALID_META)}
</script></head><body></body></html>`
    expect(parseHtmlPlanMeta(html)).toBeNull()
  })
})

describe('replaceHtmlPlanMeta', () => {
  it('preserves every byte outside the plan-meta block', () => {
    const updated: HtmlPlanMeta = parseHtmlPlanMeta(VALID_HTML)!.meta
    const written = replaceHtmlPlanMeta(VALID_HTML, { ...updated, stage: 'approved' })

    const blockRe = /<script type="application\/json" id="plan-meta">[\s\S]*?<\/script>/
    expect(written.replace(blockRe, '@BLOCK@')).toBe(VALID_HTML.replace(blockRe, '@BLOCK@'))
  })

  it('round-trips: replaced content parses back to the same meta', () => {
    const meta: HtmlPlanMeta = {
      ...parseHtmlPlanMeta(VALID_HTML)!.meta,
      stage: 'approved',
      approvedAt: '2026-07-18T00:00:00Z',
      todos: [{ id: 'phase-a', content: 'First phase', status: 'in-progress' }],
    }
    const written = replaceHtmlPlanMeta(VALID_HTML, meta)
    const reparsed = parseHtmlPlanMeta(written)!
    expect(reparsed.warnings).toEqual([])
    expect(reparsed.meta).toEqual(meta)
  })

  it('serializes with 2-space indentation', () => {
    const meta = parseHtmlPlanMeta(VALID_HTML)!.meta
    const written = replaceHtmlPlanMeta(VALID_HTML, meta)
    expect(written).toContain('\n  "schemaVersion": 1,')
  })

  it('escapes "<" in serialized JSON so script-closing text cannot break the block', () => {
    const closingTag = '</scr' + 'ipt>'
    const meta: HtmlPlanMeta = {
      ...parseHtmlPlanMeta(VALID_HTML)!.meta,
      reviewNotes: [
        {
          id: 'n1',
          author: 'user',
          text: `Beware ${closingTag} and ${'<!' + '--'} inside notes`,
          resolved: false,
          reply: '',
        },
      ],
    }
    const written = replaceHtmlPlanMeta(VALID_HTML, meta)

    // (a) the only closing script tag in the output is the block's own; the
    // JSON island itself contains no raw "<" at all.
    expect(written.split(closingTag).length - 1).toBe(1)
    const block = written.match(
      /<script type="application\/json" id="plan-meta">([\s\S]*?)<\/script>/,
    )!
    expect(block[1]).not.toContain('<')

    // (b) round-trips: JSON.parse natively decodes the unicode escape.
    const reparsed = parseHtmlPlanMeta(written)!
    expect(reparsed.warnings).toEqual([])
    expect(reparsed.meta).toEqual(meta)

    // (c) every byte outside the block is preserved.
    const blockRe = /<script type="application\/json" id="plan-meta">[\s\S]*?<\/script>/
    expect(written.replace(blockRe, '@BLOCK@')).toBe(VALID_HTML.replace(blockRe, '@BLOCK@'))
  })

  it('returns the content unchanged when no block exists', () => {
    const plain = '<!doctype html><html><body>no meta</body></html>'
    expect(replaceHtmlPlanMeta(plain, parseHtmlPlanMeta(VALID_HTML)!.meta)).toBe(plain)
  })
})

describe('htmlPlanProgress', () => {
  it('counts done only; skipped counts toward neither', () => {
    const meta = parseHtmlPlanMeta(VALID_HTML)!.meta
    expect(htmlPlanProgress(meta.todos)).toEqual({ total: 3, done: 1 })
  })
})
