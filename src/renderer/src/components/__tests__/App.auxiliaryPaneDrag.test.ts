import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// App itself is intentionally not mounted here: doing so starts the backend,
// terminal, settings, and onboarding lifecycles. This contract test instead
// guards the three lightweight non-grid drag surfaces in the SFC template,
// while cliContext.test.ts and paneOrder.test.ts cover payload and reorder
// behavior independently.
const appSource = readFileSync(
  fileURLToPath(new URL('../../App.vue', import.meta.url)),
  'utf8'
)

function elementOpeningTag(className: string): string {
  const classAt = appSource.indexOf(`class="${className}"`)
  expect(classAt, `${className} should exist`).toBeGreaterThan(-1)
  const start = appSource.lastIndexOf('<div', classAt)
  const end = appSource.indexOf('>', classAt)
  return appSource.slice(start, end + 1)
}

function expectPaneDragSurface(openingTag: string): void {
  expect(openingTag).toContain('draggable="true"')
  expect(openingTag).toContain('@dragstart="onAuxiliaryPaneDragStart($event, p.id)"')
  expect(openingTag).toContain('@dragend="onAuxiliaryPaneDragEnd"')
  expect(openingTag).toContain('@dragover="onAuxiliaryPaneDragOver($event, p.id)"')
  expect(openingTag).toContain('@drop.prevent="onAuxiliaryPaneDrop($event, p.id)"')
  expect(openingTag).toContain("'pane-drag-over': auxiliaryDragOverPaneId === p.id")
}

describe('App auxiliary pane drag surfaces', () => {
  it('wires Auto meeting cards as pane drag sources and targets', () => {
    const autoStart = appSource.indexOf('class="auto-meeting-list"')
    const spotlightStart = appSource.indexOf('class="spotlight-strip"')
    const autoSection = appSource.slice(autoStart, spotlightStart)
    expect(autoSection).toContain('class="meeting-item"')
    expectPaneDragSurface(elementOpeningTag('meeting-item'))
  })

  it('wires Spotlight thumbnails as pane drag sources and targets', () => {
    expectPaneDragSurface(elementOpeningTag('spotlight-thumb'))
  })

  it('wires Fullscreen PiP rows as pane drag sources and targets', () => {
    const pipStart = appSource.indexOf('class="float-pip-list"')
    expect(pipStart).toBeGreaterThan(-1)
    const pipItemClass = appSource.indexOf('class="meeting-item"', pipStart)
    expect(pipItemClass).toBeGreaterThan(pipStart)
    const start = appSource.lastIndexOf('<div', pipItemClass)
    const end = appSource.indexOf('>', pipItemClass)
    expectPaneDragSurface(appSource.slice(start, end + 1))
  })
})
