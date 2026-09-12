// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import DevTimePanel from '../DevTimePanel.vue'
import { registerCommand } from '@navide/plugin-ui/shared'
import type { DevTimeSnapshot } from '../../composables/useDevTime'

function snapshot(): DevTimeSnapshot {
  const t = (m: number, h: number, a: number, o: number) => ({ merged_s: m, human_s: h, agent_s: a, overlap_s: o })
  return {
    workspace_path: '/ws',
    gap_human_s: 300,
    gap_agent_s: 900,
    active: true,
    active_sources: ['agent'],
    totals: { today: t(9300, 3600, 7200, 1500), last7d: t(36000, 0, 0, 0), last30d: t(0, 0, 0, 0), all: t(90061, 0, 0, 0) },
    by_day: ['06', '07', '08', '09', '10', '11', '12'].map((d) => ({ date: `2026-09-${d}`, merged_s: d === '12' ? 9300 : 60, human_s: 0, agent_s: 0 })),
    by_pane: [{ pane_id: 'p1', today_s: 9300, all_s: 90061, active: true }],
  }
}

function mountPanel() {
  const backend = {
    status: ref('connected'),
    send: vi.fn(async () => ({ ok: true, payload: snapshot() })),
    on: () => () => {},
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = mount(DevTimePanel as any, {
    props: {
      backend,
      workspacePath: '/ws',
      panes: [
        { id: 'p1', agentKey: 'claude', agentLabel: 'API work', roleLabel: 'backend' },
        { id: 'p2', agentKey: 'codex', agentLabel: 'Docs', roleLabel: 'writer' },
      ],
    },
    global: { mocks: { $t: (key: string) => key } },
  })
  return { w, backend }
}

describe('DevTimePanel', () => {
  it('renders the three totals in h/m and the per-pane rows joined by id', async () => {
    const { w } = mountPanel()
    await new Promise((r) => setTimeout(r, 0))
    await w.vm.$nextTick()

    const bigs = w.findAll('.totals .big').map((n) => n.text())
    expect(bigs).toEqual(['2h 35m', '10h 0m', '25h 1m'])

    const rows = w.findAll('tr.pane-row')
    expect(rows).toHaveLength(2)
    // Sorted by all-time desc: the pane with data first, the one without at zero.
    expect(rows[0].text()).toContain('API work')
    expect(rows[0].text()).toContain('2h 35m')
    expect(rows[0].find('.dot').classes()).toContain('on')
    expect(rows[1].text()).toContain('Docs')
    expect(rows[1].text()).toContain('0m')
    expect(rows[1].find('.dot').classes()).not.toContain('on')
    expect(w.find('.hint').text()).toBe('devtime.idle-hint')
    w.unmount()
  })

  it('clicking a pane row asks App to focus it through ui.pane.focus', async () => {
    const focus = vi.fn()
    registerCommand('ui.pane.focus', focus)
    const { w } = mountPanel()
    await new Promise((r) => setTimeout(r, 0))
    await w.vm.$nextTick()

    await w.findAll('tr.pane-row')[1].trigger('click')
    expect(focus).toHaveBeenCalledWith({ paneId: 'p2' })
    w.unmount()
  })
})
