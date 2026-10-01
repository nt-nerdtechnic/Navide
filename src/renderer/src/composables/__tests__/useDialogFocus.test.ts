// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { useDialogFocus } from '../useDialogFocus'

/**
 * An opener button outside a dialog that is rendered with v-if, the way the
 * Marketplace dialogs are. `withInitial` focuses the Cancel button on open,
 * like the trust and uninstall dialogs do.
 */
function host(options: { withInitial?: boolean; controls?: boolean } = {}) {
  const open = ref(false)
  const Host = defineComponent({
    setup() {
      const card = ref<HTMLElement | null>(null)
      const cancel = ref<HTMLButtonElement | null>(null)
      useDialogFocus(card, options.withInitial ? () => cancel.value : undefined)
      return () =>
        h('div', [
          h('button', { class: 'opener' }, 'Open'),
          h('button', { class: 'outside' }, 'Outside'),
          open.value
            ? h('div', { ref: card, class: 'card', tabindex: -1 }, options.controls === false
              ? [h('p', 'Nothing to press')]
              : [
                h('input', { class: 'field' }),
                h('button', { class: 'disabled', disabled: true }, 'Disabled'),
                h('button', { ref: cancel, class: 'cancel' }, 'Cancel'),
                h('button', { class: 'confirm' }, 'Confirm'),
              ])
            : null,
        ])
    },
  })
  return { Host, open }
}

function tab(shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true })
  ;(document.activeElement ?? document.body).dispatchEvent(event)
  return event
}

const active = () => (document.activeElement as HTMLElement | null)?.className

describe('useDialogFocus', () => {
  let wrapper: VueWrapper | undefined

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    document.body.innerHTML = ''
  })

  async function openFrom(opener: string, options: Parameters<typeof host>[0] = {}) {
    const { Host, open } = host(options)
    wrapper = mount(Host, { attachTo: document.body })
    ;(wrapper.get(opener).element as HTMLElement).focus()
    open.value = true
    await flushPromises()
    await nextTick()
    return open
  }

  it('moves focus to the first control when the dialog opens', async () => {
    await openFrom('.opener')
    expect(active()).toBe('field')
  })

  it('moves focus to the requested control when one is given', async () => {
    await openFrom('.opener', { withInitial: true })
    expect(active()).toBe('cancel')
  })

  it('keeps Tab and Shift+Tab inside the dialog, skipping disabled controls', async () => {
    await openFrom('.opener', { withInitial: true })
    // Forward from the last control wraps to the first.
    ;(wrapper!.get('.confirm').element as HTMLElement).focus()
    expect(tab().defaultPrevented).toBe(true)
    expect(active()).toBe('field')
    // Backward from the first control wraps to the last.
    expect(tab(true).defaultPrevented).toBe(true)
    expect(active()).toBe('confirm')
    // In the middle, the browser's own Tab order applies (not intercepted).
    ;(wrapper!.get('.cancel').element as HTMLElement).focus()
    expect(tab().defaultPrevented).toBe(false)
    // Focus that escaped the dialog is pulled back in.
    ;(wrapper!.get('.outside').element as HTMLElement).focus()
    expect(tab().defaultPrevented).toBe(true)
    expect(active()).toBe('field')
    ;(wrapper!.get('.outside').element as HTMLElement).focus()
    expect(tab(true).defaultPrevented).toBe(true)
    expect(active()).toBe('confirm')
  })

  it('swallows Tab in a dialog with nothing to focus', async () => {
    await openFrom('.opener', { controls: false })
    expect(active()).toBe('card')
    expect(tab().defaultPrevented).toBe(true)
    expect(active()).toBe('card')
  })

  it('returns focus to the opener when the dialog closes', async () => {
    const open = await openFrom('.opener', { withInitial: true })
    expect(active()).toBe('cancel')
    open.value = false
    await flushPromises()
    await nextTick()
    expect(active()).toBe('opener')
  })

  it('returns focus to the opener when the host unmounts with the dialog open', async () => {
    await openFrom('.opener')
    const opener = wrapper!.get('.opener').element
    // The opener lives outside the unmounting host in real use; keep a
    // connected copy of that situation by moving it out first.
    document.body.append(opener)
    wrapper!.unmount()
    wrapper = undefined
    expect(document.activeElement).toBe(opener)
  })

  it('leaves Tab alone while no dialog is open', async () => {
    const { Host } = host()
    wrapper = mount(Host, { attachTo: document.body })
    ;(wrapper.get('.opener').element as HTMLElement).focus()
    expect(tab().defaultPrevented).toBe(false)
    expect(active()).toBe('opener')
  })
})
