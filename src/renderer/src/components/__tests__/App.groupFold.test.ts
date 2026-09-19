// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// App's half of the run group fold button, the twin of App.workspaceFold.
//
// The sidebar folds the group heading itself; the lineage subtrees live in
// collapsedPanes and are persisted per pane, so they travel here. Unlike the
// workspace fold, the parents are NOT derived here — grouping is the list's
// own layer, so the rows it drew arrive as ids.
//
// App.vue cannot be mounted by this suite, so the wiring is asserted against
// the source, the way App.workspaceFold.test.ts does. The write is deliberately
// a sibling of the workspace one rather than a shared helper, which is exactly
// why it needs its own guards: a fix applied to one must not quietly skip this.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function fn(name: string): string {
  const start = appSource.indexOf(`function ${name}(`)
  expect(start, `function ${name} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n}\n', start)
  expect(end).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

describe('setPaneSubtreesCollapsed — the write path behind the group fold button', () => {
  it('is what the sidebar event is wired to', () => {
    expect(appSource).toContain('@collapse-pane-subtrees="setPaneSubtreesCollapsed"')
  })

  it('leaves both headings alone', () => {
    // The group caret hides the group and the workspace caret hides the
    // project. This button empties the group without hiding anything, which is
    // the one distinction that makes it worth having beside the caret.
    const body = fn('setPaneSubtreesCollapsed')
    expect(body).not.toContain('collapsedGroups')
    expect(body).not.toContain('collapsedWorkspaces')
  })

  it('folds exactly the panes it was handed', () => {
    // No re-derivation: a pane that has moved to another group must not be
    // folded by the group it left, and only the sidebar knows where it is now.
    const body = fn('setPaneSubtreesCollapsed')
    expect(body).toContain('for (const id of paneIds)')
    expect(body).not.toContain('effectiveParents')
  })

  it('persists every pane it changed, and only those', () => {
    // Writing panes already in the wanted state would send one backend message
    // per pane per press, and the button is pressed on whole groups at a time.
    const body = fn('setPaneSubtreesCollapsed')
    expect(body).toContain('if (collapse === next.has(id)) continue')
    expect(body).toContain('changed.push(id)')
    expect(body).toContain("backend.send('project.set_pane_collapsed'")
    const guard = body.indexOf('if (!changed.length) return')
    const assign = body.indexOf('collapsedPanes.value = next')
    expect(guard).toBeGreaterThan(-1)
    expect(assign).toBeGreaterThan(guard)
  })

  it('refreshes the views, the way the workspace fold does', () => {
    // collapsedPanes feeds the lineage the lists render from.
    expect(fn('setPaneSubtreesCollapsed')).toContain('syncViews()')
  })

  it('leaves the workspace fold deriving its own parents', () => {
    // The two are siblings on purpose. If the workspace one ever starts taking
    // ids from the sidebar too, the walk that re-roots orphans and cycles goes
    // with it — and that rule has no other home.
    expect(fn('setWorkspaceSubtreesCollapsed')).toContain('effectiveParents(mine).values()')
  })
})
