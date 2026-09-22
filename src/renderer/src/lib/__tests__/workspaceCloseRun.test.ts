import { describe, it, expect } from 'vitest'
import { closeDialogBodyKey, closeEndsTheRun, restoreBlockedByRun } from '../workspaceCloseRun'

const A = '/Users/x/projects/alpha'
const B = '/Users/x/projects/beta'

describe('closeEndsTheRun', () => {
  it('ends the run when the workspace being closed is the one it runs in', () => {
    expect(closeEndsTheRun({
      state: 'running',
      runWorkspacePath: B,
      closingWorkspacePath: B,
      doomedOrigins: ['pipeline', 'pipeline', 'manual'],
    })).toBe(true)
  })

  it('does NOT end a run that belongs to a different workspace', () => {
    // The regression this function exists for. A window holds A and B. The user
    // ran a pipeline in B, switched to A (which aborts — a PAUSE, so B's panes
    // stay alive with origin 'pipeline'), started a NEW run in A, then closed B
    // from the sidebar. Matching on origin alone sees B's leftovers and tears
    // down the live run in A, sending A's backend an abort it never asked for.
    expect(closeEndsTheRun({
      state: 'running',
      runWorkspacePath: A,
      closingWorkspacePath: B,
      doomedOrigins: ['pipeline', 'pipeline'],
    })).toBe(false)
  })

  it('does not end a run when the close takes none of its panes', () => {
    expect(closeEndsTheRun({
      state: 'running',
      runWorkspacePath: B,
      closingWorkspacePath: B,
      doomedOrigins: ['manual', 'mcp'],
    })).toBe(false)
  })

  it('treats an mcp-spawned pane as not a slot', () => {
    // origin has three values; "not manual" would make this true.
    expect(closeEndsTheRun({
      state: 'running',
      runWorkspacePath: B,
      closingWorkspacePath: B,
      doomedOrigins: ['mcp'],
    })).toBe(false)
  })

  it('says no for every state that is not running', () => {
    for (const state of ['idle', 'aborted', 'completed', 'paused']) {
      expect(closeEndsTheRun({
        state,
        runWorkspacePath: B,
        closingWorkspacePath: B,
        doomedOrigins: ['pipeline'],
      }), state).toBe(false)
    }
  })

  it('compares paths as given, so the caller owns normalization', () => {
    // App.vue passes both through normWs. Documented here so a caller that
    // forgets one side sees a deliberate false rather than a silent match.
    expect(closeEndsTheRun({
      state: 'running',
      runWorkspacePath: B + '/',
      closingWorkspacePath: B,
      doomedOrigins: ['pipeline'],
    })).toBe(false)
  })
})

describe('restoreBlockedByRun', () => {
  it('blocks the workspace the run is in — its panes are already on screen', () => {
    expect(restoreBlockedByRun({
      state: 'running', runWorkspacePath: B, restoringWorkspacePath: B,
    })).toBe(true)
  })

  it('blocks it while the run is merely PAUSED, because abort leaves panes alive', () => {
    expect(restoreBlockedByRun({
      state: 'aborted', runWorkspacePath: B, restoringWorkspacePath: B,
    })).toBe(true)
  })

  it('does NOT block another workspace whose panes a close deliberately kept', () => {
    // The regression this function exists for. A window holds A and B, a run in
    // B is paused, and the user closes A from the sidebar: A's CLIs end but its
    // records stay 'spawned' so the reopen can resume them. Asked window-wide,
    // B's paused run refuses to restore A and the reopen comes back empty —
    // after a dialog that promised the panes come back.
    expect(restoreBlockedByRun({
      state: 'aborted', runWorkspacePath: B, restoringWorkspacePath: A,
    })).toBe(false)
    expect(restoreBlockedByRun({
      state: 'running', runWorkspacePath: B, restoringWorkspacePath: A,
    })).toBe(false)
  })

  it('blocks nothing when no run is live or paused', () => {
    for (const state of ['idle', 'completed']) {
      expect(restoreBlockedByRun({
        state, runWorkspacePath: B, restoringWorkspacePath: B,
      })).toBe(false)
    }
  })

  it('blocks when the run workspace is unknown, rather than guessing', () => {
    // Restoring on top of live panes duplicates them; refusing costs a reopen.
    // This is also the behaviour of the window-wide gate it replaced.
    expect(restoreBlockedByRun({
      state: 'aborted', runWorkspacePath: '', restoringWorkspacePath: A,
    })).toBe(true)
  })

  it('compares paths as given, like closeEndsTheRun — callers normalize', () => {
    expect(restoreBlockedByRun({
      state: 'running', runWorkspacePath: `${B}/`, restoringWorkspacePath: B,
    })).toBe(false)
  })
})

describe('closeDialogBodyKey', () => {
  it('speaks for every pane only when every pane comes back', () => {
    expect(closeDialogBodyKey({ count: 3, pipelineCount: 0 }))
      .toBe('confirm-close.sidebar-ws-body')
  })

  it('names the pipeline panes that will NOT come back', () => {
    // They take the markRemoved branch with the run, so the plain body — which
    // promises each pane returns as a card — would be a false promise.
    expect(closeDialogBodyKey({ count: 3, pipelineCount: 1 }))
      .toBe('confirm-close.sidebar-ws-body-pipeline')
  })

  it('stops describing survivors when there are none', () => {
    // The mixed body opens with "the ones you opened come back", which
    // describes nothing in a workspace holding only pipeline slots.
    expect(closeDialogBodyKey({ count: 2, pipelineCount: 2 }))
      .toBe('confirm-close.sidebar-ws-body-pipeline-only')
  })

  it('does not count panes when there are none to count', () => {
    expect(closeDialogBodyKey({ count: 0, pipelineCount: 0 }))
      .toBe('confirm-close.sidebar-ws-body-empty')
  })

  it('keeps the empty body ahead of the pipeline ones', () => {
    // A count of zero cannot hold pipeline panes, but if the two ever
    // disagreed the "0 CLI panes" wording is the one that must not ship.
    expect(closeDialogBodyKey({ count: 0, pipelineCount: 2 }))
      .toBe('confirm-close.sidebar-ws-body-empty')
  })

  it('treats more pipeline panes than panes as all of them', () => {
    expect(closeDialogBodyKey({ count: 2, pipelineCount: 5 }))
      .toBe('confirm-close.sidebar-ws-body-pipeline-only')
  })
})
