// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import PlansPane from '../PlansPane.vue'
import { i18n } from '../../i18n'
import { parseHtmlPlanMeta } from '../../composables/usePlanHtml'

i18n.global.locale.value = 'en-US'

const ACTIVE_PLAN = `---
name: Active Plan
overview: Work still pending.
todos:
  - id: phase-a
    content: Do work.
    status: pending
isProject: false
---
`

const DONE_PLAN = `---
name: Done Plan
overview: Completed work.
todos:
  - id: phase-a
    content: Done work.
    status: completed
isProject: false
---
`

function htmlPlan(meta: Record<string, unknown>): string {
  return `<!doctype html>
<html><head><title>x</title>
<script type="application/json" id="plan-meta">
${JSON.stringify(meta, null, 2)}
</script>
</head><body></body></html>`
}

const HTML_REVIEW_PLAN = htmlPlan({
  schemaVersion: 1,
  name: 'HTML Review Plan',
  overview: 'Awaiting review.',
  stage: 'in-review',
  approvedAt: null,
  todos: [
    { id: 'phase-a', content: 'First', status: 'done' },
    { id: 'phase-b', content: 'Second', status: 'pending' },
  ],
  reviewNotes: [],
})

const HTML_DONE_PLAN = htmlPlan({
  schemaVersion: 1,
  name: 'HTML Done Plan',
  overview: 'Shipped.',
  stage: 'done',
  approvedAt: '2026-07-01T00:00:00Z',
  todos: [{ id: 'phase-a', content: 'All done', status: 'done' }],
  reviewNotes: [],
})

const HTML_DRAFT_PLAN = htmlPlan({
  schemaVersion: 1,
  name: 'HTML Draft Plan',
  overview: 'Still being written.',
  stage: 'draft',
  approvedAt: null,
  todos: [{ id: 'phase-a', content: 'First', status: 'pending' }],
  reviewNotes: [],
})

const HTML_DOC = '<!doctype html><html><body>no meta here</body></html>'

const notify = {
  toast: vi.fn(),
  confirm: vi.fn(async () => true),
}

vi.mock('../../composables/useNotify', () => ({
  useNotify: () => notify,
}))

interface MockEntry {
  name: string
  rel_path: string
  is_dir: boolean
}

function makeBackend(opts?: {
  htmlEntries?: MockEntry[]
  htmlFiles?: Record<string, string>
  htmlListError?: string
  readFailures?: string[]
}) {
  // Tracks concurrent .agent-team reads so tests can assert parallel fan-out.
  const htmlReads = { inflight: 0, max: 0 }
  const renames: { src: string; dst: string }[] = []
  const writes: { rel: string; content: string }[] = []
  const listeners = new Map<string, Set<(p: unknown) => void>>()
  return {
    status: ref('connected'),
    htmlReads,
    renames,
    writes,
    on: (type: string, cb: (p: unknown) => void) => {
      let set = listeners.get(type)
      if (!set) {
        set = new Set()
        listeners.set(type, set)
      }
      set.add(cb)
      return () => set!.delete(cb)
    },
    /** Simulate a backend broadcast to `on()` subscribers. */
    emit: (type: string, payload: unknown) => listeners.get(type)?.forEach((cb) => cb(payload)),
    send: vi.fn(async (channel: string, payload: Record<string, unknown>) => {
      if (channel === 'fs.list_dir') {
        if (payload.rel_path === '.cursor/plans') {
          return {
            payload: {
              ok: true,
              entries: [
                { name: 'active.plan.md', rel_path: '.cursor/plans/active.plan.md', is_dir: false },
                { name: 'done.plan.md', rel_path: '.cursor/plans/done.plan.md', is_dir: false },
              ],
            },
          }
        }
        if (payload.rel_path === '.agent-team/plans') {
          if (opts?.htmlListError) return { payload: { ok: false, error: opts.htmlListError } }
          if (!opts?.htmlEntries) return { payload: { ok: false, error: 'not a directory' } }
          return { payload: { ok: true, entries: opts.htmlEntries } }
        }
        return { payload: { ok: false, error: 'not a directory' } }
      }
      if (channel === 'fs.read_file') {
        const rel = payload.rel_path as string
        if (rel.startsWith('.agent-team/')) {
          htmlReads.inflight++
          htmlReads.max = Math.max(htmlReads.max, htmlReads.inflight)
          await Promise.resolve()
          htmlReads.inflight--
          if (opts?.readFailures?.includes(rel)) return { payload: { ok: false, error: 'read failed' } }
        }
        if (opts?.htmlFiles && rel in opts.htmlFiles) {
          return { payload: { ok: true, content: opts.htmlFiles[rel] } }
        }
        return {
          payload: {
            ok: true,
            content: rel === '.cursor/plans/done.plan.md' ? DONE_PLAN : ACTIVE_PLAN,
          },
        }
      }
      if (channel === 'fs.delete') return { payload: { ok: true } }
      if (channel === 'fs.rename') {
        renames.push({ src: payload.src_path as string, dst: payload.dst_path as string })
        return { payload: { ok: true } }
      }
      if (channel === 'fs.write_file') {
        writes.push({ rel: payload.rel_path as string, content: payload.content as string })
        return { payload: { ok: true } }
      }
      return { payload: { ok: false, error: 'unexpected' } }
    }),
  }
}

function mountPane(backend: ReturnType<typeof makeBackend>) {
  return mount(PlansPane, {
    props: { workspacePath: '/ws', backend: backend as never },
    global: { plugins: [i18n] },
  })
}

describe('PlansPane', () => {
  it('lists active and completed plans', async () => {
    const wrapper = mountPane(makeBackend())
    await flushPromises()
    expect(wrapper.text()).toContain('Active Plan')
    expect(wrapper.text()).toContain('Done Plan')
    expect(wrapper.text()).toContain('1/1 done')
  })

  it('emits open-file when a plan is clicked', async () => {
    const wrapper = mountPane(makeBackend())
    await flushPromises()
    await wrapper.find('.plan-row').trigger('click')
    expect(wrapper.emitted('open-file')?.[0]).toEqual([
      { filepath: '.cursor/plans/active.plan.md', name: 'active.plan.md' },
    ])
  })

  it('deletes completed plans', async () => {
    const backend = makeBackend()
    const wrapper = mountPane(backend)
    await flushPromises()
    await wrapper.find('.plans-link-btn').trigger('click')
    await flushPromises()
    expect(backend.send).toHaveBeenCalledWith('fs.delete', {
      workspace_path: '/ws',
      rel_path: '.cursor/plans/done.plan.md',
    })
  })

  it('lists HTML plans grouped by stage alongside unaffected legacy plans', async () => {
    const wrapper = mountPane(
      makeBackend({
        htmlEntries: [
          { name: 'review_a1b2c3.html', rel_path: '.agent-team/plans/review_a1b2c3.html', is_dir: false },
          { name: 'shipped_d4e5f6.html', rel_path: '.agent-team/plans/shipped_d4e5f6.html', is_dir: false },
        ],
        htmlFiles: {
          '.agent-team/plans/review_a1b2c3.html': HTML_REVIEW_PLAN,
          '.agent-team/plans/shipped_d4e5f6.html': HTML_DONE_PLAN,
        },
      })
    )
    await flushPromises()

    // Legacy markdown plans unaffected.
    expect(wrapper.text()).toContain('Active Plan')
    expect(wrapper.text()).toContain('Done Plan')

    // HTML plans appear under their stage groups with progress and stage chip.
    const sectionTexts = wrapper.findAll('.plans-section').map((s) => s.text())
    const reviewSection = sectionTexts.find((t) => t.includes('In Review'))
    expect(reviewSection).toBeDefined()
    expect(reviewSection).toContain('HTML Review Plan')
    expect(reviewSection).toContain('1/2 done')
    expect(reviewSection).toContain('in-review')

    const doneSection = sectionTexts.find((t) => t.includes('HTML Done Plan'))
    expect(doneSection).toBeDefined()
    expect(doneSection).toContain('Done')
    expect(doneSection).toContain('1/1 done')
  })

  it('excludes underscore-prefixed infrastructure files', async () => {
    const backend = makeBackend({
      htmlEntries: [
        { name: '_template.html', rel_path: '.agent-team/plans/_template.html', is_dir: false },
        { name: 'review_a1b2c3.html', rel_path: '.agent-team/plans/review_a1b2c3.html', is_dir: false },
      ],
      htmlFiles: { '.agent-team/plans/review_a1b2c3.html': HTML_REVIEW_PLAN },
    })
    const wrapper = mountPane(backend)
    await flushPromises()

    expect(wrapper.text()).toContain('HTML Review Plan')
    expect(backend.send).not.toHaveBeenCalledWith('fs.read_file', {
      workspace_path: '/ws',
      rel_path: '.agent-team/plans/_template.html',
    })
  })

  it('excludes dot-prefixed files from the plan listing', async () => {
    const backend = makeBackend({
      htmlEntries: [
        { name: '.hidden_a1b2c3.html', rel_path: '.agent-team/plans/.hidden_a1b2c3.html', is_dir: false },
        { name: 'review_a1b2c3.html', rel_path: '.agent-team/plans/review_a1b2c3.html', is_dir: false },
      ],
      htmlFiles: { '.agent-team/plans/review_a1b2c3.html': HTML_REVIEW_PLAN },
    })
    const wrapper = mountPane(backend)
    await flushPromises()

    expect(wrapper.text()).toContain('HTML Review Plan')
    expect(backend.send).not.toHaveBeenCalledWith('fs.read_file', {
      workspace_path: '/ws',
      rel_path: '.agent-team/plans/.hidden_a1b2c3.html',
    })
  })

  it('lists an HTML file without valid meta as a doc under Active', async () => {
    const wrapper = mountPane(
      makeBackend({
        htmlEntries: [
          { name: 'notes_aaaaaa.html', rel_path: '.agent-team/plans/notes_aaaaaa.html', is_dir: false },
        ],
        htmlFiles: { '.agent-team/plans/notes_aaaaaa.html': HTML_DOC },
      })
    )
    await flushPromises()

    const activeSection = wrapper.findAll('.plans-section').map((s) => s.text()).find((t) => t.includes('Active'))
    expect(activeSection).toContain('notes_aaaaaa.html')
    expect(activeSection).toContain('doc')
  })

  it('opens HTML plans through the open-file emit', async () => {
    const wrapper = mountPane(
      makeBackend({
        htmlEntries: [
          { name: 'review_a1b2c3.html', rel_path: '.agent-team/plans/review_a1b2c3.html', is_dir: false },
        ],
        htmlFiles: { '.agent-team/plans/review_a1b2c3.html': HTML_REVIEW_PLAN },
      })
    )
    await flushPromises()

    const rows = wrapper.findAll('.plan-row')
    const htmlRow = rows.find((r) => r.text().includes('HTML Review Plan'))!
    await htmlRow.trigger('click')
    const emitted = wrapper.emitted('open-file')!
    expect(emitted[emitted.length - 1]).toEqual([
      { filepath: '.agent-team/plans/review_a1b2c3.html', name: 'review_a1b2c3.html' },
    ])
  })

  it('surfaces a real .agent-team/plans list error', async () => {
    const wrapper = mountPane(makeBackend({ htmlListError: 'permission denied' }))
    await flushPromises()
    expect(wrapper.find('.plans-error').exists()).toBe(true)
    expect(wrapper.find('.plans-error').text()).toContain('permission denied')
  })

  it('stays silent when .agent-team/plans does not exist', async () => {
    const wrapper = mountPane(makeBackend())
    await flushPromises()
    expect(wrapper.find('.plans-error').exists()).toBe(false)
    expect(wrapper.text()).toContain('Active Plan')
  })

  it('reads HTML plans in parallel and lists them all', async () => {
    const backend = makeBackend({
      htmlEntries: [
        { name: 'review_a1b2c3.html', rel_path: '.agent-team/plans/review_a1b2c3.html', is_dir: false },
        { name: 'shipped_d4e5f6.html', rel_path: '.agent-team/plans/shipped_d4e5f6.html', is_dir: false },
      ],
      htmlFiles: {
        '.agent-team/plans/review_a1b2c3.html': HTML_REVIEW_PLAN,
        '.agent-team/plans/shipped_d4e5f6.html': HTML_DONE_PLAN,
      },
    })
    const wrapper = mountPane(backend)
    await flushPromises()

    expect(backend.htmlReads.max).toBe(2)
    expect(wrapper.text()).toContain('HTML Review Plan')
    expect(wrapper.text()).toContain('HTML Done Plan')
  })

  it('keeps other HTML plans when one read fails', async () => {
    const wrapper = mountPane(
      makeBackend({
        htmlEntries: [
          { name: 'review_a1b2c3.html', rel_path: '.agent-team/plans/review_a1b2c3.html', is_dir: false },
          { name: 'shipped_d4e5f6.html', rel_path: '.agent-team/plans/shipped_d4e5f6.html', is_dir: false },
        ],
        htmlFiles: { '.agent-team/plans/shipped_d4e5f6.html': HTML_DONE_PLAN },
        readFailures: ['.agent-team/plans/review_a1b2c3.html'],
      })
    )
    await flushPromises()

    expect(wrapper.text()).not.toContain('HTML Review Plan')
    expect(wrapper.text()).toContain('HTML Done Plan')
  })

  it('groups draft plans under Draft, not In Review', async () => {
    const wrapper = mountPane(
      makeBackend({
        htmlEntries: [
          { name: 'draft_aaaaaa.html', rel_path: '.agent-team/plans/draft_aaaaaa.html', is_dir: false },
          { name: 'review_a1b2c3.html', rel_path: '.agent-team/plans/review_a1b2c3.html', is_dir: false },
        ],
        htmlFiles: {
          '.agent-team/plans/draft_aaaaaa.html': HTML_DRAFT_PLAN,
          '.agent-team/plans/review_a1b2c3.html': HTML_REVIEW_PLAN,
        },
      })
    )
    await flushPromises()

    const sectionTexts = wrapper.findAll('.plans-section').map((s) => s.text())
    const draftSection = sectionTexts.find((t) => t.includes('HTML Draft Plan'))
    expect(draftSection).toBeDefined()
    expect(draftSection).toContain('Draft')
    expect(draftSection).not.toContain('In Review')
    const reviewSection = sectionTexts.find((t) => t.includes('In Review'))
    expect(reviewSection).toBeDefined()
    expect(reviewSection).toContain('HTML Review Plan')
    expect(reviewSection).not.toContain('HTML Draft Plan')
  })

  it('batch delete covers markdown completed plus HTML done/abandoned', async () => {
    const backend = makeBackend({
      htmlEntries: [
        { name: 'review_a1b2c3.html', rel_path: '.agent-team/plans/review_a1b2c3.html', is_dir: false },
        { name: 'shipped_d4e5f6.html', rel_path: '.agent-team/plans/shipped_d4e5f6.html', is_dir: false },
      ],
      htmlFiles: {
        '.agent-team/plans/review_a1b2c3.html': HTML_REVIEW_PLAN,
        '.agent-team/plans/shipped_d4e5f6.html': HTML_DONE_PLAN,
      },
    })
    const wrapper = mountPane(backend)
    await flushPromises()

    await wrapper.find('.plans-link-btn').trigger('click')
    await flushPromises()

    expect(backend.send).toHaveBeenCalledWith('fs.delete', {
      workspace_path: '/ws',
      rel_path: '.cursor/plans/done.plan.md',
    })
    expect(backend.send).toHaveBeenCalledWith('fs.delete', {
      workspace_path: '/ws',
      rel_path: '.agent-team/plans/shipped_d4e5f6.html',
    })
    expect(backend.send).not.toHaveBeenCalledWith('fs.delete', {
      workspace_path: '/ws',
      rel_path: '.agent-team/plans/review_a1b2c3.html',
    })
  })
})

describe('PlansPane – plans.changed live refresh', () => {
  it('reloads the plan list on a matching-workspace broadcast', async () => {
    const backend = makeBackend()
    const wrapper = mountPane(backend)
    await flushPromises()
    const callsBefore = backend.send.mock.calls.filter(([type]) => type === 'fs.list_dir').length

    backend.emit('plans.changed', { workspace_path: '/ws' })
    await flushPromises()

    const callsAfter = backend.send.mock.calls.filter(([type]) => type === 'fs.list_dir').length
    expect(callsAfter).toBeGreaterThan(callsBefore)
    expect(wrapper.text()).toContain('Active Plan')
  })

  it('ignores broadcasts for other workspaces and malformed payloads', async () => {
    const backend = makeBackend()
    mountPane(backend)
    await flushPromises()
    const callsBefore = backend.send.mock.calls.length

    backend.emit('plans.changed', { workspace_path: '/other-ws' })
    backend.emit('plans.changed', null)
    backend.emit('plans.changed', 'nope')
    await flushPromises()

    expect(backend.send.mock.calls.length).toBe(callsBefore)
  })

  it('stops listening after unmount', async () => {
    const backend = makeBackend()
    const wrapper = mountPane(backend)
    await flushPromises()
    wrapper.unmount()
    const callsBefore = backend.send.mock.calls.length

    backend.emit('plans.changed', { workspace_path: '/ws' })
    await flushPromises()

    expect(backend.send.mock.calls.length).toBe(callsBefore)
  })
})

// ── Context menu ───────────────────────────────────────────────────────────

function reviewBackend() {
  return makeBackend({
    htmlEntries: [
      { name: 'review_a1b2c3.html', rel_path: '.agent-team/plans/review_a1b2c3.html', is_dir: false },
    ],
    htmlFiles: { '.agent-team/plans/review_a1b2c3.html': HTML_REVIEW_PLAN },
  })
}

function docBackend() {
  return makeBackend({
    htmlEntries: [
      { name: 'notes_aaaaaa.html', rel_path: '.agent-team/plans/notes_aaaaaa.html', is_dir: false },
    ],
    htmlFiles: { '.agent-team/plans/notes_aaaaaa.html': HTML_DOC },
  })
}

async function openMenuOn(wrapper: ReturnType<typeof mountPane>, rowText: string) {
  const row = wrapper.findAll('.plan-row').find((r) => r.text().includes(rowText))!
  await row.trigger('contextmenu')
  await flushPromises()
}

function menuItem(wrapper: ReturnType<typeof mountPane>, label: string) {
  return wrapper.findAll('.menu-item').find((i) => i.text() === label)!
}

describe('PlansPane – context menu', () => {
  it('opens on right-click for HTML plans with plan actions, no promote', async () => {
    const wrapper = mountPane(reviewBackend())
    await flushPromises()
    await openMenuOn(wrapper, 'HTML Review Plan')

    const labels = wrapper.findAll('.menu-item').map((i) => i.text())
    expect(labels).toEqual(['Open', 'Share to Git', 'Rename', 'Delete'])
  })

  it('adds Promote to Plan for HTML docs without meta', async () => {
    const wrapper = mountPane(docBackend())
    await flushPromises()
    await openMenuOn(wrapper, 'notes_aaaaaa.html')

    const labels = wrapper.findAll('.menu-item').map((i) => i.text())
    expect(labels).toContain('Promote to Plan')
  })

  it('does not open for legacy markdown plans', async () => {
    const wrapper = mountPane(makeBackend())
    await flushPromises()
    await openMenuOn(wrapper, 'Active Plan')
    expect(wrapper.find('.ctx-menu').exists()).toBe(false)
  })

  it('Open fires the open-file emit', async () => {
    const wrapper = mountPane(reviewBackend())
    await flushPromises()
    await openMenuOn(wrapper, 'HTML Review Plan')

    await menuItem(wrapper, 'Open').trigger('click')
    const emitted = wrapper.emitted('open-file')!
    expect(emitted[emitted.length - 1]).toEqual([
      { filepath: '.agent-team/plans/review_a1b2c3.html', name: 'review_a1b2c3.html' },
    ])
    expect(wrapper.find('.ctx-menu').exists()).toBe(false)
  })

  it('Share to Git copies the plan verbatim into .plans/', async () => {
    const backend = reviewBackend()
    const wrapper = mountPane(backend)
    await flushPromises()
    await openMenuOn(wrapper, 'HTML Review Plan')

    await menuItem(wrapper, 'Share to Git').trigger('click')
    await flushPromises()

    expect(backend.writes).toEqual([{ rel: '.plans/review_a1b2c3.html', content: HTML_REVIEW_PLAN }])
  })
})

describe('PlansPane – rename', () => {
  it('rejects a name that breaks the <slug>_<hex>.html format', async () => {
    notify.toast.mockClear()
    const backend = reviewBackend()
    const wrapper = mountPane(backend)
    await flushPromises()
    await openMenuOn(wrapper, 'HTML Review Plan')
    await menuItem(wrapper, 'Rename').trigger('click')

    await wrapper.find('.rename-input').setValue('Bad Name.html')
    await wrapper.find('.rename-btn--primary').trigger('click')
    await flushPromises()

    expect(backend.renames).toEqual([])
    expect(notify.toast).toHaveBeenCalledWith('Invalid name — must be kebab-slug_6hex.html', {
      type: 'error',
    })
    // Dialog stays open for correction.
    expect(wrapper.find('.rename-dialog').exists()).toBe(true)
  })

  it('renames within the plans directory when the format is valid', async () => {
    const backend = reviewBackend()
    const wrapper = mountPane(backend)
    await flushPromises()
    await openMenuOn(wrapper, 'HTML Review Plan')
    await menuItem(wrapper, 'Rename').trigger('click')

    await wrapper.find('.rename-input').setValue('renamed-plan_abc123.html')
    await wrapper.find('.rename-btn--primary').trigger('click')
    await flushPromises()

    expect(backend.renames).toEqual([
      { src: '.agent-team/plans/review_a1b2c3.html', dst: '.agent-team/plans/renamed-plan_abc123.html' },
    ])
    expect(wrapper.find('.rename-dialog').exists()).toBe(false)
  })
})

describe('PlansPane – delete single', () => {
  it('deletes an in-review plan only after a second confirmation', async () => {
    notify.confirm.mockClear()
    const backend = reviewBackend()
    const wrapper = mountPane(backend)
    await flushPromises()
    await openMenuOn(wrapper, 'HTML Review Plan')

    await menuItem(wrapper, 'Delete').trigger('click')
    await flushPromises()

    expect(notify.confirm).toHaveBeenCalledTimes(2)
    expect(backend.send).toHaveBeenCalledWith('fs.delete', {
      workspace_path: '/ws',
      rel_path: '.agent-team/plans/review_a1b2c3.html',
    })
  })

  it('aborts when the second confirmation is declined', async () => {
    notify.confirm.mockClear()
    notify.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const backend = reviewBackend()
    const wrapper = mountPane(backend)
    await flushPromises()
    await openMenuOn(wrapper, 'HTML Review Plan')

    await menuItem(wrapper, 'Delete').trigger('click')
    await flushPromises()

    expect(notify.confirm).toHaveBeenCalledTimes(2)
    expect(backend.send).not.toHaveBeenCalledWith('fs.delete', {
      workspace_path: '/ws',
      rel_path: '.agent-team/plans/review_a1b2c3.html',
    })
  })

  it('deletes a done plan after a single confirmation', async () => {
    notify.confirm.mockClear()
    const backend = makeBackend({
      htmlEntries: [
        { name: 'shipped_d4e5f6.html', rel_path: '.agent-team/plans/shipped_d4e5f6.html', is_dir: false },
      ],
      htmlFiles: { '.agent-team/plans/shipped_d4e5f6.html': HTML_DONE_PLAN },
    })
    const wrapper = mountPane(backend)
    await flushPromises()
    await openMenuOn(wrapper, 'HTML Done Plan')

    await menuItem(wrapper, 'Delete').trigger('click')
    await flushPromises()

    expect(notify.confirm).toHaveBeenCalledTimes(1)
    expect(backend.send).toHaveBeenCalledWith('fs.delete', {
      workspace_path: '/ws',
      rel_path: '.agent-team/plans/shipped_d4e5f6.html',
    })
  })
})

describe('PlansPane – promote doc to plan', () => {
  it('injects a minimal draft meta the parser accepts, named after the file', async () => {
    const backend = docBackend()
    const wrapper = mountPane(backend)
    await flushPromises()
    await openMenuOn(wrapper, 'notes_aaaaaa.html')

    await menuItem(wrapper, 'Promote to Plan').trigger('click')
    await flushPromises()

    expect(backend.writes).toHaveLength(1)
    expect(backend.writes[0].rel).toBe('.agent-team/plans/notes_aaaaaa.html')
    const parsed = parseHtmlPlanMeta(backend.writes[0].content)
    expect(parsed).not.toBeNull()
    expect(parsed!.warnings).toEqual([])
    expect(parsed!.meta).toMatchObject({
      schemaVersion: 1,
      name: 'notes_aaaaaa.html', // HTML_DOC has no <title>
      stage: 'draft',
      approvedAt: null,
      todos: [],
      reviewNotes: [],
    })
    // Original doc content survives around the injected island.
    expect(backend.writes[0].content).toContain('no meta here')
  })

  it('uses the <title> as the plan name when present', async () => {
    const titledDoc = '<!doctype html><html><head><title>Titled Doc</title></head><body>x</body></html>'
    const backend = makeBackend({
      htmlEntries: [
        { name: 'titled_bbbbbb.html', rel_path: '.agent-team/plans/titled_bbbbbb.html', is_dir: false },
      ],
      htmlFiles: { '.agent-team/plans/titled_bbbbbb.html': titledDoc },
    })
    const wrapper = mountPane(backend)
    await flushPromises()
    await openMenuOn(wrapper, 'titled_bbbbbb.html')

    await menuItem(wrapper, 'Promote to Plan').trigger('click')
    await flushPromises()

    expect(parseHtmlPlanMeta(backend.writes[0].content)!.meta.name).toBe('Titled Doc')
  })
})
