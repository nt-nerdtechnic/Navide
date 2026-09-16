// @vitest-environment happy-dom
// TurnStatsModal — it owns no pane state and no scan; every assertion is on
// the seams it has: the pane views the host passes in, the `tokens.turns`
// request it sends, and how it renders the contract's three shapes (exact
// data, unsupported, error).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import TurnStatsModal, { type TurnStatsPane } from '../TurnStatsModal.vue'
import type { TokenTurnsResult } from '../../composables/useTokenTurns'

const wire = vi.hoisted(() => ({
  status: 'connected' as string,
  calls: [] as Array<{ type: string; payload?: Record<string, unknown> }>,
  /** What `tokens.turns` answers with — the contract body (inside an ok envelope). */
  answer: null as unknown,
  /** When set, `tokens.turns` answers with a transport-level error envelope. */
  envelopeError: null as null | { code: string; message: string },
}))

function fakeBackend() {
  return {
    status: ref(wire.status),
    wsUrl: ref(''),
    httpUrl: ref(''),
    shell: ref(''),
    port: ref(0),
    pid: ref(0),
    lastError: ref(''),
    send: vi.fn(async (type: string, sent?: Record<string, unknown>) => {
      wire.calls.push({ type, payload: sent })
      if (type === 'tokens.turns' && wire.envelopeError) {
        return { id: 'r', type, ok: false, payload: null, error: wire.envelopeError, timestamp: '' }
      }
      const payload = type === 'tokens.turns' ? wire.answer : { ok: true }
      return { id: 'r', type, ok: true, payload, error: null, timestamp: '' }
    }),
    on: vi.fn(() => () => {}),
    restart: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  } as unknown as never
}

function exactAnswer(): TokenTurnsResult {
  return {
    ok: true,
    pane_id: 'p1',
    session_id: '3e146a7d-ba35-4e81-9999-cb65cddda625',
    vendor: 'claude',
    file_path: '/Users/x/.claude/projects/a/3e146a7d.jsonl',
    method: 'exact',
    turns: [
      {
        turn_index: 1,
        started_at: '2026-09-16T00:54:02Z',
        ended_at: '2026-09-16T00:55:00Z',
        prompt_excerpt: 'Analyze the quota detection, "with quotes"',
        input: 2101,
        cache_read: 498006,
        cache_creation: 900,
        output: 3455,
        total: 504462,
        calls: 3,
        calls_detail: [
          { ts: '2026-09-16T00:54:05Z', model: 'claude-opus-5', input: 2000, cache_read: 400000, cache_creation: 900, output: 3000 },
          { ts: '2026-09-16T00:54:20Z', model: 'claude-opus-5', input: 101, cache_read: 98006, cache_creation: 0, output: 455 },
        ],
      },
      {
        turn_index: 2,
        started_at: '2026-09-16T01:01:40Z',
        ended_at: null,
        prompt_excerpt: '',
        input: 4812,
        cache_read: 612340,
        cache_creation: 0,
        output: 9120,
        total: 626272,
        calls: 11,
        calls_detail: [],
      },
    ],
    totals: { input: 6913, cache_read: 1110346, cache_creation: 900, output: 12575, total: 1130734, calls: 14 },
    scanned_at: '2026-09-16T01:02:00Z',
  }
}

const PANES: TurnStatsPane[] = [
  { id: 'p1', agentKey: 'claude', agentLabel: 'Scan the code', status: 'idle', sessionId: '3e146a7d-ba35-4e81-9999-cb65cddda625' },
  { id: 'p2', agentKey: 'codex', agentLabel: 'Deploy notes', status: 'running' },
  { id: 'p3', agentKey: 'cursor', agentLabel: 'Cursor', status: 'idle' },
  { id: 'p4', agentKey: 'claude', agentLabel: 'Old review', status: 'waiting' },
  { id: 't1', agentKey: 'terminal', agentLabel: 'Terminal', status: 'idle' },
]

beforeEach(() => {
  wire.status = 'connected'
  wire.calls = []
  wire.answer = exactAnswer()
  wire.envelopeError = null
  i18n.global.locale.value = 'en-US'
})
afterEach(() => {
  document.body.innerHTML = ''
})

async function mountModal(
  opts: { open?: boolean; panes?: TurnStatsPane[]; activePaneId?: string | null } = {}
): Promise<VueWrapper> {
  const w = mount(TurnStatsModal, {
    props: {
      open: opts.open ?? true,
      backend: fakeBackend(),
      panes: opts.panes ?? PANES,
      activePaneId: opts.activePaneId === undefined ? 'p1' : opts.activePaneId,
    },
    global: { plugins: [i18n], stubs: { teleport: true } },
  })
  await flushPromises()
  return w
}

function turnsCalls() {
  return wire.calls.filter((c) => c.type === 'tokens.turns')
}

// Same trap as ResourceManagerModal: `.nv-modal-overlay` only skins the
// scrim, so the modal must position its own overlay and size its own card.
describe('TurnStatsModal layout', () => {
  it('positions its own overlay and sets its own box', async () => {
    const fs = await import('node:fs')
    const source = fs.readFileSync('src/renderer/src/components/TurnStatsModal.vue', 'utf8')
    const overlay = source.slice(source.indexOf('.ts-overlay {'), source.indexOf('.ts-modal {'))
    expect(overlay).toContain('position: fixed')
    expect(overlay).toContain('inset: 0')
    expect(overlay).toMatch(/z-index:\s*\S/)
    expect(overlay).toContain('display: flex')
    const modal = source.slice(source.indexOf('.ts-modal {'), source.indexOf('.ts-spacer'))
    expect(modal).toContain('width: min(var(--modal-w-wide)')
    expect(modal).toMatch(/height:\s*min\(/)
  })
})

describe('TurnStatsModal pane picker', () => {
  it('lists CLI panes only, preselects the focused pane, and greys out vendors without token usage', async () => {
    const w = await mountModal()
    const options = w.findAll('select[data-act="pane"] option')
    expect(options.map((o) => o.attributes('value'))).toEqual(['p1', 'p2', 'p3', 'p4'])
    expect((w.get('select[data-act="pane"]').element as HTMLSelectElement).value).toBe('p1')
    const cursor = options.find((o) => o.attributes('value') === 'p3')!
    expect(cursor.attributes('disabled')).toBeDefined()
    expect(cursor.text()).toContain(i18n.global.t('turn-stats.no-token-usage'))
    // A cold-restore placeholder is listed (its transcript is still on disk)
    // and says so.
    const placeholder = options.find((o) => o.attributes('value') === 'p4')!
    expect(placeholder.attributes('disabled')).toBeUndefined()
    expect(placeholder.text()).toContain(i18n.global.t('turn-stats.pane-placeholder'))
  })

  it('falls back to the first supported pane when the focused one has no token usage', async () => {
    const w = await mountModal({ activePaneId: 'p3' })
    expect((w.get('select[data-act="pane"]').element as HTMLSelectElement).value).toBe('p1')
  })

  it('shows the empty state and sends nothing when there is no CLI pane', async () => {
    const w = await mountModal({ panes: [PANES[4]], activePaneId: null })
    expect(w.get('[data-state="no-panes"]').text()).toBe(i18n.global.t('turn-stats.empty-panes'))
    expect(turnsCalls()).toHaveLength(0)
  })

  it('does not scan while closed, and scans once opened', async () => {
    const w = await mountModal({ open: false })
    expect(turnsCalls()).toHaveLength(0)
    await w.setProps({ open: true })
    await flushPromises()
    expect(turnsCalls()).toHaveLength(1)
  })
})

describe('TurnStatsModal with exact data', () => {
  it('requests the selected pane with calls included', async () => {
    await mountModal()
    expect(turnsCalls()).toHaveLength(1)
    expect(turnsCalls()[0].payload).toMatchObject({
      pane_id: 'p1',
      session_id: '3e146a7d-ba35-4e81-9999-cb65cddda625',
      agent_key: 'claude',
      include_calls: true,
    })
  })

  it('renders the summary, session, method badge, rows newest first, and the totals row', async () => {
    const w = await mountModal()
    expect(w.get('[data-part="summary"]').text()).toBe(
      i18n.global.t('turn-stats.summary', { turns: 2, calls: '14', total: '1.1M' })
    )
    expect(w.get('[data-part="session"]').text()).toContain('3e146a7d…')
    expect(w.get('.ts-method').attributes('data-method')).toBe('exact')
    expect(w.find('[data-part="method-note"]').exists()).toBe(false)

    const rows = w.findAll('[data-row="turn"]')
    expect(rows.map((r) => r.attributes('data-turn'))).toEqual(['2', '1'])
    const first = rows[1]
    expect(first.get('[data-part="input"]').text()).toBe('2,101')
    expect(first.get('[data-part="cache-read"]').text()).toBe('498,006')
    expect(first.get('[data-part="cache-write"]').text()).toBe('900')
    expect(first.get('[data-part="output"]').text()).toBe('3,455')
    expect(first.get('[data-part="total"]').text()).toBe('504,462')
    expect(first.get('[data-part="calls"]').text()).toBe('3')
    expect(first.get('.c-prompt').text()).toContain('Analyze the quota detection')
    // A turn without prompt text says so instead of rendering an empty cell.
    expect(rows[0].get('.c-prompt').text()).toBe(i18n.global.t('turn-stats.no-prompt'))

    const totals = w.get('[data-row="totals"]')
    expect(totals.get('[data-part="total"]').text()).toBe('1,130,734')
    expect(totals.get('[data-part="calls"]').text()).toBe('14')
    expect(totals.text()).toContain(i18n.global.t('turn-stats.row-total'))

    expect(w.get('[data-part="note"]').text()).toBe(i18n.global.t('turn-stats.note'))
  })

  it('expands a row to its calls and collapses it again', async () => {
    const w = await mountModal()
    expect(w.find('[data-row="detail"]').exists()).toBe(false)
    await w.get('[data-row="turn"][data-turn="1"]').trigger('click')
    const detail = w.get('[data-row="detail"][data-turn="1"]')
    const calls = detail.findAll('[data-row="call"]')
    expect(calls).toHaveLength(2)
    expect(calls[0].text()).toContain('claude-opus-5')
    expect(calls[0].text()).toContain('400,000')
    await w.get('[data-row="turn"][data-turn="1"]').trigger('click')
    expect(w.find('[data-row="detail"]').exists()).toBe(false)
  })

  it('an expanded turn with no calls says so', async () => {
    const w = await mountModal()
    await w.get('[data-row="turn"][data-turn="2"]').trigger('click')
    expect(w.get('[data-row="detail"][data-turn="2"]').text()).toBe(i18n.global.t('turn-stats.no-calls'))
  })

  it('labels an inferred cut and shows the caveat', async () => {
    wire.answer = { ...exactAnswer(), method: 'inferred' }
    const w = await mountModal()
    expect(w.get('.ts-method').attributes('data-method')).toBe('inferred')
    expect(w.get('[data-part="method-note"]').text()).toBe(i18n.global.t('turn-stats.method-inferred-note'))
  })

  it('rescans on demand and when another pane is picked', async () => {
    const w = await mountModal()
    expect(turnsCalls()).toHaveLength(1)
    await w.get('[data-act="rescan"]').trigger('click')
    await flushPromises()
    expect(turnsCalls()).toHaveLength(2)
    await w.get('select[data-act="pane"]').setValue('p2')
    await flushPromises()
    expect(turnsCalls()).toHaveLength(3)
    expect(turnsCalls()[2].payload).toMatchObject({ pane_id: 'p2', agent_key: 'codex' })
  })

  it('builds a CSV with a header, one row per turn in transcript order, and quoted prompts', async () => {
    const w = await mountModal()
    const csv = (w.vm as unknown as { buildCsv: (t: TokenTurnsResult['turns']) => string }).buildCsv(
      exactAnswer().turns
    )
    const lines = csv.trimEnd().split('\n')
    expect(lines[0]).toBe('turn,started_at,ended_at,prompt,input,cache_read,cache_creation,output,total,calls')
    expect(lines).toHaveLength(3)
    expect(lines[1]).toBe(
      '1,2026-09-16T00:54:02Z,2026-09-16T00:55:00Z,"Analyze the quota detection, ""with quotes""",2101,498006,900,3455,504462,3'
    )
    expect(lines[2]).toBe('2,2026-09-16T01:01:40Z,,,4812,612340,0,9120,626272,11')
    expect(w.get('[data-act="export"]').attributes('disabled')).toBeUndefined()
  })

  it('an empty transcript shows the empty state and disables export', async () => {
    wire.answer = { ...exactAnswer(), turns: [], totals: { input: 0, cache_read: 0, cache_creation: 0, output: 0, total: 0, calls: 0 } }
    const w = await mountModal()
    expect(w.get('[data-state="empty"]').text()).toBe(i18n.global.t('turn-stats.empty-turns'))
    expect(w.get('[data-act="export"]').attributes('disabled')).toBeDefined()
  })
})

describe('TurnStatsModal unsupported', () => {
  it('a vendor known to have no token usage is answered locally, without a scan', async () => {
    const w = await mountModal({ panes: [PANES[2]], activePaneId: 'p3' })
    expect(w.get('[data-state="unsupported"]').text()).toBe(i18n.global.t('turn-stats.method-unsupported'))
    expect(turnsCalls()).toHaveLength(0)
  })

  it('an unsupported answer from the backend renders the same message', async () => {
    wire.answer = {
      ...exactAnswer(),
      vendor: 'codex',
      method: 'unsupported',
      turns: [],
      totals: { input: 0, cache_read: 0, cache_creation: 0, output: 0, total: 0, calls: 0 },
    }
    const w = await mountModal({ activePaneId: 'p2' })
    expect(turnsCalls()).toHaveLength(1)
    expect(w.get('[data-state="unsupported"]').text()).toBe(i18n.global.t('turn-stats.method-unsupported'))
    expect(w.find('[data-row="turn"]').exists()).toBe(false)
  })
})

describe('TurnStatsModal errors', () => {
  it('maps a contract error code to its message', async () => {
    wire.answer = { ok: false, error: 'no-session' }
    const w = await mountModal()
    expect(w.get('[data-state="error"]').text()).toBe(i18n.global.t('turn-stats.error-no-session'))
  })

  it('maps a transport-level error envelope to its message', async () => {
    wire.envelopeError = { code: 'file-missing', message: 'gone' }
    const w = await mountModal()
    expect(w.get('[data-state="error"]').text()).toBe(i18n.global.t('turn-stats.error-file-missing'))
  })

  it('shows an unknown error with its detail', async () => {
    wire.answer = { ok: false, error: 'boom', detail: 'disk on fire' }
    const w = await mountModal()
    expect(w.get('[data-state="error"]').text()).toBe(
      i18n.global.t('turn-stats.error-generic', { detail: 'disk on fire' })
    )
  })

  it('never leaks a raw i18n key in either locale', async () => {
    for (const locale of ['en-US', 'zh-TW'] as const) {
      i18n.global.locale.value = locale
      const w = await mountModal()
      await w.get('[data-row="turn"][data-turn="1"]').trigger('click')
      expect(w.text()).not.toMatch(/turn-stats\.[a-z-]+/)
      w.unmount()
    }
  })
})
