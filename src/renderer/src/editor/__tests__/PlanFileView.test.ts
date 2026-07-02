// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import PlanFileView from '../PlanFileView.vue'

const PLAN_RAW = `---
name: My Feature Plan
overview: A plan to test the component.
todos:
  - id: phase-a-task
    content: Build the parser.
    status: pending
  - id: phase-b-task
    content: Build the component.
    status: done
isProject: false
---

## Phase A — Parser

Description of phase A.

## Phase B — Component

Description of phase B.
`

function makeBackend(content = PLAN_RAW) {
  return {
    send: vi.fn(async (channel: string) => {
      if (channel === 'fs.read_file') return { payload: { ok: true, content } }
      if (channel === 'fs.write_file') return { payload: { ok: true } }
      return { payload: { ok: false } }
    }),
  }
}

// Stub useNotify so toast calls don't throw.
vi.mock('../composables/useNotify', () => ({
  useNotify: () => ({ toast: vi.fn(), alert: vi.fn(), confirm: vi.fn() }),
}))
vi.mock('../../composables/useNotify', () => ({
  useNotify: () => ({ toast: vi.fn(), alert: vi.fn(), confirm: vi.fn() }),
}))

describe('PlanFileView – rendering', () => {
  it('renders the plan name and overview', async () => {
    const wrapper = mount(PlanFileView, {
      props: { workspacePath: '/ws', relPath: 'test.plan.md', backend: makeBackend() as never },
    })
    await flushPromises()
    expect(wrapper.text()).toContain('My Feature Plan')
    expect(wrapper.text()).toContain('A plan to test the component.')
  })

  it('renders phase group headings', async () => {
    const wrapper = mount(PlanFileView, {
      props: { workspacePath: '/ws', relPath: 'test.plan.md', backend: makeBackend() as never },
    })
    await flushPromises()
    expect(wrapper.text()).toContain('Phase A — Parser')
    expect(wrapper.text()).toContain('Phase B — Component')
  })

  it('renders todo contents with status badges', async () => {
    const wrapper = mount(PlanFileView, {
      props: { workspacePath: '/ws', relPath: 'test.plan.md', backend: makeBackend() as never },
    })
    await flushPromises()
    expect(wrapper.text()).toContain('Build the parser.')
    expect(wrapper.text()).toContain('Build the component.')
    expect(wrapper.text()).toContain('pending')
    expect(wrapper.text()).toContain('done')
  })

  it('shows a progress fraction per group', async () => {
    const wrapper = mount(PlanFileView, {
      props: { workspacePath: '/ws', relPath: 'test.plan.md', backend: makeBackend() as never },
    })
    await flushPromises()
    // Phase A has 0/1 done; Phase B has 1/1 done.
    expect(wrapper.text()).toContain('0/1 done')
    expect(wrapper.text()).toContain('1/1 done')
  })

  it('shows an error message when content cannot be loaded', async () => {
    const backend = {
      send: vi.fn(async () => ({ payload: { ok: false, error: 'File not found' } })),
    }
    const wrapper = mount(PlanFileView, {
      props: { workspacePath: '/ws', relPath: 'missing.plan.md', backend: backend as never },
    })
    await flushPromises()
    expect(wrapper.text()).toContain('File not found')
  })

  it('shows fallback message for invalid plan frontmatter', async () => {
    const backend = makeBackend('# Not a plan file\n\nJust markdown.')
    const wrapper = mount(PlanFileView, {
      props: { workspacePath: '/ws', relPath: 'bad.plan.md', backend: backend as never },
    })
    await flushPromises()
    expect(wrapper.text()).toContain('Could not parse plan frontmatter')
  })
})

describe('PlanFileView – checkbox interaction', () => {
  it('clicking a pending todo cycles it to in-progress and saves', async () => {
    const backend = makeBackend()
    const wrapper = mount(PlanFileView, {
      props: { workspacePath: '/ws', relPath: 'test.plan.md', backend: backend as never },
    })
    await flushPromises()

    // Find the first todo row (phase-a-task which is 'pending').
    const todos = wrapper.findAll('.pfv-todo')
    expect(todos.length).toBeGreaterThan(0)
    await todos[0].trigger('click')
    await flushPromises()

    // fs.write_file should have been called.
    const writeCall = (backend.send as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: string[]) => c[0] === 'fs.write_file'
    )
    expect(writeCall).toBeDefined()

    // The written content should have the updated status.
    const writtenContent: string = writeCall![1].content
    expect(writtenContent).toContain('status: in-progress')
  })

  it('clicking a done todo cycles it back to pending', async () => {
    const backend = makeBackend()
    const wrapper = mount(PlanFileView, {
      props: { workspacePath: '/ws', relPath: 'test.plan.md', backend: backend as never },
    })
    await flushPromises()

    // The second todo (phase-b-task) is 'done'.
    const todos = wrapper.findAll('.pfv-todo')
    await todos[1].trigger('click')
    await flushPromises()

    const writeCall = (backend.send as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: string[]) => c[0] === 'fs.write_file'
    )
    const writtenContent: string = writeCall![1].content
    expect(writtenContent).toContain('status: pending')
  })
})
