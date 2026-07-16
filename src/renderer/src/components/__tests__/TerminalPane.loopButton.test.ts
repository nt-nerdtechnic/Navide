// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import type { Ref } from 'vue'
import TerminalPane from '../TerminalPane.vue'

// Coverage for the loop launch button: the LOOP badge renders only while
// loopActive is set, clicking the header loop button emits 'toggle-loop'
// (App.vue owns the injection/clear logic), and the button is hidden once the
// pane's CLI has exited. useTerminal is mocked out — no xterm instance, no
// backend traffic (same setup as TerminalPane.cliContextDrag.test.ts).

const mockTerminal = vi.hoisted(() => ({ displayStatus: null as unknown as Ref<string> }))

vi.mock('../../composables/useTerminal', async () => {
  const { ref } = await import('vue')
  mockTerminal.displayStatus = ref('idle')
  return {
    useTerminal: () => ({
      mount: vi.fn(),
      pasteText: vi.fn(),
      updateXtermTheme: vi.fn(),
      setDisableStdin: vi.fn(),
      displayStatus: mockTerminal.displayStatus,
      sessionId: { value: '' },
      isAltBuffer: ref(false)
    })
  }
})

function mountPane(props: Record<string, unknown>): VueWrapper {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return mount(TerminalPane as any, {
    props: { paneId: 'pane-1', title: 'Claude', backend: {}, ...props },
    global: { mocks: { $t: (key: string) => key } }
  })
}

describe('TerminalPane – loop launch button', () => {
  let wrapper: VueWrapper

  afterEach(() => {
    wrapper.unmount()
    mockTerminal.displayStatus.value = 'idle'
  })

  it('renders the LOOP badge when loopActive is true and not when false', async () => {
    wrapper = mountPane({ loopActive: true })
    expect(wrapper.find('.loop-inline').exists()).toBe(true)

    await wrapper.setProps({ loopActive: false })
    expect(wrapper.find('.loop-inline').exists()).toBe(false)
  })

  it('emits toggle-loop when the loop button is clicked', async () => {
    wrapper = mountPane({})
    await wrapper.find('.loop-btn').trigger('click')
    expect(wrapper.emitted('toggle-loop')).toHaveLength(1)
  })

  it('hides the loop button when displayStatus is exited', () => {
    mockTerminal.displayStatus.value = 'exited'
    wrapper = mountPane({})
    expect(wrapper.find('.loop-btn').exists()).toBe(false)
  })

  it('shows the dimmed waiting badge variant while a session-limit auto-resume is pending', async () => {
    wrapper = mountPane({ loopActive: true, loopWaitUntil: Date.now() + 3600_000 })
    expect(wrapper.find('.loop-inline').classes()).toContain('waiting')

    await wrapper.setProps({ loopWaitUntil: null })
    expect(wrapper.find('.loop-inline').classes()).not.toContain('waiting')
  })
})
