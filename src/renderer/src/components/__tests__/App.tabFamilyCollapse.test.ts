import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { computed, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { buildPaneLineage } from '../../lib/paneLineage'
import { panesOfActiveTab, panesOfViewedWorkspace } from '../../lib/paneVisibility'

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
