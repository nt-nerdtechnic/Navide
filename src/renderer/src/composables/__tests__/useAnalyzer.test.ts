// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { useAnalyzer, type ClassifyResult } from '../useAnalyzer'
import { createMockBackend, withScope, flush } from './mockBackend'

const okResult: ClassifyResult = {
  intent: 'question',
  questions: [{ prompt: '要哪個 DB?', type: 'choice', options: ['PostgreSQL', 'MySQL'] }],
  summary: 'asking db'
}

describe('useAnalyzer', () => {
  it('loads health + models on connect', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('analyzer.health', { ok: true, version: '1.0', default_model: 'qwen2.5-coder' })
    mock.setResponse('analyzer.models', {
      models: [{ name: 'qwen2.5-coder', size: 1, family: 'qwen', parameter_size: '7b' }],
      default: 'qwen2.5-coder'
    })

    const { result, scope } = withScope(() => useAnalyzer(mock.backend))
    await flush()

    expect(result.health.value?.ok).toBe(true)
    expect(result.defaultModel.value).toBe('qwen2.5-coder')
    expect(result.models.value).toHaveLength(1)
    scope.stop()
  })

  it('does not fetch models when health is not ok', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('analyzer.health', { ok: false, error: 'llama-cli not found' })

    const { result, scope } = withScope(() => useAnalyzer(mock.backend))
    await flush()

    expect(result.health.value?.ok).toBe(false)
    expect(mock.sent.some((s) => s.type === 'analyzer.models')).toBe(false)
    scope.stop()
  })

  it('classify() returns the backend result', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('analyzer.health', { ok: true, default_model: 'qwen' })
    mock.setResponse('analyzer.models', { models: [], default: 'qwen' })
    mock.setResponse('analyzer.classify', okResult)

    const { result, scope } = withScope(() => useAnalyzer(mock.backend))
    await flush()

    const r = await result.classify('agent 列出了選項...', 'qwen', { paneId: 'p1' })
    expect(r?.intent).toBe('question')
    expect(r?.questions[0].options).toEqual(['PostgreSQL', 'MySQL'])
    scope.stop()
  })

  it('classify() short-circuits on empty text without hitting the backend', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('analyzer.health', { ok: false })
    const { result, scope } = withScope(() => useAnalyzer(mock.backend))
    await flush()

    const before = mock.sent.length
    const r = await result.classify('   ')
    expect(r).toBeNull()
    expect(mock.sent.length).toBe(before) // no analyzer.classify sent
    scope.stop()
  })

  it('classify() returns null when disconnected', async () => {
    const mock = createMockBackend('disconnected')
    const { result, scope } = withScope(() => useAnalyzer(mock.backend))
    await flush()

    expect(await result.classify('some text')).toBeNull()
    scope.stop()
  })
})
