// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The sidebar's drop-to-nest gesture and the write path it lands on. App.vue
// cannot be mounted by this suite, so the wiring is asserted against the
// source, the way App.placePane.test.ts does for ui.pane.place.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function fn(name: string): string {
  const start = appSource.indexOf(`function ${name}(`)
  expect(start, `function ${name} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n}\n', start)
  expect(end).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

describe('reparentPane — the one write path every re-parent lands on', () => {
  it('mirrors the new parent into the messaging registry after the pane object changes', () => {
    // cli_whoami reads spawned_by from the backend registry, and
    // mirrorMessagingHandle is the only writer of it. A re-parent that only
    // changed the pane object would leave the child naming its old parent
    // until its next rename or reconnect.
    const body = fn('reparentPane')
    const assign = body.indexOf('pane.spawnedBy = spawnedBy || undefined')
    const mirror = body.indexOf('mirrorMessagingHandle(pane)')
    expect(assign).toBeGreaterThan(-1)
    expect(mirror).toBeGreaterThan(assign)
  })

  it('is the only place the drop gesture and ui.pane.place mirror from', () => {
    // One writer: the mirror belongs to the function that owns the write, not
    // to each caller.
    expect(fn('applyLineageDrop')).not.toContain('mirrorMessagingHandle(')
    const start = appSource.indexOf("registerCommand('ui.pane.place'")
    const end = appSource.indexOf('\n})\n', start)
    expect(appSource.slice(start, end)).not.toContain('mirrorMessagingHandle(')
  })
})

describe('the sidebar drop wiring', () => {
  it('routes both drop targets through the pure helper and applyLineageDrop', () => {
    expect(fn('nestPane')).toContain('resolveLineageDrop(paneDragBatch(draggedId), targetId, panes.value)')
    expect(fn('rootPane')).toContain('resolveRootDrop(paneDragBatch(draggedId), workspacePath, runGroupId, panes.value)')
    expect(appSource).toContain('@nest-pane="nestPane"')
    expect(appSource).toContain('@root-pane="rootPane"')
  })

  it('re-parents through reparentPane BEFORE the group moves, and persists each group move before the pane object changes', () => {
    // The helper's cycle check sees this window's panes; the backend's walks
    // the whole workspace record, so a parent the pre-check passed can still
    // be refused. Group first would leave the pane moved into the target's
    // group without hanging under it.
    const body = fn('applyLineageDrop')
    const parent = body.indexOf('await reparentPane(w.paneId, w.spawnedBy)')
    const group = body.indexOf('if (await persistPaneRunGroup(pane, w.runGroupId)) pane.runGroupId = w.runGroupId || undefined')
    expect(parent).toBeGreaterThan(-1)
    expect(group).toBeGreaterThan(parent)
    expect(body).not.toContain('movePaneToGroup(')
  })

  it('hands the sidebar each pane’s workspace and run group, so the drop pre-checks are live', () => {
    // resolveLineageDrop / resolveRootDrop read both off the view model the
    // sidebar receives. Missing from the mapping, every pane would look
    // ungrouped and workspace-less and the pre-check would pass for rows the
    // drop then does nothing to.
    const body = fn('syncViews')
    expect(body).toContain('workspacePath: p.workspacePath')
    expect(body).toContain('runGroupId: p.runGroupId')
  })
})
