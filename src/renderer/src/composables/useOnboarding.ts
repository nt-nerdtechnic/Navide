import { ref, computed } from 'vue'
import type { useBackend } from './useBackend'

export type DepStatus = 'ok' | 'missing' | 'outdated'

export interface OnboardDep {
  id: string
  label: string
  description: string
  group: 'foundation' | 'agent_cli' | 'analyzer'
  status: DepStatus
  version: string
  min_version: string
  optional: boolean
  needs_terminal: boolean
  can_install: boolean
  docs_url: string
}

export interface OnboardGate {
  foundation_ready: boolean
  has_any_cli: boolean
  analyzer_ready: boolean
  ollama_ok: boolean
  has_model: boolean
  all_required_ready: boolean
  suggested_model: string
}

export interface OnboardStatus {
  deps: OnboardDep[]
  models: string[]
  gate: OnboardGate
  complete: boolean
  skip: boolean
}

interface InstallResult {
  ok: boolean
  needs_terminal?: boolean
  command?: string
  output?: string
  error?: string
}

/**
 * useOnboarding — drives the first-run environment wizard. The backend is the
 * single source of truth for dep definitions + status; this composable only
 * fetches, triggers installs, and exposes derived gate flags.
 */
export function useOnboarding(backend: ReturnType<typeof useBackend>) {
  const status = ref<OnboardStatus | null>(null)
  const loading = ref(false)
  const installing = ref('') // dep id currently being installed ('' = none)
  const logLines = ref<string[]>([])

  function log(line: string): void {
    logLines.value = [...logLines.value, line].slice(-200)
  }

  async function refresh(): Promise<void> {
    loading.value = true
    try {
      const resp = await backend.send<OnboardStatus>('onboarding.status', {})
      if (resp.payload) status.value = resp.payload
    } finally {
      loading.value = false
    }
  }

  async function install(dep: OnboardDep): Promise<void> {
    if (installing.value) return
    installing.value = dep.id
    log(`▶ 安裝 ${dep.label}…`)
    try {
      const resp = await backend.send<InstallResult>('onboarding.install', { dep_id: dep.id })
      const r = resp.payload
      if (!r?.ok) {
        log(`✗ ${dep.label} 安裝失敗：${r?.error || resp.error?.message || 'unknown'}`)
        return
      }
      if (r.needs_terminal && r.command) {
        await window.agentTeam?.openTerminal(r.command)
        log(`↗ 已在外部終端機開啟：${r.command}`)
        log('  完成後請按「重新偵測」。')
      } else {
        log(r.output?.trim() || `✓ ${dep.label} 安裝完成`)
      }
    } finally {
      installing.value = ''
      await refresh()
    }
  }

  async function pullModel(model?: string): Promise<void> {
    const name = model || status.value?.gate.suggested_model || 'qwen2.5-coder'
    log(`▶ 下載模型 ${name}…`)
    const resp = await backend.send<InstallResult>('onboarding.pull_model', { model: name })
    const r = resp.payload
    if (!r?.ok) { log(`✗ ${r?.error || '下載失敗'}`); return }
    if (r.needs_terminal && r.command) {
      await window.agentTeam?.openTerminal(r.command)
      log(`↗ 已在外部終端機開啟：${r.command}`)
      log('  下載完成後請按「重新偵測」。')
    }
  }

  async function markComplete(): Promise<void> {
    await backend.send('onboarding.complete', { complete: true })
    if (status.value) status.value.complete = true
  }

  // ── Derived ────────────────────────────────────────────────────────────────
  const deps = computed(() => status.value?.deps ?? [])
  const foundationDeps = computed(() => deps.value.filter((d) => d.group === 'foundation'))
  const cliDeps = computed(() => deps.value.filter((d) => d.group === 'agent_cli'))
  const analyzerDeps = computed(() => deps.value.filter((d) => d.group === 'analyzer'))
  const models = computed(() => status.value?.models ?? [])
  const gate = computed<OnboardGate | null>(() => status.value?.gate ?? null)
  const foundationReady = computed(() => gate.value?.foundation_ready ?? false)
  const hasAnyCli = computed(() => gate.value?.has_any_cli ?? false)
  const analyzerReady = computed(() => gate.value?.analyzer_ready ?? false)
  const allRequiredReady = computed(() => gate.value?.all_required_ready ?? false)

  return {
    status, loading, installing, logLines,
    refresh, install, pullModel, markComplete,
    deps, foundationDeps, cliDeps, analyzerDeps, models, gate,
    foundationReady, hasAnyCli, analyzerReady, allRequiredReady,
  }
}
