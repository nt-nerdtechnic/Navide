import { onScopeDispose, ref, shallowRef, watch } from 'vue'
import type { useBackend } from './useBackend'

const BENCHMARK_STORAGE_KEY = 'agent-team.benchmark-results'

export interface AnalyzerModel {
  name: string
  size: number
  family: string
  parameter_size: string
}

export interface AnalyzerHealth {
  ok: boolean
  version?: string
  default_model?: string
  error?: string
}

export interface ClassifyQuestion {
  prompt: string
  type: 'text' | 'choice'
  options: string[]
}

export interface ClassifyResult {
  intent: 'question' | 'completion' | 'in_progress'
  questions: ClassifyQuestion[]
  question?: ClassifyQuestion | null // legacy single-question (= questions[0])
  summary: string
  model?: string
  prompt_eval_count?: number
  eval_count?: number
  total_duration_ms?: number
  _error?: string
}

/** Optional context for attribution of the token usage to a workspace /
 *  pipeline stage / pane in the token stats panel. All fields are best-effort
 *  — backend records under "unknown" if any are missing. */
export interface ClassifyContext {
  workspacePath?: string
  stageId?: string
  paneId?: string
}

export interface BenchmarkTaskResult {
  task_id: string
  passed: boolean
  elapsed_s: number
}

export interface BenchmarkModelResult {
  name: string
  tasks: BenchmarkTaskResult[]
  score: number  // 0-3
  passed: boolean // score >= 2
}

export interface BenchmarkProgress {
  model: string
  task_id: string
  passed: boolean
  elapsed_s: number
  score: number
}

/**
 * Composable around the backend analyzer (Ollama-backed). Caches per-window
 * health + model list, surfaces classify() for the pipeline watcher.
 */
export function useAnalyzer(backend: ReturnType<typeof useBackend>) {
  const health = shallowRef<AnalyzerHealth | null>(null)
  const models = ref<AnalyzerModel[]>([])
  const defaultModel = ref<string>('')
  const loading = ref<boolean>(false)
  const lastError = ref<string>('')
  let lastHealthAt = 0

  // ── Benchmark state (persisted to localStorage) ──────────────────────────
  const _stored = localStorage.getItem(BENCHMARK_STORAGE_KEY)
  const benchmarkResults = ref<BenchmarkModelResult[]>(_stored ? JSON.parse(_stored) : [])
  const benchmarking = ref<boolean>(false)
  const benchmarkProgress = ref<BenchmarkProgress | null>(null)

  async function refreshHealth(): Promise<AnalyzerHealth | null> {
    if (backend.status.value !== 'connected') return null
    try {
      const resp = await backend.send<AnalyzerHealth>('analyzer.health', {})
      if (resp.ok && resp.payload) {
        health.value = resp.payload
        defaultModel.value = resp.payload.default_model ?? defaultModel.value
        lastHealthAt = Date.now()
        return resp.payload
      }
    } catch (err) {
      lastError.value = String((err as Error).message ?? err)
    }
    return null
  }

  async function refreshModels(): Promise<void> {
    if (backend.status.value !== 'connected') return
    loading.value = true
    try {
      const resp = await backend.send<{ models: AnalyzerModel[]; default: string }>(
        'analyzer.models',
        {}
      )
      if (resp.ok && resp.payload) {
        models.value = resp.payload.models
        if (resp.payload.default && !defaultModel.value) {
          defaultModel.value = resp.payload.default
        }
      }
    } catch (err) {
      lastError.value = String((err as Error).message ?? err)
    } finally {
      loading.value = false
    }
  }

  async function classify(
    text: string,
    model?: string,
    ctx?: ClassifyContext
  ): Promise<ClassifyResult | null> {
    if (!text || text.trim().length === 0) return null
    if (backend.status.value !== 'connected') return null
    try {
      // Ollama inference can take 30–60 s on slower hardware; use a generous
      // timeout so the WS layer doesn't drop the response before it arrives.
      const resp = await backend.send<ClassifyResult>(
        'analyzer.classify',
        {
          text,
          model: model ?? undefined,
          workspace_path: ctx?.workspacePath ?? undefined,
          stage_id: ctx?.stageId ?? undefined,
          pane_id: ctx?.paneId ?? undefined
        },
        60_000
      )
      if (resp.ok && resp.payload) return resp.payload
      lastError.value = resp.error?.message ?? 'classify failed'
      return null
    } catch (err) {
      lastError.value = String((err as Error).message ?? err)
      return null
    }
  }

  async function benchmark(): Promise<void> {
    if (backend.status.value !== 'connected') return
    if (benchmarking.value) return
    benchmarking.value = true
    benchmarkProgress.value = null
    try {
      // Just kick it off — backend runs in background and pushes events
      await backend.send('analyzer.benchmark', {}, 10_000)
    } catch {
      // timeout or error starting — the done event will reset benchmarking
    }
  }

  // ── Backend push events ───────────────────────────────────────────────────
  backend.on('analyzer.benchmark_progress', (payload) => {
    benchmarkProgress.value = payload as BenchmarkProgress
  })
  backend.on('analyzer.benchmark_done', (payload) => {
    const p = payload as { results: BenchmarkModelResult[] }
    benchmarkResults.value = p.results ?? []
    localStorage.setItem(BENCHMARK_STORAGE_KEY, JSON.stringify(benchmarkResults.value))
    benchmarking.value = false
    benchmarkProgress.value = null
  })

  async function refreshAll(): Promise<void> {
    const h = await refreshHealth()
    if (h?.ok) await refreshModels()
  }

  // Drive a refresh on every WS-connection transition. Also retry every 5s
  // if we still don't have health (or it's stale) to recover from a backend
  // restart without a manual page reload.
  watch(
    () => backend.status.value,
    (s) => {
      if (s === 'connected') void refreshAll()
    },
    { immediate: true }
  )

  let pollHandle: number | null = null
  pollHandle = window.setInterval(() => {
    if (backend.status.value !== 'connected') return
    const stale = Date.now() - lastHealthAt > 30_000
    const needModels = models.value.length === 0
    if (stale || needModels) void refreshAll()
  }, 5_000)

  onScopeDispose(() => {
    if (pollHandle !== null) window.clearInterval(pollHandle)
  })

  return {
    health,
    models,
    defaultModel,
    loading,
    lastError,
    refreshHealth,
    refreshModels,
    classify,
    benchmark,
    benchmarkResults,
    benchmarking,
    benchmarkProgress,
  }
}
