// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Closing a workspace also ends that workspace's Pipeline Manager panel
// (AiCliDock): it lives in a modal of this window, has no pane of its own here,
// and would otherwise keep running a CLI for a workspace the window let go of.
// The panel is reached by its surface through the backend — never by widening
// the pools the owning actions read, which stay exactly what they were. Kill
// all leaves the panel running (owner ruling Q11).
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

const killSurface = "sendQuiet('terminal.kill_surface', { surface: 'pm', workspace_path: closing })"

describe('closing a workspace ends its Pipeline Manager panel, and nothing else changes', () => {
  it('ends the pm panel of the workspace being closed', () => {
    expect(body(appSource, 'doCloseWorkspace')).toContain(killSurface)
  })

  it('captures and kills the panes exactly as before, then ends the panel', () => {
    const fn = body(appSource, 'doCloseWorkspace')
    const capture = fn.indexOf('const paneIdsToKill = panesInView.value.map((p) => p.id)')
    const kill = fn.indexOf('await onPipelineReset(paneIdsToKill)')
    const panel = fn.indexOf(killSurface)
    expect(capture).toBeGreaterThan(-1)
    expect(kill).toBeGreaterThan(capture)
    expect(panel).toBeGreaterThan(kill)
    // Exactly one, and only for the panel surface of this window.
    expect(fn.split('terminal.kill_surface').length - 1).toBe(1)
  })

  it('leaves kill all alone (Q11)', () => {
    expect(body(appSource, 'onKillAll')).not.toContain('kill_surface')
  })

  it('keeps panels out of the pools the owning actions read', () => {
    for (const name of ['panesInView', 'panesOnStage']) {
      const text = computedBody(appSource, name)
      expect(text, name).not.toMatch(/dock|surface/i)
    }
  })
})
