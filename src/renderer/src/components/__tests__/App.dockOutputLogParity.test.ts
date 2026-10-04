// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dockOutputLogFile } from '@navide/plugin-shell'

// An embedded AI panel writes its conversation log where the main window
// writes a manual pane's: `<ws>/.agent-team/manual/<yyyymmdd>/<agent>-<id8>.log`.
// The main window builds that path inline in spawnPane, the panel through
// dockOutputLogFile — this pins the two to the same template so they cannot
// drift apart.
const read = (p: string): string => readFileSync(resolve(process.cwd(), p), 'utf8')
const appSource = read('src/renderer/src/App.vue')
const helperSource = read('src/renderer/src/platform/plugin-shell/lib/aiCliContext.ts')

const APP_YMD = "const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '')"
const APP_TEMPLATE = '`${opts.workspacePath}/.agent-team/manual/${ymd}/${opts.agentKey}-${id.slice(0, 8)}.log`'

describe('dock output log path matches the main window manual pane path', () => {
  it('App.vue still builds the manual log path with the same template', () => {
    expect(appSource).toContain(APP_YMD)
    expect(appSource).toContain(APP_TEMPLATE)
  })

  it('the dock helper uses the same date stamp and template', () => {
    expect(helperSource).toContain("toISOString().slice(0, 10).replace(/-/g, '')")
    const renamed = APP_TEMPLATE
      .replace('opts.workspacePath', 'workspacePath')
      .replace('opts.agentKey', 'agentKey')
      .replace('id.slice(0, 8)', 'paneId.slice(0, 8)')
    expect(helperSource).toContain(renamed)
  })

  it('renders the path for a known date', () => {
    expect(dockOutputLogFile('/ws/a', 'claude', 'ab12cd34-plans-ai-terminal', new Date('2026-10-04T06:00:00Z')))
      .toBe('/ws/a/.agent-team/manual/20261004/claude-ab12cd34.log')
  })
})
