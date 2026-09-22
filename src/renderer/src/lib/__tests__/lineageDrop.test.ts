import { describe, expect, it } from 'vitest'
import { resolveLineageDrop, resolveRootDrop, type LineageDropPane } from '../lineageDrop'

// The decision behind "drop a pane onto a sidebar row to make it that row's
// child". Every refusal here is one the backend enforces too; the point of
// pre-checking is that a refused row never lights up as a drop target.

const WS = '/ws/a'
const p = (
  id: string,
  spawnedBy?: string,
  extra: Partial<Pick<LineageDropPane, 'workspacePath' | 'runGroupId'>> = {},
): LineageDropPane => ({
  id,
  ...(spawnedBy ? { spawnedBy } : {}),
  workspacePath: extra.workspacePath ?? WS,
  ...(extra.runGroupId !== undefined ? { runGroupId: extra.runGroupId } : {}),
})

describe('resolveLineageDrop', () => {
  it('makes a single dragged pane a child of the target', () => {
    const panes = [p('a'), p('b')]
    expect(resolveLineageDrop(['a'], 'b', panes)).toEqual({
      ok: true,
      writes: [{ paneId: 'a', spawnedBy: 'b' }],
      groupWrites: [],
    })
  })

  it('refuses a self-drop', () => {
    expect(resolveLineageDrop(['a'], 'a', [p('a'), p('b')])).toEqual({
      ok: false,
      reason: 'target-in-batch',
    })
  })

  it('refuses a target that is inside the dragged batch', () => {
    expect(resolveLineageDrop(['a', 'b'], 'b', [p('a'), p('b'), p('c')])).toEqual({
      ok: false,
      reason: 'target-in-batch',
    })
  })

  it('refuses a target that descends from a dragged pane (cycle)', () => {
    const panes = [p('a'), p('a1', 'a'), p('a1x', 'a1')]
    expect(resolveLineageDrop(['a'], 'a1x', panes)).toEqual({ ok: false, reason: 'cycle' })
    expect(resolveLineageDrop(['a'], 'a1', panes)).toEqual({ ok: false, reason: 'cycle' })
  })

  it('compares workspaces with trailing slashes trimmed', () => {
    const panes = [p('a', undefined, { workspacePath: '/x/' }), p('b', undefined, { workspacePath: '/x' })]
    expect(resolveLineageDrop(['a'], 'b', panes)).toMatchObject({ ok: true })
  })

  it('refuses a target in another workspace', () => {
    const panes = [p('a'), p('b', undefined, { workspacePath: '/ws/b' })]
    expect(resolveLineageDrop(['a'], 'b', panes)).toEqual({ ok: false, reason: 'cross-workspace' })
  })

  it('refuses when nothing dragged is a pane of this window', () => {
    expect(resolveLineageDrop(['ghost'], 'b', [p('b')])).toEqual({ ok: false, reason: 'unknown-pane' })
  })

  it('refuses an unknown target', () => {
    expect(resolveLineageDrop(['a'], 'ghost', [p('a')])).toEqual({ ok: false, reason: 'unknown-target' })
  })

  it('refuses when the dragged pane already hangs under the target', () => {
    expect(resolveLineageDrop(['a1'], 'a', [p('a'), p('a1', 'a')])).toEqual({
      ok: false,
      reason: 'already-child',
    })
  })

  it('re-parents only the top-level members of a batch that holds a parent and its child', () => {
    const panes = [p('a'), p('a1', 'a'), p('b'), p('t')]
    expect(resolveLineageDrop(['a', 'a1', 'b'], 't', panes)).toEqual({
      ok: true,
      writes: [
        { paneId: 'a', spawnedBy: 't' },
        { paneId: 'b', spawnedBy: 't' },
      ],
      groupWrites: [],
    })
  })

  it('moves the batch and its descendants into the target parent’s run group', () => {
    const panes = [
      p('t', undefined, { runGroupId: 'g1' }),
      p('a', undefined, { runGroupId: 'g2' }),
      p('a1', 'a', { runGroupId: 'g2' }),
      p('a1x', 'a1', { runGroupId: 'g1' }),
    ]
    expect(resolveLineageDrop(['a'], 't', panes)).toEqual({
      ok: true,
      writes: [{ paneId: 'a', spawnedBy: 't' }],
      groupWrites: [
        { paneId: 'a', runGroupId: 'g1' },
        { paneId: 'a1', runGroupId: 'g1' },
      ],
    })
  })

  it('moves into the ungrouped tab when the target has no run group', () => {
    const panes = [p('t'), p('a', undefined, { runGroupId: 'g2' })]
    expect(resolveLineageDrop(['a'], 't', panes)).toMatchObject({
      ok: true,
      groupWrites: [{ paneId: 'a', runGroupId: '' }],
    })
  })

  it('accepts a placeholder (unrealized) pane as the parent — it is a persisted record like any other', () => {
    // A placeholder differs from a live pane only by App.vue's `realized`
    // flag, which this helper does not read: nothing about the record makes
    // it unfit to be a parent.
    const panes = [p('placeholder'), p('a')]
    expect(resolveLineageDrop(['a'], 'placeholder', panes)).toEqual({
      ok: true,
      writes: [{ paneId: 'a', spawnedBy: 'placeholder' }],
      groupWrites: [],
    })
  })
})

describe('resolveRootDrop', () => {
  it('makes a nested pane a root and moves it into the header’s group', () => {
    const panes = [p('a', undefined, { runGroupId: 'g1' }), p('a1', 'a', { runGroupId: 'g1' })]
    expect(resolveRootDrop(['a1'], WS, 'g2', panes)).toEqual({
      ok: true,
      writes: [{ paneId: 'a1', spawnedBy: '' }],
      groupWrites: [{ paneId: 'a1', runGroupId: 'g2' }],
    })
  })

  it('is a no-op for a pane that is already a root of that group', () => {
    const panes = [p('a', undefined, { runGroupId: 'g1' })]
    expect(resolveRootDrop(['a'], WS, 'g1', panes)).toEqual({ ok: false, reason: 'already-child' })
  })

  it('only moves the group when the pane is already a root elsewhere', () => {
    const panes = [p('a', undefined, { runGroupId: 'g1' }), p('a1', 'a', { runGroupId: 'g1' })]
    expect(resolveRootDrop(['a'], WS, 'g2', panes)).toEqual({
      ok: true,
      writes: [],
      groupWrites: [
        { paneId: 'a', runGroupId: 'g2' },
        { paneId: 'a1', runGroupId: 'g2' },
      ],
    })
  })

  it('clears a stale pointer to a parent that is not in this window', () => {
    // Drawn as a root already, but the record still names the parent, and a
    // restore of that parent would tuck the pane back under it.
    const panes = [p('a', 'gone-parent')]
    expect(resolveRootDrop(['a'], WS, '', panes)).toEqual({
      ok: true,
      writes: [{ paneId: 'a', spawnedBy: '' }],
      groupWrites: [],
    })
  })

  it('keeps a batch child under its batched parent', () => {
    const panes = [p('r'), p('a', 'r'), p('a1', 'a')]
    expect(resolveRootDrop(['a', 'a1'], WS, '', panes)).toEqual({
      ok: true,
      writes: [{ paneId: 'a', spawnedBy: '' }],
      groupWrites: [],
    })
  })

  it('treats a header path with a trailing slash as the same workspace', () => {
    // workspaceGroups lists the workspace as recorded by the window, which can
    // carry a trailing slash the pane's own workspacePath does not.
    const panes = [p('a', 'r', { workspacePath: '/x' }), p('r', undefined, { workspacePath: '/x' })]
    expect(resolveRootDrop(['a'], '/x/', '', panes)).toEqual({
      ok: true,
      writes: [{ paneId: 'a', spawnedBy: '' }],
      groupWrites: [],
    })
  })

  it('refuses a header in another workspace', () => {
    expect(resolveRootDrop(['a'], '/ws/b', '', [p('a', 'r'), p('r')])).toEqual({
      ok: false,
      reason: 'cross-workspace',
    })
  })

  it('refuses a drag that carries no pane of this window', () => {
    expect(resolveRootDrop(['ghost'], WS, '', [p('a')])).toEqual({ ok: false, reason: 'unknown-pane' })
  })
})
