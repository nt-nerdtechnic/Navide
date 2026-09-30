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

  it('renders an opt-in detail: prose message, and only the literal in monospace', async () => {
    const wrapper = mount(NotificationHost, { attachTo: document.body })
    void useNotify().confirm('Opens in your browser:', { detail: 'https://github.com/acme/demo' })
    await flushPromises()
    const [message, detail] = Array.from(document.querySelectorAll('.body pre'))
    expect(message.className).toBe('prose')
    expect(message.textContent).toBe('Opens in your browser:')
    expect(detail.className).toBe('detail')
    expect(detail.textContent).toBe('https://github.com/acme/demo')
    wrapper.unmount()
  })

  it('keeps a confirm without detail on the single default body', async () => {
    const wrapper = mount(NotificationHost, { attachTo: document.body })
    void useNotify().confirm('/tmp/some/path')
    await flushPromises()
    const pres = document.querySelectorAll('.body pre')
    expect(pres).toHaveLength(1)
    expect(pres[0].className).toBe('')
    wrapper.unmount()
  })
})
