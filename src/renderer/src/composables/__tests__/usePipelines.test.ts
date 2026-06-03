// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { usePipelines, type PipelineSummary } from '../usePipelines'
import { createMockBackend, withScope, flush } from './mockBackend'

const mockPipelines: PipelineSummary[] = [
  { id: 'default', name: '預設流程', builtin: true, stage_count: 6 },
  { id: 'maintenance', name: '維護流程', builtin: true, stage_count: 3 },
]

describe('usePipelines', () => {
  it('loads pipelines on connect', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('pipelines.list', {
      pipelines: mockPipelines,
      active_pipeline_id: 'default',
      path: '/data/pipelines.json',
    })

    const { result, scope } = withScope(() => usePipelines(mock.backend))
    await flush()

    expect(result.pipelines.value).toHaveLength(2)
    expect(result.activePipelineId.value).toBe('default')
    expect(result.isLoaded.value).toBe(true)
    scope.stop()
  })

  it('activePipeline reflects the active id', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('pipelines.list', {
      pipelines: mockPipelines,
      active_pipeline_id: 'maintenance',
      path: '/data/pipelines.json',
    })

    const { result, scope } = withScope(() => usePipelines(mock.backend))
    await flush()

    expect(result.activePipeline.value?.id).toBe('maintenance')
    expect(result.activePipeline.value?.name).toBe('維護流程')
    scope.stop()
  })

  it('updates pipelines on pipelines.changed broadcast', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('pipelines.list', {
      pipelines: mockPipelines,
      active_pipeline_id: 'default',
      path: '/data/pipelines.json',
    })

    const { result, scope } = withScope(() => usePipelines(mock.backend))
    await flush()

    const newPipelines: PipelineSummary[] = [
      ...mockPipelines,
      { id: 'custom', name: '自訂流程', builtin: false, stage_count: 0 },
    ]
    mock.emit('pipelines.changed', {
      pipelines: newPipelines,
      active_pipeline_id: 'custom',
    })
    await flush()

    expect(result.pipelines.value).toHaveLength(3)
    expect(result.activePipelineId.value).toBe('custom')
    scope.stop()
  })

  it('createPipeline calls pipelines.create and updates state', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('pipelines.list', {
      pipelines: mockPipelines,
      active_pipeline_id: 'default',
      path: '/data/pipelines.json',
    })
    const newPipeline: PipelineSummary = { id: 'abc123', name: '新流程', builtin: false, stage_count: 0 }
    mock.setResponse('pipelines.create', {
      pipeline: newPipeline,
      pipelines: [...mockPipelines, newPipeline],
    })

    const { result, scope } = withScope(() => usePipelines(mock.backend))
    await flush()

    const p = await result.createPipeline('新流程')
    expect(p).not.toBeNull()
    expect(p?.id).toBe('abc123')
    expect(result.pipelines.value).toHaveLength(3)

    const sentCreate = mock.sent.find((s) => s.type === 'pipelines.create')
    expect(sentCreate?.payload.name).toBe('新流程')
    scope.stop()
  })

  it('setActivePipeline calls pipelines.set_active', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('pipelines.list', {
      pipelines: mockPipelines,
      active_pipeline_id: 'default',
      path: '/data/pipelines.json',
    })
    mock.setResponse('pipelines.set_active', {
      active_pipeline_id: 'maintenance',
      pipelines: mockPipelines,
    })

    const { result, scope } = withScope(() => usePipelines(mock.backend))
    await flush()

    const ok = await result.setActivePipeline('maintenance', '/workspace')
    expect(ok).toBe(true)
    expect(result.activePipelineId.value).toBe('maintenance')

    const sent = mock.sent.find((s) => s.type === 'pipelines.set_active')
    expect(sent?.payload.pipeline_id).toBe('maintenance')
    expect(sent?.payload.workspace_path).toBe('/workspace')
    scope.stop()
  })

  it('deletePipeline calls pipelines.delete', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('pipelines.list', {
      pipelines: mockPipelines,
      active_pipeline_id: 'default',
      path: '/data/pipelines.json',
    })
    mock.setResponse('pipelines.delete', {
      pipelines: [mockPipelines[0]], // only default remains
    })

    const { result, scope } = withScope(() => usePipelines(mock.backend))
    await flush()

    const ok = await result.deletePipeline('maintenance', '/workspace')
    expect(ok).toBe(true)
    expect(result.pipelines.value).toHaveLength(1)
    scope.stop()
  })

  it('returns null from createPipeline on backend error', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('pipelines.list', {
      pipelines: mockPipelines,
      active_pipeline_id: 'default',
      path: '/data/pipelines.json',
    })
    mock.setResponse('pipelines.create', null, { ok: false, error: { code: 'ERR', message: 'fail' } })

    const { result, scope } = withScope(() => usePipelines(mock.backend))
    await flush()

    const p = await result.createPipeline('boom')
    expect(p).toBeNull()
    scope.stop()
  })

  it('pipelineById is a correct lookup map', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('pipelines.list', {
      pipelines: mockPipelines,
      active_pipeline_id: 'default',
      path: '/data/pipelines.json',
    })

    const { result, scope } = withScope(() => usePipelines(mock.backend))
    await flush()

    expect(result.pipelineById.value['default']?.name).toBe('預設流程')
    expect(result.pipelineById.value['maintenance']?.stage_count).toBe(3)
    scope.stop()
  })
})
