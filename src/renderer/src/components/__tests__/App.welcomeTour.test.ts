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

  it('waits for onboarding to settle for real and for nothing modal on screen', () => {
    const poll = functionBody('pollWelcomeTour')
    expect(poll).toContain('onboardingComplete.value !== true')
    expect(poll).toContain('onboardingCheckFailed.value')
    expect(poll).toContain('mainModalOpen()')
    expect(poll.indexOf('mainModalOpen()')).toBeLessThan(poll.indexOf('welcomeTour.startWelcome()'))
  })

  it('waits for the CLI health guide too, which can open right after onboarding but is not a modal', () => {
    const poll = functionBody('pollWelcomeTour')
    expect(poll).toMatch(/if \(mainModalOpen\(\) \|\| cliHealthGuide\.value\) return/)
    // The guide stays out of mainModalOpen: that drives the modalOpen keybinding context.
    expect(functionBody('mainModalOpen')).not.toContain('cliHealthGuide')
  })

  // 20:44: "the tour only ever appears on a first install; a workspace record
  // means it is not one" — and then the whole tour is off, not just Welcome.
  it('calls the whole tour off when a workspace is already open as it comes due', () => {
    const poll = functionBody('pollWelcomeTour')
    const start = poll.slice(poll.indexOf("if (stage === 'start') {"))
    expect(start).toMatch(/^if \(stage === 'start'\) \{\s+if \(workspaceSelected\.value\) \{\s+welcomeTour\.cancel\(\)/)
    expect(appSource).not.toContain('passWelcome')
  })

  it('checks the recent-workspace list once before starting, and starts only when it is empty', () => {
    const poll = functionBody('pollWelcomeTour')
    const start = poll.slice(poll.indexOf("if (stage === 'start') {"))
    expect(start.indexOf('welcomeTourRecordsChecked')).toBeLessThan(start.indexOf('welcomeTour.startWelcome()'))
    const check = functionBody('checkWelcomeTourRecords')
    expect(check).toContain("backend.send<{ recent?: unknown[] }>('workspace.list_recent', {})")
    // Any record, a failed answer or an error: not a first install, as far as
    // the tour can tell — it stays off rather than greet a returning user.
    expect(check).toMatch(/if \(!resp\.ok \|\| \(resp\.payload\?\.recent\?\.length \?\? 0\) > 0\) welcomeTour\.cancel\(\)/)
    expect(check).toMatch(/catch \{\s+welcomeTour\.cancel\(\)/)
  })

  it('shows the main-screen part only once a workspace is open', () => {
    const poll = functionBody('pollWelcomeTour')
    const gate = poll.indexOf('if (!workspaceSelected.value) return')
    expect(gate).toBeGreaterThan(poll.indexOf("stage === 'start'"))
    expect(gate).toBeLessThan(poll.indexOf('welcomeTour.startMain()'))
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

  it('tells GuidedTour whether the last card keeps Skip', () => {
    expect(appSource).toContain('const activeTourSkipOnLast = releaseTour.skipOnLast')
    expect(appSource).toMatch(/<GuidedTour[^>]*@close="endTour"\s+:skip-on-last="activeTourSkipOnLast"/)
  })

  it('hands GuidedTour the interactive mode, the done and skip checks, and when to step aside', () => {
    expect(appSource).toMatch(
      /<GuidedTour[^>]*:interactive="activeTourInteractive"\s+:is-complete="welcomeStepComplete"\s+:should-skip="welcomeStepSkip"\s+:suspended="welcomeTourSuspended"/,
    )
    expect(functionBody('welcomeStepComplete')).toContain('welcomeActionDone(step.waitFor, welcomeFacts(), enteredAt)')
    expect(functionBody('welcomeStepSkip')).toContain('welcomeActionAlreadyDone(step.waitFor, welcomeFacts())')
    // Answering a CLI's trust prompt is a keystroke, not a first instruction:
    // only a finished turn counts as having given one.
    expect(functionBody('welcomeFacts')).toContain('paneTurnCompleteAt.get(id)')
  })

  it('steps the first-run tour aside for the install dialog, a release note, Settings or the CLI health guide', () => {
    const start = appSource.indexOf('const welcomeTourSuspended = computed(')
    expect(start).toBeGreaterThan(-1)
    const body = appSource.slice(start, appSource.indexOf('\n})', start))
    for (const what of ['cliInstallRequest.value', 'whatsNewEntry.value', 'showSettings.value', 'cliHealthGuide.value']) {
      expect(body, what).toContain(what)
    }
    expect(body).toContain('activeTourInteractive.value')
  })

  it('tells the tour about an @ pick and a pane drop where they already happen', () => {
    expect(functionBody('rememberMentionPick')).toContain("welcomeTour.notify('mention')")
    expect(functionBody('injectPaneContextSources')).toContain("welcomeTour.notify('drop')")
  })

  it('has the quota badge tell the tour when it opens', () => {
    const badge = readFileSync(resolve(process.cwd(), 'src/renderer/src/components/UsageBadge.vue'), 'utf8')
    expect(badge).toContain("useWelcomeTour().notify('usage')")
  })
})
