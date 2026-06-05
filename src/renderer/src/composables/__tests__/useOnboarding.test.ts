import { describe, it, expect } from 'vitest'
import { useOnboarding, type OnboardStatus } from '../useOnboarding'
import { createMockBackend, withScope, flush } from './mockBackend'

function status(opts: { found?: boolean; cli?: boolean; ollama?: boolean; models?: string[] }): OnboardStatus {
  const found = opts.found ?? true
  const cli = opts.cli ?? true
  const ollama = opts.ollama ?? true
  const models = opts.models ?? ['qwen2.5-coder']
  const analyzer = ollama && models.length > 0
  const all = found && cli && analyzer
  return {
    deps: [
      { id: 'node', label: 'Node', description: '', group: 'foundation', status: found ? 'ok' : 'missing', version: '22.0.0', min_version: '22.0.0', optional: false, needs_terminal: false, can_install: true, docs_url: '' },
      { id: 'claude', label: 'Claude', description: '', group: 'agent_cli', status: cli ? 'ok' : 'missing', version: '', min_version: '', optional: true, needs_terminal: true, can_install: true, docs_url: '' },
      { id: 'ollama', label: 'Ollama', description: '', group: 'analyzer', status: ollama ? 'ok' : 'missing', version: '', min_version: '', optional: false, needs_terminal: false, can_install: true, docs_url: '' },
    ],
    models,
    model_catalog: [
      { name: 'qwen2.5-coder:7b', size: '~4.7 GB', desc: '', recommended: true },
    ],
    gate: {
      foundation_ready: found,
      has_any_cli: cli,
      analyzer_ready: analyzer,
      ollama_ok: ollama,
      has_model: models.length > 0,
      all_required_ready: all,
      suggested_model: 'qwen2.5-coder',
    },
    complete: false,
    skip: false,
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

  it('install of a needs_terminal dep opens an external terminal', async () => {
    const calls: string[] = []
    ;(globalThis as unknown as { window: { agentTeam: { openTerminal: (c: string) => Promise<{ ok: boolean }> } } }).window = {
      agentTeam: { openTerminal: (c: string) => { calls.push(c); return Promise.resolve({ ok: true }) } },
    }
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({ cli: false }))
    mock.setResponse('onboarding.install', { ok: true, needs_terminal: true, command: 'npm i -g x' })
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    await result.install(result.cliDeps.value[0])
    await flush()
    expect(calls).toContain('npm i -g x')
    scope.stop()
  })

  it('markComplete sends onboarding.complete', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({}))
    const { result, scope } = withScope(() => useOnboarding(mock.backend))
    await result.refresh()
    await result.markComplete()
    expect(mock.sent.some((s) => s.type === 'onboarding.complete')).toBe(true)
    scope.stop()
  })
})
