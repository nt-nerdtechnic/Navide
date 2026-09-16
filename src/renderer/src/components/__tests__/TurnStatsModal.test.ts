// @vitest-environment happy-dom
// TurnStatsModal — the Settings-shaped shell and the pane list. The modal
// teleports to <body>, and VTU's teleport stub remounts the child component
// on every parent render (which would fake extra scans), so the real Teleport
// is kept and the DOM is read through `ui()` — a wrapper over document.body. The turns
// table itself is TurnStatsView's business (TurnStatsView.test.ts); here the
// assertions are on the shell (overlay, close, Esc), the list (grouping,
// placeholders, unsupported vendors, quota pills, limit pills) and the pick
// rule that decides which pane the view is handed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOMWrapper, mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import TurnStatsModal from '../TurnStatsModal.vue'
import type { TurnStatsPane } from '../TurnStatsView.vue'
import { __resetUsageForTest, initUsage } from '../../composables/useUsage'
import type { useCliProfiles } from '../../composables/useCliProfiles'

const wire = vi.hoisted(() => ({
  calls: [] as Array<{ type: string; payload?: Record<string, unknown> }>,
  handlers: {} as Record<string, Array<(raw: unknown) => void>>,
}))

function fakeBackend() {
  return {
    status: ref('connected'),
    wsUrl: ref(''),
    httpUrl: ref(''),
    shell: ref(''),
    port: ref(0),
    pid: ref(0),
    lastError: ref(''),
    send: vi.fn(async (type: string, sent?: Record<string, unknown>) => {
      wire.calls.push({ type, payload: sent })
      if (type === 'tokens.turns') {
        return {
          id: 'r', type, ok: true, error: null, timestamp: '',
          payload: {
            ok: true, pane_id: sent?.pane_id, session_id: 'abcdef0123456789', vendor: sent?.agent_key,
            file_path: '/x.jsonl', method: 'exact',
            turns: [{ turn_index: 1, started_at: '2026-09-16T00:54:02Z', ended_at: null, prompt_excerpt: 'hi', input: 1, cache_read: 2, cache_creation: 3, output: 4, total: 10, calls: 1, calls_detail: [] }],
            totals: { input: 1, cache_read: 2, cache_creation: 3, output: 4, total: 10, calls: 1 },
            scanned_at: '2026-09-16T01:02:00Z',
          },
        }
      }
      return { id: 'r', type, ok: true, payload: { ok: true }, error: null, timestamp: '' }
    }),
    on: vi.fn((ev: string, cb: (raw: unknown) => void) => {
      ;(wire.handlers[ev] ??= []).push(cb)
      return () => {}
    }),
    restart: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  } as unknown as never
}

function emitUsage(providers: Record<string, unknown>, accounts: Record<string, Record<string, unknown>> = {}): void {
  for (const h of wire.handlers['usage.changed'] ?? []) h({ providers, accounts })
}

/** The slice of useCliProfiles the modal reads, as a plain object. */
type FakeCliProfiles = {
  identityFor: (agent: string, profileId: string | null) => { email: string | null; signedIn: boolean } | null
  findProfile: (id: string | null | undefined) => { id: string; agentKey: string; name: string; createdAt: string } | undefined
  defaultProfileId: (agent: string) => string | null
  profilesForAgent: (agent: string) => { id: string; agentKey: string; name: string; createdAt: string }[]
}
function fakeProfiles(opts: {
  profiles?: { id: string; agentKey: string; name: string }[]
  emails?: Record<string, string>
  active?: Record<string, string | null>
} = {}): FakeCliProfiles {
  const profiles = (opts.profiles ?? []).map((p) => ({ ...p, createdAt: '' }))
  return {
    identityFor: (_agent, profileId) => {
      const slot = profileId ?? '__default__'
      return opts.emails && slot in opts.emails ? { email: opts.emails[slot], signedIn: true } : null
    },
    findProfile: (id) => profiles.find((p) => p.id === id),
    defaultProfileId: (agent) => opts.active?.[agent] ?? null,
    profilesForAgent: (agent) => profiles.filter((p) => p.agentKey === agent),
  }
}

const PANES: TurnStatsPane[] = [
  { id: 'p1', agentKey: 'claude', agentLabel: 'Scan the code', status: 'idle', sessionId: 'sess-1', workspacePath: '/Users/x/Agent-Team' },
  { id: 'p2', agentKey: 'codex', agentLabel: 'Deploy notes', status: 'running', workspacePath: '/Users/x/navide-web/' },
  { id: 'p3', agentKey: 'cursor', agentLabel: 'Cursor', status: 'idle', workspacePath: '/Users/x/Agent-Team' },
  { id: 'p4', agentKey: 'claude', agentLabel: 'Old review', status: 'waiting', sessionId: 'sess-4', workspacePath: '/Users/x/Agent-Team' },
  { id: 'p5', agentKey: 'claude', agentLabel: 'Never started', status: 'waiting', workspacePath: '/Users/x/Agent-Team' },
  { id: 't1', agentKey: 'terminal', agentLabel: 'Terminal', status: 'idle', workspacePath: '/Users/x/Agent-Team' },
]

beforeEach(() => {
  wire.calls = []
  wire.handlers = {}
  __resetUsageForTest()
  i18n.global.locale.value = 'en-US'
})
const mounted: VueWrapper[] = []
afterEach(() => {
  mounted.splice(0).forEach((w) => w.unmount())
  __resetUsageForTest()
  document.body.innerHTML = ''
})

type Modal = VueWrapper & { ui: DOMWrapper<HTMLElement> }
async function mountModal(
  opts: { open?: boolean; panes?: TurnStatsPane[]; activePaneId?: string | null; cliProfiles?: FakeCliProfiles } = {}
): Promise<Modal> {
  // One modal at a time in <body>: the previous test's is gone (afterEach).
  const backend = fakeBackend()
  initUsage(backend)
  const w = mount(TurnStatsModal, {
    props: {
      open: opts.open ?? true,
      backend,
      panes: opts.panes ?? PANES,
      activePaneId: opts.activePaneId === undefined ? 'p1' : opts.activePaneId,
      cliProfiles: opts.cliProfiles as unknown as ReturnType<typeof useCliProfiles> | undefined,
    },
    global: { plugins: [i18n] },
  }) as unknown as Modal
  w.ui = new DOMWrapper(document.body)
  mounted.push(w)
  await flushPromises()
  return w
}

function turnsCalls() {
  return wire.calls.filter((c) => c.type === 'tokens.turns')
}
function selectedId(w: Modal): string | undefined {
  const active = w.ui.find('[data-act="pane"].active')
  return active.exists() ? active.attributes('data-pane-id') : undefined
}

describe('TurnStatsModal shell', () => {
  it('is the Settings shell: its own positioned overlay, a sidebar/content grid, and a close button', async () => {
    const w = await mountModal()
    expect(w.ui.find('.s-overlay.nv-modal-overlay').exists()).toBe(true)
    expect(w.ui.find('.s-modal.nv-modal-shell.nv-modal-shell--wide').exists()).toBe(true)
    expect(w.ui.find('.s-sidebar').exists()).toBe(true)
    expect(w.ui.find('.s-content .s-body').exists()).toBe(true)
    const fs = await import('node:fs')
    const source = fs.readFileSync('src/renderer/src/components/TurnStatsModal.vue', 'utf8')
    const overlay = source.slice(source.indexOf('.s-overlay {'), source.indexOf('.s-modal {'))
    expect(overlay).toContain('position: fixed')
    expect(overlay).toContain('inset: 0')
    expect(overlay).toMatch(/z-index:\s*\S/)
    const modal = source.slice(source.indexOf('.s-modal {'), source.indexOf('.s-sidebar {'))
    expect(modal).toContain('grid-template-columns: 232px')
  })

  it('closes on ✕, on the scrim, and on Escape — but not on Escape while closed', async () => {
    const w = await mountModal()
    await w.ui.get('[data-act="close"]').trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
    await w.ui.get('.s-overlay').trigger('click')
    expect(w.emitted('close')).toHaveLength(2)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(w.emitted('close')).toHaveLength(3)
    await w.setProps({ open: false })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(w.emitted('close')).toHaveLength(3)
  })

  it('does not scan while closed, and scans the focused pane once opened', async () => {
    const w = await mountModal({ open: false })
    expect(turnsCalls()).toHaveLength(0)
    await w.setProps({ open: true })
    await flushPromises()
    expect(turnsCalls()).toHaveLength(1)
    expect(turnsCalls()[0].payload).toMatchObject({ pane_id: 'p1', session_id: 'sess-1', agent_key: 'claude' })
  })

  it('reopening on the same pane rescans it — once, not once per watcher', async () => {
    const w = await mountModal()
    expect(turnsCalls()).toHaveLength(1)
    await w.setProps({ open: false })
    await flushPromises()
    await w.setProps({ open: true })
    await flushPromises()
    expect(turnsCalls()).toHaveLength(2)
    expect(turnsCalls()[1].payload).toMatchObject({ pane_id: 'p1' })
  })

  it('a session id that changes while closed starts no scan behind the modal', async () => {
    const w = await mountModal()
    expect(turnsCalls()).toHaveLength(1)
    await w.setProps({ open: false })
    await flushPromises()
    await w.setProps({ panes: PANES.map((p) => (p.id === 'p1' ? { ...p, sessionId: 'sess-1-new' } : p)) })
    await flushPromises()
    expect(turnsCalls()).toHaveLength(1)
  })
})

describe('TurnStatsModal pane list', () => {
  it('groups CLI panes by workspace folder, skips terminals, marks placeholders and greys out vendors without token usage', async () => {
    const w = await mountModal()
    const groups = w.ui.findAll('[data-part="group"]')
    expect(groups.map((g) => g.attributes('data-workspace'))).toEqual(['Agent-Team', 'navide-web'])
    expect(groups[0].findAll('[data-act="pane"]').map((b) => b.attributes('data-pane-id'))).toEqual(['p1', 'p3', 'p4', 'p5'])
    expect(groups[1].findAll('[data-act="pane"]').map((b) => b.attributes('data-pane-id'))).toEqual(['p2'])
    const cursor = w.ui.get('[data-act="pane"][data-pane-id="p3"]')
    expect(cursor.classes()).toContain('unsupported')
    expect(cursor.attributes('title')).toBe(i18n.global.t('turn-stats.no-token-usage'))
    const placeholder = w.ui.get('[data-act="pane"][data-pane-id="p4"]')
    expect(placeholder.classes()).toContain('placeholder')
    expect(placeholder.text()).toContain(i18n.global.t('turn-stats.pane-placeholder'))
    expect(placeholder.text()).toContain('Claude Code')
  })

  it('shows the empty state in the sidebar and the body when there is no CLI pane', async () => {
    const w = await mountModal({ panes: [PANES[5]], activePaneId: null })
    expect(w.ui.get('.s-sidebar [data-state="no-panes"]').text()).toBe(i18n.global.t('turn-stats.empty-panes'))
    expect(w.ui.find('.s-body [data-state="no-panes"]').exists()).toBe(true)
    expect(turnsCalls()).toHaveLength(0)
  })

  it('picking a pane hands it to the view, which scans it', async () => {
    const w = await mountModal()
    await w.ui.get('[data-act="pane"][data-pane-id="p2"]').trigger('click')
    await flushPromises()
    expect(selectedId(w)).toBe('p2')
    expect(turnsCalls()).toHaveLength(2)
    expect(turnsCalls()[1].payload).toMatchObject({ pane_id: 'p2', agent_key: 'codex' })
    expect(w.ui.get('[data-part="pane-name"]').text()).toBe('Deploy notes')
  })

  it('a placeholder with a saved session is scanned by that session id', async () => {
    const w = await mountModal()
    await w.ui.get('[data-act="pane"][data-pane-id="p4"]').trigger('click')
    await flushPromises()
    expect(turnsCalls()[1].payload).toMatchObject({ pane_id: 'p4', session_id: 'sess-4', agent_key: 'claude' })
    expect(w.ui.find('[data-row="turn"]').exists()).toBe(true)
  })

  it('a never-started placeholder is pickable and explains itself without a scan', async () => {
    const w = await mountModal()
    await w.ui.get('[data-act="pane"][data-pane-id="p5"]').trigger('click')
    await flushPromises()
    expect(turnsCalls()).toHaveLength(1)
    expect(w.ui.get('[data-state="never-started"]').text()).toBe(i18n.global.t('turn-stats.error-never-started'))
  })

  it('keeps the pick across a list rebuild and falls back when the picked pane is gone', async () => {
    const w = await mountModal()
    await w.ui.get('[data-act="pane"][data-pane-id="p2"]').trigger('click')
    await flushPromises()
    await w.setProps({ panes: PANES.map((p) => ({ ...p })) })
    await flushPromises()
    expect(selectedId(w)).toBe('p2')
    expect(turnsCalls()).toHaveLength(2)
    await w.setProps({ panes: PANES.filter((p) => p.id !== 'p2') })
    await flushPromises()
    expect(selectedId(w)).toBe('p1')
    expect(turnsCalls()).toHaveLength(3)
  })
})

describe('TurnStatsModal pick rule', () => {
  it('prefers the focused pane', async () => {
    const w = await mountModal({ activePaneId: 'p4' })
    expect(selectedId(w)).toBe('p4')
  })

  it('falls back to the first running supported pane when the focused one cannot be read', async () => {
    // p3 (cursor) has no token usage; p5 was never started.
    const a = await mountModal({ activePaneId: 'p3' })
    expect(selectedId(a)).toBe('p1')
    a.unmount()
    const b = await mountModal({ activePaneId: 'p5' })
    expect(selectedId(b)).toBe('p1')
  })

  it('then to the first placeholder with a session, and to nothing when there is none', async () => {
    const w = await mountModal({ panes: [PANES[2], PANES[4], PANES[3]], activePaneId: null })
    expect(selectedId(w)).toBe('p4')
    w.unmount()
    const none = await mountModal({ panes: [PANES[2], PANES[4]], activePaneId: null })
    expect(selectedId(none)).toBeUndefined()
    expect(none.ui.find('.s-body [data-state="no-panes"]').exists()).toBe(true)
  })
})

describe('TurnStatsModal quota pills', () => {
  it('shows the usage badge figure per row — remaining % in its tier, or a solid "spent"', async () => {
    const w = await mountModal()
    expect(w.ui.find('[data-part="quota-pill"]').exists()).toBe(false)
    emitUsage({
      claude: { provider: 'claude', status: 'ok', planType: null, fetchedAt: '', error: null,
        windows: [{ kind: 'session', label: 'Session', usedPercent: 70, resetsAt: '2026-09-16T05:00:00Z' }] },
      codex: { provider: 'codex', status: 'ok', planType: null, fetchedAt: '', error: null,
        windows: [{ kind: 'weekly', label: 'Week', usedPercent: 100, resetsAt: '2026-09-20T00:00:00Z' }] },
    })
    await flushPromises()
    const claude = w.ui.get('[data-act="pane"][data-pane-id="p1"] [data-part="quota-pill"]')
    expect(claude.text()).toBe('30%')
    expect(claude.classes()).toContain('warn')
    const codex = w.ui.get('[data-act="pane"][data-pane-id="p2"] [data-part="quota-pill"]')
    expect(codex.text()).toBe(i18n.global.t('usage.exhausted-short'))
    expect(codex.classes()).toContain('exhausted')
    // Every Claude pane shares the agent's figure: it is per agent, not per pane.
    expect(w.ui.get('[data-act="pane"][data-pane-id="p4"] [data-part="quota-pill"]').text()).toBe('30%')
    // The view on the right gets the same snapshot.
    expect(w.ui.get('[data-part="quota-window"]').text()).toContain('70%')
  })

  it('shows "back HH:MM" on a pane whose own limit hit has not lifted, and nothing once it has', async () => {
    const until = Date.now() + 60 * 60 * 1000
    const hit = { ...PANES[0], usageLimitAt: Date.now() - 1000, usageLimitUntil: until, usageLimitSeenAt: Date.now() - 1000 }
    const lifted = { ...PANES[3], usageLimitAt: null, usageLimitUntil: Date.now() - 60_000, usageLimitSeenAt: Date.now() - 120_000 }
    const w = await mountModal({ panes: [hit, lifted] })
    const pill = w.ui.get('[data-act="pane"][data-pane-id="p1"] [data-part="limit-pill"]')
    const d = new Date(until)
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    expect(pill.text()).toBe(i18n.global.t('turn-stats.limit-back', { time: hhmm }))
    expect(w.ui.find('[data-act="pane"][data-pane-id="p4"] [data-part="limit-pill"]').exists()).toBe(false)
  })

  it('never leaks a raw i18n key in either locale', async () => {
    for (const locale of ['en-US', 'zh-TW'] as const) {
      i18n.global.locale.value = locale
      const w = await mountModal()
      expect(w.ui.text()).not.toMatch(/turn-stats\.[a-z-]+/)
      w.unmount()
    }
  })
})

// ── Accounts ────────────────────────────────────────────────────────────────
const PINNED: TurnStatsPane[] = [
  { ...PANES[0], profileId: 'slot-a' },
  { ...PANES[1], profileId: '__default__' },
  { ...PANES[3], profileId: 'gone' },
  PANES[4],
]
const CLAUDE_SNAP = (used: number, over: Record<string, unknown> = {}) => ({
  provider: 'claude', status: 'ok', planType: null, fetchedAt: '2026-09-16T01:05:00Z', error: null,
  windows: [{ kind: 'session', label: 'Session', usedPercent: used, resetsAt: '2026-09-16T05:00:00Z' }],
  ...over,
})

describe('TurnStatsModal accounts', () => {
  const profiles = () =>
    fakeProfiles({
      profiles: [{ id: 'slot-a', agentKey: 'claude', name: 'Services' }],
      emails: { 'slot-a': 'services@x.dev', __default__: 'me@x.dev' },
      active: { claude: null, codex: null },
    })

  it('each pane row reads its own account\'s snapshot, names the account on its second line, and fades a stale reading', async () => {
    const w = await mountModal({ panes: PINNED, cliProfiles: profiles() })
    emitUsage(
      { claude: CLAUDE_SNAP(70), codex: { provider: 'codex', status: 'ok', planType: null, fetchedAt: '', error: null, windows: [{ kind: 'weekly', label: 'Week', usedPercent: 20, resetsAt: null }] } },
      { claude: { __default__: CLAUDE_SNAP(70), 'slot-a': CLAUDE_SNAP(90, { stale: true, fetchedAt: '2026-09-16T00:40:00Z' }) } },
    )
    await flushPromises()
    const p1 = w.ui.get('[data-act="pane"][data-pane-id="p1"]')
    expect(p1.get('[data-part="pane-sub"]').text()).toBe('Claude Code · services@x.dev')
    const pill = p1.get('[data-part="quota-pill"]')
    expect(pill.text()).toBe('10%')
    expect(pill.classes()).toContain('crit')
    expect(pill.attributes('data-stale')).toBe('true')
    const staleAt = new Date('2026-09-16T00:40:00Z')
    expect(pill.attributes('title')).toContain(`${String(staleAt.getHours()).padStart(2, '0')}:${String(staleAt.getMinutes()).padStart(2, '0')}`)
    // A pane on the built-in Default reads that slot; nothing stale about it.
    const p2 = w.ui.get('[data-act="pane"][data-pane-id="p2"]')
    expect(p2.get('[data-part="pane-sub"]').text()).toBe('Codex · me@x.dev')
    expect(p2.get('[data-part="quota-pill"]').attributes('data-stale')).toBe('false')
    // A pin to a removed profile has no slot to read: no pill, id shown as removed.
    const p4 = w.ui.get('[data-act="pane"][data-pane-id="p4"]')
    expect(p4.get('[data-part="pane-sub"]').text()).toContain(i18n.global.t('account-dim.removed'))
    expect(p4.find('[data-part="quota-pill"]').exists()).toBe(false)
    // A pane without a pin (before pinning existed) reads the agent figure and names no account.
    const p5 = w.ui.get('[data-act="pane"][data-pane-id="p5"]')
    expect(p5.get('[data-part="pane-sub"]').text()).toContain('Claude Code')
    expect(p5.get('[data-part="pane-sub"]').text()).not.toContain('·  ')
    expect(p5.get('[data-part="quota-pill"]').text()).toBe('30%')
  })

  it('the active account without a per-slot snapshot falls back to the agent figure', async () => {
    const w = await mountModal({ panes: [{ ...PANES[0], profileId: '__default__' }], cliProfiles: profiles() })
    emitUsage({ claude: CLAUDE_SNAP(70) }, {})
    await flushPromises()
    expect(w.ui.get('[data-act="pane"][data-pane-id="p1"] [data-part="quota-pill"]').text()).toBe('30%')
  })

  it('lists an Accounts section: Default, each profile, a removed pin and unknown per vendor, with quota pills', async () => {
    const w = await mountModal({ panes: PINNED, cliProfiles: profiles() })
    emitUsage({ claude: CLAUDE_SNAP(70) }, { claude: { __default__: CLAUDE_SNAP(70), 'slot-a': CLAUDE_SNAP(90) } })
    await flushPromises()
    const rows = w.ui.findAll('[data-act="account"]')
    expect(rows.map((r) => r.attributes('data-account-key'))).toEqual([
      'claude/__default__', 'claude/slot-a', 'claude/gone', 'claude/unknown',
      'codex/__default__', 'codex/unknown',
    ])
    expect(rows[0].text()).toContain('me@x.dev')
    expect(rows[0].text()).toContain(i18n.global.t('account-dim.active'))
    expect(rows[0].get('[data-part="account-quota-pill"]').text()).toBe('30%')
    expect(rows[1].text()).toContain('services@x.dev')
    expect(rows[1].get('[data-part="account-quota-pill"]').text()).toBe('10%')
    expect(rows[2].text()).toContain(i18n.global.t('account-dim.removed'))
    expect(rows[3].text()).toContain(i18n.global.t('account-dim.unknown'))
    expect(rows[3].classes()).toContain('unknown')
    expect(rows[3].find('[data-part="account-quota-pill"]').exists()).toBe(false)
  })

  it('picking an account swaps the right side for its quota cycles and deselects the pane; picking a pane swaps back', async () => {
    const w = await mountModal({ panes: PINNED, cliProfiles: profiles() })
    expect(w.ui.find('[data-part="quota-cycles"]').exists()).toBe(false)
    await w.ui.get('[data-act="account"][data-account-key="claude/slot-a"]').trigger('click')
    await flushPromises()
    const view = w.ui.get('[data-part="quota-cycles"]')
    expect(view.get('[data-part="account-name"]').text()).toBe('services@x.dev')
    expect(view.get('[data-part="vendor"]').text()).toContain('Claude Code')
    expect(w.ui.get('[data-act="account"][data-account-key="claude/slot-a"]').classes()).toContain('active')
    expect(w.ui.find('[data-act="pane"].active').exists()).toBe(false)
    expect(wire.calls.filter((c) => c.type === 'tokens.quota_cycles')).toHaveLength(1)
    expect(wire.calls.find((c) => c.type === 'tokens.quota_cycles')?.payload).toMatchObject({ agent_key: 'claude', profile_id: 'slot-a' })

    await w.ui.get('[data-act="pane"][data-pane-id="p1"]').trigger('click')
    await flushPromises()
    expect(w.ui.find('[data-part="quota-cycles"]').exists()).toBe(false)
    expect(w.ui.find('[data-state="table"]').exists()).toBe(true)
    expect(selectedId(w)).toBe('p1')
  })

  it('reopening forgets the account pick and returns to the pane', async () => {
    const w = await mountModal({ panes: PINNED, cliProfiles: profiles() })
    await w.ui.get('[data-act="account"][data-account-key="claude/unknown"]').trigger('click')
    await flushPromises()
    expect(w.ui.find('[data-part="quota-cycles"] [data-state="unknown"]').exists()).toBe(true)
    await w.setProps({ open: false })
    await w.setProps({ open: true })
    await flushPromises()
    expect(w.ui.find('[data-part="quota-cycles"]').exists()).toBe(false)
    expect(selectedId(w)).toBe('p1')
  })

  it('never leaks a raw i18n key with accounts, in either locale', async () => {
    for (const locale of ['en-US', 'zh-TW'] as const) {
      i18n.global.locale.value = locale
      const w = await mountModal({ panes: PINNED, cliProfiles: profiles() })
      await w.ui.get('[data-act="account"][data-account-key="claude/slot-a"]').trigger('click')
      await flushPromises()
      expect(w.ui.text()).not.toMatch(/(turn-stats|account-dim|quota-cycles)\.[a-z-]+/)
      w.unmount()
    }
  })
})
