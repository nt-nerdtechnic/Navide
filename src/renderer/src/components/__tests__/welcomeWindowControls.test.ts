import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { needsDrawnWindowControls, setPlatformId } from '../../../../shared/osplat'

/**
 * W1: the opaque first-launch / Home Welcome overlay used to cover the app's
 * `.titlebar`, so Windows and Linux — which draw their window controls INTO
 * that bar — had a Home screen with no reachable minimise or close (only
 * Alt+F4). macOS was unaffected: its controls are OS-drawn over the window.
 *
 * The fix drops the overlay below the titlebar, gated on the same
 * `data-window-controls="drawn"` attribute `main.ts` sets only when
 * `needsDrawnWindowControls()` is true. These are the invariants that keep the
 * fix working AND keep macOS a pixel unchanged; they are asserted from source
 * because a stylesheet rule keyed on an ancestor attribute is not something
 * jsdom computes.
 */

const here = dirname(fileURLToPath(import.meta.url))
const rendererSrc = join(here, '..', '..')
const read = (rel: string): string => readFileSync(join(rendererSrc, rel), 'utf-8')

describe('W1: Welcome window controls on Windows/Linux', () => {
  const BASELINE = 'darwin'
  const asPlatform = (id: 'darwin' | 'win32' | 'linux', fn: () => void): void => {
    setPlatformId(id)
    try {
      fn()
    } finally {
      setPlatformId(BASELINE)
    }
  }

  it('applies only where the controls are drawn — never on macOS', () => {
    // The gate the CSS keys on: macOS never gets `data-window-controls="drawn"`,
    // so its Welcome overlay keeps `inset: 0` unchanged.
    asPlatform('darwin', () => expect(needsDrawnWindowControls()).toBe(false))
    asPlatform('win32', () => expect(needsDrawnWindowControls()).toBe(true))
    asPlatform('linux', () => expect(needsDrawnWindowControls()).toBe(true))
  })

  it("main.ts sets data-window-controls='drawn' only behind that gate", () => {
    const main = read('main.ts')
    expect(main).toContain('needsDrawnWindowControls()')
    expect(main).toContain("dataset.windowControls = 'drawn'")
    // The attribute write must be guarded by the gate, not unconditional.
    expect(main).toMatch(/if\s*\(\s*needsDrawnWindowControls\(\)\s*\)\s*\{[^}]*dataset\.windowControls\s*=\s*'drawn'/s)
  })

  it('the Welcome overlay override is gated on that attribute, not global', () => {
    const welcome = read('components/Welcome.vue')
    // The rule that lowers the overlay must be scoped to the drawn-controls
    // attribute — a bare `.welcome-overlay { top }` would move it on macOS too.
    expect(welcome).toMatch(/html\[data-window-controls=['"]drawn['"]\]\s+\.welcome-overlay\s*\{\s*top:/)
    // And it must use the shared titlebar-height variable, not a hardcoded px.
    expect(welcome).toMatch(/html\[data-window-controls=['"]drawn['"]\]\s+\.welcome-overlay\s*\{\s*top:\s*var\(--titlebar-height/)
  })

  it('titlebar height has a single source of truth', () => {
    const app = read('App.vue')
    // Defined once…
    expect(app).toMatch(/--titlebar-height:\s*38px/)
    // …and consumed by both the bar and the padding that reserves room for it,
    // so the Welcome overlay can never drift from the bar it sits below.
    expect(app).toMatch(/height:\s*var\(--titlebar-height\)/)
    expect(app).toMatch(/padding-top:\s*var\(--titlebar-height\)/)
    // The `.app` top padding is no longer a hardcoded 38px that could drift.
    expect(app).not.toMatch(/padding-top:\s*38px/)
  })
})
