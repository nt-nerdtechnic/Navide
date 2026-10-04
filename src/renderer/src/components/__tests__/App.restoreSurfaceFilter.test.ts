// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// An embedded AI panel (AiCliDock) files its own restore record in the same
// project.panes list the main window restores from, marked with its `surface`.
// The main window must never bring such a record back as one of its panes: the
// panel's window owns it and reattaches it itself. Records written before the
// field existed have no surface and read as main, so the restore set of every
// existing workspace stays exactly what it was.
//
// Source-scanned, like the other App.*.test.ts files: App.vue cannot be
// mounted, since backend and terminal lifecycles start on mount.
const read = (p: string): string => readFileSync(resolve(process.cwd(), p), 'utf8')
const appSource = read('src/renderer/src/App.vue')

function body(source: string, name: string): string {
  const pat = `async function ${name}(`
  const at = source.indexOf(pat)
  if (at < 0) throw new Error(`${name} not found`)
  const rest = source.slice(at + pat.length)
  const next = /\n(?:async )?function \w+/.exec(rest)
  return source.slice(at, at + pat.length + (next ? next.index : 20000))
}

describe('main-window restore leaves embedded panel records alone', () => {
  const restore = body(appSource, 'restoreWorkspacePanes')
  const surfaceFilter = "toRestore = toRestore.filter((p) => !p.surface || p.surface === 'main')"

  it('filters dock records out of the restore set', () => {
    expect(restore).toContain(surfaceFilter)
  })

  it('applies the filter after the detached-group filter and before dedupe', () => {
    const detached = restore.indexOf('toRestore = toRestore.filter((p) => !detachedGroupIds.value.has(')
    const surface = restore.indexOf(surfaceFilter)
    const dedupe = restore.indexOf('toRestore = dedupeRestorablePanes(toRestore)')
    expect(detached).toBeGreaterThan(0)
    expect(surface).toBeGreaterThan(detached)
    expect(dedupe).toBeGreaterThan(surface)
  })

  it('starts from the spawned records, as before', () => {
    expect(restore).toContain("let toRestore = allProjectPanes.filter((p) => p.spawn_status === 'spawned')")
  })
})
