// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Mounting App starts backend/terminal/settings lifecycles, so — like the other
// App.*.test.ts files — these assert against the source text. The decisions
// behind the wiring are unit-tested in lib/__tests__/welcomeTour.test.ts,
// composables/__tests__/useWelcomeTour.test.ts and
// components/__tests__/CoachMark.test.ts.
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

  it('waits for onboarding to settle for real and for nothing modal on screen', () => {
    const poll = functionBody('pollWelcomeTour')
    expect(poll).toContain('onboardingComplete.value !== true')
    expect(poll).toContain('onboardingCheckFailed.value')
    expect(poll).toMatch(/if \(mainModalOpen\(\) \|\| cliHealthGuide\.value\) return/)
    expect(poll.indexOf('mainModalOpen()')).toBeLessThan(poll.indexOf('welcomeTour.start()'))
  })

  // 20:44: "the tour only ever appears on a first install; a workspace record
  // means it is not one" — and then the whole tour is off.
  it('calls the tour off before its first bubble when a workspace is already open', () => {
    const poll = functionBody('pollWelcomeTour')
    const first = poll.slice(poll.indexOf('if (welcomeTour.savedStep() === 0) {'))
    expect(first).toMatch(/^if \(welcomeTour\.savedStep\(\) === 0\) \{\s+if \(workspaceSelected\.value\) \{\s+welcomeTour\.cancel\(\)/)
    expect(first.indexOf('welcomeTourRecordsChecked')).toBeLessThan(first.indexOf('welcomeTour.start()'))
  })

  it('checks the recent-workspace list once before the first bubble, and starts only when it is empty', () => {
    const check = functionBody('checkWelcomeTourRecords')
    expect(check).toContain("backend.send<{ recent?: unknown[] }>('workspace.list_recent', {})")
    expect(check).toMatch(/if \(!resp\.ok \|\| \(resp\.payload\?\.recent\?\.length \?\? 0\) > 0\) welcomeTour\.cancel\(\)/)
    expect(check).toMatch(/catch \{\s+welcomeTour\.cancel\(\)/)
  })

  it('stops polling once the tour is off', () => {
    expect(functionBody('pollWelcomeTour')).toMatch(/if \(!welcomeTour\.pending\(\)\) \{\s+stopWelcomeTourPoll\(\)/)
  })

  it('routes Help → First-Run Tour… to the replay', () => {
    expect(functionBody('onMenuAction')).toMatch(/action === 'show-welcome-tour'\) \{\s+replayWelcomeTour\(\)/)
    expect(functionBody('replayWelcomeTour')).toContain('welcomeTour.replay()')
  })

  it('mounts the coach marks with the steps, the facts, where to start and when to step aside', () => {
    expect(appSource).toMatch(
      /<CoachMark\s+v-if="welcomeTourActive"\s+:key="welcomeTourActive"\s+:steps="WELCOME_STEPS"\s+:facts="welcomeFacts"\s+:start-index="welcomeTourStartIndex"\s+:replay="welcomeTourActive === 'replay'"\s+:suspended="welcomeTourSuspended"\s+@progress="welcomeTour\.progress"\s+@finish="onWelcomeTourFinish"/,
    )
    const start = appSource.indexOf('const welcomeTourSuspended = computed(')
    expect(start).toBeGreaterThan(-1)
    expect(appSource.slice(start, start + 200)).toMatch(/mainModalOpen\(\) \|\| !!cliHealthGuide\.value/)
  })

  it('reads a finished turn, not a keystroke, as a first instruction already given', () => {
    // Answering a CLI's trust prompt is a keystroke too.
    expect(functionBody('welcomeFacts')).toContain('paneTurnCompleteAt.get(id)')
  })

  it('tells the tour about an @ pick and a pane drop where they already happen', () => {
    expect(functionBody('rememberMentionPick')).toContain("welcomeTour.notify('mention')")
    expect(functionBody('injectPaneContextSources')).toContain("welcomeTour.notify('drop')")
    const badge = readFileSync(resolve(process.cwd(), 'src/renderer/src/components/UsageBadge.vue'), 'utf8')
    expect(badge).toContain("useWelcomeTour().notify('usage')")
  })

  it('says the tour is done, and where to see it again, only when it was walked to the end', () => {
    const finish = functionBody('onWelcomeTourFinish')
    expect(finish).toContain('welcomeTour.finish(completed)')
    expect(finish).toMatch(/if \(completed\) notifyRestore\.toast\(i18n\.global\.t\('tour\.welcome\.finished'\)/)
  })

  // The first-run tour no longer rides the card engine: GuidedTour is the
  // release tour's alone again.
  it('leaves GuidedTour mounted for release tours only', () => {
    expect(appSource).toMatch(
      /<GuidedTour\s+v-if="activeTourSteps"\s+:steps="activeTourSteps"\s+:run-prepare="runTourPrepare"\s+@close="endTour"\s*\/>/,
    )
  })
})
