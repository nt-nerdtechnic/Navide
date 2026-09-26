import { describe, expect, it, vi } from 'vitest'
import { preparePaneClose, releasePaneClose, type PaneCloseGuard } from '../components/multiRepoClose'

function pane(state: 'accepted' | 'busy' | 'draft'): PaneCloseGuard & { prepared: boolean[] } {
  const prepared: boolean[] = []
  return {
    prepared,
    getCloseState: () => ({ state }),
    setClosePrepared: (value: boolean) => { prepared.push(value) },
  }
}

describe('preparePaneClose', () => {
  it('freezes every pane only after drafts are confirmed', async () => {
    const draft = pane('draft')
    const clean = pane('accepted')
    const confirmDiscard = vi.fn(async () => true)

    await expect(preparePaneClose([draft, clean], confirmDiscard)).resolves.toEqual({ accepted: true })
    expect(confirmDiscard).toHaveBeenCalledOnce()
    expect(draft.prepared).toEqual([true])
    expect(clean.prepared).toEqual([true])

    releasePaneClose([draft, clean])
    expect(draft.prepared).toEqual([true, false])
    expect(clean.prepared).toEqual([true, false])
  })

  it('refuses drafts without freezing when the confirmation is declined', async () => {
    const draft = pane('draft')
    await expect(preparePaneClose([draft], async () => false)).resolves.toEqual({ accepted: false, reason: 'refused' })
    expect(draft.prepared).toEqual([])
  })

  it('fails closed for busy or unclassifiable panes', async () => {
    const busy = pane('busy')
    const silent: PaneCloseGuard = {}
    await expect(preparePaneClose([busy], async () => true)).resolves.toEqual({ accepted: false, reason: 'busy' })
    await expect(preparePaneClose([silent], async () => true)).resolves.toEqual({ accepted: false, reason: 'busy' })
    expect(busy.prepared).toEqual([])
  })

  it('rechecks busy after the confirmation and never partially freezes', async () => {
    let state: 'accepted' | 'busy' | 'draft' = 'draft'
    const prepared: boolean[] = []
    const changing: PaneCloseGuard = {
      getCloseState: () => ({ state }),
      setClosePrepared: (value: boolean) => { prepared.push(value) },
    }
    await expect(preparePaneClose([changing], async () => {
      state = 'busy'
      return true
    })).resolves.toEqual({ accepted: false, reason: 'busy' })
    expect(prepared).toEqual([])
  })
})
