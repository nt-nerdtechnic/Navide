// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// `panes` holds every workspace this window has adopted, and group ids are not
// unique across workspaces — every project's default tab is `rg-default`.
// Deleting or closing a tab must therefore touch only the viewed workspace's
// panes. Selecting by group id alone reached the same-id panes of every other
// held workspace: deleting a project's last group wrote run_group_id '' into
// other projects' pane records, which then showed up under "manual" once you
// switched to them. App.vue cannot be mounted in this suite, so the scoping is
// asserted against the source.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function body(startMarker: string, endMarker: string): string {
  const start = appSource.indexOf(startMarker)
  expect(start, `missing: ${startMarker}`).toBeGreaterThan(-1)
  const end = appSource.indexOf(endMarker, start)
  expect(end, `missing: ${endMarker}`).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

describe('run-group tab edits stay inside the viewed workspace', () => {
  const close = body('async function closeRunGroup(', '\nasync function deleteRunGroup(')
  const del = body('async function deleteRunGroup(', '\n/** A tab\'s structure')

  it('deleteRunGroup picks affected panes from the viewed workspace only', () => {
    expect(del).not.toMatch(/panes\.value\.filter/)
    expect(del.match(/panesInView\.value\.filter/g)?.length).toBe(2)
  })

  it('closeRunGroup kills panes of the viewed workspace only', () => {
    expect(close).not.toMatch(/panes\.value\.filter/)
    expect(close.match(/panesInView\.value\.filter/g)?.length).toBe(2)
  })
})
