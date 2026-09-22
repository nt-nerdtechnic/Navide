import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// App.vue is too large to mount, so — as App.paneReachability.test.ts does —
// these pin the wiring of the per-pane mute by reading the source: the two
// sound calls are gated, the flag rides along in the persisted record, and
// every place the minimized flag is restored or carried across a rebuild does
// the same for mute. Dropping any one of them is silent at runtime (a pane
// just chimes again after a restart), which is why they are asserted here.

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

/** A function's text, from its declaration to the closing brace in column 0. */
function fn(name: string): string {
  const at = appSource.indexOf(`function ${name}(`)
  if (at < 0) throw new Error(`${name} not found`)
  return appSource.slice(at, appSource.indexOf('\n}', at) + 2)
}

function count(needle: string): number {
  return appSource.split(needle).length - 1
}

describe('per-pane mute wiring in App.vue', () => {
  it('both sounds are gated on the pane not being muted', () => {
    expect(fn('scheduleDoneNotify')).toContain('if (!isPaneMuted(paneId)) playDoneSound()')
    expect(fn('notifyAttention')).toContain('if (!isPaneMuted(paneId)) playAttentionSound()')
    // No ungated call anywhere else.
    expect(count('playDoneSound()')).toBe(1)
    expect(count('playAttentionSound()')).toBe(1)
  })

  it('the flag is written into the persisted pane record', () => {
    expect(fn('projectPaneFromActive')).toContain('is_muted: isPaneMuted(pane.id)')
  })

  it('toggling persists through the same channel shape as minimized', () => {
    expect(fn('persistPaneMuted')).toContain("backend.send('project.set_pane_muted'")
    expect(fn('togglePaneMuted')).toContain('persistPaneMuted(id, next)')
  })

  it('restore re-applies the flag wherever is_minimized is re-applied', () => {
    // Cold-restore placeholder (saved.pane_id) and realize (new paneId).
    expect(count('if (saved.is_muted) setPaneMuted(saved.pane_id, true)')).toBe(1)
    expect(count('if (saved.is_muted) setPaneMuted(paneId, true)')).toBe(1)
    // Realize of a placeholder carries it to the replacement id and persists it.
    expect(appSource).toContain('const wasMuted = isPaneMuted(paneId)')
    expect(appSource).toContain('if (wasMuted) {\n      setPaneMuted(newId, true)\n      persistPaneMuted(newId, true)\n    }')
  })

  it('a user-initiated rebuild (resume or clean) carries the mute to the replacement id', () => {
    // Both paths onKill(keepInList) the old pane first, so the flag has to be
    // snapshotted before and re-applied to newId after.
    for (const name of ['rebuildPaneViaResume', 'rebuildPaneClean']) {
      const src = fn(name)
      expect(src, name).toContain('muted: isPaneMuted(paneId)')
      expect(src, name).toContain('if (snap.muted) setPaneMuted(newId, true)')
      // The DISK write must come after the spawn that re-keys the record to
      // newId: set_pane_muted is a silent no-op for an id the store cannot
      // find, so persisting before the spawn looks fine and writes nothing.
      const persistAt = src.indexOf('persistPaneMuted(newId, true)')
      const spawnAt = src.lastIndexOf("sendQuiet<ProjectPayload>('pipeline.slot_spawn'")
      expect(persistAt, name).toBeGreaterThan(0)
      expect(spawnAt, name).toBeGreaterThan(0)
      expect(persistAt, name).toBeGreaterThan(spawnAt)
      // A failed replacement drops the pane; its mute must not outlive it.
      expect(src, name).toContain("panes.value = panes.value.filter((p) => p.id !== paneId)\n      setPaneMuted(paneId, false)")
    }
  })

  it('onKill never touches the persisted flag; only the slot-reuse caller clears it', () => {
    // A workspace closed and reopened (onKillAll leaves its records 'spawned')
    // must come back muted, like is_minimized does — so onKill stays off the
    // disk. The exception is activateStage dropping cold placeholders whose
    // slot record the fresh pane will reuse: cleared there, before onKill.
    expect(fn('onKill')).not.toContain('project.set_pane_muted')
    expect(fn('onKill')).not.toContain('persistPaneMuted')
    const activate = fn('activateStage')
    const clearAt = activate.indexOf('for (const paneId of unrealizedPaneIds) persistPaneMuted(paneId, false)')
    const killAt = activate.indexOf("unrealizedPaneIds.map((paneId) => onKill(paneId, { markRemoved: false }))")
    expect(clearAt).toBeGreaterThan(0)
    expect(killAt).toBeGreaterThan(clearAt)
  })

  it('detaching a group to another window drops its local notify state', () => {
    const src = fn('handleGroupDetached')
    expect(src).toContain('sysNotify.forgetPane(p.id)')
    expect(src).toContain('setPaneMuted(p.id, false)')
  })

  it('onKill keeps the mute for keepInList (rebuild / idle reclaim) and clears it on a real close', () => {
    expect(fn('onKill')).toContain('if (!keepInList) setPaneMuted(paneId, false)')
  })
})
