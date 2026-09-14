// The window's own buttons must outrank every layer the app can draw.
//
// On Windows and Linux the minimise / maximise / close buttons are ours to
// draw — the OS draws none over a frameless window. That makes them the one
// piece of UI with no in-app fallback: cover them and the window can only be
// left with Alt+F4. macOS is immune and always was, because its traffic lights
// are painted by the compositor above the page, which is exactly the guarantee
// this test exists to reproduce for the other two platforms.
//
// It had already been broken 25 times over before anyone noticed once. The
// cluster lived inside `.titlebar`, which is `position: absolute; z-index: 200`
// and therefore a stacking context of its own: no z-index on a child of it can
// beat a `position: fixed` overlay outside it, and `position: fixed` does not
// escape a stacking context either. Every dialog, scrim and popover in the app
// (999 … 3100) sat on top of the buttons. The fix teleports the cluster to
// <body>, into the root stacking context, where `--z-window-controls` can
// actually win — and this test is what keeps the 26th overlay from undoing it.
//
// It is a source scan rather than a mount for the same reason
// stackingOrder.test.ts is: what breaks this rule is a component nobody has
// written yet. The failure mode is "not covered", so the assertion has to be
// about the whole tree, not about the files somebody remembered.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const RENDERER = resolve(here, '../..')
const TOKENS_CSS = resolve(
  here,
  '../../../../../packages/plugin-ui/src/foundation/styles/tokens/semantic.css',
)

/**
 * Every `--z-*` token, read from the stylesheet that defines them.
 *
 * Read rather than restated: a copy here would keep passing after somebody
 * changed a token's value, which is precisely the kind of green this test
 * must not produce.
 */
function tokens(): Map<string, number> {
  const css = readFileSync(TOKENS_CSS, 'utf8')
  const found = new Map<string, number>()
  for (const m of css.matchAll(/(--z-[\w-]+):\s*(\d+)\s*;/g)) found.set(m[1], Number(m[2]))
  return found
}

/**
 * A z-index as it is actually written, resolved to the number the browser
 * would compute — or `null`, which this test treats as a failure rather than
 * as something to skip.
 *
 * Deliberately narrow: a plain integer, a token, a token with a numeric
 * fallback, and a token plus or minus a constant, which covers every form in
 * the tree today. Anything else is a form nobody has thought about against
 * this rule yet, and the right response to that is a red test, not a silent
 * pass over it.
 */
function resolveZ(raw: string, vars: Map<string, number>): number | null {
  let expr = raw.trim().replace(/\s+/g, ' ')
  const calc = expr.match(/^calc\((.*)\)$/)
  if (calc) expr = calc[1].trim()

  const substituted = expr.replace(
    /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*?)\s*)?\)/g,
    (_all, name: string, fallback: string | undefined) => {
      const value = vars.get(name)
      if (value !== undefined) return String(value)
      if (fallback !== undefined && /^-?\d+$/.test(fallback.trim())) return fallback.trim()
      return 'UNRESOLVED'
    },
  )
  if (substituted.includes('UNRESOLVED')) return null

  if (/^-?\d+$/.test(substituted)) return Number(substituted)
  const sum = substituted.match(/^(-?\d+) ([+-]) (\d+)$/)
  if (sum) return sum[2] === '+' ? Number(sum[1]) + Number(sum[3]) : Number(sum[1]) - Number(sum[3])
  return null
}

type Layer = { file: string; line: number; raw: string; z: number | null }

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules' && entry !== '__tests__') walk(full, out)
      continue
    }
    if (/\.(vue|css|ts|js)$/.test(entry)) out.push(full)
  }
  return out
}

const lineOf = (source: string, index: number): number => source.slice(0, index).split('\n').length

/**
 * Every full-viewport-capable layer in the renderer: anything that combines
 * `position: fixed` with a z-index, whether written as a CSS rule or assigned
 * to `element.style` from TypeScript.
 *
 * The imperative half is not hypothetical. Two `inset: 0` sheets in
 * useTerminal.ts carried a hardcoded `zIndex: '99999'` for months, and
 * stackingOrder.test.ts — the test whose name promises nothing is hardcoded
 * above the notification band — never saw them, because it reads `.vue` and
 * `.css` for `z-index:` and these are `.ts` files spelling it `zIndex`.
 *
 * Plugin bundles under plugins/ are deliberately out of scope: they render
 * inside a <webview> guest, a separate document that cannot paint over the
 * host's chrome however it stacks itself.
 */
function layers(): Layer[] {
  const vars = tokens()
  const found: Layer[] = []

  for (const full of walk(RENDERER)) {
    const file = full.slice(RENDERER.length + 1)
    const source = readFileSync(full, 'utf8')

    if (full.endsWith('.vue') || full.endsWith('.css')) {
      // Comments first: several of these rules are introduced by a comment that
      // quotes the very declarations being matched.
      const styles = full.endsWith('.css')
        ? [{ text: source, offset: 0 }]
        : [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => ({
            text: m[1],
            offset: m.index! + m[0].indexOf(m[1]),
          }))

      for (const block of styles) {
        const clean = stripComments(block.text)
        // Innermost rule bodies only — a selector list containing braces is a
        // wrapper (@media, @supports) and its own body holds no declarations.
        for (const rule of clean.matchAll(/\{([^{}]*)\}/g)) {
          const body = rule[1]
          if (!/position\s*:\s*fixed/.test(body)) continue
          const z = body.match(/z-index\s*:\s*([^;]+);/)
          if (!z) continue
          found.push({
            file,
            line: lineOf(source, block.offset + rule.index!),
            raw: z[1].trim(),
            z: resolveZ(z[1], vars),
          })
        }
      }
      if (!full.endsWith('.vue')) continue
    }

    if (/\.(ts|js)$/.test(full) || full.endsWith('.vue')) {
      // An object literal handed to `Object.assign(el.style, …)` or equivalent.
      // Matched by walking back to the brace that opens it, which is enough for
      // the shape these are written in and keeps the test out of the business
      // of parsing TypeScript.
      for (const m of source.matchAll(/zIndex\s*:\s*(['"`])([^'"`]*)\1/g)) {
        const open = source.lastIndexOf('{', m.index!)
        const close = source.indexOf('}', m.index!)
        if (open < 0 || close < 0) continue
        const literal = source.slice(open, close)
        if (!/position\s*:\s*['"`]fixed['"`]/.test(literal)) continue
        found.push({ file, line: lineOf(source, m.index!), raw: m[2].trim(), z: resolveZ(m[2], vars) })
      }
    }
  }
  return found
}

const CONTROLS = join(RENDERER, 'components/WindowControls.vue')
const controlsSource = (): string => readFileSync(CONTROLS, 'utf8')

describe('window controls outrank every overlay', () => {
  it('is actually scanning something', () => {
    // A scan that matches nothing passes every assertion below it. This number
    // has no meaning beyond "the scanner did not come back empty" — it is the
    // count at the time of writing, rounded well down, and there is no reason
    // to raise it when the app grows.
    expect(layers().length).toBeGreaterThan(55)
    expect(tokens().get('--z-window-controls')).toBeGreaterThan(0)
  })

  it('can read every z-index it found', () => {
    // The one that matters most. A form this test cannot evaluate would be
    // skipped silently, and a silently skipped overlay is the whole bug: the
    // next `z-index: var(--something-new)` has to turn this red and be dealt
    // with, not slip past as "no layers over the limit".
    const unreadable = layers().filter((l) => l.z === null)
    expect(unreadable.map((l) => `${l.file}:${l.line} → ${l.raw}`)).toEqual([])
  })

  it('leaves nothing able to cover the minimise and close buttons', () => {
    const ceiling = tokens().get('--z-window-controls')!
    const over = layers()
      .filter((l) => l.file !== 'components/WindowControls.vue')
      .filter((l) => l.z !== null && l.z >= ceiling)

    // Anything listed here is a layer that, on Windows and Linux, leaves the
    // window with no close button while it is open. Give it a z-index inside
    // one of the bands in semantic.css instead of a number that beats them all.
    expect(over.map((l) => `${l.file}:${l.line} → ${l.raw} (${l.z})`)).toEqual([])
  })

  it('has no literal large enough to be aiming past the bands', () => {
    // A cheap net beside the one above, and the shape that actually shipped:
    // `zIndex: '99999'`, a number picked to beat whatever was on screen that
    // day. Catches it wherever it is written, without having to work out
    // whether the element is positioned.
    const ceiling = tokens().get('--z-window-controls')!
    const big: string[] = []
    for (const full of walk(RENDERER)) {
      const source = readFileSync(full, 'utf8')
      for (const m of source.matchAll(/z-?[iI]ndex['"]?\s*:\s*['"]?(\d{4,})/g)) {
        if (Number(m[1]) >= ceiling) {
          big.push(`${full.slice(RENDERER.length + 1)}:${lineOf(source, m.index!)} → ${m[1]}`)
        }
      }
    }
    expect(big).toEqual([])
  })
})

describe('the structure that makes the z-index mean anything', () => {
  // Without these, the rule above is a promise the CSS cannot keep: a cluster
  // left inside `.titlebar` is sealed into that bar's stacking context and its
  // z-index is compared against its siblings there, not against the overlays.
  it('teleports the cluster out of the title bar', () => {
    expect(controlsSource()).toMatch(/<Teleport[^>]*to="body"/)
  })

  it('pins the teleported cluster to the viewport at the controls layer', () => {
    const rule = controlsSource().match(/\.win-controls \{[\s\S]*?\}/)![0]
    expect(rule).toMatch(/position:\s*fixed/)
    expect(rule).toMatch(/z-index:\s*var\(--z-window-controls\)/)
    // `height: 100%` would be the viewport now that this lives on <body>.
    expect(rule).not.toMatch(/height:\s*100%/)
  })

  it('keeps the title bar it was lifted out of exactly as it was', () => {
    // The premise of this whole test: `.titlebar` is a stacking context, and
    // nothing here quietly stopped it from being one to make the numbers work.
    const app = readFileSync(join(RENDERER, 'App.vue'), 'utf8')
    const titlebar = app.match(/\.titlebar \{[\s\S]*?\}/)![0]
    expect(titlebar).toMatch(/position:\s*absolute/)
    expect(titlebar).toMatch(/z-index:\s*200/)
  })

  it('never gives the host bar a position of its own', () => {
    // W1/L2: the cluster used to be absolutely positioned inside the bar, so a
    // global rule made the bar a positioning context. It beat
    // `.titlebar { position: absolute }`, pulling the bar out of its overlay
    // into the grid flow — an empty band above the content on Linux, and the
    // controls buried under the Welcome overlay on Windows and Linux.
    // Teleporting removed the need for it, so the declaration is gone rather
    // than defused; a `:where()` version would pass the old test and still be
    // a rule waiting to be "tidied up" into a specific one.
    const globalStyles = stripComments(controlsSource().split('<style>').pop()!)
    expect(globalStyles).toMatch(/:has\(>\s*\.win-controls-anchor\)/)
    expect(globalStyles).not.toMatch(/position\s*:/)
  })

  it('leaves behind the marker the bar padding rule matches on', () => {
    // The cluster leaves; the room reserved for it must not. Without this the
    // bar falls back to the 80px macOS traffic-light gutter on the wrong side
    // and its own content slides under the buttons.
    expect(controlsSource()).toMatch(/class="win-controls-anchor"/)
    expect(controlsSource()).toMatch(/aria-hidden="true"/)
  })
})
