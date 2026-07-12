// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import TerminalPane from '../TerminalPane.vue'

// Coverage for the header dragstart payload: alongside the pane-reorder id
// ('application/x-pane-id'), the drag must carry 'application/x-cli-context'
// with { paneId, agentKey, label, sessionId } so the editor window's AI Chat
// can fetch the pane's buffer on drop. useTerminal is mocked out — no xterm
// instance, no backend traffic (same setup as TerminalPane.reorderDrop.test.ts).

const mockSessionId = { value: '' }

vi.mock('../../composables/useTerminal', async () => {
  const { ref } = await import('vue')
  return {
    useTerminal: () => ({
      mount: vi.fn(),
      pasteText: vi.fn(),
      updateXtermTheme: vi.fn(),
      setDisableStdin: vi.fn(),
      displayStatus: ref('idle'),
      sessionId: mockSessionId,
      isAltBuffer: ref(false)
    })
  }
})

function dragStartEvent(): Event & { dataTransfer: { setData: ReturnType<typeof vi.fn> } } {
  const ev = new Event('dragstart', { bubbles: true, cancelable: true })
  Object.assign(ev, {
    dataTransfer: { types: [], getData: () => '', setData: vi.fn(), effectAllowed: '' }
  })
  return ev as Event & { dataTransfer: { setData: ReturnType<typeof vi.fn> } }
}

function mountPane(props: Record<string, unknown>): VueWrapper {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return mount(TerminalPane as any, {
    props: { paneId: 'pane-1', title: 'Claude', backend: {}, ...props },
    global: { mocks: { $t: (key: string) => key } }
  })
}

function cliContextPayload(ev: ReturnType<typeof dragStartEvent>): unknown {
  const call = ev.dataTransfer.setData.mock.calls.find(
    ([type]) => type === 'application/x-cli-context'
  )
  expect(call).toBeDefined()
  return JSON.parse(call![1] as string)
}

describe('TerminalPane – cli-context drag payload on header dragstart', () => {
  let wrapper: VueWrapper

  afterEach(() => {
    wrapper.unmount()
    mockSessionId.value = ''
  })

  it('sets the cli-context payload with pane id, agent key, label, and session id', () => {
    mockSessionId.value = 'sess-42'
    wrapper = mountPane({ agentKey: 'claude', title: 'My Claude' })
    const ev = dragStartEvent()
    wrapper.find('.pane-header').element.dispatchEvent(ev)

    expect(cliContextPayload(ev)).toEqual({
      paneId: 'pane-1',
      agentKey: 'claude',
      label: 'My Claude',
      sessionId: 'sess-42'
    })
  })

  it('sends sessionId as null when the terminal has no session yet', () => {
    wrapper = mountPane({ agentKey: 'codex' })
    const ev = dragStartEvent()
    wrapper.find('.pane-header').element.dispatchEvent(ev)

    expect(cliContextPayload(ev)).toEqual({
      paneId: 'pane-1',
      agentKey: 'codex',
      label: 'Claude',
      sessionId: null
    })
  })

  it('keeps setting the reorder pane-id payload alongside the cli-context one', () => {
    wrapper = mountPane({ agentKey: 'claude' })
    const ev = dragStartEvent()
    wrapper.find('.pane-header').element.dispatchEvent(ev)

    expect(ev.dataTransfer.setData).toHaveBeenCalledWith('application/x-pane-id', 'pane-1')
  })
})
