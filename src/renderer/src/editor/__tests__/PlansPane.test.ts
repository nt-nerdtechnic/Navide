// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import PlansPane from '../PlansPane.vue'

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

const notify = {
  toast: vi.fn(),
  confirm: vi.fn(async () => true),
}

vi.mock('../../composables/useNotify', () => ({
  useNotify: () => notify,
}))

function makeBackend() {
  return {
    status: ref('connected'),
    send: vi.fn(async (channel: string, payload: Record<string, unknown>) => {
      if (channel === 'fs.list_dir') {
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
      if (channel === 'fs.read_file') {
        return {
          payload: {
            ok: true,
            content: payload.rel_path === '.cursor/plans/done.plan.md' ? DONE_PLAN : ACTIVE_PLAN,
          },
        }
      }
      if (channel === 'fs.delete') return { payload: { ok: true } }
      return { payload: { ok: false, error: 'unexpected' } }
    }),
  }
}

describe('PlansPane', () => {
  it('lists active and completed plans', async () => {
    const wrapper = mount(PlansPane, {
      props: { workspacePath: '/ws', backend: makeBackend() as never },
    })
    await flushPromises()
    expect(wrapper.text()).toContain('Active Plan')
    expect(wrapper.text()).toContain('Done Plan')
    expect(wrapper.text()).toContain('1/1 done')
  })

  it('emits open-file when a plan is clicked', async () => {
    const wrapper = mount(PlansPane, {
      props: { workspacePath: '/ws', backend: makeBackend() as never },
    })
    await flushPromises()
    await wrapper.find('.plan-row').trigger('click')
    expect(wrapper.emitted('open-file')?.[0]).toEqual([
      { filepath: '.cursor/plans/active.plan.md', name: 'active.plan.md' },
    ])
  })

  it('deletes completed plans', async () => {
    const backend = makeBackend()
    const wrapper = mount(PlansPane, {
      props: { workspacePath: '/ws', backend: backend as never },
    })
    await flushPromises()
    await wrapper.find('.plans-link-btn').trigger('click')
    await flushPromises()
    expect(backend.send).toHaveBeenCalledWith('fs.delete', {
      workspace_path: '/ws',
      rel_path: '.cursor/plans/done.plan.md',
    })
  })
})
