import { describe, it, expect, vi } from 'vitest'
import { cliHealthGuideForLaunch, useOnboarding, type OnboardStatus } from '../useOnboarding'
import { createMockBackend, withScope, flush } from './mockBackend'

// Fields every backend-sent dep carries; irrelevant to the gate assertions here.
const depBase = {
  binary_path: '', resolved_path: '', install_method: '', update_cmd: '',
  doctor_cmd: '', autoupdate_env: '', autoupdate_policy: '',
} as const

function status(opts: { found?: boolean; cli?: boolean; ollama?: boolean; models?: string[] }): OnboardStatus {
  const found = opts.found ?? true
  const cli = opts.cli ?? true
  const ollama = opts.ollama ?? true
  const models = opts.models ?? ['qwen2.5-coder']
  const analyzer = ollama && models.length > 0
  const all = found && cli && analyzer
  return {
    deps: [
      { ...depBase, id: 'node', label: 'Node', description: '', group: 'foundation', status: found ? 'ok' : 'missing', version: '22.0.0', min_version: '22.0.0', optional: false, needs_terminal: false, can_install: true, docs_url: '' },
      { ...depBase, id: 'claude', label: 'Claude', description: '', group: 'agent_cli', status: cli ? 'ok' : 'missing', version: '', min_version: '', optional: true, needs_terminal: true, can_install: true, docs_url: '' },
      { ...depBase, id: 'ollama', label: 'Ollama', description: '', group: 'analyzer', status: ollama ? 'ok' : 'missing', version: '', min_version: '', optional: false, needs_terminal: false, can_install: true, docs_url: '' },
    ],
    models,
    model_catalog: [
      { name: 'qwen2.5-coder:7b', size: '~4.7 GB', desc: '', recommended: true },
    ],
    cli_health: {
      entries: [],
      findings: [],
      fingerprint: '',
      dismissed: false,
      needs_attention: false,
    },
    gate: {
      foundation_ready: found,
      has_any_cli: cli,
      analyzer_ready: analyzer,
      ollama_ok: ollama,
      ollama_service_up: ollama,
      has_model: models.length > 0,
      all_required_ready: all,
      suggested_model: 'qwen2.5-coder',
    },
    complete: false,
  }
}

describe('useOnboarding', () => {
  it('refresh populates status and derived gate flags', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({}))
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    await flush()
    expect(result.allRequiredReady.value).toBe(true)
    expect(result.foundationReady.value).toBe(true)
    expect(result.hasAnyCli.value).toBe(true)
    expect(result.analyzerReady.value).toBe(true)
    expect(result.foundationDeps.value).toHaveLength(1)
    expect(result.cliDeps.value).toHaveLength(1)
    scope.stop()
  })

  it('gate blocks when no CLI is present', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({ cli: false }))
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    expect(result.hasAnyCli.value).toBe(false)
    expect(result.allRequiredReady.value).toBe(false)
    scope.stop()
  })

  it('gate blocks when ollama present but no model', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({ models: [] }))
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    expect(result.analyzerReady.value).toBe(false)
    expect(result.allRequiredReady.value).toBe(false)
    scope.stop()
  })

  // ── embedded runs (onboarding.run → terminal.* events) ─────────────────────
  type Mock = ReturnType<typeof createMockBackend>

  function startedRun(mock: Mock, command = 'npm i -g x', runId = 'run-1'): void {
    mock.setResponse('onboarding.run', { ok: true, run_id: runId, command })
  }

  /** The command's exit, as the backend reports it after the last output. */
  async function exitRun(mock: Mock, exitCode: number | null, extra: Record<string, unknown> = {}): Promise<void> {
    await flush()
    mock.emit('terminal.exit', { terminal_session_id: 'run-1', exit_code: exitCode, ...extra })
    await flush()
  }

  function stubTerminal(result: { ok: boolean; error?: string }): string[] {
    const calls: string[] = []
    ;(globalThis as unknown as {
      window: { agentTeam: { openTerminal: (c: string) => Promise<{ ok: boolean; error?: string }> } }
    }).window = {
      agentTeam: { openTerminal: (c: string) => { calls.push(c); return Promise.resolve(result) } },
    }
    return calls
  }

  it('install asks for the dep by id and waits for the command to exit', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({ cli: false }))
    startedRun(mock)
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    const pending = result.install(result.cliDeps.value[0])
    await flush()
    // The renderer names a kind and an id — never a command.
    const sent = mock.sent.find((s) => s.type === 'onboarding.run')
    expect(sent?.payload).toEqual({ kind: 'install', dep_id: 'claude', cols: 100, rows: 24 })
    expect(result.installing.value).toBe('claude')
    expect(result.runBusy.value).toBe(true)
    expect(result.run.value?.state).toBe('running')

    mock.setResponse('onboarding.status', status({ cli: true }))
    await exitRun(mock, 0)
    const r = await pending
    expect(r?.ok).toBe(true)
    expect(r?.exit_code).toBe(0)
    expect(result.installing.value).toBe('')
    expect(result.run.value?.state).toBe('exited')
    // Exit 0 is followed by a fresh re-detect.
    expect(mock.sent.filter((s) => s.type === 'onboarding.status').at(-1)?.payload).toEqual({ fresh: true })
    expect(result.installErrors.value.claude).toBeUndefined()
    scope.stop()
  })

  it('a non-zero exit is a failure that names the exit code and keeps the output', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({ cli: false }))
    startedRun(mock)
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    const pending = result.install(result.cliDeps.value[0])
    await flush()
    mock.emit('terminal.output', { terminal_session_id: 'run-1', data: new TextEncoder().encode('EACCES\r\n') })
    // Another PTY's output must not leak into this run.
    mock.emit('terminal.output', { terminal_session_id: 'pane-9', data: new TextEncoder().encode('other') })
    await exitRun(mock, 3)
    const r = await pending
    expect(r?.ok).toBe(false)
    expect(r?.exit_code).toBe(3)
    expect(result.installErrors.value.claude.message).toContain('code 3')
    expect(result.installErrors.value.claude.command).toBe('npm i -g x')
    expect(result.run.value).toMatchObject({ state: 'exited', exitCode: 3 })
    const replayed: string[] = []
    result.attachRunOutput((d) => replayed.push(new TextDecoder().decode(d)))
    expect(replayed.join('')).toBe('EACCES\r\n')
    scope.stop()
  })

  it('records exit-0-but-undetected as its own kind of failure', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({ found: false }))
    startedRun(mock, 'brew install node')
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    const pending = result.install(result.foundationDeps.value[0])
    await exitRun(mock, 0)
    await pending
    expect(result.installErrors.value.node.ranButUndetected).toBe(true)
    expect(result.logLines.value.join('\n')).toContain('still not detected')
    scope.stop()
  })

  it('drops a reported failure when re-detection finds the dep anyway', async () => {
    // Homebrew exits non-zero on "already installed" often enough that the
    // command can fail while the tool is in fact present.
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({ found: false }))
    startedRun(mock, 'brew install node')
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    const pending = result.install(result.foundationDeps.value[0])
    mock.setResponse('onboarding.status', status({ found: true }))
    await exitRun(mock, 1)
    await pending
    expect(result.installErrors.value.node).toBeUndefined()
    scope.stop()
  })

  it('does not lose output or the exit that arrive before the reply naming the run', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({ cli: false }))
    startedRun(mock)
    const send = mock.backend.send
    ;(mock.backend as { send: typeof send }).send = (async (type: string, payload?: Record<string, unknown>, timeoutMs?: number) => {
      if (type === 'onboarding.run') {
        mock.emit('terminal.output', { terminal_session_id: 'run-1', data: new TextEncoder().encode('fast') })
        mock.emit('terminal.exit', { terminal_session_id: 'run-1', exit_code: 7 })
      }
      return send(type, payload, timeoutMs)
    }) as typeof send
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    const r = await result.install(result.cliDeps.value[0])
    expect(r?.exit_code).toBe(7)
    const replayed: string[] = []
    result.attachRunOutput((d) => replayed.push(new TextDecoder().decode(d)))
    expect(replayed.join('')).toBe('fast')
    scope.stop()
  })

  it('holds a bounded amount of other panes\' output while the start is pending', async () => {
    // Every pane's output arrives before the reply naming this run; a busy
    // window used to pile all of it up for up to the 30s start budget.
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({ cli: false }))
    let answer: (v: unknown) => void = () => {}
    const reply = new Promise((resolve) => { answer = resolve })
    const send = mock.backend.send
    ;(mock.backend as unknown as { send: typeof send }).send = (async (type: string, payload?: Record<string, unknown>, t?: number) =>
      type === 'onboarding.run' ? reply : send(type, payload, t)) as typeof send
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    const pending = result.install(result.cliDeps.value[0])
    await flush()
    const big = new Uint8Array(1_000_000)
    // Held past the cap: pushed out by the 5 MB that follows it.
    mock.emit('terminal.output', { terminal_session_id: 'run-1', data: new TextEncoder().encode('oldest') })
    for (let i = 0; i < 5; i++) mock.emit('terminal.output', { terminal_session_id: `pane-${i}`, data: big })
    // This run's own output is the newest by the time its id arrives.
    mock.emit('terminal.output', { terminal_session_id: 'run-1', data: new TextEncoder().encode('mine') })
    answer({ id: 't', type: 'onboarding.run', ok: true, payload: { ok: true, run_id: 'run-1', command: 'x' }, error: null, timestamp: '' })
    await flush()
    const seen: string[] = []
    result.attachRunOutput((d) => seen.push(new TextDecoder().decode(d)))
    expect(seen).toEqual(['mine'])
    await exitRun(mock, 0)
    await pending
    scope.stop()
  })

  it('cancel kills the run and reports it as cancelled', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({ cli: false }))
    startedRun(mock)
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    const pending = result.install(result.cliDeps.value[0])
    await flush()
    await result.cancelRun()
    expect(mock.sent.find((s) => s.type === 'terminal.kill')?.payload).toEqual({ terminal_session_id: 'run-1' })
    await exitRun(mock, -15, { signal: 'SIGTERM', reason: 'killed' })
    const r = await pending
    expect(r?.ok).toBe(false)
    expect(r?.cancelled).toBe(true)
    expect(result.installErrors.value.claude.message).toBe('Cancelled')
    scope.stop()
  })

  it('keystrokes and resizes go to the run PTY, never flagged as human input', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({ cli: false }))
    startedRun(mock)
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    const pending = result.install(result.cliDeps.value[0])
    await flush()
    result.runInput('hunter2\r')
    result.runResize(120, 30)
    expect(mock.sent.find((s) => s.type === 'terminal.input')?.payload)
      .toEqual({ terminal_session_id: 'run-1', data: 'hunter2\r' })
    expect(mock.sent.find((s) => s.type === 'terminal.resize')?.payload)
      .toEqual({ terminal_session_id: 'run-1', cols: 120, rows: 30 })
    await exitRun(mock, 0)
    await pending
    scope.stop()
  })

  it('dispose kills a command that is still running', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({ cli: false }))
    startedRun(mock)
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    void result.install(result.cliDeps.value[0])
    await flush()
    result.dispose()
    await flush()
    expect(mock.sent.filter((s) => s.type === 'terminal.kill')).toHaveLength(1)
    scope.stop()
  })

  it('dispose kills a command whose start was still in flight once its id arrives', async () => {
    // Closing Settings while onboarding.run is being answered used to leave the
    // PTY running with no surface to show it or answer its sudo prompt.
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({ cli: false }))
    startedRun(mock)
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    void result.install(result.cliDeps.value[0])
    expect(result.run.value?.state).toBe('starting')
    result.dispose()
    await flush()
    expect(mock.sent.filter((s) => s.type === 'terminal.kill').map((s) => s.payload))
      .toEqual([{ terminal_session_id: 'run-1' }])
    scope.stop()
  })

  it('a cancel that could not be sent leaves Cancel usable and the run not cancelled', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({ cli: false }))
    startedRun(mock)
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    const pending = result.install(result.cliDeps.value[0])
    await flush()
    mock.setRejection('terminal.kill', 'ws not open')
    await result.cancelRun()
    expect(result.run.value?.cancelled).toBe(false)
    expect(result.logLines.value.join('\n')).toContain('Could not cancel: ws not open')
    mock.setResponse('onboarding.status', status({ cli: true }))
    await exitRun(mock, 0)
    const r = await pending
    expect(r?.ok).toBe(true)
    expect(r?.cancelled).toBeUndefined()
    scope.stop()
  })

  it('a dropped connection ends the run instead of leaving it running forever', async () => {
    // The backend kills the run with the connection, and that exit event goes
    // to the dead socket — nothing else would ever settle the install.
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({ cli: false }))
    startedRun(mock)
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    const pending = result.install(result.cliDeps.value[0])
    await flush()
    mock.backend.status.value = 'disconnected'
    const r = await pending
    expect(r?.ok).toBe(false)
    expect(result.run.value?.lost).toBe(true)
    expect(result.runBusy.value).toBe(false)
    scope.stop()
  })

  it('records a blocked install against the dep so its card can show it', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({ found: false }))
    mock.setResponse('onboarding.run', {
      ok: false,
      error: 'brew is required to install Python. Install brew first, then retry.',
      missing_requirements: ['brew'],
      command: 'brew install python3',
    })
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    const r = await result.install(result.foundationDeps.value[0])
    expect(r?.missing_requirements).toEqual(['brew'])
    const failure = result.installErrors.value.node
    expect(failure.message).toContain('brew is required')
    expect(failure.command).toBe('brew install python3')
    expect(failure.ranButUndetected).toBe(false)
    expect(result.run.value).toBeNull()
    expect(result.runFallback.value).toBeNull()
    scope.stop()
  })

  it('offers the external terminal when the embedded one cannot start', async () => {
    const calls = stubTerminal({ ok: true })
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({ cli: false }))
    mock.setResponse('onboarding.run', {
      ok: false, spawn_failed: true, command: 'npm i -g x', error: 'executable not found: zsh',
    })
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    const r = await result.install(result.cliDeps.value[0])
    expect(r?.ok).toBe(false)
    expect(result.installErrors.value.claude.message).toContain('executable not found')
    expect(result.runFallback.value).toMatchObject({ key: 'claude', command: 'npm i -g x' })
    expect(await result.openFallbackInTerminal()).toBe(true)
    expect(calls).toEqual(['npm i -g x'])
    scope.stop()
  })

  it('reports a failed external-terminal fallback instead of claiming one opened', async () => {
    stubTerminal({ ok: false, error: 'not authorised' })
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({ cli: false }))
    mock.setResponse('onboarding.run', { ok: false, spawn_failed: true, command: 'npm i -g x', error: 'no pty' })
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    await result.install(result.cliDeps.value[0])
    expect(await result.openFallbackInTerminal()).toBe(false)
    const log = result.logLines.value.join('\n')
    expect(log).not.toContain('Opened in external terminal')
    expect(log).toContain('not authorised')
    expect(log).toContain('npm i -g x') // the command to run by hand
    scope.stop()
  })

  it('records a transport error against the dep too', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({ found: false }))
    mock.setRejection('onboarding.run', 'ws not open')
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    await result.install(result.foundationDeps.value[0])
    expect(result.installErrors.value.node.message).toContain('ws not open')
    expect(result.runBusy.value).toBe(false)
    scope.stop()
  })

  it('says why a second install did not start instead of returning silently', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({ found: false, cli: false }))
    startedRun(mock)
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    const first = result.install(result.foundationDeps.value[0])
    const second = await result.install(result.cliDeps.value[0])
    expect(second).toBeNull()
    expect(mock.sent.filter((s) => s.type === 'onboarding.run')).toHaveLength(1)
    expect(result.logLines.value.join('\n')).toContain('has to wait for')
    await exitRun(mock, 0)
    await first
    scope.stop()
  })

  it('records the opt-out for one CLI without touching the others', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({}))
    mock.setResponse('onboarding.install_prompt', { ok: true })
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    expect(await result.dismissInstallPrompt('claude')).toBe(true)
    expect(result.installPromptDismissed.value.has('claude')).toBe(true)
    expect(result.installPromptDismissed.value.has('node')).toBe(false)
    await result.dismissInstallPrompt('claude', false)
    expect(result.installPromptDismissed.value.has('claude')).toBe(false)
    scope.stop()
  })

  it('keeps the opt-out unset when the backend rejects it', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({}))
    mock.setResponse('onboarding.install_prompt', { ok: false, error: 'unknown dependency' })
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    expect(await result.dismissInstallPrompt('nope')).toBe(false)
    expect(result.installPromptDismissed.value.size).toBe(0)
    expect(result.logLines.value.join('\n')).toContain('unknown dependency')
    scope.stop()
  })

  it('reads the stored opt-out list from status', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', { ...status({}), install_prompt_dismissed: ['claude'] })
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    expect(result.installPromptDismissed.value.has('claude')).toBe(true)
    scope.stop()
  })

  it('ignores a second model pull while one is in flight', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({}))
    startedRun(mock, 'ollama pull a')
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    const first = result.pullModel('a')
    const second = await result.pullModel('b')
    expect(second).toBeNull()
    expect(mock.sent.find((s) => s.type === 'onboarding.run')?.payload)
      .toMatchObject({ kind: 'pull_model', model: 'a' })
    await exitRun(mock, 0)
    expect((await first)?.ok).toBe(true)
    scope.stop()
  })

  it('startOllamaService runs the service command and re-detects after it', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({}))
    startedRun(mock, 'brew services start ollama')
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    const pending = result.startOllamaService()
    await flush()
    expect(mock.sent.find((s) => s.type === 'onboarding.run')?.payload)
      .toMatchObject({ kind: 'start_ollama' })
    await exitRun(mock, 0)
    expect((await pending)?.ok).toBe(true)
    expect(mock.sent.filter((s) => s.type === 'onboarding.status').at(-1)?.payload).toEqual({ fresh: true })
    scope.stop()
  })

  it('startOllamaService reports a transport failure instead of rejecting', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({}))
    mock.setRejection('onboarding.run', 'ws not open')
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    await expect(result.startOllamaService()).resolves
      .toEqual({ ok: false, error: 'ws not open', unanswered: true })
    expect(result.logLines.value.join('\n')).toContain('ws not open')
    scope.stop()
  })

  it('setAutoupdatePolicy reports whether the policy was stored', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({}))
    mock.setResponse('onboarding.cli_autoupdate', { ok: true })
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    await expect(result.setAutoupdatePolicy('claude', 'manual')).resolves.toBe(true)
    mock.setResponse('onboarding.cli_autoupdate', { ok: false, error: 'unknown agent' })
    await expect(result.setAutoupdatePolicy('claude', 'manual')).resolves.toBe(false)
    mock.setRejection('onboarding.cli_autoupdate', 'ws not open')
    await expect(result.setAutoupdatePolicy('claude', 'manual')).resolves.toBe(false)
    expect(result.logLines.value.join('\n')).toContain('ws not open')
    scope.stop()
  })

  it('dismissInstallPrompt reports a transport failure instead of rejecting', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({}))
    mock.setRejection('onboarding.install_prompt', 'ws not open')
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    await expect(result.dismissInstallPrompt('claude')).resolves.toBe(false)
    expect(result.installPromptDismissed.value.has('claude')).toBe(false)
    expect(result.logLines.value.join('\n')).toContain('ws not open')
    scope.stop()
  })

  describe('overlapping refreshes', () => {
    /** Every onboarding.status call waits until the test settles it. */
    function deferredStatus(mock: ReturnType<typeof createMockBackend>) {
      const pending: { type: string; resolve: (s: OnboardStatus) => void }[] = []
      const send = mock.backend.send.bind(mock.backend)
      mock.backend.send = ((type: string, payload: Record<string, unknown>, timeoutMs?: number) => {
        if (type !== 'onboarding.status' && type !== 'onboarding.status_quick') {
          return send(type, payload, timeoutMs)
        }
        return new Promise<unknown>((resolve) => {
          pending.push({ type, resolve: (s) => resolve({ ok: true, payload: s }) })
        })
      }) as typeof mock.backend.send
      return pending
    }

    it('keeps the newer answer when an older one arrives last', async () => {
      const mock = createMockBackend('connected')
      mock.setResponse('onboarding.status', status({}))
      const { result, scope } = withScope(() => useOnboarding(mock.backend))
      await result.refresh()
      const pending = deferredStatus(mock)

      const older = result.refresh()
      const newer = result.refresh({ fresh: true })
      await flush()
      expect(pending.map((p) => p.type)).toEqual(['onboarding.status', 'onboarding.status'])

      pending[1].resolve(status({ cli: true }))
      await newer
      // The latest answer is in; nothing still in flight may change it.
      expect(result.loading.value).toBe(false)
      pending[0].resolve(status({ cli: false }))
      await older

      expect(result.hasAnyCli.value).toBe(true)
      expect(result.loading.value).toBe(false)
      scope.stop()
    })

    it('never lets a late quick pass overwrite a newer full answer', async () => {
      const mock = createMockBackend('connected')
      const { result, scope } = withScope(() => useOnboarding(mock.backend))
      const pending = deferredStatus(mock)

      const first = result.refresh()
      await flush()
      const second = result.refresh()
      await flush()
      // Both started before any status existed, so both asked for a quick pass.
      expect(pending.map((p) => p.type)).toEqual(['onboarding.status_quick', 'onboarding.status_quick'])
      pending[1].resolve(status({ cli: true }))
      await flush()
      pending[2].resolve(status({ cli: true }))
      await second
      expect(result.hasAnyCli.value).toBe(true)

      pending[0].resolve(status({ cli: false }))
      await flush()
      pending[3].resolve(status({ cli: false }))
      await first
      expect(result.hasAnyCli.value).toBe(true)
      scope.stop()
    })
  })

  it('shows CLI health guide only for completed onboarding with an undismissed finding', () => {
    const ready = status({})
    ready.complete = true
    ready.cli_health = {
      entries: [],
      findings: [{ type: 'duplicate_install', agent_key: 'claude', label: 'Claude' }],
      fingerprint: '0123456789abcdef',
      dismissed: false,
      needs_attention: true,
    }
    expect(cliHealthGuideForLaunch(ready)?.fingerprint).toBe('0123456789abcdef')

    ready.complete = false
    expect(cliHealthGuideForLaunch(ready)).toBeNull()
    ready.complete = true
    ready.cli_health.needs_attention = false
    expect(cliHealthGuideForLaunch(ready)).toBeNull()
  })

  it('does not open the repair guide for a failed vendor update alone', () => {
    const ready = status({})
    ready.complete = true
    ready.cli_health = {
      entries: [],
      findings: [{
        type: 'update_failed',
        agent_key: 'claude',
        label: 'Claude',
        records: [{
          scope: 'profile:4ad13e88', home: '/tmp/p', timestamp: '2026-07-25T00:07:12.372Z',
          outcome: 'failed', status: 'install_failed', version_from: '2.1.219', version_to: '',
        }],
      }],
      fingerprint: '0123456789abcdef',
      dismissed: false,
      needs_attention: true,
    }
    expect(cliHealthGuideForLaunch(ready)).toBeNull()

    ready.cli_health.findings.push({ type: 'probe_failed', agent_key: 'codex', label: 'Codex' })
    expect(cliHealthGuideForLaunch(ready)?.fingerprint).toBe('0123456789abcdef')
  })

  it('maintenance runs the vendor command by action id and never composes one', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({}))
    startedRun(mock, 'claude update')
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()

    const pending = result.runMaintenance('claude', 'update')
    await flush()
    expect(result.maintaining.value).toBe('claude:update')
    const sent = mock.sent.find((s) => s.type === 'onboarding.run')
    expect(sent?.payload).toEqual({ kind: 'maintenance', agent_key: 'claude', action: 'update', cols: 100, rows: 24 })
    await exitRun(mock, 0)
    const outcome = await pending
    expect(outcome).toMatchObject({ ok: true, command: 'claude update', exit_code: 0 })
    expect(result.maintaining.value).toBe('')
    scope.stop()
  })

  it('maintenance starts nothing when the vendor ships no such command', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({}))
    mock.setResponse('onboarding.run', { ok: false, error: 'no official update command', docs_url: 'https://docs' })
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()

    const outcome = await result.runMaintenance('kimi', 'update')
    expect(outcome?.ok).toBe(false)
    expect(result.run.value).toBeNull()
    scope.stop()
  })
})
