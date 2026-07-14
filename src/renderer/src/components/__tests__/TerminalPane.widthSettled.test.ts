// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import TerminalPane from '../TerminalPane.vue'

const captured = vi.hoisted(() => ({
  onStableWidthChange: undefined as undefined | ((cols: number) => void),
}))

vi.mock('../../composables/useTerminal', async () => {
  const { ref } = await import('vue')
  return {
    useTerminal: (_paneId: string, _backend: unknown, opts: { onStableWidthChange?: (cols: number) => void }) => {
      captured.onStableWidthChange = opts.onStableWidthChange
      return {
        mount: vi.fn(),
        pasteText: vi.fn(),
        updateXtermTheme: vi.fn(),
        setDisableStdin: vi.fn(),
        displayStatus: ref('idle'),
        sessionId: ref('session-1'),
        isAltBuffer: ref(false),
      }
    },
  }
})

describe('TerminalPane stable width forwarding', () => {
  it('emits width-settled with the measured column count', async () => {
    const wrapper = mount(TerminalPane, {
      props: { paneId: 'pane-1', title: 'Claude', backend: {} as never },
      global: { mocks: { $t: (key: string) => key } },
    })

    captured.onStableWidthChange?.(112)
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('width-settled')).toEqual([[112]])
    wrapper.unmount()
  })
})
