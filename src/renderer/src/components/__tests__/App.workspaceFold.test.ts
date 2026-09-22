// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { effectiveParents } from '../../lib/paneLineage'

// App's half of the workspace fold button: the sidebar folds the run group
// headings itself, but the lineage subtrees live in collapsedPanes and are
// persisted per pane, so they have to travel here.
//
// App.vue cannot be mounted by this suite, so the wiring is asserted against
// the source the way App.lineageDrop.test.ts does. What that CANNOT check is
// the walk itself, so the parent-selection rule is exercised for real against
// the shared helper below.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function fn(name: string): string {
  const start = appSource.indexOf(`function ${name}(`)
  expect(start, `function ${name} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n}\n', start)
  expect(end).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

describe('setWorkspaceSubtreesCollapsed — the write path behind the fold button', () => {
  it('is what the sidebar event is wired to', () => {
    expect(appSource).toContain('@collapse-workspace-subtrees="setWorkspaceSubtreesCollapsed"')
  })

  it('leaves the workspace heading alone', () => {
    // The whole point of the button: it empties the project without hiding it.
    // Touching collapsedWorkspaces here would make it a slower duplicate of
    // the caret, which is the one confusion this feature has to avoid.
    const body = fn('setWorkspaceSubtreesCollapsed')
    expect(body).not.toContain('collapsedWorkspaces')
  })

  it('folds only panes that actually have children', () => {
    // A leaf has no subtree, so a persisted `collapsed` flag on one records a
    // state the sidebar can never show — and becomes a lie the moment that
    // pane gains a child.
    const body = fn('setWorkspaceSubtreesCollapsed')
    expect(body).toContain('effectiveParents(mine).values()')
    expect(body).toContain('if (parent) withChildren.add(parent)')
  })

  it('scopes the walk to one workspace, trailing slash and all', () => {
    const body = fn('setWorkspaceSubtreesCollapsed')
    expect(body).toContain('normWs(p.workspacePath) === normWs(path)')
  })

  it('persists every pane it changed, and only those', () => {
    // Writing panes that were already in the wanted state would send one
    // backend message per pane per press, and the button is pressed on whole
    // projects at a time.
    const body = fn('setWorkspaceSubtreesCollapsed')
    expect(body).toContain('if (collapse === next.has(id)) continue')
    expect(body).toContain('changed.push(id)')
    expect(body).toContain("backend.send('project.set_pane_collapsed'")
    const guard = body.indexOf('if (!changed.length) return')
    const assign = body.indexOf('collapsedPanes.value = next')
    expect(guard).toBeGreaterThan(-1)
    expect(assign).toBeGreaterThan(guard)
  })

  it('refreshes the views, the way the single-pane toggle does', () => {
    // collapsedPanes feeds the lineage the lists render from.
    expect(fn('setWorkspaceSubtreesCollapsed')).toContain('syncViews()')
  })
})

// The rule the source assertions above can only name: which panes count as
// having children. This runs the real helper App calls.
describe('effectiveParents — the parent set the fold button writes', () => {
  const parentsOf = (panes: { id: string; spawnedBy?: string }[]): Set<string> => {
    const withChildren = new Set<string>()
    for (const parent of effectiveParents(panes).values()) if (parent) withChildren.add(parent)
    return withChildren
  }

  it('names the parent and not the leaf', () => {
    expect(parentsOf([{ id: 'a' }, { id: 'b', spawnedBy: 'a' }])).toEqual(new Set(['a']))
  })

  it('names nothing in a flat project, so the fold writes nothing', () => {
    expect(parentsOf([{ id: 'a' }, { id: 'b' }])).toEqual(new Set())
  })

  it('re-roots a child whose parent is not in this window', () => {
    // The sidebar draws that child as a root, so it has no subtree on screen.
    // Folding its absent parent would persist a flag against a pane this
    // window cannot show.
    expect(parentsOf([{ id: 'b', spawnedBy: 'gone' }])).toEqual(new Set())
  })

  it('does not treat a pane parented to itself as its own parent', () => {
    expect(parentsOf([{ id: 'a', spawnedBy: 'a' }])).toEqual(new Set())
  })

  it('re-roots a cycle rather than folding every pane in it', () => {
    // A hand-edited record can name a loop. Every pane in it would otherwise
    // look like a parent, and the fold would write all of them.
    expect(parentsOf([{ id: 'a', spawnedBy: 'b' }, { id: 'b', spawnedBy: 'a' }])).toEqual(new Set())
  })

  it('names every level of a deep chain, since each one hides rows', () => {
    const chain = [{ id: 'a' }, { id: 'b', spawnedBy: 'a' }, { id: 'c', spawnedBy: 'b' }]
    expect(parentsOf(chain)).toEqual(new Set(['a', 'b']))
  })
})
