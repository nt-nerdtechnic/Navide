// The Plans window was the one Host window still wearing the system's frame.
//
// Every other window in the app hides the title bar and draws its own, which
// is why `WindowControls` exists at all. This one did not, so on Windows and
// Linux it was the odd one out in a UI that is otherwise uniformly self-drawn.
// It also meant the window had no bar to put the controls in, which is the
// gap this closes.
//
// macOS deliberately does NOT change. Hiding the bar there would turn a window
// that ships with a system frame today into a self-drawn one — a visible
// change to a platform that is explicitly staying as it is, and one that buys
// nothing, because the traffic lights already work. So the frame is hidden
// only where the system draws no controls, and the bar renders under the same
// condition.
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { isMac, needsDrawnWindowControls, platformId, setPlatformId } from '../shared/osplat'
import { drawnFrameWhereNeeded, systemFrameUnlessMac } from './window-controls'

// Lives beside the main-process code it imports rather than with the other
// window-control tests: `tsconfig.web.json` does not include `src/main`, so a
// renderer-side test that imported the frame helper failed to typecheck. The
// renderer half is asserted from source text, which needs no such membership.
const here = dirname(fileURLToPath(import.meta.url))
const MAIN = here
const RENDERER = resolve(here, '../renderer/src')
const read = (p: string): string => readFileSync(p, 'utf-8')

// Restore whatever this file saw on load, not the host: a vitest setup file may
// have injected a platform, and restoring to the host would silently undo it.
const BASELINE = platformId()
const asPlatform = (id: 'darwin' | 'win32' | 'linux', fn: () => void): void => {
  setPlatformId(id)
  try {
    fn()
  } finally {
    setPlatformId(BASELINE)
  }
}

describe('the Plans window frame', () => {
  it('hides the system bar only where we draw the replacement', () => {
    asPlatform('darwin', () => {
      expect(isMac()).toBe(true)
      // Unchanged: no titleBarStyle at all, exactly as this window shipped.
      expect(drawnFrameWhereNeeded()).toEqual({})
    })
    for (const platform of ['win32', 'linux'] as const) {
      asPlatform(platform, () => {
        expect(drawnFrameWhereNeeded()).toEqual({ titleBarStyle: 'hidden' })
      })
    }
  })

  it('is the exact inverse of the plugin-window helper it sits beside', () => {
    // The two answer opposite questions and are easy to reach for by mistake.
    // A plugin contribution window draws no controls of its own, so it takes
    // the system's frame off macOS; this window draws its own, so it takes the
    // system's frame ONLY on macOS.
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      asPlatform(platform, () => {
        const system = 'titleBarStyle' in systemFrameUnlessMac()
        const drawn = 'titleBarStyle' in drawnFrameWhereNeeded()
        expect(system).toBe(!drawn)
      })
    }
  })

  it('is what the window is actually created with', () => {
    // The helper is only correct if the creation site uses it — asserted on
    // the source because the window is built inside an async IPC handler.
    const index = read(join(MAIN, 'index.ts'))
    const plansWindow = index.slice(index.indexOf("title: 'Plans',"))
    expect(plansWindow.slice(0, 900)).toContain('...drawnFrameWhereNeeded(),')
  })
})

describe('the Plans window title bar', () => {
  const planWindow = (): string => read(join(RENDERER, 'PlanWindowApp.vue'))

  it('renders only where the system draws no controls', () => {
    const source = planWindow()
    expect(source).toContain('needsDrawnWindowControls()')
    // Gated in the template, not merely computed — a bar rendered on macOS
    // would sit underneath the system's own.
    expect(source).toMatch(/v-if="drawsOwnTitleBar"[\s\S]{0,80}class="plan-titlebar"/)
    asPlatform('darwin', () => expect(needsDrawnWindowControls()).toBe(false))
    asPlatform('win32', () => expect(needsDrawnWindowControls()).toBe(true))
    asPlatform('linux', () => expect(needsDrawnWindowControls()).toBe(true))
  })

  it('carries the controls and a drag region, like every other bar', () => {
    const source = planWindow()
    expect(source).toContain('<WindowControls />')
    const rule = source.match(/\.plan-titlebar \{[\s\S]*?\}/)![0]
    expect(rule).toMatch(/-webkit-app-region:\s*drag/)
  })

  it('takes its height from the shared token rather than restating 38px', () => {
    const rule = planWindow().match(/\.plan-titlebar \{[\s\S]*?\}/)![0]
    expect(rule).toMatch(/height:\s*var\(--titlebar-height\)/)
    expect(rule).not.toMatch(/height:\s*38px/)
  })

  it('leaves no macOS traffic-light gutter on the left', () => {
    // `.titlebar` and `.ide-titlebar` both reserve 80px there because they are
    // hidden-bar windows on macOS too. This bar never renders on macOS, so the
    // same gutter would just be dead space on the only platforms that see it.
    const rule = planWindow().match(/\.plan-titlebar \{[\s\S]*?\}/)![0]
    expect(rule).not.toMatch(/padding-left:\s*8[0-9]px/)
    expect(rule).toMatch(/padding-left:\s*8px/)
  })

  it('puts the row into a wrapper so the bar is not squeezed out', () => {
    // The root was a `display: flex` row of side + document + dock. Adding the
    // bar makes it a column, and the row needs `min-height: 0` or it refuses to
    // shrink and pushes the bar off the top of a short window.
    const source = planWindow()
    expect(source).toContain('class="plan-window-body"')
    const root = source.match(/\.plan-window \{[\s\S]*?\}/)![0]
    expect(root).toMatch(/flex-direction:\s*column/)
    const body = source.match(/\.plan-window-body \{[\s\S]*?\}/)![0]
    expect(body).toMatch(/min-height:\s*0/)
    expect(body).toMatch(/flex:\s*1/)
  })
})
