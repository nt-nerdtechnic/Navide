import { ref } from 'vue'
import type { useBackend } from './useBackend'

// Per-turn token usage of one CLI session, fetched on demand over the
// `tokens.turns` request (same road as `tokens.snapshot` in useTokens). One
// turn = the user sends a prompt → the CLI finishes replying, which may span
// several API calls. The backend cuts the turns from the session transcript;
// how it cut them is reported as `method` so the modal can label it.

export interface TurnCall {
  ts: string | null
  model: string
  input: number
  cache_read: number
  cache_creation: number
  output: number
}

export interface TokenTurn {
  /** 1-based, in time order. */
  turn_index: number
  started_at: string | null
  ended_at: string | null
  /** First 80 characters of the user prompt; "" when unavailable. */
  prompt_excerpt: string
  input: number
  cache_read: number
  cache_creation: number
  output: number
  /** Sum of the four figures above. */
  total: number
  calls: number
  /** Present only when the request asked for `include_calls`. */
  calls_detail?: TurnCall[]
}

export interface TurnTotals {
  input: number
  cache_read: number
  cache_creation: number
  output: number
  total: number
  calls: number
}

/** exact = the transcript carries turn boundaries; inferred = cut at the
 *  turn-complete timestamps, so a tool call longer than the silence window can
 *  split one turn in two; unsupported = the vendor logs no token usage. */
export type TurnMethod = 'exact' | 'inferred' | 'unsupported'

export interface TokenTurnsResult {
  ok: true
  pane_id?: string
  session_id: string
  /** The vendor's agent key, e.g. "claude". */
  vendor: string
  file_path: string
  method: TurnMethod
  turns: TokenTurn[]
  totals: TurnTotals
  scanned_at: string
}

/** Domain failures the backend answers inside an ok envelope. */
export type TokenTurnsErrorCode = 'no-session' | 'file-missing' | 'unknown-vendor' | 'scan-failed'

interface TokenTurnsFailure {
  ok: false
  error: TokenTurnsErrorCode | string
  detail?: string
}

export interface TokenTurnsTarget {
  paneId?: string
  sessionId?: string
  agentKey?: string
}

export function emptyTurnTotals(): TurnTotals {
  return { input: 0, cache_read: 0, cache_creation: 0, output: 0, total: 0, calls: 0 }
}

export function useTokenTurns(backend: ReturnType<typeof useBackend>) {
  const data = ref<TokenTurnsResult | null>(null)
  const loading = ref(false)
  /** Empty when the last load succeeded; otherwise the contract error code
   *  ("no-session", …) or the transport's message. */
  const error = ref('')
  const errorDetail = ref('')
  let loadSeq = 0

  async function load(target: TokenTurnsTarget, opts: { includeCalls?: boolean } = {}): Promise<void> {
    const seq = ++loadSeq
    loading.value = true
    error.value = ''
    errorDetail.value = ''
    try {
      const resp = await backend.send<TokenTurnsResult | TokenTurnsFailure>('tokens.turns', {
        pane_id: target.paneId || undefined,
        session_id: target.sessionId || undefined,
        agent_key: target.agentKey || undefined,
        include_calls: opts.includeCalls ?? false
      })
      // A later load owns the state now; this answer is for a pane the user
      // has already moved away from.
      if (seq !== loadSeq) return
      if (!resp.ok || !resp.payload) {
        data.value = null
        error.value = resp.error?.code || resp.error?.message || 'scan-failed'
        errorDetail.value = resp.error?.message ?? ''
        return
      }
      const body = resp.payload
      if (body.ok === false) {
        data.value = null
        error.value = body.error || 'scan-failed'
        errorDetail.value = body.detail ?? ''
        return
      }
      data.value = body
    } catch (err) {
      if (seq !== loadSeq) return
      data.value = null
      error.value = String((err as Error).message ?? err)
    } finally {
      if (seq === loadSeq) loading.value = false
    }
  }

  function clear(): void {
    loadSeq++
    data.value = null
    loading.value = false
    error.value = ''
    errorDetail.value = ''
  }

  return { data, loading, error, errorDetail, load, clear }
}
