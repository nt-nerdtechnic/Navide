import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { computed, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { buildPaneLineage } from '../../lib/paneLineage'
import { panesOfActiveTab, panesOfViewedWorkspace } from '../../lib/paneVisibility'
import { computeRangeSelection } from '../../lib/paneSelection'

const source = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function block(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  expect(start, startMarker).toBeGreaterThan(-1)
  const end = source.indexOf(endMarker, start + startMarker.length)
  expect(end, endMarker).toBeGreaterThan(start)
  return source.slice(start, end)
}

function fn(name: string): string {
  return `${block(`function ${name}(`, '\n}\n')}\n}`
}

interface Pane {
  id: string
  workspacePath: string
  runGroupId: string
  spawnedBy?: string
  realized: boolean
}

function pane(id: string, spawnedBy?: string, runGroupId = 'feature', workspacePath = '/project'): Pane {
  return { id, spawnedBy, runGroupId, workspacePath, realized: true }
}

const familyPanes = () => [
  pane('parent'), pane('nested', 'parent'), pane('child', 'nested'),
  pane('second'), pane('second-child', 'second'), pane('standalone'),
  pane('other-parent', undefined, 'fix'), pane('other-child', 'other-parent', 'fix'),
  pane('remote-parent', undefined, 'feature', '/other'), pane('remote-child', 'remote-parent', 'feature', '/other'),
]

// Execute App's actual computed state and handlers with reactive pane data.
// App's unrelated workspace/terminal lifecycles remain outside the harness.
function harness(initial = familyPanes(), closed: string[] = [], actions = true) {
  const panes = ref(initial)
  const paneListCollapsed = ref(new Set(closed))
  const minimizedPanes = ref(new Set<string>())
  const activeTab = ref('feature')
  const currentWorkspace = ref('/project')
  const focusPaneId = ref<string | null>('child')
  const effectiveLayoutMode = ref('sidebar')
  const tabFilteredPaneIds = computed(() => panesOfActiveTab(
    panesOfViewedWorkspace(panes.value, ['/project', '/other'].filter(path => path !== currentWorkspace.value)),
    { hasTabs: true, activeTab: activeTab.value, groupIds: ['feature', 'fix'] },
  ))
  const paneListLineage = computed(() => buildPaneLineage(panes.value, new Set()))
  const paneViews = computed(() => panes.value.map(p => ({ ...p, isMinimized: minimizedPanes.value.has(p.id) })))
  const backend = { send: vi.fn() }
  const selectPane = vi.fn()
  const realizeRestoredPane = vi.fn()
  const syncViews = vi.fn()
  const deps = {
    computed, panes, paneViews, paneListLineage, paneListCollapsed, minimizedPanes,
    activeTab, currentWorkspace, focusPaneId, effectiveLayoutMode, tabFilteredPaneIds,
    backend, selectPane, realizeRestoredPane, syncViews,
  }
  const declarations = [
    block('const auxiliaryListPanes = computed(() => {', 'const auxiliaryListOrderedIds'),
    fn('togglePaneFamily'),
    ...(actions ? [
      block('const tabFamilyParentIds = computed', '/** What the lists render'),
      fn('toggleTabFamilies'),
    ] : []),
  ].join('\n')
  const javascript = ts.transpileModule(declarations, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  const exports = actions
    ? 'auxiliaryListPanes, togglePaneFamily, tabFamiliesCollapsed, tabFamilyToggleDisabledReason, toggleTabFamilies'
    : 'auxiliaryListPanes, togglePaneFamily'
  const result = new Function(...Object.keys(deps), `${javascript}; return { ${exports} }`)(...Object.values(deps)) as {
    auxiliaryListPanes: { value: { id: string; expanded: boolean; descendantCount: number }[] }
    togglePaneFamily: (id: string) => void
    tabFamiliesCollapsed: { value: boolean }
    tabFamilyToggleDisabledReason: { value: 'grid' | 'empty' | undefined }
    toggleTabFamilies: () => void
  }
  return { ...deps, ...result }
}

describe('active-tab family folding', () => {
  it('does not hide descendants whose closed ancestor belongs to another tab', () => {
    const h = harness([pane('parent', undefined, 'fix'), pane('child', 'parent')], ['parent'], false)
    expect(h.auxiliaryListPanes.value.map(p => p.id)).toEqual(['child'])
    h.activeTab.value = 'fix'
    expect(h.auxiliaryListPanes.value.map(p => p.id)).toEqual(['parent'])
  })

  it('does not hide descendants whose closed ancestor belongs to another workspace', () => {
    const h = harness([pane('parent', undefined, 'feature', '/other'), pane('child', 'parent')], ['parent'], false)
    expect(h.auxiliaryListPanes.value.map(p => p.id)).toEqual(['child'])
  })

  it('collapses every eligible parent in a mixed tab, including hidden nested parents', () => {
    const h = harness(familyPanes(), ['parent', 'other-parent', 'remote-parent'])
    expect(h.tabFamiliesCollapsed.value).toBe(false)
    expect(h.tabFamilyToggleDisabledReason.value).toBeUndefined()
    h.toggleTabFamilies()
    expect([...h.paneListCollapsed.value].sort()).toEqual(['nested', 'other-parent', 'parent', 'remote-parent', 'second'])
    expect(h.auxiliaryListPanes.value.map(p => p.id)).toEqual(['parent', 'second', 'standalone'])
    expect(h.auxiliaryListPanes.value[0].descendantCount).toBe(2)
    expect(h.tabFamiliesCollapsed.value).toBe(true)
  })

  it('expands every nested family while preserving other tabs and workspaces', () => {
    const h = harness(familyPanes(), ['parent', 'nested', 'second', 'other-parent', 'remote-parent'])
    h.toggleTabFamilies()
    expect([...h.paneListCollapsed.value].sort()).toEqual(['other-parent', 'remote-parent'])
    expect(h.auxiliaryListPanes.value.map(p => p.id)).toEqual(['parent', 'nested', 'child', 'second', 'second-child', 'standalone'])
    expect(h.tabFamiliesCollapsed.value).toBe(false)
  })

  it('shares state with individual family triangles and responds to tab switches', () => {
    const h = harness()
    h.togglePaneFamily('parent')
    h.toggleTabFamilies()
    expect(h.tabFamiliesCollapsed.value).toBe(true)
    h.activeTab.value = 'fix'
    expect(h.tabFamiliesCollapsed.value).toBe(false)
    expect(h.auxiliaryListPanes.value.map(p => p.id)).toEqual(['other-parent', 'other-child'])
    h.toggleTabFamilies()
    h.activeTab.value = 'feature'
    h.toggleTabFamilies()
    expect([...h.paneListCollapsed.value]).toEqual(['other-parent'])
  })

  it.each(['sidebar', 'spotlight', 'fullscreen'])('folds families in %s without changing terminal state or sending I/O', mode => {
    const initial = familyPanes()
    initial.find(p => p.id === 'child')!.realized = false
    const h = harness(initial)
    h.effectiveLayoutMode.value = mode
    const before = h.paneListCollapsed.value
    const panesBefore = JSON.stringify(h.panes.value)
    h.toggleTabFamilies()
    expect(h.paneListCollapsed.value).not.toBe(before)
    h.toggleTabFamilies()
    expect(JSON.stringify(h.panes.value)).toBe(panesBefore)
    expect(h.focusPaneId.value).toBe('child')
    expect(h.activeTab.value).toBe('feature')
    expect(h.currentWorkspace.value).toBe('/project')
    expect(h.minimizedPanes.value.size).toBe(0)
    for (const effect of [h.backend.send, h.selectPane, h.realizeRestoredPane, h.syncViews]) {
      expect(effect).not.toHaveBeenCalled()
    }
  })

  it('leaves minimized parents untouched and never targets a leaf', () => {
    const h = harness(familyPanes(), ['second'])
    h.minimizedPanes.value = new Set(['second'])
    h.toggleTabFamilies()
    expect([...h.paneListCollapsed.value].sort()).toEqual(['nested', 'parent', 'second'])
    h.toggleTabFamilies()
    expect([...h.paneListCollapsed.value]).toEqual(['second'])
    expect([...h.minimizedPanes.value]).toEqual(['second'])
  })

  it('disables Grid without modifying family state', () => {
    const h = harness(familyPanes(), ['parent'])
    h.effectiveLayoutMode.value = 'grid'
    const before = h.paneListCollapsed.value
    expect(h.tabFamilyToggleDisabledReason.value).toBe('grid')
    h.toggleTabFamilies()
    expect(h.paneListCollapsed.value).toBe(before)
  })

  it.each([{ initial: [] }, { initial: [pane('leaf')] }])('disables an empty or leaf-only tab', ({ initial }) => {
    const h = harness(initial)
    const before = h.paneListCollapsed.value
    expect(h.tabFamilyToggleDisabledReason.value).toBe('empty')
    expect(h.tabFamiliesCollapsed.value).toBe(false)
    h.toggleTabFamilies()
    expect(h.paneListCollapsed.value).toBe(before)
  })

  it('wires the toolbar state and event to the behavior-tested action', () => {
    const toolbar = block('<StageTabBar', '</StageTabBar>')
    expect(toolbar).toContain(':all-families-collapsed="tabFamiliesCollapsed"')
    expect(toolbar).toContain(':family-toggle-disabled-reason="tabFamilyToggleDisabledReason"')
    expect(toolbar).toContain('@toggle-families="toggleTabFamilies"')
  })
})

// A parent's count walks every pane, so each counted descendant must be
// reachable by opening the family in the list — even when it is minimized or
// lives on another tab or in another workspace.
const reachableFamily = () => [
  pane('lead'), pane('mini', 'lead'), pane('away', 'lead', 'fix'), pane('remote', 'lead', 'feature', '/other'),
  pane('deep', 'away', 'fix'), pane('deeper', 'deep', 'feature', '/other'),
  pane('unrelated', undefined, 'fix'), pane('unrelated-mini'), pane('unrelated-remote', undefined, 'feature', '/other'),
]

describe('descendants reachable from the pane lists', () => {
  it('lists every counted descendant of a current-tab entry, wherever it lives', () => {
    const h = harness(reachableFamily(), [], false)
    h.minimizedPanes.value = new Set(['mini', 'unrelated-mini', 'deeper'])
    const rows = h.auxiliaryListPanes.value
    expect(rows.map(r => r.id)).toEqual(['lead', 'mini', 'away', 'deep', 'deeper', 'remote'])
    const lead = rows.find(r => r.id === 'lead')!
    expect(lead.descendantCount).toBe(5)
    expect(rows.filter(r => (r as unknown as { ancestors: string[] }).ancestors.includes('lead'))).toHaveLength(lead.descendantCount)
  })

  it('never adds unrelated panes and lists an overlapping entry once', () => {
    const h = harness(reachableFamily(), [], false)
    const ids = h.auxiliaryListPanes.value.map(r => r.id)
    for (const id of ['unrelated', 'unrelated-mini', 'unrelated-remote']) {
      if (id === 'unrelated-mini') expect(ids).toContain(id)
      else expect(ids).not.toContain(id)
    }
    h.minimizedPanes.value = new Set(['unrelated-mini'])
    expect(h.auxiliaryListPanes.value.map(r => r.id)).not.toContain('unrelated-mini')
    expect(new Set(h.auxiliaryListPanes.value.map(r => r.id)).size).toBe(h.auxiliaryListPanes.value.length)
  })

  it('folds a carried nested parent with its own caret, level by level', () => {
    const h = harness(reachableFamily(), ['away'], false)
    expect(h.auxiliaryListPanes.value.map(r => r.id)).toEqual(['lead', 'mini', 'away', 'remote', 'unrelated-mini'])
    h.togglePaneFamily('away')
    h.togglePaneFamily('deep')
    expect(h.auxiliaryListPanes.value.map(r => r.id)).toEqual(['lead', 'mini', 'away', 'deep', 'remote', 'unrelated-mini'])
    h.togglePaneFamily('deep')
    expect(h.auxiliaryListPanes.value.map(r => r.id)).toContain('deeper')
  })

  it('does not let a closed ancestor outside the list hide a current-tab entry', () => {
    const h = harness([pane('root', undefined, 'fix'), pane('entry', 'root'), pane('leaf', 'entry', 'fix')], ['root'], false)
    expect(h.auxiliaryListPanes.value.map(r => r.id)).toEqual(['entry', 'leaf'])
  })

  it('keeps batch collapse on current-tab parents and leaves carried parents alone', () => {
    const h = harness(reachableFamily())
    h.toggleTabFamilies()
    expect([...h.paneListCollapsed.value]).toEqual(['lead'])
    h.toggleTabFamilies()
    h.togglePaneFamily('away')
    h.toggleTabFamilies()
    expect([...h.paneListCollapsed.value].sort()).toEqual(['away', 'lead'])
    h.toggleTabFamilies()
    expect([...h.paneListCollapsed.value]).toEqual(['away'])
  })

  it('drops a closed child and its count together', () => {
    const h = harness(reachableFamily(), [], false)
    h.panes.value = h.panes.value.filter(p => p.id !== 'away')
    const rows = h.auxiliaryListPanes.value
    expect(rows.map(r => r.id)).toEqual(['lead', 'mini', 'remote', 'unrelated-mini'])
    expect(rows[0].descendantCount).toBe(2)
  })
})

// The list's row click: rows on the stage keep onSetFocus; a carried row is
// reached through the sidebar's jump, and a modifier click only selects.
function clickHarness(onStage: string[]) {
  const selectedPaneIds = ref(new Set<string>())
  const focusPaneId = ref<string | null>('lead')
  const lastClickPaneId = ref<string | null>(null)
  const tabVisiblePanes = computed(() => onStage.map(id => ({ id })))
  const auxiliaryListOrderedIds = computed(() => ['lead', 'mini', 'away', 'remote'])
  const panes = ref(['lead', 'mini', 'away', 'remote'].map(id => ({ id })))
  const deps = {
    selectedPaneIds, focusPaneId, lastClickPaneId, tabVisiblePanes, auxiliaryListOrderedIds, panes,
    computeRangeSelection,
    revealPaneTab: vi.fn(), selectPane: vi.fn(), restorePane: vi.fn(), onSidebarFocusPane: vi.fn(),
  }
  const javascript = ts.transpileModule(
    ['onAuxiliaryListClick', 'togglePaneSelection', 'onSetFocus', 'rangeSelectPanes'].map(fn).join('\n'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText
  const run = new Function(...Object.keys(deps), `${javascript}; return onAuxiliaryListClick`)(...Object.values(deps)) as
    (id: string, ev: Partial<MouseEvent>) => void
  const click = (id: string, ev: Partial<MouseEvent> = {}) => run(id, { shiftKey: false, metaKey: false, ctrlKey: false, ...ev })
  return { ...deps, click }
}

describe('clicking a row in the pane lists', () => {
  it('jumps to a carried row through the sidebar flow', () => {
    const h = clickHarness(['lead'])
    h.click('away')
    expect(h.onSidebarFocusPane).toHaveBeenCalledWith('away')
    expect(h.selectPane).not.toHaveBeenCalled()
  })

  it('keeps the on-stage click exactly as before', () => {
    const h = clickHarness(['lead', 'mini'])
    h.click('mini')
    expect(h.selectPane).toHaveBeenCalledWith('mini', { userInitiated: true })
    expect(h.onSidebarFocusPane).not.toHaveBeenCalled()
    h.click('lead', { metaKey: true })
    expect([...h.selectedPaneIds.value]).toEqual(['lead'])
    expect(h.selectPane).toHaveBeenLastCalledWith('lead', { userInitiated: false })
  })

  it.each([{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }])('only selects a carried row on %o', ev => {
    const h = clickHarness(['lead'])
    h.click('away', ev)
    expect([...h.selectedPaneIds.value].sort()).toEqual(ev.shiftKey ? ['away', 'lead', 'mini'] : ['away', 'lead'])
    for (const effect of [h.revealPaneTab, h.selectPane, h.restorePane, h.onSidebarFocusPane]) {
      expect(effect).not.toHaveBeenCalled()
    }
    expect(h.focusPaneId.value).toBe('lead')
  })
})

describe('reordering from the pane lists', () => {
  function reorderHarness() {
    const reorderPane = vi.fn()
    const tabFilteredPaneIds = computed(() => new Set(['lead', 'mini']))
    const javascript = ts.transpileModule(fn('reorderAuxiliaryPane'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText
    const reorder = new Function('tabFilteredPaneIds', 'reorderPane', `${javascript}; return reorderAuxiliaryPane`)(
      tabFilteredPaneIds, reorderPane,
    ) as (from: string, to: string) => void
    return { reorder, reorderPane }
  }

  it('refuses a drop on a carried row from another tab or workspace', () => {
    const h = reorderHarness()
    h.reorder('lead', 'away')
    h.reorder('lead', 'remote')
    expect(h.reorderPane).not.toHaveBeenCalled()
  })

  it('reorders on a row of this tab exactly as before', () => {
    const h = reorderHarness()
    h.reorder('lead', 'mini')
    expect(h.reorderPane).toHaveBeenCalledWith('lead', 'mini')
  })

  it('is the reorder the auxiliary lists use', () => {
    expect(source).toContain('  batchFor: auxiliaryDragBatch,\n  reorder: reorderAuxiliaryPane,\n')
  })
})
