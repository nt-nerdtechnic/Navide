// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import { createMockBackend } from '../../../composables/__tests__/mockBackend'
import SecurityPane from '../SecurityPane.vue'

let wrapper: VueWrapper | undefined
let mock: ReturnType<typeof createMockBackend>

async function render(): Promise<VueWrapper> {
  wrapper = mount(SecurityPane, { props: { backend: mock.backend }, global: { plugins: [i18n] } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  i18n.global.locale.value = 'en-US'
  mock = createMockBackend('connected')
  mock.setResponse('guard.status', {
    enabled: true,
    counts: { critical: 1, high: 2, asks: 3, denies_24h: 4 },
    hook_support: { claude: 'block', cursor: 'none' },
  })
  mock.setResponse('guard.taint.list', { panes: [{ pane_id: 'p9', sources: ['relay'], since: 1_700_000_000, detail: '' }] })
  mock.setResponse('guard.rules.list', { rules: [{ id: 7, kind: 'deny', pattern: 'terraform apply', note: 'prod' }] })
  mock.setResponse('guard.audit.list', {
    entries: [{ id: 1, ts: 1_700_000_000, pane_id: 'p9', vendor: 'claude', source: 'relay', tool: 'shell', excerpt: 'rm -rf ~', level: 'critical', action: 'deny', rule_ids: ['rm-home'], tainted: true }],
  })
})
afterEach(() => {
  wrapper?.unmount()
})

describe('SecurityPane', () => {
  it('loads everything the page shows', async () => {
    const w = await render()
    expect(mock.sent.map((s) => s.type)).toEqual(
      expect.arrayContaining(['guard.status', 'guard.taint.list', 'guard.rules.list', 'guard.audit.list'])
    )
    expect(w.find('[data-testid="guard-unavailable"]').exists()).toBe(false)
    expect(w.get('[data-testid="guard-counts"]').text()).toContain('Denied (24h) 4')
    expect(w.findAll('[data-testid="guard-rule-row"]')[0].text()).toContain('terraform apply')
    expect(w.findAll('[data-testid="guard-audit-row"]')[0].text()).toContain('rm -rf ~')
    expect(w.findAll('[data-testid="guard-taint-row"]')).toHaveLength(1)
  })

  it('shows the policy matrix with chat approvals denied for critical and high', async () => {
    const w = await render()
    const rows = w.get('[data-testid="guard-policy"]').findAll('tbody tr')
    const relay = rows.find((r) => r.text().includes('Approved from a chat app'))!
    expect(relay.findAll('td').map((c) => c.text())).toEqual(['Deny', 'Deny', 'Allow'])
  })

  it('labels which CLIs Guard can block', async () => {
    const w = await render()
    const row = (k: string) => w.get(`[data-testid="guard-vendor-row"][data-vendor="${k}"]`).text()
    expect(row('claude')).toContain('Can be blocked')
    expect(row('cursor')).toContain('Cannot be blocked')
  })

  it('toggles Guard, adds and removes rules, clears taint and runs a test', async () => {
    mock.setResponse('guard.test', {
      verdict: { level: 'critical', rule_ids: ['rm-home'], reasons: ['deletes home'], parseable: true },
      decision: { action: 'deny', level: 'critical', rule_ids: ['rm-home'], reason: 'needs local confirmation', tainted: false },
    })
    const w = await render()
    await w.get('[data-testid="guard-enabled-toggle"]').trigger('click')
    await flushPromises()
    expect(mock.sent.find((s) => s.type === 'guard.set_enabled')?.payload).toEqual({ enabled: false })

    await w.get('input[name="pattern"]').setValue('rm -rf build')
    await w.get('[data-testid="guard-rule-add"]').trigger('submit')
    await flushPromises()
    expect(mock.sent.find((s) => s.type === 'guard.rules.add')?.payload).toEqual({ kind: 'deny', pattern: 'rm -rf build', note: '', level: 'critical' })

    await w.get('[data-testid="guard-rule-remove"]').trigger('click')
    await flushPromises()
    // Removing a deny loosens Guard, so it carries a confirmation (none in a test window).
    expect(mock.sent.find((s) => s.type === 'guard.rules.remove')?.payload).toEqual({ id: 7, confirm: null })

    await w.get('[data-testid="guard-taint-clear-row"]').trigger('click')
    expect(mock.sent.find((s) => s.type === 'guard.taint.clear')?.payload).toEqual({ pane_id: 'p9' })

    await w.get('input[name="command"]').setValue('rm -rf ~')
    await w.get('select[name="source"]').setValue('relay')
    await w.get('[data-testid="guard-test-run"]').trigger('submit')
    await flushPromises()
    expect(mock.sent.find((s) => s.type === 'guard.test')?.payload).toEqual({ command: 'rm -rf ~', source: 'relay', tainted: false })
    expect(w.get('[data-testid="guard-test-result"]').text()).toContain('needs local confirmation')
  })

  it('lists built-in rules by group, keeps floor rules above off, and edits levels and branches', async () => {
    const builtin = {
      rules: [
        { id: 'credential-access', group: 'critical', description: 'Credential store', example: 'cat ~/.ssh/id_rsa', default_level: 'critical', level: 'critical', floor: true },
        { id: 'git-push', group: 'high', description: 'Pushes to a remote', example: 'git push', default_level: 'high', level: 'high', floor: false },
      ],
      protected_branches: ['main', 'master'],
    }
    mock.setResponse('guard.builtin.get', builtin)
    mock.setResponse('guard.builtin.set_level', builtin)
    mock.setResponse('guard.branches.add', { ...builtin, protected_branches: ['main', 'master', 'release'] })
    const w = await render()
    const row = (id: string) => w.get(`[data-testid="guard-builtin-row"][data-rule="${id}"]`)
    expect(row('git-push').text()).toContain('Pushes to a remote')
    expect(row('credential-access').text()).toContain('Safety floor')
    expect(row('credential-access').get('option[value="normal"]').attributes('disabled')).toBeDefined()
    expect(row('git-push').get('option[value="normal"]').attributes('disabled')).toBeUndefined()

    await row('git-push').get('select').setValue('critical')
    await flushPromises()
    expect(mock.sent.find((s) => s.type === 'guard.builtin.set_level')?.payload).toEqual({ id: 'git-push', level: 'critical' })

    expect(w.findAll('[data-testid="guard-branch-row"]').map((r) => r.text())).toEqual([
      expect.stringContaining('main'), expect.stringContaining('master'),
    ])
    await w.get('input[name="branch"]').setValue('release')
    await w.get('[data-testid="guard-branch-add"]').trigger('submit')
    await flushPromises()
    expect(mock.sent.find((s) => s.type === 'guard.branches.add')?.payload).toEqual({ name: 'release' })
    expect(w.findAll('[data-testid="guard-branch-row"]')).toHaveLength(3)
  })

  it('shows which rules a tested command matched and how each was graded', async () => {
    mock.setResponse('guard.builtin.get', {
      rules: [{ id: 'git-push', group: 'high', description: 'Pushes to a remote', example: 'git push', default_level: 'high', level: 'critical', floor: false }],
      protected_branches: ['main'],
    })
    mock.setResponse('guard.test', {
      verdict: { level: 'high', rule_ids: ['git-push'], reasons: ['pushes to a remote'], parseable: true },
      decision: { action: 'ask', level: 'critical', rule_ids: ['git-push', 'user-deny:7'], reason: '', tainted: false },
      graded_level: 'critical',
      matched: [
        { id: 'git-push', reason: 'pushes to a remote', default_level: 'high', level: 'critical' },
        { id: 'user-deny:7', reason: 'origin', default_level: 'critical', level: 'high', user: 'user-deny' },
      ],
    })
    const w = await render()
    await w.get('input[name="command"]').setValue('git push origin')
    await w.get('[data-testid="guard-test-run"]').trigger('submit')
    await flushPromises()
    const rows = w.findAll('[data-testid="guard-test-matched-row"]')
    expect(rows[0].text()).toContain('Pushes to a remote')
    expect(rows[0].text()).toContain('High')
    expect(rows[0].text()).toContain('Critical')
    expect(rows[1].text()).toContain('Your deny pattern `origin`')
  })

  it('explains itself when the backend has no Guard yet', async () => {
    mock.setResponse('guard.status', null, { ok: false, error: { code: 'unknown_type', message: 'unknown type' } })
    const w = await render()
    expect(w.find('[data-testid="guard-unavailable"]').exists()).toBe(true)
    expect(w.get('[data-testid="guard-enabled-toggle"]').attributes('disabled')).toBeDefined()
  })
})
