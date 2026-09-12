import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isMac, normalizePlatformId, platformId, setPlatformId } from './osplat'

// Every test file that switches the platform with setPlatformId has to hand it
// back afterwards. Sixteen of them handed back `normalizePlatformId(
// process.platform)` — the host — which reads as the safe choice and is the
// wrong one. Vitest isolates each file, so a setup file saying "run everything
// as win32" injects afresh per file; the host restore then discarded it at the
// first test in the file that switched, and every later test in that file
// silently ran as the host. Worse than a gap: osplat.test.ts's "resolves from
// process.platform when nothing was injected" *passed* under injection,
// because the injection had been wiped before it ran. "Run the whole
// front-end suite as Windows on a Linux runner" is the cheapest
// cross-platform check we have, and it needs the baseline to be whatever the
// file *loaded with*, not the machine.
//
// Two tests here. The first shows the mechanism works in-process. The second
// is the ratchet: no test file may restore to the host, because the host form
// will always look safer to whoever touches the file next.

/** Simulate a setup file: inject before anything below evaluates. */
const HOST = normalizePlatformId(process.platform)
const INJECTED = HOST === 'win32' ? 'linux' : 'win32'
setPlatformId(INJECTED)
// What every converted file does at its top.
const BASELINE = platformId()

describe('a load-time baseline keeps a suite-wide platform injection alive', () => {
  afterEach(() => setPlatformId(BASELINE))

  it('captured the injection, not the host', () => {
    expect(BASELINE).toBe(INJECTED)
    expect(BASELINE).not.toBe(HOST)
  })

  it('a test can switch platforms for its own purposes', () => {
    setPlatformId('darwin')
    expect(isMac()).toBe(true)
  })

  it('and the next test still sees the injection, not the host', () => {
    expect(platformId()).toBe(INJECTED)
  })

  it('restoring to the host would have discarded it — the shape the ratchet bans', () => {
    setPlatformId(normalizePlatformId(process.platform))
    expect(platformId()).toBe(HOST)
    expect(platformId()).not.toBe(INJECTED)
  })
})

// ── the ratchet ──────────────────────────────────────────────────────────────

const REPO_ROOT = resolve(__dirname, '..', '..')
const TEST_DIRS = ['src', 'packages', 'plugins', 'tests']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'dist-plugins', '.git'])

function testFiles(): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(test|spec)\.tsx?$/.test(name) && full !== __filename) found.push(full)
    }
  }
  for (const dir of TEST_DIRS) walk(join(REPO_ROOT, dir))
  return found.sort()
}

/** Restoring the platform to the host rather than to the load-time baseline. */
export const HOST_RESTORE_RE = /setPlatformId\(\s*normalizePlatformId\(\s*process\.platform\s*\)\s*\)/

describe('no test restores the platform to the host', () => {
  it('every setPlatformId reset goes back to a load-time BASELINE', () => {
    const offenders = testFiles()
      .filter((f) => HOST_RESTORE_RE.test(readFileSync(f, 'utf8')))
      .map((f) => relative(REPO_ROOT, f).split('\\').join('/'))
    expect(
      offenders,
      'these tests restore the platform to normalizePlatformId(process.platform) — the host — ' +
        'which discards an injected platform for the rest of that file. Capture ' +
        '`const BASELINE = platformId()` at the top of the file and restore to that'
    ).toEqual([])
  })

  it('still matches the shape it bans', () => {
    expect(HOST_RESTORE_RE.test('afterEach(() => setPlatformId(normalizePlatformId(process.platform)))')).toBe(true)
    expect(HOST_RESTORE_RE.test('setPlatformId( normalizePlatformId( process.platform ) )')).toBe(true)
    expect(HOST_RESTORE_RE.test('afterEach(() => setPlatformId(BASELINE))')).toBe(false)
    // Reading the host to *classify* the host (a kernel-fact gate) is not a restore.
    expect(HOST_RESTORE_RE.test("const hostIsWindows = normalizePlatformId(process.platform) === 'win32'")).toBe(false)
  })
})
