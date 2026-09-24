// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import { useGuard } from '../../composables/useGuard'
import PaneGuardBadge from '../PaneGuardBadge.vue'

let wrapper: VueWrapper | undefined
let mock: ReturnType<typeof createMockBackend>

async function render(paneId = 'p1'): Promise<VueWrapper> {
  wrapper = mount(PaneGuardBadge, {
    props: { paneId, store: useGuard(mock.backend) },
    global: { plugins: [i18n] },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  i18n.global.locale.value = 'en-US'
  mock = createMockBackend('connected')
  mock.setResponse('guard.status', { enabled: true, counts: {}, hook_support: {} })
  mock.setResponse('guard.taint.list', {
    panes: [{ pane_id: 'p1', sources: ['remote', 'agent'], since: 1_700_000_000, detail: '' }],
  })
  mock.setResponse('guard.taint.clear', {})
})
afterEach(() => {
  wrapper?.unmount()
  document.body.innerHTML = ''
})

describe('PaneGuardBadge', () => {
  it('renders nothing for a pane that is not tainted', async () => {
    const w = await render('p2')
    expect(w.find('[data-testid="guard-taint-badge"]').exists()).toBe(false)
  })

  it('shows the badge with why and since in its tooltip', async () => {
    const w = await render()
    const badge = w.get('[data-testid="guard-taint-badge"]')
    expect(badge.text()).toBe('External influence')
    expect(badge.attributes('title')).toContain('Remote, Other agent')
  })

  it('clears only after the confirm step', async () => {
    const w = await render()
    await w.get('[data-testid="guard-taint-badge"]').trigger('click')
    expect(mock.sent.some((s) => s.type === 'guard.taint.clear')).toBe(false)
    mock.setResponse('guard.taint.list', { panes: [] })
    ;(document.querySelector('[data-testid="guard-taint-clear"]') as HTMLElement).click()
    await flushPromises()
    expect(mock.sent.find((s) => s.type === 'guard.taint.clear')?.payload).toEqual({ pane_id: 'p1' })
    expect(w.find('[data-testid="guard-taint-badge"]').exists()).toBe(false)
  })
})
