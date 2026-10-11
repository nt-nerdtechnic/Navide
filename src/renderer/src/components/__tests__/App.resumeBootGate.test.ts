import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The messaging gate let a message into a `claude --resume` that was still
// reloading its transcript (see lib/__tests__/resumeBoot.test.ts for the
// incident). messagingHoldKey lives in App.vue, which the suite cannot mount,
// so its wiring is asserted against the source the way the other
// App.*.test.ts files do.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
const terminalSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/platform/terminal/composables/useTerminal.ts'),
  'utf8',
)
const paneSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/components/TerminalPane.vue'), 'utf8')

function fn(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`)
  expect(start).toBeGreaterThan(-1)
  const end = source.indexOf('\n}\n', start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('messagingHoldKey holds a resuming CLI as starting', () => {
  it('asks resumeBootHold, with the PTY, spawn time, push channel and CLI clocks', () => {
    const body = fn(appSource, 'messagingHoldKey')
    expect(body).toContain('resumeBootHold({')
    expect(body).toContain('hasPty: !!')
    expect(body).toContain('resumeSpawnedAt')
    expect(body).toContain('pushReady: pushReadyPanes.has(paneId)')
    expect(body).toContain('lastSignalAt: Math.max(paneTurnCompleteAt.get(paneId) ?? 0, paneLastActiveAt.get(paneId) ?? 0)')
  })

  it("answers 'starting', ahead of the typing and turn holds", () => {
    const body = fn(appSource, 'messagingHoldKey')
    const boot = body.indexOf('resumeBootHold({')
    expect(body.slice(boot, boot + 400)).toContain("return 'starting'")
    expect(boot).toBeLessThan(body.indexOf("return 'typing'"))
    expect(boot).toBeLessThan(body.indexOf("return 'mid-turn'"))
  })
})

describe('useTerminal stamps a resume only when it creates the PTY', () => {
  it('sets resumeSpawnedAt on a successful create of a resume spawn', () => {
    const created = terminalSource.indexOf('sessionId.value = resp.payload.terminal_session_id')
    expect(created).toBeGreaterThan(-1)
    expect(terminalSource.slice(created, created + 400)).toContain('resumeSpawnedAt.value = opts.isResume ? Date.now() : 0')
  })

  it('leaves a reattach unstamped — that CLI never stopped running', () => {
    const start = terminalSource.indexOf('async function tryReattach(')
    expect(start).toBeGreaterThan(-1)
    const body = terminalSource.slice(start, terminalSource.indexOf('\n  }\n', start))
    expect(body).toContain('sessionId.value = prev')
    expect(body).not.toContain('resumeSpawnedAt')
  })

  it('is exposed to App through the pane ref', () => {
    expect(paneSource).toContain('resumeSpawnedAt: terminal.resumeSpawnedAt')
  })
})
