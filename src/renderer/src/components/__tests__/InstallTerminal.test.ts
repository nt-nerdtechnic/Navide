// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import InstallTerminal from '../InstallTerminal.vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import { useOnboarding } from '../../composables/useOnboarding'

// xterm needs a real canvas and layout; the component only needs a screen it
// can write to and read keystrokes from.
const xterm = vi.hoisted(() => ({
  written: [] as string[],
  onData: null as ((data: string) => void) | null,
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 100
    rows = 24
    loadAddon(): void {}
    open(): void {}
    onData(cb: (data: string) => void): { dispose(): void } {
      xterm.onData = cb
      return { dispose(): void {} }
    }
    write(data: Uint8Array | string): void {
      xterm.written.push(typeof data === 'string' ? data : new TextDecoder().decode(data))
    }
    reset(): void {}
    focus(): void {}
    dispose(): void {}
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
    dispose(): void {}
  },
}))

describe('InstallTerminal', () => {
  let wrapper: VueWrapper | undefined
  let mock: ReturnType<typeof createMockBackend>
  let onboarding: ReturnType<typeof useOnboarding>

  beforeEach(() => {
    xterm.written = []
    xterm.onData = null
    mock = createMockBackend('connected')
    onboarding = useOnboarding(mock.backend)
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
  })

  /** Start `claude update` in a PTY and mount the terminal on it. */
  async function startRun(): Promise<VueWrapper> {
    mock.setResponse('onboarding.run', { ok: true, run_id: 'run-1', command: 'claude update' })
    void onboarding.runMaintenance('claude', 'update')
    await flushPromises()
    const w = mount(InstallTerminal, {
      props: { onboarding },
      global: { plugins: [i18n] },
    })
    await flushPromises()
    return w
  }

  async function exitRun(payload: Record<string, unknown>): Promise<void> {
    mock.emit('terminal.exit', { terminal_session_id: 'run-1', ...payload })
    await flushPromises()
  }

  const statusText = (w: VueWrapper) => w.get('[data-testid="install-terminal-status"]').text()

  it('says it is running and names the command while the run is live', async () => {
    wrapper = await startRun()

    expect(statusText(wrapper)).toBe(i18n.global.t('install-terminal.running'))
    expect(wrapper.text()).toContain('claude update')
    expect(wrapper.find('[data-testid="install-terminal-close"]').exists()).toBe(false)
  })

  it('says so when typed input (a sudo password) never reached the command', async () => {
    wrapper = await startRun()
    expect(wrapper.find('[data-testid="install-terminal-input-error"]').exists()).toBe(false)
    mock.setRejection('terminal.input', 'ws not open')

    onboarding.runInput('hunter2\r')
    await flushPromises()

    expect(wrapper.get('[data-testid="install-terminal-input-error"]').text())
      .toBe(i18n.global.t('install-terminal.input-lost', { error: 'ws not open' }))
  })

  it('says so when the backend refuses typed input', async () => {
    wrapper = await startRun()
    mock.setResponse('terminal.input', { ok: false, error: 'no such terminal' })

    onboarding.runInput('y')
    await flushPromises()

    expect(wrapper.get('[data-testid="install-terminal-input-error"]').text())
      .toBe(i18n.global.t('install-terminal.input-lost', { error: 'no such terminal' }))
  })

  it('reports a clean exit', async () => {
    wrapper = await startRun()
    await exitRun({ exit_code: 0 })

    expect(statusText(wrapper)).toBe(i18n.global.t('install-terminal.exited-ok'))
  })

  it('reports a failing exit with its code', async () => {
    wrapper = await startRun()
    await exitRun({ exit_code: 3 })

    expect(statusText(wrapper)).toBe(i18n.global.t('install-terminal.exited-fail', { code: 3 }))
    expect(wrapper.get('[data-testid="install-terminal-status"]').classes()).toContain('is-failed')
  })

  it('offers Cancel only while running, and Cancel kills the run', async () => {
    wrapper = await startRun()

    await wrapper.get('[data-testid="install-terminal-cancel"]').trigger('click')
    await flushPromises()

    expect(mock.sent).toContainEqual(expect.objectContaining({
      type: 'terminal.kill', payload: { terminal_session_id: 'run-1' },
    }))
    // A second press cannot send a second kill.
    expect(wrapper.get('[data-testid="install-terminal-cancel"]').attributes('disabled')).toBeDefined()

    await exitRun({ exit_code: null, signal: 'SIGTERM' })

    expect(statusText(wrapper)).toBe(i18n.global.t('install-terminal.cancelled'))
    expect(wrapper.find('[data-testid="install-terminal-cancel"]').exists()).toBe(false)
  })

  it('closes a finished run', async () => {
    wrapper = await startRun()
    await exitRun({ exit_code: 0 })

    await wrapper.get('[data-testid="install-terminal-close"]').trigger('click')
    await flushPromises()

    expect(onboarding.run.value).toBeNull()
    expect(wrapper.find('[data-testid="install-terminal-status"]').exists()).toBe(false)
  })

  it('offers the external terminal when the embedded one could not start', async () => {
    const openTerminal = vi.fn(() => Promise.resolve({ ok: true }))
    ;(window as unknown as { agentTeam: unknown }).agentTeam = { openTerminal }
    mock.setResponse('onboarding.run', {
      ok: false, spawn_failed: true, command: 'claude update', error: 'posix_spawn failed',
    })
    await onboarding.runMaintenance('claude', 'update')
    wrapper = mount(InstallTerminal, { props: { onboarding }, global: { plugins: [i18n] } })
    await flushPromises()

    const fallback = wrapper.get('[data-testid="install-terminal-fallback"]')
    expect(fallback.text()).toContain('claude update')
    expect(fallback.text()).toContain('posix_spawn failed')

    await wrapper.get('[data-testid="install-terminal-open-external"]').trigger('click')
    await flushPromises()

    expect(openTerminal).toHaveBeenCalledWith('claude update')
  })

  it('sends what is typed to the running command', async () => {
    wrapper = await startRun()

    xterm.onData!('hunter2\r')

    expect(mock.sent).toContainEqual(expect.objectContaining({
      type: 'terminal.input', payload: { terminal_session_id: 'run-1', data: 'hunter2\r' },
    }))
  })

  it('replays output that arrived before it mounted, then streams the rest', async () => {
    mock.setResponse('onboarding.run', { ok: true, run_id: 'run-1', command: 'claude update' })
    void onboarding.runMaintenance('claude', 'update')
    await flushPromises()
    mock.emit('terminal.output', { terminal_session_id: 'run-1', data: new TextEncoder().encode('early ') })

    wrapper = mount(InstallTerminal, { props: { onboarding }, global: { plugins: [i18n] } })
    await flushPromises()
    mock.emit('terminal.output', { terminal_session_id: 'run-1', data: new TextEncoder().encode('late') })
    // Another PTY's output is not this run's.
    mock.emit('terminal.output', { terminal_session_id: 'other', data: new TextEncoder().encode('noise') })

    expect(xterm.written.join('')).toBe('early late')
  })
})
