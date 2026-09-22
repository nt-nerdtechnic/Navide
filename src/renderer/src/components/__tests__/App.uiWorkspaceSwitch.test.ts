// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// ui.workspace.switch puts another workspace this window already holds on
// screen — the MCP face of the sidebar's "one window, many projects" switch.
// It must take the same road the sidebar takes, switchToWorkspace: a bare
// onWorkspaceBrowse would keep the panes but leave the window half-switched
// (no onWorkspaceCheck, focus still on a hidden pane, declines unreported).
// And an MCP caller cannot answer switchToWorkspace's pipeline dialog, so the
// action refuses that case itself instead of running into the reply timeout.
//
// The registration lives in App.vue, which the suite cannot mount, so it is
// asserted against the source the way the other App.*.test.ts files do.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function registration(action: string): string {
  const start = appSource.indexOf(`registerCommand('${action}'`)
  expect(start).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n})\n', start)
  expect(end).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

describe('ui.workspace.switch', () => {
  it('is registered as a UI action', () => {
    expect(appSource).toContain("registerCommand('ui.workspace.switch'")
  })

  it('switches through switchToWorkspace, never a bare browse', () => {
    const body = registration('ui.workspace.switch')
    expect(body).toContain('await switchToWorkspace(path)')
    expect(body).not.toContain('onWorkspaceBrowse')
    expect(body).not.toContain('onPipelineReset')
  })

  it('refuses a workspace this window does not hold and points at ui.workspace.open', () => {
    const body = registration('ui.workspace.switch')
    expect(body).toContain('workspaceOrder.value.some((w) => normWs(w) === normWs(path))')
    const refusal = body.slice(body.indexOf('does not hold'))
    expect(refusal.slice(0, refusal.indexOf('\n'))).toContain('ui.workspace.open')
    // The refusal is a throw, not a silent open on the side.
    expect(body).not.toContain('openMainWindow')
  })

  it('refuses up front while a pipeline is running, before switchToWorkspace can ask', () => {
    const body = registration('ui.workspace.switch')
    const guard = body.indexOf("if (pipeline.state === 'running')")
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(body.indexOf('await switchToWorkspace(path)'))
    expect(body.slice(guard)).toContain('a pipeline is running in this window')
  })

  it('checks that the switch landed instead of trusting a silent return', () => {
    const body = registration('ui.workspace.switch')
    const after = body.slice(body.indexOf('await switchToWorkspace(path)'))
    const check = after.indexOf('if (normWs(currentWorkspace.value) !== normWs(path))')
    expect(check).toBeGreaterThan(-1)
    expect(after.slice(check)).toContain('throw new Error(')
    expect(check).toBeLessThan(after.indexOf('return { path: currentWorkspace.value }'))
  })

  it('requires path', () => {
    const body = registration('ui.workspace.switch')
    expect(body).toContain("throw new Error('ui.workspace.switch requires path')")
  })
})
