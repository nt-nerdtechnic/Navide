import { ref, watch, onUnmounted } from 'vue'
import type { useBackend } from './useBackend'

export interface ReviewOptions {
  workspacePath: string
  mode: 'working' | 'branch'
  base?: string
  compare?: string
}

export interface ReviewFinding {
  id: string
  file: string
  line: number | null
  severity: 'critical' | 'warning' | 'suggestion'
  title: string
  body: string
}

export interface ReviewResult {
  summary: string
  findings: ReviewFinding[]
  verdict: 'approve' | 'approve_with_comments' | 'request_changes'
}

export function useReview(backend: ReturnType<typeof useBackend>) {
  const isReviewing = ref(false)
  const reviewResult = ref<ReviewResult | null>(null)
  const reviewError = ref('')
  const currentReviewId = ref('')
  const reviewElapsed = ref(0)
  let _elapsedTimer: ReturnType<typeof setInterval> | null = null

  let _unsubResult: (() => void) | null = null
  let _unsubEnd: (() => void) | null = null
  let _unsubError: (() => void) | null = null

  function _teardown() {
    if (_elapsedTimer !== null) { clearInterval(_elapsedTimer); _elapsedTimer = null }
    _unsubResult?.(); _unsubResult = null
    _unsubEnd?.(); _unsubEnd = null
    _unsubError?.(); _unsubError = null
  }

  function _setup(rid: string) {
    _teardown()
    _unsubResult = backend.on('ai.review.result', (payload) => {
      const p = payload as { review_id: string; result: ReviewResult }
      if (p.review_id !== rid) return
      reviewResult.value = p.result
    })
    _unsubEnd = backend.on('ai.review.end', (payload) => {
      const p = payload as { review_id: string }
      if (p.review_id !== rid) return
      if (!reviewResult.value) {
        reviewError.value = 'Could not parse review output. Try again.'
      }
      isReviewing.value = false
      _teardown()
    })
    _unsubError = backend.on('ai.review.error', (payload) => {
      const p = payload as { review_id: string; message: string }
      if (p.review_id !== rid) return
      reviewError.value = p.message
      isReviewing.value = false
      _teardown()
    })
  }

  async function startReview(options: ReviewOptions): Promise<void> {
    reviewResult.value = null
    reviewError.value = ''
    reviewElapsed.value = 0
    isReviewing.value = true
    const rid = crypto.randomUUID()
    currentReviewId.value = rid
    _setup(rid)
    _elapsedTimer = setInterval(() => { reviewElapsed.value++ }, 1000)

    try {
      await backend.send('ai.review.start', {
        review_id: rid,
        workspace_path: options.workspacePath,
        mode: options.mode,
        base: options.base ?? '',
        compare: options.compare ?? '',
      })
    } catch (e) {
      reviewError.value = e instanceof Error ? e.message : String(e)
      isReviewing.value = false
      _teardown()
    }
  }

  function stopReview() {
    if (currentReviewId.value) {
      backend.send('ai.review.stop', { review_id: currentReviewId.value }).catch(() => {/* ignore */})
    }
    isReviewing.value = false
    _teardown()
  }

  watch(() => backend.status.value, (s) => {
    if ((s === 'disconnected' || s === 'error') && isReviewing.value) stopReview()
  })
  onUnmounted(_teardown)

  return { isReviewing, reviewResult, reviewError, reviewElapsed, startReview, stopReview }
}
