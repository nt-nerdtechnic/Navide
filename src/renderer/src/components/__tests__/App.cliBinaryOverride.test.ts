import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { cliHealthGuideForLaunch } from '../../composables/useOnboarding'
import type { CliHealthStatus, OnboardStatus } from '../../composables/useOnboarding'

// The backend owns the CLI binary override (cli_binary_overrides) and applies
// it to every terminal.create. The renderer used to keep a second copy in
// `agentTeam.cliBinary.<key>` and rewrite commands itself; what is left of that
// is the one-time migration of old values into the backend.
const source = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function entry(agentKey: string, paths: string[]): CliHealthStatus['entries'][number] {
  return {
    agent_key: agentKey,
    label: agentKey,
    diagnostic_command: '',
    update_command: '',
    docs_url: '',
    update_state: [],
    candidates: paths.map((path, index) => ({
      path,
      resolved_path: path,
      version: '1.0.0',
      status: 'ok',
      is_primary: index === 0,
    })),
  } as unknown as CliHealthStatus['entries'][number]
}

function statusWith(health: CliHealthStatus): OnboardStatus {
  return { complete: true, install_prompt_dismissed: [], cli_health: health } as unknown as OnboardStatus
}

type SelectReply = () => Promise<unknown>

function harness(
  first: OnboardStatus,
  second: OnboardStatus,
  legacy: Record<string, string>,
  selectReply: SelectReply = async () => ({ ok: true, payload: { ok: true } }),
) {
  const start = source.indexOf('async function checkOnboarding(')
  const fnSource = source.slice(start, source.indexOf('\n}\n', start) + 2)
  const javascript = ts.transpileModule(fnSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  const settings = { ...legacy }
  const statuses = [first, second]
  const send = vi.fn(async (type: string, _payload?: unknown) => type === 'onboarding.status'
    ? { ok: true, payload: statuses.shift() }
    : selectReply())
  const cliHealthGuide = { value: null as CliHealthStatus | null }
  const deps = {
    backend: { send },
    ONBOARDING_STATUS_TIMEOUT_MS: 1,
    onboardingComplete: { value: null },
    onboardingCheckFailed: { value: false },
    cliInstallPromptDismissed: { value: new Set() },
    cliInstallPromptDismissedLoaded: { value: false },
    settingsGet: (key: string, fallback: string) => settings[key] ?? fallback,
    settingsRemove: (key: string) => { delete settings[key] },
    cliHealthGuideForLaunch,
    cliHealthGuide,
    scheduleOnboardingRetry: vi.fn(),
    notifyRestore: { toast: vi.fn() },
    i18n: { global: { t: (key: string, params?: Record<string, unknown>) => `${key} ${JSON.stringify(params ?? {})}` } },
  }
  const checkOnboarding = new Function(...Object.keys(deps), `${javascript}; return checkOnboarding`)(
    ...Object.values(deps),
  ) as () => Promise<void>
  return { checkOnboarding, send, settings, cliHealthGuide, toast: deps.notifyRestore.toast }
}

describe('legacy agentTeam.cliBinary.<key> values move to the backend', () => {
  const noFindings: CliHealthStatus = {
    entries: [entry('claude', ['/a/claude', '/b/claude']), entry('codex', ['/a/codex', '/b/codex'])],
    findings: [], fingerprint: '', dismissed: false, needs_attention: false,
  }

  it('migrates every entry, even with no finding to repair, and drops the old setting', async () => {
    const { checkOnboarding, send, settings } = harness(statusWith(noFindings), statusWith(noFindings), {
      'agentTeam.cliBinary.claude': '/b/claude',
      'agentTeam.cliBinary.codex': '/b/codex',
    })

    await checkOnboarding()

    const selects = send.mock.calls.filter(([type]) => type === 'onboarding.cli_health.select_binary')
    expect(selects.map(([, payload]) => payload)).toEqual([
      { agent_key: 'claude', path: '/b/claude' },
      { agent_key: 'codex', path: '/b/codex' },
    ])
    // Removed once persisted, so a stale value can never overwrite a later
    // choice made in CLI management on the next launch.
    expect(settings).toEqual({})
  })

  it('re-reads status after migrating, so the guide opens on the post-override findings', async () => {
    const stale: CliHealthStatus = {
      ...noFindings,
      findings: [{ type: 'duplicate_install', agent_key: 'claude', label: 'claude', candidates: [] }],
      fingerprint: '0123456789abcdef',
      needs_attention: true,
    } as CliHealthStatus
    const { checkOnboarding, send, cliHealthGuide } = harness(statusWith(stale), statusWith(noFindings), {
      'agentTeam.cliBinary.claude': '/b/claude',
    })

    await checkOnboarding()

    expect(send.mock.calls.filter(([type]) => type === 'onboarding.status')).toHaveLength(2)
    expect(cliHealthGuide.value).toBeNull()
  })

  it('keeps a value whose install is not found, says it is not in use, and does not re-read status', async () => {
    const { checkOnboarding, send, settings, toast } = harness(statusWith(noFindings), statusWith(noFindings), {
      'agentTeam.cliBinary.claude': '/gone/claude',
    })

    await checkOnboarding()

    expect(send.mock.calls.map(([type]) => type)).toEqual(['onboarding.status'])
    expect(settings).toEqual({ 'agentTeam.cliBinary.claude': '/gone/claude' })
    // Spawns no longer read the setting: silence would leave the user on the
    // default install without knowing their choice stopped applying.
    expect(toast).toHaveBeenCalledTimes(1)
    expect(toast.mock.calls[0][0]).toContain('cli-health.override-missing')
    expect(toast.mock.calls[0][0]).toContain('/gone/claude')
  })

  it('says why when the backend refuses the choice, and drops the dead value', async () => {
    const { checkOnboarding, settings, toast } = harness(
      statusWith(noFindings), statusWith(noFindings),
      { 'agentTeam.cliBinary.claude': '/b/claude' },
      async () => ({ ok: true, payload: { ok: false, error: 'not executable' } }),
    )

    await checkOnboarding()

    expect(toast).toHaveBeenCalledTimes(1)
    expect(toast.mock.calls[0][0]).toContain('cli-health.override-refused')
    expect(toast.mock.calls[0][0]).toContain('not executable')
    expect(settings).toEqual({})
  })

  it('keeps the value for the next launch when the request itself failed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { checkOnboarding, settings, toast } = harness(
      statusWith(noFindings), statusWith(noFindings),
      { 'agentTeam.cliBinary.claude': '/b/claude' },
      async () => { throw new Error('ws not open') },
    )

    await checkOnboarding()

    expect(settings).toEqual({ 'agentTeam.cliBinary.claude': '/b/claude' })
    expect(toast).not.toHaveBeenCalled()
    expect(warn.mock.calls.flat().join(' ')).toContain('migration failed')
    warn.mockRestore()
  })
})

describe('the renderer no longer keeps its own binary override', () => {
  it('never rewrites a command itself — terminal.create applies the backend override', () => {
    expect(source).not.toContain('commandWithSelectedBinary')
  })

  it('never writes agentTeam.cliBinary.<key>', () => {
    expect(source).not.toMatch(/settingsSet\(`agentTeam\.cliBinary\./)
    expect(source).not.toContain('CLI_BINARY_SETTING_PREFIX')
  })

  it('lets the repair guide decide when it is done instead of closing on the first pick', () => {
    expect(source).not.toContain('@use-binary')
    expect(source).not.toContain('function selectCliBinary(')
  })
})
