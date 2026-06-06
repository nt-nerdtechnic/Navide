import { ref, onUnmounted } from 'vue'
import type { useBackend } from './useBackend'

export interface ReviewOptions {
  workspacePath: string
  mode: 'working' | 'branch'
  base?: string
  compare?: string
}

export function useReview(backend: ReturnType<typeof useBackend>) {
  const isReviewing = ref(false)
  const reviewText = ref('')
  const reviewError = ref('')
  const currentReviewId = ref('')

  let _unsubChunk: (() => void) | null = null
  let _unsubEnd: (() => void) | null = null
  let _unsubError: (() => void) | null = null

  function _teardown() {
    _unsubChunk?.(); _unsubChunk = null
    _unsubEnd?.(); _unsubEnd = null
    _unsubError?.(); _unsubError = null
  }

  function _setup(rid: string) {
    _teardown()
    _unsubChunk = backend.on('ai.review.chunk', (payload) => {
      const p = payload as { review_id: string; text: string }
      if (p.review_id !== rid) return
      reviewText.value += p.text
    })
    _unsubEnd = backend.on('ai.review.end', (payload) => {
      const p = payload as { review_id: string }
      if (p.review_id !== rid) return
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
    reviewText.value = ''
    reviewError.value = ''
    isReviewing.value = true
    const rid = crypto.randomUUID()
    currentReviewId.value = rid
    _setup(rid)

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
    isReviewing.value = false
    _teardown()
  }

  onUnmounted(_teardown)

  return { isReviewing, reviewText, reviewError, startReview, stopReview }
}
