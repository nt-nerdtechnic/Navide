// Unit tests for the Phase B render-time interactivity layer: outline
// extraction, srcdoc assembly (script stripping + CSP + runtime injection,
// including escaping safety for document-controlled anchor data), and the
// host-side postMessage validation — non-whitelisted events are ignored and
// malformed payloads never reach the write hooks.
import { describe, it, expect, vi } from 'vitest'
import {
  MAX_ANCHOR_LENGTH,
  MAX_OPEN_CODE_LINE,
  MAX_OPEN_CODE_PATH_LENGTH,
  buildPlanRuntimeScript,
  createPlanRuntimeMessageHandler,
  extractPlanOutline,
  preparePlanDocHtml,
  stripExecutableScripts,
  type PlanRuntimeHostHooks,
} from '../planRuntime'

const DOC = [
  '<!doctype html><html><head><title>t</title>',
  '<script type="application/json" id="plan-meta">{"schemaVersion":1}</scr' + 'ipt>',
  '</head><body>',
  '<section><h2>Goals</h2><p>text</p></section>',
  '<section><h2>Phases</h2>',
  '<div class="phase"><div class="phase-head">Phase A · Alpha<span class="size">S</span></div></div>',
  '<div class="phase"><div class="phase-head">Phase B · Beta</div></div>',
  '</section>',
  '<section><h2>  Spaced   Title </h2></section>',
  '</body></html>',
].join('\n')

describe('extractPlanOutline', () => {
  it('extracts h2 and phase-head anchors in document order, whitespace-collapsed', () => {
    expect(extractPlanOutline(DOC)).toEqual([
      'Goals',
      'Phases',
      'Phase A · Alpha',
      'Phase B · Beta',
      'Spaced Title',
    ])
  })

  it('deduplicates repeated anchors and skips empty headings', () => {
    const html = '<h2>Goals</h2><h2>Goals</h2><h2></h2><h2><code>x</code></h2>'
    expect(extractPlanOutline(html)).toEqual(['Goals'])
  })

  it('returns an empty outline for a document without headings', () => {
    expect(extractPlanOutline('<html><body><h1>only h1</h1></body></html>')).toEqual([])
  })
})

describe('buildPlanRuntimeScript', () => {
  it('embeds the init data with "<" escaped so anchors cannot break out of the script', () => {
    const script = buildPlanRuntimeScript({
      anchors: { '</script><img src=x onerror=alert(1)>': 2 },
      commentLabel: '<b>Comment</b>',
      scrollY: 0,
    })
    expect(script).not.toContain('</script')
    expect(script).toContain('\\u003c')
  })

  it('embeds the scroll offset and comment label', () => {
    const script = buildPlanRuntimeScript({ anchors: {}, commentLabel: 'Comment', scrollY: 420 })
    expect(script).toContain('"scrollY":420')
    expect(script).toContain('"commentLabel":"Comment"')
  })

  it('binds file:line references in code elements to the open-code event', () => {
    const script = buildPlanRuntimeScript({ anchors: {}, commentLabel: 'Comment', scrollY: 0 })
    expect(script).toContain("querySelectorAll('code')")
    expect(script).toContain("type: 'open-code'")
    // The embedded reference regex survives template-literal escaping intact.
    expect(script).toContain('CODE_REF_RE')
    expect(script).toContain('\\d{1,7}')
  })
})

describe('stripExecutableScripts / preparePlanDocHtml', () => {
  const init = { anchors: {}, commentLabel: 'Comment', scrollY: 0 }

  it('strips executable scripts but keeps the JSON plan-meta island', () => {
    const html = [
      '<html><head>',
      '<script type="application/json" id="plan-meta">{"a":1}</scr' + 'ipt>',
      '<script>alert(1)</scr' + 'ipt>',
      '<script src="https://evil.example/x.js"></scr' + 'ipt>',
      '</head><body></body></html>',
    ].join('')
    const out = stripExecutableScripts(html)
    expect(out).toContain('id="plan-meta"')
    expect(out).not.toContain('alert(1)')
    expect(out).not.toContain('evil.example')
  })

  it('prepends a nonce-restricted CSP meta at the very start and the runtime before </body>', () => {
    const out = preparePlanDocHtml(DOC, init, 'abc123')
    expect(out.startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true)
    expect(out).toContain("script-src 'nonce-abc123'")
    expect(out).toContain("default-src 'none'")
    const runtimeAt = out.indexOf('<script nonce="abc123">')
    expect(runtimeAt).toBeGreaterThan(-1)
    expect(runtimeAt).toBeLessThan(out.indexOf('</body>'))
    // The plan-meta data island survives assembly.
    expect(out).toContain('id="plan-meta"')
  })

  it('appends the runtime and prepends the CSP when head/body tags are missing', () => {
    const out = preparePlanDocHtml('<p>bare fragment</p>', init, 'abc123')
    expect(out.startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true)
    expect(out).toContain('<script nonce="abc123">')
  })

  it('places the CSP before pre-head content, including an unclosed script the strip regex cannot consume', () => {
    const html = '<script>window.leak=1<!doctype html><html><head><title>t</title></head><body></body></html>'
    const out = preparePlanDocHtml(html, init, 'abc123')
    // The unclosed script survives stripping, but the CSP still precedes it.
    expect(out.startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true)
    expect(out.indexOf('<meta http-equiv="Content-Security-Policy"')).toBeLessThan(
      out.indexOf('window.leak'),
    )
  })

  it('generates a fresh nonce per render by default', () => {
    const a = preparePlanDocHtml(DOC, init)
    const b = preparePlanDocHtml(DOC, init)
    const nonceOf = (html: string): string => /script-src 'nonce-([0-9a-f]+)'/.exec(html)![1]
    expect(nonceOf(a)).toHaveLength(32)
    expect(nonceOf(a)).not.toBe(nonceOf(b))
  })
})

describe('createPlanRuntimeMessageHandler', () => {
  function harness(overrides: Partial<PlanRuntimeHostHooks> = {}) {
    const frameWindow = {} as Window
    const hooks: PlanRuntimeHostHooks = {
      getSourceWindow: () => frameWindow,
      getTodoIds: () => ['phase-a', 'phase-b'],
      getAnchors: () => ['Goals', 'Risks'],
      onTodoClicked: vi.fn(),
      onSectionComment: vi.fn(),
      onScrollPos: vi.fn(),
      onOpenCode: vi.fn(),
      ...overrides,
    }
    const handler = createPlanRuntimeMessageHandler(hooks)
    const send = (data: unknown, source: unknown = frameWindow): void =>
      handler({ data, source } as MessageEvent)
    return { hooks, send, frameWindow }
  }

  it('ignores messages from any other source window', () => {
    const { hooks, send } = harness()
    send({ type: 'todo-clicked', todoId: 'phase-a', alt: false }, {} as Window)
    send({ type: 'todo-clicked', todoId: 'phase-a', alt: false }, null)
    expect(hooks.onTodoClicked).not.toHaveBeenCalled()
  })

  it('ignores everything when no frame window is available', () => {
    const { hooks, send } = harness({ getSourceWindow: () => null })
    send({ type: 'todo-clicked', todoId: 'phase-a', alt: false }, null)
    expect(hooks.onTodoClicked).not.toHaveBeenCalled()
  })

  it('ignores non-whitelisted event types and non-object payloads', () => {
    const { hooks, send } = harness()
    send({ type: 'eval', code: 'alert(1)' })
    send({ type: 'approve-plan' })
    send('todo-clicked')
    send(null)
    send(42)
    expect(hooks.onTodoClicked).not.toHaveBeenCalled()
    expect(hooks.onSectionComment).not.toHaveBeenCalled()
    expect(hooks.onScrollPos).not.toHaveBeenCalled()
  })

  it('accepts a valid todo-clicked and normalizes alt to a boolean', () => {
    const { hooks, send } = harness()
    send({ type: 'todo-clicked', todoId: 'phase-b', alt: true })
    send({ type: 'todo-clicked', todoId: 'phase-a', alt: 'yes' })
    expect(hooks.onTodoClicked).toHaveBeenNthCalledWith(1, 'phase-b', true)
    expect(hooks.onTodoClicked).toHaveBeenNthCalledWith(2, 'phase-a', false)
  })

  it('rejects todo-clicked with an unknown or non-string todoId', () => {
    const { hooks, send } = harness()
    send({ type: 'todo-clicked', todoId: 'phase-z', alt: false })
    send({ type: 'todo-clicked', todoId: 7, alt: false })
    send({ type: 'todo-clicked' })
    expect(hooks.onTodoClicked).not.toHaveBeenCalled()
  })

  it('accepts a valid section-comment anchor', () => {
    const { hooks, send } = harness()
    send({ type: 'section-comment', anchor: 'Risks' })
    expect(hooks.onSectionComment).toHaveBeenCalledWith('Risks')
  })

  it('rejects section-comment with unknown, non-string, empty, or oversized anchors', () => {
    const { hooks, send } = harness()
    send({ type: 'section-comment', anchor: 'Not A Section' })
    send({ type: 'section-comment', anchor: 123 })
    send({ type: 'section-comment', anchor: '' })
    send({ type: 'section-comment', anchor: 'x'.repeat(MAX_ANCHOR_LENGTH + 1) })
    expect(hooks.onSectionComment).not.toHaveBeenCalled()
  })

  it('accepts a finite non-negative scroll-pos and rejects everything else', () => {
    const { hooks, send } = harness()
    send({ type: 'scroll-pos', y: 240 })
    send({ type: 'scroll-pos', y: -1 })
    send({ type: 'scroll-pos', y: Number.NaN })
    send({ type: 'scroll-pos', y: Number.POSITIVE_INFINITY })
    send({ type: 'scroll-pos', y: '240' })
    expect(hooks.onScrollPos).toHaveBeenCalledTimes(1)
    expect(hooks.onScrollPos).toHaveBeenCalledWith(240)
  })

  it('accepts a valid open-code with a workspace-relative path and line', () => {
    const { hooks, send } = harness()
    send({ type: 'open-code', path: 'src/renderer/src/App.vue', line: 42 })
    send({ type: 'open-code', path: 'backend/app.py', line: MAX_OPEN_CODE_LINE })
    expect(hooks.onOpenCode).toHaveBeenNthCalledWith(1, 'src/renderer/src/App.vue', 42)
    expect(hooks.onOpenCode).toHaveBeenNthCalledWith(2, 'backend/app.py', MAX_OPEN_CODE_LINE)
  })

  it('rejects open-code paths that are absolute, traversing, or otherwise unsafe', () => {
    const { hooks, send } = harness()
    send({ type: 'open-code', path: '/etc/passwd', line: 1 })
    send({ type: 'open-code', path: '../secrets.env', line: 1 })
    send({ type: 'open-code', path: 'src/../../outside.ts', line: 1 })
    send({ type: 'open-code', path: 'src\\windows\\file.ts', line: 1 })
    send({ type: 'open-code', path: 'C:/drive/file.ts', line: 1 })
    send({ type: 'open-code', path: '', line: 1 })
    send({ type: 'open-code', path: `${'a'.repeat(MAX_OPEN_CODE_PATH_LENGTH)}/x.ts`, line: 1 })
    send({ type: 'open-code', path: 42, line: 1 })
    send({ type: 'open-code', line: 1 })
    expect(hooks.onOpenCode).not.toHaveBeenCalled()
  })

  it('rejects open-code lines that are zero, negative, fractional, oversized, or non-numeric', () => {
    const { hooks, send } = harness()
    send({ type: 'open-code', path: 'src/app.ts', line: 0 })
    send({ type: 'open-code', path: 'src/app.ts', line: -5 })
    send({ type: 'open-code', path: 'src/app.ts', line: 1.5 })
    send({ type: 'open-code', path: 'src/app.ts', line: MAX_OPEN_CODE_LINE + 1 })
    send({ type: 'open-code', path: 'src/app.ts', line: '42' })
    send({ type: 'open-code', path: 'src/app.ts' })
    expect(hooks.onOpenCode).not.toHaveBeenCalled()
  })
})
