// @vitest-environment happy-dom
// Unit tests for the plan review toolbar shown above HTML plan previews:
// stage badge + progress display, approve gating, note resolution, note
// submission, and that every write goes through replaceHtmlPlanMeta (only the
// plan-meta block changes; all other bytes are preserved).
import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import PlanReviewToolbar from '../PlanReviewToolbar.vue'
import { i18n } from '../../i18n'
import { parseHtmlPlanMeta, replaceHtmlPlanMeta } from '../../composables/usePlanHtml'
import type { HtmlPlanMeta } from '../../composables/usePlanHtml'

i18n.global.locale.value = 'en-US'

vi.mock('../../composables/useNotify', () => ({
  useNotify: () => ({ toast: vi.fn(), alert: vi.fn(), confirm: vi.fn() }),
}))

function baseMeta(overrides: Partial<HtmlPlanMeta> = {}): HtmlPlanMeta {
  return {
    schemaVersion: 1,
    name: 'Test Plan',
    overview: 'A plan for testing.',
    stage: 'in-review',
    approvedAt: null,
    todos: [
      { id: 'phase-a', content: 'Phase A', status: 'done' },
      { id: 'phase-b', content: 'Phase B', status: 'pending' },
    ],
    reviewNotes: [],
    ...overrides,
  }
}

function planDoc(meta: HtmlPlanMeta): string {
  return [
    '<html><head><title>Test Plan</title></head><body>',
    '<h1>Head marker</h1>',
    '<script type="application/json" id="plan-meta">',
    JSON.stringify(meta, null, 2),
    '</scr' + 'ipt>',
    '<footer>tail marker</footer>',
    '</body></html>',
  ].join('\n')
}

interface Harness {
  wrapper: VueWrapper
  writes: string[]
  setContent: (c: string) => void
}

async function mountToolbar(content: string): Promise<Harness> {
  const writes: string[] = []
  let current = content
  const backend = {
    httpUrl: ref('http://127.0.0.1:8123'),
    status: ref('connected'),
    send: vi.fn(async (type: string, payload: Record<string, unknown>) => {
      if (type === 'fs.read_file') return { payload: { ok: true, content: current } }
      if (type === 'fs.write_file') {
        writes.push(payload.content as string)
        current = payload.content as string
        return { payload: { ok: true } }
      }
      return { payload: { ok: true } }
    }),
  }
  const wrapper = mount(PlanReviewToolbar, {
    props: {
      workspacePath: '/ws',
      relPath: '.agent-team/plans/test-plan_a1b2c3.html',
      backend: backend as never,
    },
    global: { plugins: [i18n] },
  })
  await flushPromises()
  return { wrapper, writes, setContent: (c: string) => { current = c } }
}

function lastWrittenMeta(writes: string[]): HtmlPlanMeta {
  const parsed = parseHtmlPlanMeta(writes[writes.length - 1])
  expect(parsed).not.toBeNull()
  return parsed!.meta
}

describe('PlanReviewToolbar – display', () => {
  it('shows the stage badge and todo progress from plan-meta', async () => {
    const { wrapper } = await mountToolbar(planDoc(baseMeta()))
    const badge = wrapper.find('.prt-stage')
    expect(badge.exists()).toBe(true)
    expect(badge.classes()).toContain('prt-stage--in-review')
    expect(badge.text()).toBe('In Review')
    expect(wrapper.find('.prt-progress').text()).toBe('1/2 done')
  })

  it('renders nothing for a file without a valid plan-meta block', async () => {
    const { wrapper } = await mountToolbar('<html><body><p>plain page</p></body></html>')
    expect(wrapper.find('.prt').exists()).toBe(false)
  })

  it('shows the unresolved note count and note details in the panel', async () => {
    const meta = baseMeta({
      reviewNotes: [
        { id: 'n1', author: 'user', text: 'Fix the risk section', resolved: false, reply: '' },
        { id: 'n2', author: 'ai', text: 'Clarified scope', resolved: true, reply: 'Done in rev 2' },
      ],
    })
    const { wrapper } = await mountToolbar(planDoc(meta))
    expect(wrapper.find('.prt-notes-btn').text()).toContain('1 unresolved')

    await wrapper.find('.prt-notes-btn').trigger('click')
    const notes = wrapper.findAll('.prt-note')
    expect(notes).toHaveLength(2)
    expect(notes[0].find('.prt-note-author').text()).toBe('user')
    expect(notes[0].find('.prt-note-text').text()).toBe('Fix the risk section')
    expect(notes[0].find('.prt-note-resolve').exists()).toBe(true)
    expect(notes[1].find('.prt-note-reply').text()).toBe('Done in rev 2')
    expect(notes[1].find('.prt-note-resolve').exists()).toBe(false)
    expect(notes[1].find('.prt-note-done').exists()).toBe(true)
  })
})

describe('PlanReviewToolbar – approve gating', () => {
  it('disables Approve while unresolved notes exist', async () => {
    const meta = baseMeta({
      reviewNotes: [{ id: 'n1', author: 'user', text: 'Open point', resolved: false, reply: '' }],
    })
    const { wrapper } = await mountToolbar(planDoc(meta))
    expect(wrapper.find('.prt-approve').attributes('disabled')).toBeDefined()
  })

  it('disables Approve when stage is not in-review', async () => {
    const meta = baseMeta({ stage: 'draft' })
    const { wrapper } = await mountToolbar(planDoc(meta))
    expect(wrapper.find('.prt-approve').attributes('disabled')).toBeDefined()
  })

  it('approves an in-review plan with all notes resolved, writing stage and approvedAt', async () => {
    const meta = baseMeta({
      reviewNotes: [{ id: 'n1', author: 'user', text: 'Ok now', resolved: true, reply: 'ack' }],
    })
    const { wrapper, writes } = await mountToolbar(planDoc(meta))
    const approve = wrapper.find('.prt-approve')
    expect(approve.attributes('disabled')).toBeUndefined()

    await approve.trigger('click')
    await flushPromises()

    expect(writes).toHaveLength(1)
    const written = lastWrittenMeta(writes)
    expect(written.stage).toBe('approved')
    expect(typeof written.approvedAt).toBe('string')
    expect(Number.isNaN(Date.parse(written.approvedAt!))).toBe(false)
    expect(wrapper.emitted('updated')).toHaveLength(1)
    // Badge reflects the new stage without a remount.
    expect(wrapper.find('.prt-stage').classes()).toContain('prt-stage--approved')
  })
})

describe('PlanReviewToolbar – notes', () => {
  it('resolves a note and writes the flip through replaceHtmlPlanMeta', async () => {
    const meta = baseMeta({
      reviewNotes: [
        { id: 'n1', author: 'user', text: 'First', resolved: false, reply: '' },
        { id: 'n2', author: 'user', text: 'Second', resolved: false, reply: '' },
      ],
    })
    const doc = planDoc(meta)
    const { wrapper, writes } = await mountToolbar(doc)
    await wrapper.find('.prt-notes-btn').trigger('click')

    await wrapper.findAll('.prt-note-resolve')[0].trigger('click')
    await flushPromises()

    const written = lastWrittenMeta(writes)
    expect(written.reviewNotes[0]).toMatchObject({ id: 'n1', resolved: true })
    expect(written.reviewNotes[1]).toMatchObject({ id: 'n2', resolved: false })
    // The write is exactly the replaceHtmlPlanMeta output: bytes outside the
    // meta block are untouched.
    expect(writes[0]).toBe(replaceHtmlPlanMeta(doc, written))
    expect(writes[0]).toContain('<h1>Head marker</h1>')
    expect(writes[0]).toContain('<footer>tail marker</footer>')
  })

  it('appends a submitted note with the next incremental id and user author', async () => {
    const meta = baseMeta({
      reviewNotes: [{ id: 'n2', author: 'ai', text: 'Existing', resolved: true, reply: '' }],
    })
    const { wrapper, writes } = await mountToolbar(planDoc(meta))
    await wrapper.find('.prt-notes-btn').trigger('click')

    await wrapper.find('.prt-input').setValue('  Please add tests  ')
    await wrapper.find('.prt-send').trigger('click')
    await flushPromises()

    const written = lastWrittenMeta(writes)
    expect(written.reviewNotes).toHaveLength(2)
    expect(written.reviewNotes[1]).toEqual({
      id: 'n3',
      author: 'user',
      text: 'Please add tests',
      resolved: false,
      reply: '',
    })
    expect((wrapper.find('.prt-input').element as HTMLInputElement).value).toBe('')
    expect(wrapper.find('.prt-notes-btn').text()).toContain('1 unresolved')
  })
})

describe('PlanReviewToolbar – external refresh', () => {
  it('re-reads the file on window focus and emits updated when it changed', async () => {
    const { wrapper, setContent } = await mountToolbar(planDoc(baseMeta()))
    expect(wrapper.emitted('updated')).toBeUndefined()

    setContent(planDoc(baseMeta({ stage: 'approved', approvedAt: '2026-07-18T00:00:00Z' })))
    window.dispatchEvent(new Event('focus'))
    await flushPromises()

    expect(wrapper.emitted('updated')).toHaveLength(1)
    expect(wrapper.find('.prt-stage').classes()).toContain('prt-stage--approved')
  })

  it('does not emit updated on focus when the file is unchanged', async () => {
    const { wrapper } = await mountToolbar(planDoc(baseMeta()))
    window.dispatchEvent(new Event('focus'))
    await flushPromises()
    expect(wrapper.emitted('updated')).toBeUndefined()
  })
})
