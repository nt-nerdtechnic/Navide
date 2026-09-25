// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// App.vue cannot be mounted here (see App.spawnAdvisories.test.ts), so these
// parse the source to guard the wiring that opens plain terminal panes to MCP:
// addressable, spawnable, and never typed anything but the command itself.
// The pieces with logic of their own are unit tested directly —
// useAgentMessagingTerminal.test.ts, spawnKickoff.test.ts, agentSpawnGate.test.ts.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function block(startMarker: string, endMarker: string): string {
  const start = appSource.indexOf(startMarker)
  expect(start, `${startMarker} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf(endMarker, start + startMarker.length)
  expect(end, `${endMarker} should exist after ${startMarker}`).toBeGreaterThan(-1)
  return appSource.slice(start, end)
}

describe('plain terminal panes over MCP', () => {
  it('registers terminals in the messaging registry like any other pane', () => {
    const fn = block('function registerPaneMessaging(', '\n}\n')
    expect(fn).not.toContain("'terminal'")
    expect(fn).toContain('messaging.registerPane(pane.id, pane.agentKey, preferred)')
  })

  it('whitelists terminal for both spawn gates but counts agent panes only', () => {
    for (const marker of ['function spawnGateContextFor(', 'function standaloneSpawnGateContext(']) {
      const fn = block(marker, '\n}\n')
      expect(fn).toContain('validAgentKeys: agentSpecs.map((s) => s.agentKey)')
      expect(fn).toContain("cliPaneCount: panes.value.filter((p) => p.agentKey !== 'terminal').length")
    }
  })

  it('types a terminal kickoff bare and once, never the report-back kickoff', () => {
    const fn = block('async function kickoffRequestedPane(', '\n/** Spawn + kick off a pane')
    const branch = fn.indexOf('if (pane.agentKey === TERMINAL_AGENT_KEY) {')
    const rendered = fn.indexOf('renderSpawnKickoff(task, parentName)')
    expect(branch).toBeGreaterThan(-1)
    expect(branch).toBeLessThan(rendered)
    const terminalBranch = fn.slice(branch, rendered)
    expect(terminalBranch).toContain("injectPane(paneId, task, 'agent-spawn', true, undefined, seen)")
    expect(terminalBranch).not.toContain('runKickoffAttempts')
    expect(terminalBranch).not.toContain('spawnReportPending')
  })

  it('holds a message while a terminal is printing', () => {
    const fn = block('function messagingHoldKey(', '\n}\n')
    expect(fn).toContain("if (pane.agentKey === TERMINAL_AGENT_KEY && status === 'running') return 'mid-turn'")
  })

  it('does not mark a terminal delivery pending — a shell writes no user record to release it', () => {
    const fn = block('async function deliverAgentMessage(', '\n}\n')
    expect(fn).toContain('?.agentKey !== TERMINAL_AGENT_KEY')
  })

  it('leaves terminals out of a group broadcast', () => {
    const cmd = block("registerCommand('ui.groupPeers'", "\nregisterCommand('ui.pane.getStatus'")
    expect(cmd).toContain('.filter((p) => p.agentKey !== TERMINAL_AGENT_KEY)')
  })
})
