// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { i18n } from './foundation'
import SafeAiCliPanel from './SafeAiCliPanel.vue'
import {
  createAiCliSessionController,
  type AiCliPluginContext,
  type AiCliSessionController,
  type SafeAiCliPanelHandle,
} from './index'
import { seedSettings, settingsGet } from './shared'
import { __resetSettingsForTest } from './shared/testing'

const { terminals, terminalOptions, terminalProviders, FakeTerminal } = vi.hoisted(() => {
  const terminals: Array<{
    cols: number
    rows: number
    writes: string[]
    focused: boolean
    emitData(data: string): void
    keyHandler?: (event: KeyboardEvent) => boolean
    wheelHandler?: (event: WheelEvent) => boolean
  }> = []
  const terminalOptions: unknown[] = []
  const terminalProviders: unknown[] = []
  class FakeTerminal {
    cols = 80
    rows = 24
    writes: string[] = []
    focused = false
    private dataListener: ((data: string) => void) | null = null
    options: Record<string, unknown>
    unicode = { activeVersion: '6' }
    modes = { bracketedPasteMode: false, mouseTrackingMode: 'none', applicationCursorKeys: false }
    buffer = { active: { type: 'normal', cursorX: 0, cursorY: 0, baseY: 0, getLine: () => null } }
    textarea: HTMLTextAreaElement | null = null
    keyHandler: ((event: KeyboardEvent) => boolean) | undefined = undefined
    wheelHandler: ((event: WheelEvent) => boolean) | undefined = undefined
    constructor(options: Record<string, unknown>) { this.options = options; terminalOptions.push(options); terminals.push(this) }
    loadAddon(addon: { activate?: (terminal: FakeTerminal) => void }) { addon.activate?.(this) }
    open() {}
    write(data: string, callback?: () => void) { this.writes.push(data); callback?.() }
    focus() { this.focused = true }
    onData(listener: (data: string) => void) {
      this.dataListener = listener
      return { dispose: vi.fn() }
    }
    attachCustomWheelEventHandler(handler: (event: WheelEvent) => boolean) { this.wheelHandler = handler }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) { this.keyHandler = handler }
    registerLinkProvider(provider: unknown) { terminalProviders.push(provider); return { dispose: vi.fn() } }
    onSelectionChange(_listener: () => void) { return { dispose: vi.fn() } }
    resize(cols: number, rows: number) { this.cols = cols; this.rows = rows }
    emitData(data: string) { this.dataListener?.(data) }
    dispose() {}
  }
  return { terminals, terminalOptions, terminalProviders, FakeTerminal }
})

vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerminal }))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    activate() {}
    fit() {}
    dispose() {}
  },
}))
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class { activate() {} } }))
vi.mock('@xterm/addon-serialize', () => ({ SerializeAddon: class { activate() {}; serialize() { return '' } } }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

class FakeResizeObserver {
  observe() {}
  disconnect() {}
}

beforeEach(() => {
  terminals.length = 0
  terminalOptions.length = 0
  terminalProviders.length = 0
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  __resetSettingsForTest()
})

function makeController(): AiCliSessionController & { emitOutput(data: string): void; emitExit(): void } {
  let sessionId: string | null = null
  let output: ((data: string) => void) | null = null
  let exit: (() => void) | null = null
  return {
    get sessionId() { return sessionId },
    get profileId() { return sessionId ? 'claude' : null },
    listProfiles: vi.fn(async () => [
      { id: 'claude', label: 'Claude Code' },
      { id: 'codex', label: 'Codex' },
    ]),
    resume: vi.fn(async () => null),
    start: vi.fn(async () => { sessionId = 'session-1'; return sessionId }),
    send: vi.fn(async () => undefined),
    resize: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => undefined),
    stop: vi.fn(async () => { sessionId = null }),
    cancelStart: vi.fn(async () => undefined),
    dispose: vi.fn(),
    onOutput(listener) { output = listener; return () => { output = null } },
    onExit(listener) { exit = listener; return () => { exit = null } },
    emitOutput(data) { output?.(data) },
    emitExit() { sessionId = null; exit?.() },
  }
}

describe('SafeAiCliPanel', () => {
  it('keeps the legacy terminal defaults and opts into the persisted terminal view settings', async () => {
    const legacy = makeController()
    const legacyWrapper = mount(SafeAiCliPanel, { props: { controller: legacy }, global: { plugins: [i18n] } })
    await flushPromises()
    expect(terminalOptions[0]).toMatchObject({ scrollback: 5_000, convertEol: true })
    legacyWrapper.unmount()

    const persisted = makeController()
    const terminalView = { read: vi.fn(async () => ({ fontSize: 14, lastSize: null, snapshot: null })), save: vi.fn(async () => undefined), setFontSize: vi.fn(async () => undefined) }
    mount(SafeAiCliPanel, { props: { controller: persisted, terminalView }, global: { plugins: [i18n] } })
    await flushPromises()
    expect(terminalOptions[1]).toMatchObject({ scrollback: 10_000, fontSize: 14, convertEol: false })
    expect(terminalView.read).toHaveBeenCalledOnce()
  })

  it('registers terminal links only when the panel receives the opt-in picker and URL resources', async () => {
    const gitController = makeController()
    const gitWrapper = mount(SafeAiCliPanel, { props: { controller: gitController }, global: { plugins: [i18n] } })
    await flushPromises()
    expect(terminalProviders).toHaveLength(0)
    gitWrapper.unmount()

    const plansController = makeController()
    const plansResources = {
      listMentionTargets: vi.fn(async () => []),
      saveClipboardImage: vi.fn(async () => null),
      showContextMenu: vi.fn(async () => undefined),
      reportSelection: vi.fn(async () => undefined),
      openPlan: vi.fn(async (_path: string) => undefined),
    }
    const plansWrapper = mount(SafeAiCliPanel, {
      props: { controller: plansController, terminalResources: plansResources },
      global: { plugins: [i18n] },
    })
    await flushPromises()
    expect(terminalProviders).toHaveLength(0)
    plansWrapper.unmount()

    const miniIdeController = makeController()
    const miniIdeResources = {
      ...plansResources,
      openFilePicker: vi.fn(async () => undefined),
      openExternal: vi.fn(async (_url: string) => undefined),
    }
    const miniIdeWrapper = mount(SafeAiCliPanel, {
      props: { controller: miniIdeController, terminalResources: miniIdeResources },
      global: { plugins: [i18n] },
    })
    await flushPromises()
    expect(terminalProviders).toHaveLength(1)
    miniIdeWrapper.unmount()
  })

  it('refreshes link hover at the stationary pointer when Cmd changes', async () => {
    const controller = makeController()
    const resources = {
      listMentionTargets: vi.fn(async () => []),
      saveClipboardImage: vi.fn(async () => null),
      showContextMenu: vi.fn(async () => undefined),
      reportSelection: vi.fn(async () => undefined),
      openFilePicker: vi.fn(async () => undefined),
      openExternal: vi.fn(async (_url: string) => undefined),
    }
    const wrapper = mount(SafeAiCliPanel, {
      props: { controller, terminalResources: resources },
      global: { plugins: [i18n] },
    })
    await flushPromises()

    const host = wrapper.get('.navide-safe-ai-cli__terminal').element
    const mousemoves: MouseEvent[] = []
    host.addEventListener('mousemove', event => { mousemoves.push(event as MouseEvent) })
    host.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 37, clientY: 19 }))
    mousemoves.length = 0

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta' }))
    expect(mousemoves).toHaveLength(1)
    expect(mousemoves[0]).toMatchObject({ clientX: 37, clientY: 19, metaKey: true })

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta' }))
    expect(mousemoves).toHaveLength(1)

    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta' }))
    expect(mousemoves).toHaveLength(2)
    expect(mousemoves[1]).toMatchObject({ clientX: 37, clientY: 19, metaKey: false })
    wrapper.unmount()
  })

  it('replays saved output before resume and distinguishes live resume from a fresh start', async () => {
    const order: string[] = []
    const liveController = makeController()
    Object.defineProperty(liveController, 'sessionId', { configurable: true, get: () => 'live-session' })
    vi.mocked(liveController.resume).mockImplementation(async () => { order.push('resume'); return { sessionId: 'live-session', profileId: 'claude' } })
    const liveView = { read: vi.fn(async () => { order.push('read'); return { fontSize: 12, lastSize: null, snapshot: 'saved' } }), save: vi.fn(async () => undefined), setFontSize: vi.fn(async () => undefined) }
    const liveWrapper = mount(SafeAiCliPanel, { props: { controller: liveController, terminalView: liveView }, global: { plugins: [i18n] } })
    await flushPromises()
    expect(order).toEqual(['read', 'resume'])
    expect(terminals[0]?.writes).toContain('saved')
    expect(terminals[0]?.writes).not.toContain(expect.stringContaining('2004l'))
    expect(terminals[0]?.writes).not.toContain(expect.stringContaining('reconnected'))
    liveWrapper.unmount()

    const freshController = makeController()
    const freshView = { read: vi.fn(async () => ({ fontSize: 12, lastSize: null, snapshot: 'saved' })), save: vi.fn(async () => undefined), setFontSize: vi.fn(async () => undefined) }
    const resources = { listMentionTargets: vi.fn(async () => []), saveClipboardImage: vi.fn(async () => null), showContextMenu: vi.fn(async () => undefined), reportSelection: vi.fn(async () => undefined) }
    const freshWrapper = mount(SafeAiCliPanel, { props: { controller: freshController, terminalView: freshView, terminalResources: resources }, global: { plugins: [i18n] } })
    await flushPromises()
    expect(typeof terminals[1]?.keyHandler).toBe('function')
    expect(typeof terminals[1]?.wheelHandler).toBe('function')
    await (freshWrapper.vm as unknown as SafeAiCliPanelHandle).start()
    expect(terminals[1]?.writes).toContain('saved')
    expect(terminals[1]?.writes.some(write => write.includes('2004l'))).toBe(true)
    expect(terminals[1]?.writes.some(write => write.includes('reconnected'))).toBe(true)
    freshWrapper.unmount()
  })
  it('starts collapsed and checks for a tuple-owned detached session', async () => {
    const controller = makeController()
    const wrapper = mount(SafeAiCliPanel, { props: { controller }, global: { plugins: [i18n] } })
    await flushPromises()

    expect(wrapper.classes()).toContain('is-collapsed')
    expect(controller.listProfiles).toHaveBeenCalledOnce()
    expect(controller.resume).toHaveBeenCalledWith(80, 24)
    expect(controller.start).not.toHaveBeenCalled()
  })

  it('ignores terminal input until the Host-owned session is running', async () => {
    const controller = makeController()
    mount(SafeAiCliPanel, { props: { controller }, global: { plugins: [i18n] } })

    terminals[0]?.emitData('not-running')
    await flushPromises()

    expect(controller.send).not.toHaveBeenCalled()
  })

  it('pastes raw text only and never starts or submits a prompt', async () => {
    const controller = makeController()
    const wrapper = mount(SafeAiCliPanel, { props: { controller }, global: { plugins: [i18n] } })
    const handle = wrapper.vm as unknown as SafeAiCliPanelHandle

    await expect(handle.pasteText('idle paste')).resolves.toBe(false)
    expect(controller.start).not.toHaveBeenCalled()
    expect(controller.send).not.toHaveBeenCalled()

    await handle.start()
    vi.mocked(controller.send).mockClear()
    await expect(handle.pasteText('raw pasted text')).resolves.toBe(true)
    await flushPromises()

    expect(controller.start).toHaveBeenCalledOnce()
    expect(controller.send).toHaveBeenCalledOnce()
    expect(controller.send).toHaveBeenCalledWith('raw pasted text')
    expect(controller.send).not.toHaveBeenCalledWith(expect.stringContaining('\u001b[200~'))
    expect(controller.send).not.toHaveBeenCalledWith('\r')
  })

  it('renders PTY output in xterm and forwards terminal input serially', async () => {
    const controller = makeController()
    const wrapper = mount(SafeAiCliPanel, { props: { controller }, global: { plugins: [i18n] } })
    const handle = wrapper.vm as unknown as SafeAiCliPanelHandle
    await handle.start()
    controller.emitOutput('\u001b[32mready\u001b[0m')
    terminals[0]?.emitData('a')
    terminals[0]?.emitData('b')
    await flushPromises()

    expect(terminals[0]?.writes).toEqual(['\u001b[32mready\u001b[0m'])
    expect(controller.send).toHaveBeenNthCalledWith(1, 'a')
    expect(controller.send).toHaveBeenNthCalledWith(2, 'b')
  })

  it('continues forwarding terminal input after one send fails', async () => {
    const controller = makeController()
    vi.mocked(controller.send).mockRejectedValueOnce(new Error('send failed'))
    const wrapper = mount(SafeAiCliPanel, { props: { controller }, global: { plugins: [i18n] } })
    const handle = wrapper.vm as unknown as SafeAiCliPanelHandle
    await handle.start()

    terminals[0]?.emitData('first')
    terminals[0]?.emitData('second')
    await flushPromises()

    expect(controller.send).toHaveBeenNthCalledWith(1, 'first')
    expect(controller.send).toHaveBeenNthCalledWith(2, 'second')
  })

  it('starts, focuses, and submits a bracketed prompt through its public handle', async () => {
    vi.useFakeTimers()
    const controller = makeController()
    const wrapper = mount(SafeAiCliPanel, { props: { controller }, global: { plugins: [i18n] } })
    const handle = wrapper.vm as unknown as SafeAiCliPanelHandle

    const submitted = handle.submitPrompt('resolve this')
    await vi.advanceTimersByTimeAsync(4_000)
    await expect(submitted).resolves.toBe(true)

    expect(controller.start).toHaveBeenCalledOnce()
    expect(controller.send).toHaveBeenNthCalledWith(1, '\u001b[200~resolve this\u001b[201~')
    expect(controller.send).toHaveBeenNthCalledWith(2, '\r')
    expect(terminals[0]?.focused).toBe(true)
    vi.useRealTimers()
  })

  it('does not build or inject fresh context when a detached session resumes', async () => {
    const controller = makeController()
    vi.mocked(controller.resume).mockResolvedValue({ sessionId: 'resumed-session', profileId: 'codex' })
    Object.defineProperty(controller, 'sessionId', { configurable: true, get: () => 'resumed-session' })
    const buildContext = vi.fn(() => 'must not be injected')
    const wrapper = mount(SafeAiCliPanel, {
      props: { controller, buildContext },
      global: { plugins: [i18n] },
    })
    await flushPromises()

    const handle = wrapper.vm as unknown as SafeAiCliPanelHandle
    expect(handle.status).toBe('running')
    await handle.start()

    expect(controller.start).not.toHaveBeenCalled()
    expect(buildContext).not.toHaveBeenCalled()
    expect(controller.send).not.toHaveBeenCalled()
  })

  it('opens and focuses the terminal through its public handle', async () => {
    const controller = makeController()
    const wrapper = mount(SafeAiCliPanel, { props: { controller }, global: { plugins: [i18n] } })
    const handle = wrapper.vm as unknown as SafeAiCliPanelHandle

    expect(handle.status).toBe('idle')
    expect(wrapper.classes()).toContain('is-collapsed')
    handle.focus()
    await flushPromises()

    expect(wrapper.classes()).not.toContain('is-collapsed')
    expect(terminals[0]?.focused).toBe(true)
  })

  it('uses a custom width key and default without reading Git panel width', async () => {
    seedSettings({ 'git-ai-panel-width': 420 })
    const controller = makeController()
    const wrapper = mount(SafeAiCliPanel, {
      props: { controller, widthKey: 'plans-ai-panel-width', defaultWidth: 480 },
      global: { plugins: [i18n] },
    })
    await wrapper.get('.navide-safe-ai-cli__toggle').trigger('click')

    expect(wrapper.attributes('style')).toContain('width: 480px')
    expect(wrapper.attributes('style')).not.toContain('420px')
  })

  it('cancels a pending start only when allowCancelStart is enabled', async () => {
    let resolveDefaultStart!: (sessionId: string) => void
    const defaultController = makeController()
    vi.mocked(defaultController.start).mockImplementation(() => new Promise(resolve => { resolveDefaultStart = resolve }))
    const defaultWrapper = mount(SafeAiCliPanel, {
      props: { controller: defaultController },
      global: { plugins: [i18n] },
    })
    const defaultHandle = defaultWrapper.vm as unknown as SafeAiCliPanelHandle
    const defaultStart = defaultHandle.start()
    await flushPromises()
    expect(defaultHandle.status).toBe('starting')
    expect(defaultWrapper.findAll('button')[0]?.attributes('disabled')).toBeDefined()
    await defaultHandle.stop()
    expect(defaultController.cancelStart).not.toHaveBeenCalled()
    resolveDefaultStart('default-session')
    await defaultStart

    let resolveOptInStart!: (sessionId: string) => void
    const optInController = makeController()
    vi.mocked(optInController.start).mockImplementation(() => new Promise(resolve => { resolveOptInStart = resolve }))
    const optInWrapper = mount(SafeAiCliPanel, {
      props: { controller: optInController, allowCancelStart: true },
      global: { plugins: [i18n] },
    })
    const optInHandle = optInWrapper.vm as unknown as SafeAiCliPanelHandle
    const optInStart = optInHandle.start()
    await flushPromises()
    expect(optInHandle.status).toBe('starting')
    expect(optInWrapper.findAll('button')[0]?.attributes('disabled')).toBeUndefined()
    await optInWrapper.findAll('button')[0]!.trigger('click')
    expect(optInController.cancelStart).toHaveBeenCalledOnce()
    resolveOptInStart('opt-in-session')
    await optInStart
  })

  it('persists profile and width and injects fresh Git context with unattended mode', async () => {
    vi.useFakeTimers()
    seedSettings({
      'git-ai-panel-width': 420,
      'git-ai-panel-width.agent': 'codex',
      'agentTeam.yolo': '1',
    })
    const controller = makeController()
    const wrapper = mount(SafeAiCliPanel, {
      props: { controller, buildContext: () => 'Git context' },
      global: { plugins: [i18n] },
    })
    await flushPromises()

    await wrapper.get('.navide-safe-ai-cli__toggle').trigger('click')
    expect((wrapper.get('select').element as HTMLSelectElement).value).toBe('codex')
    expect(wrapper.attributes('style')).toContain('width: 420px')

    await wrapper.get('select').setValue('claude')
    const start = (wrapper.vm as unknown as SafeAiCliPanelHandle).start()
    await vi.advanceTimersByTimeAsync(4_000)
    await start

    expect(controller.start).toHaveBeenCalledWith('claude', 80, 24, { yolo: true })
    expect(controller.send).toHaveBeenNthCalledWith(1, '\u001b[200~Git context\u001b[201~')
    expect(controller.send).toHaveBeenNthCalledWith(2, '\r')
    expect(settingsGet('git-ai-panel-width.agent', '')).toBe('claude')
    vi.useRealTimers()
  })

  it('restores and persists an opt-in profile preference through its adapter', async () => {
    seedSettings({ 'git-ai-panel-width.agent': 'claude' })
    const read = vi.fn(async () => 'codex')
    const write = vi.fn(async (_profileId: string) => undefined)
    const controller = makeController()
    const wrapper = mount(SafeAiCliPanel, {
      props: { controller, profilePreference: { read, write } },
      global: { plugins: [i18n] },
    })
    await flushPromises()

    expect(read).toHaveBeenCalledOnce()
    expect((wrapper.get('select').element as HTMLSelectElement).value).toBe('codex')
    await wrapper.get('select').setValue('claude')
    expect(write).toHaveBeenCalledWith('claude')
    expect(settingsGet('git-ai-panel-width.agent', '')).toBe('claude')
  })

  it('stops a real controller session with the required force contract', async () => {
    const invoke = vi.fn(async (address: string) => {
      if (address === 'aiCli.listProfiles') return { profiles: [{ id: 'claude', label: 'Claude Code' }] }
      if (address === 'aiCli.resumeSession') return null
      if (address === 'aiCli.startSession') return { sessionId: 'session-1' }
      if (address === 'aiCli.stopSession') return {}
      return {}
    })
    const capabilities: AiCliPluginContext['capabilities'] = {
      invoke: invoke as unknown as AiCliPluginContext['capabilities']['invoke'],
    }
    const controller = createAiCliSessionController({
      capabilities,
      events: { subscribe: () => ({ dispose: vi.fn() }) },
    })
    const wrapper = mount(SafeAiCliPanel, { props: { controller }, global: { plugins: [i18n] } })
    await flushPromises()

    const handle = wrapper.vm as unknown as SafeAiCliPanelHandle
    await handle.start()
    await handle.stop()

    expect(invoke).toHaveBeenCalledWith('aiCli.stopSession', {
      sessionId: 'session-1',
      force: true,
    })
    expect(controller.sessionId).toBeNull()
  })

  it('does not clear terminal scrollback during resize', async () => {
    const controller = makeController()
    const wrapper = mount(SafeAiCliPanel, { props: { controller }, global: { plugins: [i18n] } })
    const handle = wrapper.vm as unknown as SafeAiCliPanelHandle
    await wrapper.get('.navide-safe-ai-cli__toggle').trigger('click')
    await handle.start()
    await flushPromises()

    expect(controller.resize).toHaveBeenCalled()
    expect('clear' in (terminals[0] ?? {})).toBe(false)
  })
})
