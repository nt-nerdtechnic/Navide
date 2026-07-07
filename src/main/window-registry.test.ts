import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseRegistryDoc, pendingFromDoc, WindowRegistry } from './window-registry'

describe('parseRegistryDoc', () => {
  it('returns a clean empty doc for missing or corrupt content', () => {
    for (const text of [null, '', 'not json', '[]', '{"windows": "nope"}']) {
      expect(parseRegistryDoc(text)).toEqual({
        version: 1, cleanExit: true, windows: [], snapshot: [], restoreOnLaunch: true,
      })
    }
  })

  it('parses a valid doc and drops malformed window entries', () => {
    const doc = parseRegistryDoc(JSON.stringify({
      version: 1,
      cleanExit: false,
      windows: [
        { workspace_path: '/a', bounds: { x: 0, y: 0, width: 800, height: 600 } },
        { workspace_path: '' }, // empty → dropped
        { nope: true }, // malformed → dropped
        { workspace_path: '/b' },
      ],
    }))
    expect(doc.cleanExit).toBe(false)
    expect(doc.windows).toEqual([
      { workspace_path: '/a', bounds: { x: 0, y: 0, width: 800, height: 600 } },
      { workspace_path: '/b' },
    ])
  })
})

describe('pendingFromDoc', () => {
  const base = { snapshot: [], restoreOnLaunch: true }

  it('offers nothing after a clean exit', () => {
    expect(pendingFromDoc({ version: 1, cleanExit: true, windows: [{ workspace_path: '/a' }], ...base })).toBeNull()
  })

  it('offers nothing when no workspaces were open', () => {
    expect(pendingFromDoc({ version: 1, cleanExit: false, windows: [], ...base })).toBeNull()
  })

  it('offers the windows after an unclean exit', () => {
    expect(pendingFromDoc({ version: 1, cleanExit: false, windows: [{ workspace_path: '/a' }], ...base }))
      .toEqual([{ workspace_path: '/a' }])
  })
})

describe('WindowRegistry', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'win-reg-'))
    file = join(dir, 'open-windows.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const readDoc = (): unknown => JSON.parse(readFileSync(file, 'utf-8'))

  it('simulated crash: next launch sees the previous windows as pending', () => {
    const run1 = new WindowRegistry(file)
    expect(run1.readPendingAndReset()).toBeNull() // first run ever
    run1.setWorkspace(1, '/ws/alpha')
    run1.setWorkspace(2, '/ws/beta')
    // ...crash: no markCleanExit, no remove...

    const run2 = new WindowRegistry(file)
    expect(run2.readPendingAndReset()).toEqual([
      { workspace_path: '/ws/alpha' },
      { workspace_path: '/ws/beta' },
    ])
    // and the offer is one-shot: a third run (also unclean) has no windows
    const run3 = new WindowRegistry(file)
    expect(run3.readPendingAndReset()).toBeNull()
  })

  it('clean exit: next launch has nothing to restore', () => {
    const run1 = new WindowRegistry(file)
    run1.readPendingAndReset()
    run1.setWorkspace(1, '/ws/alpha')
    run1.markCleanExit()

    const run2 = new WindowRegistry(file)
    expect(run2.readPendingAndReset()).toBeNull()
  })

  it('clean exit snapshots open windows for auto-restore, surviving the remove() sweep', () => {
    const run1 = new WindowRegistry(file)
    run1.readPendingAndReset()
    run1.setWorkspace(1, '/ws/alpha')
    run1.setWorkspace(2, '/ws/beta')
    run1.markCleanExit()
    // Quit sequence: each window closes → remove(). This used to wipe the
    // snapshot to [] (the bug); it must survive.
    run1.remove(1)
    run1.remove(2)

    const run2 = new WindowRegistry(file)
    expect(run2.readPendingAndReset()).toBeNull() // clean exit → no crash banner
    expect(run2.cleanExitRestore()).toEqual([
      { workspace_path: '/ws/alpha' },
      { workspace_path: '/ws/beta' },
    ])
  })

  it('restoreOnLaunch=false suppresses clean-exit auto-restore and persists across reset', () => {
    const run1 = new WindowRegistry(file)
    run1.readPendingAndReset()
    run1.setWorkspace(1, '/ws/alpha')
    run1.setRestoreOnLaunch(false)
    run1.markCleanExit()
    run1.remove(1)

    const run2 = new WindowRegistry(file)
    run2.readPendingAndReset()
    expect(run2.cleanExitRestore()).toEqual([]) // setting off → nothing
    expect(run2.getRestoreOnLaunch()).toBe(false) // setting preserved across the reset
  })

  it('a crash yields a restore banner but no clean-exit auto-restore', () => {
    const run1 = new WindowRegistry(file)
    run1.readPendingAndReset()
    run1.setWorkspace(1, '/ws/alpha')
    // ...crash: no markCleanExit, no remove...

    const run2 = new WindowRegistry(file)
    expect(run2.readPendingAndReset()).toEqual([{ workspace_path: '/ws/alpha' }]) // banner
    expect(run2.cleanExitRestore()).toEqual([]) // not clean → no auto-restore
  })

  it('closing a window or returning to Welcome removes its entry', () => {
    const reg = new WindowRegistry(file)
    reg.readPendingAndReset()
    reg.setWorkspace(1, '/ws/alpha')
    reg.setWorkspace(2, '/ws/beta')
    reg.remove(1)
    reg.setWorkspace(2, '') // back to Welcome
    expect(readDoc()).toMatchObject({ cleanExit: false, windows: [] })
  })

  it('keeps bounds attached to the window entry across workspace updates', () => {
    const reg = new WindowRegistry(file)
    reg.readPendingAndReset()
    reg.setWorkspace(1, '/ws/alpha')
    reg.setBounds(1, { x: 5, y: 6, width: 700, height: 500 })
    // bounds writes are debounced — force a flush via an immediate-persist op
    reg.setWorkspace(1, '/ws/alpha')
    expect(readDoc()).toMatchObject({
      windows: [{ workspace_path: '/ws/alpha', bounds: { x: 5, y: 6, width: 700, height: 500 } }],
    })
  })

  it('ignores bounds for untracked (Welcome) windows', () => {
    const reg = new WindowRegistry(file)
    reg.readPendingAndReset()
    reg.setBounds(9, { x: 0, y: 0, width: 100, height: 100 })
    reg.markCleanExit() // flush
    expect(readDoc()).toMatchObject({ windows: [] })
  })

  it('survives a corrupt file on disk', () => {
    writeFileSync(file, '{truncated', 'utf-8')
    const reg = new WindowRegistry(file)
    expect(reg.readPendingAndReset()).toBeNull()
  })
})
