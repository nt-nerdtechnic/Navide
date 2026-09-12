// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import { useWorkspaceAliases } from '../useWorkspaceAliases'
import type { RecentWorkspace } from '../useRecentWorkspaces'
import { createMockBackend, withScope } from './mockBackend'

const A = '/Users/me/Desktop/alpha'
const B = '/Users/me/Git/beta'

const entry = (path: string, name: string): RecentWorkspace => ({
  path,
  name,
  last_opened_at: '2026-01-01T00:00:00Z',
  pinned: false,
  last_known_state: '',
  last_known_task: '',
  exists: true,
})

function setup(recentList: RecentWorkspace[] = []) {
  const mock = createMockBackend('connected')
  const recent = ref<RecentWorkspace[]>(recentList)
  const { result, scope } = withScope(() => useWorkspaceAliases(mock.backend, recent))
  return { mock, recent, api: result, scope }
}

describe('useWorkspaceAliases', () => {
  it('falls back to the folder name when nothing names the workspace', () => {
    const { api, scope } = setup()
    expect(api.displayNameOf(A)).toBe('alpha')
    scope.stop()
  })

  it('reads the name the recent store already mirrors the alias into', () => {
    const { api, scope } = setup([entry(A, 'Payments API')])
    expect(api.displayNameOf(A)).toBe('Payments API')
    scope.stop()
  })

  // The mirror holds the folder basename for a workspace with no alias — that
  // is what the backend's touch() writes — and taking it as an alias made
  // "has the user named this" answer yes for every workspace ever opened: the
  // rename editor then opened pre-filled with the folder name, and typing the
  // folder name back in was a no-op instead of the write it is.
  it('does not count the mirrored basename of an unaliased workspace as an alias', () => {
    const { api, scope } = setup([entry(A, 'alpha')])
    expect(api.aliases.value[A]).toBeUndefined()
    // The row still says the folder name — through the fallback, not the map.
    expect(api.displayNameOf(A)).toBe('alpha')
    scope.stop()
  })

  it('still keeps a mirrored name that differs from the basename', () => {
    const { api, scope } = setup([entry(A, 'alpha'), entry(B, 'Ledger')])
    expect(api.aliases.value).toEqual({ [B]: 'Ledger' })
    scope.stop()
  })

  it('lets a peek override lead the recent store, which lags a broadcast', () => {
    const { api, scope } = setup([entry(A, 'Payments API')])
    api.adopt(A, 'Billing')
    expect(api.displayNameOf(A)).toBe('Billing')
    scope.stop()
  })

  // The regression this shape exists for: the recent store still holds the old
  // alias for a moment after it is cleared, and taking it at face value left
  // the dead name on screen.
  it('shows the folder name again the moment the alias is cleared', () => {
    const { api, scope } = setup([entry(A, 'Payments API')])
    api.adopt(A, '')
    expect(api.displayNameOf(A)).toBe('alpha')
    expect(api.aliases.value[A]).toBeUndefined()
    scope.stop()
  })

  it('adopts a peer window rename for a workspace that is not the one on screen', () => {
    const { mock, api, scope } = setup([entry(A, 'alpha'), entry(B, 'beta')])
    mock.emit('project.ui_state_changed', { workspace_path: B, display_name: 'Ledger' })
    expect(api.displayNameOf(B)).toBe('Ledger')
    expect(api.displayNameOf(A)).toBe('alpha')
    scope.stop()
  })

  it('ignores a ui_state_changed delta that carries no display_name', () => {
    const { mock, api, scope } = setup([entry(A, 'Payments API')])
    mock.emit('project.ui_state_changed', { workspace_path: A, run_groups: [] })
    expect(api.displayNameOf(A)).toBe('Payments API')
    scope.stop()
  })

  it('sends the trimmed name and adopts what the backend normalised it to', async () => {
    const { mock, api, scope } = setup()
    mock.setResponse('project.set_display_name', { ok: true, display_name: 'Payments API' })
    expect(await api.setDisplayName(A, '  Payments API  ')).toBe(true)
    expect(mock.sent.at(-1)).toMatchObject({
      type: 'project.set_display_name',
      payload: { workspace_path: A, display_name: 'Payments API' },
    })
    expect(api.displayNameOf(A)).toBe('Payments API')
    expect(api.error.value).toBe('')
    scope.stop()
  })

  it('sends an empty name to clear the alias, and restores the folder name', async () => {
    const { mock, api, scope } = setup([entry(A, 'Payments API')])
    mock.setResponse('project.set_display_name', { ok: true, display_name: '' })
    expect(await api.setDisplayName(A, '   ')).toBe(true)
    expect(mock.sent.at(-1)?.payload).toMatchObject({ display_name: '' })
    expect(api.displayNameOf(A)).toBe('alpha')
    scope.stop()
  })

  // The refusal arrives as an ORDINARY reply, not an error frame: a truthy
  // envelope with `ok: false` inside it. Trusting the envelope would report a
  // rename that never happened, and the old name on screen would be the only
  // hint.
  it('fails on an ok:false payload and surfaces the backend reason', async () => {
    const { mock, api, scope } = setup([entry(A, 'Payments API')])
    mock.setResponse('project.set_display_name', {
      ok: false,
      error: 'could not write the project document',
    })
    expect(await api.setDisplayName(A, 'Billing')).toBe(false)
    expect(api.error.value).toBe('could not write the project document')
    // Nothing adopted — the name on screen is still what is stored.
    expect(api.displayNameOf(A)).toBe('Payments API')
    scope.stop()
  })

  it('fails, with a reason, when the socket rejects the send', async () => {
    const { mock, api, scope } = setup()
    mock.setRejection('project.set_display_name', 'ws not open')
    expect(await api.setDisplayName(A, 'Billing')).toBe(false)
    expect(api.error.value).toBe('ws not open')
    scope.stop()
  })

  // The regression: `project.peek` is a READ and its reply can pre-date a
  // rename. The run-group prefetch and the onMounted restore loop both peek
  // every held workspace in sequence with no guard of their own, and
  // onWorkspaceCheck's seq guard only covers newer workspace checks — a rename
  // bumps nothing. A reply already in flight therefore landed after the rename
  // and put the folder name back, which is the "the rename did not take" this
  // whole feature exists to remove.
  //
  // The guard is a per-path write generation: the caller records
  // `generationOf(path)` before it sends the peek and hands it back with the
  // reply, and only a reply from the current generation is believed.
  describe('a stale peek cannot undo a write', () => {
    it('drops a peek issued before this window renamed the workspace', async () => {
      const { mock, api, scope } = setup([entry(A, 'alpha')])
      const gen = api.generationOf(A)
      mock.setResponse('project.set_display_name', { ok: true, display_name: 'Payments' })
      expect(await api.setDisplayName(A, 'Payments')).toBe(true)
      // The reply to that peek: no alias yet.
      api.adopt(A, '', 'peek', gen)
      expect(api.displayNameOf(A)).toBe('Payments')
      scope.stop()
    })

    it('drops a peek issued before a peer window renamed the workspace', () => {
      const { mock, api, scope } = setup([entry(A, 'alpha')])
      const gen = api.generationOf(A)
      mock.emit('project.ui_state_changed', { workspace_path: A, display_name: 'Ledger' })
      api.adopt(A, '', 'peek', gen)
      expect(api.displayNameOf(A)).toBe('Ledger')
      scope.stop()
    })

    it('drops a stale peek that carries the PREVIOUS alias, not just an empty one', async () => {
      const { mock, api, scope } = setup()
      const gen = api.generationOf(A)
      mock.setResponse('project.set_display_name', { ok: true, display_name: 'Payments' })
      await api.setDisplayName(A, 'Payments')
      api.adopt(A, 'Billing', 'peek', gen)
      expect(api.displayNameOf(A)).toBe('Payments')
      scope.stop()
    })

    // The other half of the guard, and why it is a generation rather than a
    // "written once" flag: the truth can change without a broadcast reaching
    // this window (two Navide builds on one navide.db, a rename during a
    // reconnect gap). A peek sent AFTER this window's write is newer than the
    // write, and what it brings back is the truth now — a flag pinned the old
    // name here until reload.
    it('accepts a peek issued after the write, even one that carries a different value', async () => {
      const { mock, api, scope } = setup([entry(A, 'alpha')])
      mock.setResponse('project.set_display_name', { ok: true, display_name: 'Payments' })
      expect(await api.setDisplayName(A, 'Payments')).toBe(true)
      const gen = api.generationOf(A)
      api.adopt(A, 'Ledger', 'peek', gen)
      expect(api.displayNameOf(A)).toBe('Ledger')
      // Including a clear made elsewhere.
      api.adopt(A, '', 'peek', api.generationOf(A))
      expect(api.displayNameOf(A)).toBe('alpha')
      scope.stop()
    })

    it('every write bumps the generation, so a peek from between two writes is stale too', async () => {
      const { mock, api, scope } = setup()
      mock.setResponse('project.set_display_name', { ok: true, display_name: 'Payments' })
      await api.setDisplayName(A, 'Payments')
      const between = api.generationOf(A)
      mock.emit('project.ui_state_changed', { workspace_path: A, display_name: 'Ledger' })
      expect(api.generationOf(A)).toBe(between + 1)
      api.adopt(A, 'Payments', 'peek', between)
      expect(api.displayNameOf(A)).toBe('Ledger')
      scope.stop()
    })

    it('only guards the path that was written', async () => {
      const { mock, api, scope } = setup()
      const genB = api.generationOf(B)
      mock.setResponse('project.set_display_name', { ok: true, display_name: 'Payments' })
      await api.setDisplayName(A, 'Payments')
      api.adopt(B, 'Ledger', 'peek', genB)
      expect(api.displayNameOf(B)).toBe('Ledger')
      scope.stop()
    })

    it('still lets a later write through — a write is never stale', async () => {
      const { mock, api, scope } = setup()
      mock.setResponse('project.set_display_name', { ok: true, display_name: 'Payments' })
      await api.setDisplayName(A, 'Payments')
      mock.emit('project.ui_state_changed', { workspace_path: A, display_name: 'Ledger' })
      expect(api.displayNameOf(A)).toBe('Ledger')
      // Including a clear.
      mock.emit('project.ui_state_changed', { workspace_path: A, display_name: '' })
      expect(api.displayNameOf(A)).toBe('alpha')
      scope.stop()
    })

    it('a failed rename leaves peek trusted — nothing was written', async () => {
      const { mock, api, scope } = setup([entry(A, 'alpha')])
      const gen = api.generationOf(A)
      mock.setResponse('project.set_display_name', { ok: false, error: 'disk' })
      expect(await api.setDisplayName(A, 'Payments')).toBe(false)
      expect(api.generationOf(A)).toBe(gen)
      api.adopt(A, 'Billing', 'peek', gen)
      expect(api.displayNameOf(A)).toBe('Billing')
      scope.stop()
    })

    // A caller that recorded no generation is taken to have read before any
    // write: trusted while nothing has been written for the path, dropped
    // once something has. So an unguarded caller can never outrank a write.
    it('a peek with no generation is trusted only until the first write', async () => {
      const { mock, api, scope } = setup()
      api.adopt(A, 'Billing')
      expect(api.displayNameOf(A)).toBe('Billing')
      mock.setResponse('project.set_display_name', { ok: true, display_name: 'Payments' })
      await api.setDisplayName(A, 'Payments')
      api.adopt(A, '')
      expect(api.displayNameOf(A)).toBe('Payments')
      scope.stop()
    })
  })

  it('matches an alias through a trailing slash on either side', () => {
    const { api, scope } = setup([entry(`${A}/`, 'Payments API')])
    expect(api.displayNameOf(A)).toBe('Payments API')
    expect(api.displayNameOf(`${A}/`)).toBe('Payments API')
    scope.stop()
  })
})
