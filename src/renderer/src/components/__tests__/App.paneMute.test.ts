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
    // Rebuild carries it to the replacement id and persists it there.
    expect(appSource).toContain('const wasMuted = isPaneMuted(paneId)')
    expect(appSource).toContain('if (wasMuted) {\n      setPaneMuted(newId, true)\n      persistPaneMuted(newId, true)\n    }')
  })
})
