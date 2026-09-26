// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Mounting App starts backend/terminal/settings lifecycles, so — like the other
// App.*.test.ts files — these assert against the source text. The logic behind
// the wiring is unit-tested in lib/__tests__/whatsNew.test.ts, tours.test.ts and
// components/__tests__/GuidedTour.test.ts / WhatsNewModal.test.ts.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function functionBody(name: string): string {
  const start = appSource.indexOf(`function ${name}(`)
  expect(start).toBeGreaterThan(-1)
  return appSource.slice(start, appSource.indexOf('\n}', start))
}

describe('Help → What’s New… (menu action show-whats-new)', () => {
  it('routes the menu action to the on-demand opener', () => {
    const menu = functionBody('onMenuAction')
    expect(menu).toMatch(/action === 'show-whats-new'\) \{\s+showWhatsNewOnDemand\(\)/)
  })

  it('picks the entry with the dev flag, so a dev build shows the next release', () => {
    expect(functionBody('showWhatsNewOnDemand')).toContain(
      'pickWhatsNewOnDemand(window.agentTeam?.version ?? \'\', import.meta.env.DEV)',
    )
  })

  it('records nothing when an on-demand showing is closed', () => {
    const body = functionBody('closeWhatsNew')
    const onDemand = body.slice(0, body.indexOf('dismissWhatsNew()'))
    expect(onDemand).toContain('whatsNewOnDemand.value')
    expect(onDemand).not.toContain('settingsSet')
    expect(onDemand).not.toContain('markRead')
    expect(onDemand).toContain('return')
  })

  it('leaves the once-per-version path to dismissWhatsNew, unchanged', () => {
    const body = functionBody('dismissWhatsNew')
    expect(body).toContain("settingsSet('agentTeam.whatsNew.lastSeenVersion', current)")
    expect(body).not.toContain('whatsNewOnDemand')
    // The startup evaluation still decides by pickWhatsNew, not the on-demand pick.
    expect(functionBody('evaluateWhatsNew')).toContain('pickWhatsNew(current, seen)')
    expect(functionBody('evaluateWhatsNew')).not.toContain('OnDemand')
  })
})

describe('the tour question and the tour', () => {
  it('mounts the modal with the tour answer and the replay flag', () => {
    expect(appSource).toContain(':tour-done="whatsNewTourDone"')
    expect(appSource).toContain('@close="closeWhatsNew"')
    expect(appSource).toContain('@tour="startWhatsNewTour"')
  })

  it('closes the modal (recording it seen) before starting the tour it names', () => {
    const body = functionBody('startWhatsNewTour')
    expect(body.indexOf('whatsNewEntry.value?.tour')).toBeLessThan(body.indexOf('closeWhatsNew()'))
    expect(body).toContain('if (id && TOURS[id]) activeTourId.value = id')
  })

  it('persists tour-done only when the tour reached its end', () => {
    const body = functionBody('endTour')
    expect(body).toContain('if (completed && id) settingsSet(tourDoneKey(id), true)')
  })

  it('only opens or closes Settings to prepare a step', () => {
    const body = functionBody('runTourPrepare')
    expect(body).toContain("if (prepare.kind === 'settings') openSettingsAt(prepare.tab)")
    expect(body).toContain('else showSettings.value = false')
    expect(body).not.toContain('settingsSet')
  })

  it('mounts GuidedTour with the steps, the prepare hook and the end handler', () => {
    expect(appSource).toMatch(
      /<GuidedTour\s+v-if="activeTourSteps"\s+:steps="activeTourSteps"\s+:run-prepare="runTourPrepare"\s+@close="endTour"/,
    )
  })

  it('counts the tour as a modal, and lets Esc leave the tour before anything under it', () => {
    expect(functionBody('mainModalOpen')).toContain('!!activeTourId.value')
    expect(appSource).toContain(
      'watch([reconnectPickerOpen, cliInstallRequest, whatsNewEntry, activeTourId], () => setContext(\'modalOpen\', mainModalOpen()))',
    )
    const start = appSource.indexOf("registerCommand('workbench.action.closeModal'")
    const close = appSource.slice(start, appSource.indexOf('\n})', start))
    expect(close.indexOf('activeTourId.value')).toBeGreaterThan(-1)
    expect(close.indexOf('activeTourId.value')).toBeLessThan(close.indexOf('showSettings.value'))
  })

  it('lets Settings be opened at the Voice Input tab', () => {
    expect(appSource).toMatch(/const settingsInitialTab = ref<[^>]*'voice'[^>]*>/)
  })
})
