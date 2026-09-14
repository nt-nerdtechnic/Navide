// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Same approach as App.spawnAdvisories.test.ts: App.vue cannot be mounted
// here, so these tests parse the source text and guard the wiring of the
// spawn kickoff path — the gate it waits on before typing, the bounded retry
// when the injection cannot be verified, and the kickoff verdict event the
// MCP cli_open_agent call blocks on. The pure pieces (composerHoldsPayload,
// injectionVerified) are unit tested in lib/__tests__/injectEcho.test.ts.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function block(startMarker: string, endMarker: string, fromIndex = 0): string {
  const start = appSource.indexOf(startMarker, fromIndex)
  expect(start, `${startMarker} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf(endMarker, start + startMarker.length)
  expect(end, `${endMarker} should exist after ${startMarker}`).toBeGreaterThan(-1)
  return appSource.slice(start, end)
}

const kickoff = () => block('async function kickoffRequestedPane(', '\n/** Spawn + kick off a pane requested by a SPAWN block.')

describe('kickoffRequestedPane waits for the prompt, not for one quiet second', () => {
  it('no longer gates on waitForQuiet(1s/8s) — that let a booting TUI eat the task', () => {
    expect(kickoff()).not.toContain('waitForQuiet(paneId, 1000, 8000)')
    expect(kickoff()).toContain('await waitForPromptReady(paneId, KICKOFF_PROMPT_READY_TIMEOUT_MS)')
  })

  it('caps the prompt wait at 30s', () => {
    expect(appSource).toContain('const KICKOFF_PROMPT_READY_TIMEOUT_MS = 30_000')
  })

  it('prompt-ready means the status machine reads idle AND the clean buffer has settled', () => {
    const fn = block('async function waitForPromptReady(', '\nasync function waitForStartupActivity(')
    expect(fn).toContain("displayStatus")
    expect(fn).toContain("=== 'idle'")
    expect(fn).toContain('PROMPT_READY_QUIET_MS')
    expect(fn).toContain('paneCleanBytes(paneId)')
  })

  it('falls back to typing anyway on timeout, and says so in a diagnostic', () => {
    expect(kickoff()).toContain("code: 'spawn.prompt-ready-timeout'")
  })
})

describe('kickoffRequestedPane judges the injection against the gate it waited on', () => {
  it('uses kickoffVerified with the prompt-ready result, not the strict check alone', () => {
    // The strict check never passes for a collapsed paste (Claude Code shows
    // "[Pasted text #N +M lines]" for a multi-line task, so the tail is never
    // on screen and Enter is judged by growth); judged strictly, every long
    // kickoff was retyped or reported failed with a resend hint.
    expect(kickoff()).toContain('kickoffVerified(evidence.echo ?? null, evidence.submit ?? null, promptReady)')
    expect(kickoff()).not.toContain('injectionVerified(')
  })
})

describe('kickoffRequestedPane retries an unverified injection at most once', () => {
  it('bounds the attempts at 2', () => {
    expect(appSource).toContain('const KICKOFF_MAX_ATTEMPTS = 2')
    expect(kickoff()).toContain('attempt <= KICKOFF_MAX_ATTEMPTS')
  })

  it('only retypes when the composer is not already holding the first copy', () => {
    expect(kickoff()).toContain('composerHoldsPayload(')
    const importBlock = block("import {\n  composerHoldsPayload, echoEvidence,", "} from './lib/injectEcho'")
    expect(importBlock).toContain('composerHoldsPayload')
  })

  it('settles a second unverified attempt as failed, with the reason', () => {
    expect(kickoff()).toContain("if (attempt === KICKOFF_MAX_ATTEMPTS) {\n        outcome = 'failed'")
    expect(kickoff()).toContain('settled.kickoffStatus = outcome')
    expect(kickoff()).toContain("code: 'spawn.kickoff-failed'")
  })
})

describe('the kickoff verdict reaches the waiting cli_open_agent call', () => {
  it('emits agent_spawn.kickoff with request_id / pane_id / kickoff once settled', () => {
    expect(kickoff()).toContain("backend.send('agent_spawn.kickoff'")
    expect(kickoff()).toContain('request_id: requestId')
    expect(kickoff()).toContain('pane_id: paneId')
  })

  it('the MCP spawn path hands its request_id to the kickoff', () => {
    const handler = block('async function handleMcpSpawnRequest(ev: {', '\nfunction describeSpawnRefusal(')
    expect(handler).toContain('void kickoffRequestedPane(paneId, parentName, gate.task, ev.request_id)')
  })

  it('the standalone path reports its (already injected) kickoff too, so the call never waits 45s for it', () => {
    const handler = block('async function handleMcpSpawnRequest(ev: {', '\nfunction describeSpawnRefusal(')
    const standaloneReport = handler.indexOf('report({ ok: true, paneId, name: childName, advisories: gate.advisories })')
    expect(standaloneReport).toBeGreaterThan(-1)
    const emit = handler.indexOf("backend.send('agent_spawn.kickoff'", standaloneReport)
    expect(emit).toBeGreaterThan(standaloneReport)
    expect(handler.slice(emit, emit + 300)).toContain("kickoff: 'sent'")
  })

  it('a kickoff that never reached a verdict (early return / throw) is reported failed, not left pending', () => {
    // The `finally` is the only code that runs on every exit; the verdict must
    // go out from there when nothing settled it.
    const fin = kickoff().slice(kickoff().lastIndexOf('} finally {'))
    expect(fin).toContain("emitKickoffVerdict('failed'")
  })
})

describe('deliverAgentMessage marks delivered-pending before the Enter, not after', () => {
  // An idle CLI writes the user record the moment it submits, and that record
  // can reach the agent.activity handler inside injectPane's 200ms submit
  // poll. A consume that lands before its mark is dropped (count already 0),
  // and the mark that follows then holds RUNNING for the whole 120s fuse.
  it('marks first, injects second, and unmarks on an injection failure', () => {
    const fn = block('async function deliverAgentMessage(', '\n/** How long after the last keystroke')
    const mark = fn.indexOf('markDeliveredPending?.()')
    const inject = fn.indexOf("await injectPane(paneId, text, 'agent-msg', true)")
    expect(mark).toBeGreaterThan(-1)
    expect(inject).toBeGreaterThan(mark)
    const failure = fn.indexOf('if (!ok) {', inject)
    expect(failure).toBeGreaterThan(-1)
    expect(fn.slice(failure, failure + 120)).toContain('clearDeliveredPending?.()')
  })
})
