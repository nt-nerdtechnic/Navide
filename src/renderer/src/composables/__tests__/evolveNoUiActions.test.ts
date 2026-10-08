// Security guard: workspace self-evolution settings and runs may only be
// changed by the user clicking in EvolvePanel. An agent can call any
// registered ui.* command through ui_invoke, so a command that reached
// evolve.set / evolve.run_now would let it widen the permission scope
// (propose-only → fix) or start runs itself, bypassing the user.
// This scans the shipped renderer and plugin sources, not a mounted app, so
// a command registered anywhere (App.vue included) is caught.
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(__dirname, '../../../../..')
const SCAN = ['src/renderer/src', 'plugins', 'packages']

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__' || name === 'dist' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) sources(p, out)
    else if (/\.(ts|vue)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p)
  }
  return out
}

const files = SCAN.flatMap((d) => sources(join(ROOT, d))).map((p) => ({
  rel: relative(ROOT, p),
  // latin1 keeps App.vue's NUL byte from tripping a UTF-8 decode.
  text: readFileSync(p, 'latin1'),
}))

const hits = (re: RegExp) => files.filter((f) => re.test(f.text)).map((f) => f.rel).sort()

describe('evolve has no ui.* action an agent could invoke', () => {
  it('scans the real sources', () => {
    expect(files.some((f) => f.rel.endsWith('src/renderer/src/App.vue'))).toBe(true)
  })

  it('registers no command whose id mentions evolve', () => {
    expect(hits(/registerCommand\(\s*['"`][^'"`]*evolve/i)).toEqual([])
  })

  it('sends evolve.set / evolve.run_now only from useEvolve', () => {
    // Quoted string literals only: backticks also mark names in comments.
    expect(hits(/['"]evolve\.(set|run_now)['"]/)).toEqual(['src/renderer/src/composables/useEvolve.ts'])
  })

  it('calls the evolve write helpers only from the panel', () => {
    expect(hits(/\bevolve(Set|RunNow)\b/)).toEqual([
      'src/renderer/src/components/EvolvePanel.vue',
      'src/renderer/src/composables/useEvolve.ts',
    ])
  })
})
