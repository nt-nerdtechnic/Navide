import { describe, expect, it } from 'vitest'
import { dockWindowLabelKey, historyEntryIsLive, workspaceHasPmPanel } from '../dockWindow'

// Which window an embedded AI panel (AiCliDock) lives in, as the main window
// names it. A window pane — no surface, or 'main' — has no window to name, and
// every caller draws it exactly as before.
describe('dockWindowLabelKey', () => {
  it.each([
    ['pm', 'dockWindow.pm'],
    ['plans', 'dockWindow.plans'],
    ['git', 'dockWindow.git'],
    ['editor', 'dockWindow.editor'],
  ])('names the %s panel', (surface, key) => {
    expect(dockWindowLabelKey(surface)).toBe(key)
  })

  it.each([undefined, '', 'main', 'something-new'])('names nothing for %s', (surface) => {
    expect(dockWindowLabelKey(surface)).toBeNull()
  })
})

describe('workspaceHasPmPanel', () => {
  const norm = (p: string) => p.replace(/\/+$/, '')
  it('finds the Pipeline Manager panel of the workspace being closed', () => {
    const roster = [
      { surface: 'git', workspacePath: '/ws/a' },
      { surface: 'pm', workspacePath: '/ws/a/' },
    ]
    expect(workspaceHasPmPanel(roster, '/ws/a', norm)).toBe(true)
  })

  it('ignores another workspace\'s panel, other panels and window panes', () => {
    const roster = [
      { surface: 'pm', workspacePath: '/ws/b' },
      { surface: 'plans', workspacePath: '/ws/a' },
      { workspacePath: '/ws/a' },
    ]
    expect(workspaceHasPmPanel(roster, '/ws/a', norm)).toBe(false)
    expect(workspaceHasPmPanel([{ surface: 'pm', workspacePath: '/ws/a' }], '', norm)).toBe(false)
  })
})

describe('historyEntryIsLive', () => {
  const live = new Set(['pane-1'])
  const roster = new Set(['dock-1'])
  it('judges a window pane by the panes of this window, as before', () => {
    expect(historyEntryIsLive({ paneId: 'pane-1' }, live, roster)).toBe(true)
    expect(historyEntryIsLive({ paneId: 'dock-1' }, live, roster)).toBe(false)
    expect(historyEntryIsLive({ paneId: 'pane-1', surface: 'main' }, live, roster)).toBe(true)
  })
  it('judges an embedded panel by the roster, never by this window\'s panes', () => {
    expect(historyEntryIsLive({ paneId: 'dock-1', surface: 'pm' }, live, roster)).toBe(true)
    expect(historyEntryIsLive({ paneId: 'dock-2', surface: 'git' }, live, roster)).toBe(false)
    expect(historyEntryIsLive({ paneId: 'pane-1', surface: 'pm' }, live, roster)).toBe(false)
  })
})
