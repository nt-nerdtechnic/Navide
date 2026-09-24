// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { i18n, useNotify } from '@navide/plugin-ui/foundation'
import { createMockBackend, flush } from './mockBackend'
import { useGuard } from '../useGuard'

function seed(mock: ReturnType<typeof createMockBackend>): void {
  mock.setResponse('guard.status', {
    enabled: true,
    counts: { critical: 2, high: 5, asks: 1, denies_24h: 3 },
    hook_support: { claude: 'block', cursor: 'none' },
  })
  mock.setResponse('guard.taint.list', {
    panes: [{ pane_id: 'p1', sources: ['remote'], since: 1_700_000_000, detail: 'telegram:alice' }],
  })
  mock.setResponse('guard.rules.list', { rules: [{ id: 1, kind: 'deny', pattern: 'terraform apply', note: '' }] })
  mock.setResponse('guard.audit.list', { entries: [] })
}

beforeEach(() => {
  i18n.global.locale.value = 'en-US'
  const { toasts, dismissToast } = useNotify()
  for (const t of [...toasts.value]) dismissToast(t.id)
})

describe('useGuard', () => {
  it('reads status and taint on connect, without the Settings-only lists', async () => {
    const mock = createMockBackend('connected')
    seed(mock)
    const store = useGuard(mock.backend)
    await flush()
    expect(mock.sent.map((s) => s.type).sort()).toEqual(['guard.status', 'guard.taint.list'])
    expect(store.available.value).toBe(true)
    expect(store.counts.value.denies_24h).toBe(3)
    expect(store.hookSupportFor('cursor')).toBe('none')
    expect(store.hookSupportFor('claude')).toBe('block')
    expect(store.hookSupportFor('kimi')).toBeNull()
    expect(store.taintFor('p1')?.detail).toBe('telegram:alice')
    expect(store.taintFor('p2')).toBeNull()
  })

  it('stays unavailable when the backend has no Guard', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('guard.status', null, { ok: false, error: { code: 'unknown_type', message: 'unknown type' } })
    const store = useGuard(mock.backend)
    await flush()
    expect(store.available.value).toBe(false)
  })

  it('shares one store per backend', () => {
    const mock = createMockBackend('disconnected')
    expect(useGuard(mock.backend)).toBe(useGuard(mock.backend))
  })

  it('re-reads the taint set on guard.taint_changed', async () => {
    const mock = createMockBackend('connected')
    seed(mock)
    const store = useGuard(mock.backend)
    await flush()
    mock.setResponse('guard.taint.list', { panes: [] })
    mock.emit('guard.taint_changed', { pane_id: 'p1', tainted: false })
    await flush()
    expect(store.taintFor('p1')).toBeNull()
  })

  it('turns a non-allow guard.decision into a notice with the reason', async () => {
    const mock = createMockBackend('connected')
    seed(mock)
    useGuard(mock.backend)
    await flush()
    mock.emit('guard.decision', { pane_id: 'p1', action: 'deny', level: 'critical', reason: 'rm outside workspace', excerpt: 'rm -rf ~' })
    mock.emit('guard.decision', { pane_id: 'p1', action: 'allow', level: 'normal', reason: 'fine', excerpt: 'ls' })
    await flush()
    const messages = useNotify().toasts.value.map((t) => t.message)
    expect(messages).toEqual(['Navide Guard blocked an action: rm outside workspace'])
    expect(useNotify().toasts.value[0].type).toBe('error')
  })

  it('announces a fail-open (action error) as an error notice', async () => {
    const mock = createMockBackend('connected')
    seed(mock)
    useGuard(mock.backend)
    await flush()
    mock.emit('guard.decision', { pane_id: 'p1', action: 'error', level: 'normal', reason: 'Navide Guard error, allowed: no decision within 5s', excerpt: '' })
    await flush()
    const toast = useNotify().toasts.value[0]
    expect(toast.message).toBe('Navide Guard could not check an action and let it run: Navide Guard error, allowed: no decision within 5s')
    expect(toast.type).toBe('error')
  })

  it('sends mutations with the contract payloads', async () => {
    const mock = createMockBackend('connected')
    seed(mock)
    const store = useGuard(mock.backend)
    await flush()
    await store.setEnabled(false)
    await store.addRule('allow', 'rm -rf dist', 'build output')
    await store.removeRule(1)
    await store.clearTaint('p1')
    await store.test('rm -rf ~', 'relay', true)
    const payload = (type: string) => mock.sent.find((s) => s.type === type)?.payload
    expect(payload('guard.set_enabled')).toEqual({ enabled: false })
    expect(payload('guard.rules.add')).toEqual({ kind: 'allow', pattern: 'rm -rf dist', note: 'build output' })
    expect(payload('guard.rules.remove')).toEqual({ id: 1 })
    expect(payload('guard.taint.clear')).toEqual({ pane_id: 'p1' })
    expect(payload('guard.test')).toEqual({ command: 'rm -rf ~', source: 'relay', tainted: true })
  })
})
