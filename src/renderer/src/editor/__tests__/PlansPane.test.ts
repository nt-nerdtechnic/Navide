// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import PlansPane from '../PlansPane.vue'
import { i18n } from '../../i18n'

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
  return {
    status: ref('connected'),
    htmlReads,
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
