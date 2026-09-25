// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { useNotify } from '@navide/plugin-ui/foundation'
import NotificationHost from '../NotificationHost.vue'

describe('NotificationHost danger confirm', () => {
  afterEach(() => {
    useNotify().resolveDialog(false)
    document.body.innerHTML = ''
  })

  it('renders a default confirm exactly as before (no danger classes)', async () => {
    const wrapper = mount(NotificationHost, { attachTo: document.body })
    void useNotify().confirm('Delete the pipeline?', { title: 'Delete', confirmText: 'Delete' })
    await flushPromises()
    expect(document.querySelector('.card')?.className).toBe('card confirm')
    expect(document.querySelector('footer .primary')?.className).toBe('primary')
    wrapper.unmount()
  })

  it('renders an opt-in danger confirm with a danger action', async () => {
    const wrapper = mount(NotificationHost, { attachTo: document.body })
    const answer = useNotify().confirm('Uninstall acme.demo?', { danger: true, confirmText: 'Uninstall' })
    await flushPromises()
    expect(document.querySelector('.card')?.classList.contains('danger')).toBe(true)
    const primary = document.querySelector<HTMLButtonElement>('footer .primary')!
    expect(primary.classList.contains('danger')).toBe(true)
    primary.click()
    expect(await answer).toBe(true)
    wrapper.unmount()
  })
})
