// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Free mode widens what the STAGE draws to every workspace this window runs.
// The danger is that it widens what the owning actions REACH: panesInView is
// read by "close this workspace", "kill all", the pane-order write and the
// run-group edits, and each of those acts on one project. A mode that is only a
// way of looking must not make them close, kill or file another project's panes.
//
// Source-scanned, like the other App.*.test.ts files: App.vue cannot be
// mounted, since backend and terminal lifecycles start on mount.
const read = (p: string): string => readFileSync(resolve(process.cwd(), p), 'utf8')
const appSource = read('src/renderer/src/App.vue')

/** A top-level function's text, up to the next declaration. */
function body(source: string, name: string): string {
  for (const pat of [`async function ${name}(`, `function ${name}(`]) {
    const at = source.indexOf(pat)
    if (at < 0) continue
    const rest = source.slice(at + pat.length)
    const next = /\n(?:async )?function \w+|\nconst \w+ =|\n\/\*\*/.exec(rest)
    return source.slice(at, at + pat.length + (next ? next.index : 3000))
  }
  throw new Error(`${name} not found`)
}

/** A top-level `const x = computed(...)`'s text, up to the next declaration. */
function computedBody(source: string, name: string): string {
  const pat = `const ${name} = computed`
  const at = source.indexOf(pat)
  if (at < 0) throw new Error(`${name} not found`)
  const rest = source.slice(at + pat.length)
  const next = /\nconst \w+ =|\n(?:async )?function \w+|\n\/\*\*/.exec(rest)
  return source.slice(at, at + pat.length + (next ? next.index : 2000))
}

describe('free mode widens the stage, not the owning actions', () => {
  it('keeps the two pools apart', () => {
    // panesInView stays "the workspace on screen"; panesOnStage is the one that
    // opens up. Collapsing them into one is the mistake this guards.
    expect(computedBody(appSource, 'panesInView')).toContain('panesOfViewedWorkspace')
    const onStage = computedBody(appSource, 'panesOnStage')
    expect(onStage).toContain("sidebarMode.value === 'free'")
    expect(onStage).toContain('panes.value')
    expect(onStage).toContain('panesInView.value')
  })

  it('draws the stage, its tabs and its focus from the wider pool', () => {
    expect(computedBody(appSource, 'stageTabShapes')).toContain('panes: panesOnStage.value')
    expect(computedBody(appSource, 'tabFilteredPaneIds')).toContain(
      'panesOfActiveTab(panesOnStage.value'
    )
    expect(computedBody(appSource, 'effectiveFocusPaneId')).toContain('panesOnStage.value')
  })

  it('leaves every action that owns or destroys panes on the narrow pool', () => {
    for (const fn of [
      'doCloseWorkspace',
      'onKillAll',
      'persistPaneOrder',
      'closeRunGroup',
      'deleteRunGroup'
    ]) {
      const text = body(appSource, fn)
      expect(text, fn).toContain('panesInView')
      expect(text, fn).not.toContain('panesOnStage')
    }
  })

  it('stops switching workspaces under a click that only asked for focus', () => {
    const fn = body(appSource, 'ensurePaneWorkspaceOnScreen')
    const guard = fn.indexOf("sidebarMode.value === 'free'")
    expect(guard).toBeGreaterThan(-1)
    // Before the switch, or it would have already happened.
    expect(guard).toBeLessThan(fn.indexOf('await switchToWorkspace('))
  })

  it('walks the flat lineage for shift-range selection in free mode', () => {
    const fn = computedBody(appSource, 'sidebarOrderedPaneIds')
    expect(fn).toContain("sidebarMode.value === 'free'")
    expect(fn).toContain('paneLineage.value')
    expect(fn).toContain('workspaceGroups.value')
  })

  it('persists the mode globally and pins a detached window to workspace', () => {
    const seed = appSource.slice(appSource.indexOf('const sidebarMode = ref<SidebarMode>('))
    expect(seed.slice(0, 300)).toContain("isDetachedWindow ? 'workspace'")
    // Written only when it differs from the cache, so following another
    // window's change does not echo it back as a write of our own.
    expect(seed).toMatch(/watch\(sidebarMode, \(v\) => \{\s*if \(settingsGet\(SIDEBAR_MODE_KEY, 'workspace'\) !== v\) settingsSet\(SIDEBAR_MODE_KEY, v\)/)
  })

  it('follows a mode changed in another window, except in a detached one', () => {
    const at = appSource.indexOf('onSettingsChanged(')
    expect(at).toBeGreaterThan(-1)
    const sub = appSource.slice(at - 200, at + 400)
    expect(sub).toContain('!isDetachedWindow')
    expect(sub).toContain('keys.includes(SIDEBAR_MODE_KEY)')
    expect(sub).toContain('parseSidebarMode(settingsGet(SIDEBAR_MODE_KEY')
  })

  it('says how many panes on the stage an owning action left alone in free mode', () => {
    const note = body(appSource, 'noteOtherWorkspacesUntouched')
    expect(note).toContain("sidebarMode.value !== 'free'")
    expect(note).toContain('countUntouchedElsewhere(panesOnStage.value, panesInView.value')
    for (const fn of ['closeRunGroup', 'rebuildPanesViaResume', 'runRunGroupCtxAction']) {
      expect(body(appSource, fn), fn).toContain('noteOtherWorkspacesUntouched(')
    }
  })
})
