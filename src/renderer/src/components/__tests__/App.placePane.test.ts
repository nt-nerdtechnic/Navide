// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// ui.pane.place — the action behind cli_place_pane: move a pane between tab
// groups and/or re-parent it. App.vue cannot be mounted by this suite, so the
// wiring is asserted against the source: that the action reuses the SAME write
// paths the sidebar's drag uses (so record and screen agree), that '' is a
// value and not "unset", and that a refused parent cannot leave the tree
// showing something the record does not hold.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function fn(name: string): string {
  const start = appSource.indexOf(`function ${name}(`)
  expect(start, `function ${name} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n}\n', start)
  expect(end).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

function action(id: string): string {
  const start = appSource.indexOf(`registerCommand('${id}'`)
  expect(start, `${id} should be registered`).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n})\n', start)
  expect(end).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

describe('ui.pane.place — the action behind cli_place_pane', () => {
  it('is registered and refuses a call that changes nothing', () => {
    const body = action('ui.pane.place')
    expect(body).toContain('a.runGroupId === undefined && a.spawnedBy === undefined')
    expect(body).toContain('nothing to change')
  })

  it('moves ONE pane, never the sidebar multi-selection it may be part of', () => {
    // movePaneToGroup moves paneDragBatch(paneId) — the whole selection when
    // the pane is in one. An MCP caller named one pane and cannot see a UI
    // selection; using the drag path would silently widen the move while the
    // answer described a single pane. So the action writes the one pane
    // itself, with the drag path's persist-and-roll-back.
    const body = action('ui.pane.place')
    expect(body).not.toContain('movePaneToGroup(')
    expect(body).not.toContain('paneDragBatch(')
    expect(body).toContain('await persistPaneRunGroup(pane, targetGroupId)')
    expect(body).toContain('pane.runGroupId = previous')
  })

  it("validates the group against the PANE's workspace, not the viewed one", () => {
    // runGroups is the viewed workspace's list. A pane held in a non-viewed
    // workspace of the same window has its own tabs: checking against the
    // viewed list refuses its valid ids and accepts foreign ones — the exact
    // cross-workspace write _saveRunGroups guards against.
    const body = action('ui.pane.place')
    expect(body).toContain('runGroupsOf(pane.workspacePath)')
    expect(body).not.toMatch(/runGroups\.value\.some/)
    expect(body).toContain('unknown run group')
    const helper = fn('runGroupsOf')
    expect(helper).toContain('runGroupsByWorkspace.value[key]')
  })

  it('verifies the group move actually persisted before reporting it', () => {
    // movePaneToGroup rolls back silently when the write fails; the caller
    // must not be told "moved" in that case.
    const body = action('ui.pane.place')
    expect(body).toContain('the group move did not persist')
  })

  it('re-parents through reparentPane, which persists before mutating', () => {
    const body = action('ui.pane.place')
    expect(body).toContain('await reparentPane(a.paneId, a.spawnedBy)')
    const rp = fn('reparentPane')
    // Persist first; the in-memory pointer moves only once the record holds it.
    const persistAt = rp.indexOf("backend.send('pane.set_parent'")
    const mutateAt = rp.indexOf('pane.spawnedBy = spawnedBy || undefined')
    expect(persistAt).toBeGreaterThan(-1)
    expect(mutateAt).toBeGreaterThan(persistAt)
    // A refusal is thrown with the backend's reason, not swallowed.
    expect(rp).toContain("throw new Error(String(resp?.error?.message ?? resp?.error ?? 'reparent refused'))")
  })

  it('refuses a parent from another workspace before asking the backend', () => {
    const rp = fn('reparentPane')
    expect(rp).toContain('parent.workspacePath !== pane.workspacePath')
  })

  it('applies group before parent so a parent refusal does not undo the move', () => {
    const body = action('ui.pane.place')
    const groupAt = body.indexOf('await persistPaneRunGroup(')
    const parentAt = body.indexOf('await reparentPane(')
    expect(groupAt).toBeGreaterThan(-1)
    expect(parentAt).toBeGreaterThan(groupAt)
    // And the answer says which halves landed.
    expect(body).toContain('applied,')
  })
})
