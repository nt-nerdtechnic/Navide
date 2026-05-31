import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import { useHistory, type HistoryEvent } from '../useHistory'
import { createMockBackend, withScope, flush } from './mockBackend'

function ev(id: string): HistoryEvent {
  return { id, ts: '2026-05-30T00:00:00Z', run_id: 'r1', type: 'log', summary: `event ${id}` }
}

describe('useHistory', () => {
  it('loads the snapshot on connect', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('history.snapshot', { events: [ev('1'), ev('2')], path: '/ws/history.jsonl' })
    const { result, scope } = withScope(() => useHistory(mock.backend, ref('/ws')))
    await flush()

    expect(result.events.value.map((e) => e.id)).toEqual(['1', '2'])
    expect(result.path.value).toBe('/ws/history.jsonl')
    scope.stop()
  })

  it('appends a broadcast event for the current workspace', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('history.snapshot', { events: [ev('1')], path: '' })
    const { result, scope } = withScope(() => useHistory(mock.backend, ref('/ws')))
    await flush()

    mock.emit('history.appended', { workspace_path: '/ws', event: ev('2') })
    expect(result.events.value.map((e) => e.id)).toEqual(['1', '2'])
    scope.stop()
  })

  it('ignores a broadcast for a different workspace', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('history.snapshot', { events: [], path: '' })
    const { result, scope } = withScope(() => useHistory(mock.backend, ref('/ws')))
    await flush()

    mock.emit('history.appended', { workspace_path: '/other', event: ev('x') })
    expect(result.events.value).toHaveLength(0)
    scope.stop()
  })

  it('caps the timeline at MAX_EVENTS (2000)', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('history.snapshot', { events: [], path: '' })
    const { result, scope } = withScope(() => useHistory(mock.backend, ref('/ws')))
    await flush()

    for (let i = 0; i < 2050; i++) {
      mock.emit('history.appended', { workspace_path: '/ws', event: ev(String(i)) })
    }
    expect(result.events.value).toHaveLength(2000)
    // Oldest dropped — newest retained.
    expect(result.events.value[result.events.value.length - 1].id).toBe('2049')
    scope.stop()
  })
})
