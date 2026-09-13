// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The App.vue half of "only the default skill loops". isLoopSkill itself is
// covered in lib/__tests__/promptSkills.test.ts; what cannot be asserted there
// is the WIRING inside togglePaneLoop — that a one-shot skill returns before
// any loop state is touched, and that the loop path itself was left alone.
// App.vue cannot be mounted by this suite, so the wiring is asserted against
// the source the way the other App.*.test.ts files do.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function togglePaneLoopBody(): string {
  const start = appSource.indexOf('async function togglePaneLoop(')
  expect(start).toBeGreaterThan(-1)
  return appSource.slice(start, appSource.indexOf('\n}\n', start))
}

describe('togglePaneLoop – one-shot skills', () => {
  it('sends a non-loop skill once and returns before arming any loop state', () => {
    const body = togglePaneLoopBody()
    const gate = body.indexOf('if (!isLoopSkill(skill))')
    expect(gate).toBeGreaterThan(-1)
    // The gate must come after the running-loop toggle-off branch (a click on
    // the lit badge still stops the loop) and before the optimistic badge.
    expect(body.indexOf('if (pane.loopActive)')).toBeLessThan(gate)
    expect(gate).toBeLessThan(body.indexOf('pane.loopActive = true'))
    const branch = body.slice(gate, body.indexOf('pane.loopActive = true'))
    // Plain prompt, not the loop-wrapped one, and nothing else arms.
    expect(branch).toContain("injectPane(paneId, skill.prompt, 'skill-cast', true)")
    expect(branch).toContain('return')
    for (const loopOnly of [
      'withLoopDoneInstruction',
      'startLoopLimitWatcher',
      'armLoopTurn',
      'bumpLoopGen',
      'loopSkillId',
      'loopMaxTurns',
    ]) {
      expect(branch).not.toContain(loopOnly)
    }
  })

  it('leaves the loop path intact for the default skill', () => {
    const body = togglePaneLoopBody()
    const loopPath = body.slice(body.indexOf('pane.loopActive = true'))
    expect(loopPath).toContain('withLoopDoneInstruction(skill.prompt)')
    expect(loopPath).toContain('pane.loopMaxTurns = skill.maxTurns')
    expect(loopPath).toContain('startLoopLimitWatcher(paneId)')
    expect(loopPath).toContain('armLoopTurn(paneId)')
  })
})
