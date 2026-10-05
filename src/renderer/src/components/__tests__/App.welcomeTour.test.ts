// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Mounting App starts backend/terminal/settings lifecycles, so — like the other
// App.*.test.ts files — these assert against the source text. The decisions
// behind the wiring are unit-tested in lib/__tests__/welcomeTour.test.ts and
// composables/__tests__/useWelcomeTour.test.ts.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function functionBody(name: string): string {
  const start = appSource.indexOf(`function ${name}(`)
  expect(start).toBeGreaterThan(-1)
  return appSource.slice(start, appSource.indexOf('\n}', start))
}

describe('first-run welcome tour', () => {
  it('is marked pending only when the wizard was shown for a first run, not a rerun from Settings', () => {
    expect(functionBody('reopenOnboarding')).toContain('onboardingRerun = true')
    const complete = functionBody('completeOnboarding')
    expect(complete).toMatch(/if \(!onboardingRerun\) welcomeTour\.markFirstRun\(\)/)
    expect(complete).toContain('onboardingRerun = false')
  })

  it('is never marked from the status check, so an upgraded install never sees it', () => {
    expect(functionBody('checkOnboarding')).not.toContain('markFirstRun')
    expect(functionBody('evaluateWhatsNew')).not.toContain('welcomeTour')
  })

  it('waits for the shell: onboarding settled for real, a workspace open, nothing modal on screen', () => {
    const poll = functionBody('pollWelcomeTour')
    expect(poll).toContain('onboardingComplete.value !== true')
    expect(poll).toContain('onboardingCheckFailed.value')
    expect(poll).toContain('!workspaceSelected.value')
    expect(poll).toContain('mainModalOpen()')
    expect(poll.indexOf('mainModalOpen()')).toBeLessThan(poll.indexOf('welcomeTour.startMain()'))
  })

  it('starts the pane part only for a pane on stage that paneTourReady accepts', () => {
    const poll = functionBody('pollWelcomeTour')
    expect(poll).toContain('panesOnStage.value')
    expect(poll).toContain('paneTourReady(')
    expect(poll).toContain('loginPaneIds')
    expect(poll).toContain('welcomeTour.startPane()')
  })

  it('stops polling once the tour is off', () => {
    const poll = functionBody('pollWelcomeTour')
    expect(poll).toMatch(/stage === 'off'\) \{\s+stopWelcomeTourPoll\(\)/)
  })

  it('routes Help → First-Run Tour… to the replay', () => {
    expect(functionBody('onMenuAction')).toMatch(/action === 'show-welcome-tour'\) \{\s+replayWelcomeTour\(\)/)
    expect(functionBody('replayWelcomeTour')).toContain('welcomeTour.replay()')
  })

  it('anchors the settings step on the title-bar gear and the groups step on the tab bar', () => {
    expect(appSource).toMatch(/<button class="titlebar-gear" data-tour="settings"/)
    expect(appSource).toMatch(/<StageTabBar\s+v-if="stageTabs\.length > 0"\s+data-tour="stage-tabs"/)
  })
})
